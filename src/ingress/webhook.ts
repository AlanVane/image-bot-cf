/**
 * webhook 入口（DESIGN.md §3.1 ingress / §4.1.3 HMAC / §4.1.4 delivery 去重）。
 *
 * 顺序是契约的一部分：
 *   1. `await request.arrayBuffer()` **先**取原始字节，再 JSON.parse
 *      （对已解析对象重序列化会改变空白/键序，HMAC 立刻失效）；
 *   2. 校验 `X-Hub-Signature-256`，失败 401（fail-closed）；
 *   3. `x-github-delivery` 落 D1 `deliveries`，`INSERT OR IGNORE` 后 `meta.changes === 0`
 *      ⇒ 重复投递，202 直接丢弃，不再入队；
 *   4. 映射描述符 → Queue `router`；202 快速应答（GitHub 要求 ~10s 内）。
 *   5. 默认分支上的 imgbot web 合并（§2.1）→ `ctx.waitUntil` 异步删 `heads/imgbot`，
 *      失败只记日志，绝不拖慢/污染主流程。
 */
import { getInstallationToken } from "../github/auth";
import { GITHUB_API_BASE, GITHUB_API_VERSION } from "../github/gitdata";
import type { Env } from "../types";
import {
  parseDeliveryHeaders,
  verifyWebhookSignature,
} from "../github/webhook";
import {
  IMBOT_BRANCH,
  getWebMergeTarget,
  isDefaultWebMerge,
  mapEventToRuns,
  type WebMergeTarget,
} from "./events";

const SIGNATURE_HEADER = "x-hub-signature-256";

/**
 * POST-only webhook handler。
 * 非 POST → 404（路由层只暴露 `POST /api/hook`）。
 *
 * `ctx` 可选：Worker 入口必须传（合并删分支要 waitUntil 保活）；单测可省略。
 */
export async function handleWebhook(
  request: Request,
  env: Env,
  ctx?: ExecutionContext,
): Promise<Response> {
  if (request.method !== "POST") {
    return json({ ok: false, error: "not_found" }, 404);
  }

  try {
    // ① 原始字节：摘要必须基于它计算
    const rawBody = await request.arrayBuffer();

    // ② HMAC
    const verified = await verifyWebhookSignature(
      env.GITHUB_WEBHOOK_SECRET,
      rawBody,
      request.headers.get(SIGNATURE_HEADER),
    );
    if (!verified) {
      return json({ ok: false, error: "unauthorized" }, 401);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder().decode(rawBody));
    } catch {
      // 验签通过却非 JSON：请求本身畸形，不是内部错误
      return json({ ok: false, error: "invalid_json" }, 400);
    }

    const { event, deliveryId } = parseDeliveryHeaders(request.headers);

    // ③ 去重（§4.1.4）：唯一主键 + INSERT OR IGNORE 天然幂等
    if (deliveryId) {
      const inserted = await env.DB.prepare(
        "INSERT OR IGNORE INTO deliveries (delivery_id, event, received_at) VALUES (?, ?, ?)",
      )
        .bind(deliveryId, event, new Date().toISOString())
        .run();
      if ((inserted.meta?.changes ?? 0) === 0) {
        return json({ ok: true, duplicate: true }, 202);
      }
    }

    // ④ 入队
    if (!event) return json({ ok: true, queued: 0 }, 202);

    const descriptors = mapEventToRuns(event, payload);
    for (const desc of descriptors) {
      await env.ROUTER.send(
        deliveryId ? { ...desc, delivery_id: deliveryId } : desc,
        { contentType: "json" },
      );
    }

    // ⑤ 合并删分支（§2.1）：202 应答后异步执行，失败只记日志。
    if (event === "push" && isDefaultWebMerge(payload)) {
      const target = getWebMergeTarget(payload);
      if (target) {
        const task = deleteImgbotBranch(env, target).catch((error) => {
          console.error(
            `webhook: failed to delete refs/heads/${IMBOT_BRANCH} for ${target.repo}`,
            error,
          );
        });
        if (ctx) ctx.waitUntil(task);
        else void task;
      }
    }

    return json({ ok: true, queued: descriptors.length }, 202);
  } catch (error) {
    // 内部错误不泄露细节给调用方（GitHub 侧只看状态码）
    console.error("webhook ingress failed", error);
    return json({ ok: false, error: "internal_error" }, 500);
  }
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/**
 * 删除 `refs/heads/imgbot`（§2.1 合并后清理）。
 * 404 静默（可能已删/已被 webhook 重投），其余失败抛给调用方的 catch。
 */
async function deleteImgbotBranch(
  env: Env,
  target: WebMergeTarget,
): Promise<void> {
  const slash = target.repo.indexOf("/");
  if (slash <= 0 || slash === target.repo.length - 1) return;
  const owner = target.repo.slice(0, slash);
  const repo = target.repo.slice(slash + 1);

  const { token } = await getInstallationToken({
    installationId: target.installationId,
    appId: env.GITHUB_APP_ID,
    privateKeyPem: env.GITHUB_PRIVATE_KEY,
  });

  const url =
    `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/` +
    `${encodeURIComponent(repo)}/git/refs/heads/${IMBOT_BRANCH}`;
  const fetchImpl = globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("deleteImgbotBranch requires a fetch implementation");
  }

  const res = await fetchImpl(url, {
    method: "DELETE",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": GITHUB_API_VERSION,
      "user-agent": "image-bot-cf",
    },
  });

  // 404：分支已不存在（重复投递/已清理），视为成功。
  if (res.status === 404) return;
  if (!res.ok) {
    throw new Error(
      `GitHub DELETE refs/heads/${IMBOT_BRANCH} for ${target.repo} failed: ${res.status}`,
    );
  }
}
