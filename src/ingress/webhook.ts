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
import { githubRequest } from "../github/http";
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

    // ③ 去重预查（§4.1.4）：已见过的投递短路。**先入队、后落账**——若 ROUTER.send
    // 失败则不留下任何去重记录，GitHub 重投可重试（P1 修复：旧顺序会把失败事件
    // 永久挡掉）；并发重复投递的双跑由 RepoLock 合并（§5.4），无害。
    if (deliveryId) {
      const seen = await env.DB.prepare(
        "SELECT delivery_id FROM deliveries WHERE delivery_id = ?",
      )
        .bind(deliveryId)
        .first();
      if (seen) {
        return json({ ok: true, duplicate: true }, 202);
      }
    }

    // ④ 入队
    const descriptors = event ? mapEventToRuns(event, payload) : [];

    // ④′ 计费：Marketplace 购买/变更/取消 → `marketplace_purchases` UPSERT。
    // 不进 ROUTER（不产生 run），但仍走同一 delivery 去重与 202 应答路径。
    if (event === "marketplace_purchase") {
      await applyMarketplacePurchase(env, payload);
    }

    for (const desc of descriptors) {
      await env.ROUTER.send(
        deliveryId ? { ...desc, delivery_id: deliveryId } : desc,
        { contentType: "json" },
      );
    }

    // ④′ 去重落账（唯一主键 + INSERT OR IGNORE；并发同投递仅一行生效）
    if (deliveryId) {
      await env.DB.prepare(
        "INSERT OR IGNORE INTO deliveries (delivery_id, event, received_at) VALUES (?, ?, ?)",
      )
        .bind(deliveryId, event, new Date().toISOString())
        .run();
    }

    if (!event) return json({ ok: true, queued: 0 }, 202);

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

/* -------------------------------------------------------------------------- */
/* Marketplace 计费（D16）                                                     */
/* -------------------------------------------------------------------------- */

/**
 * payload：`{action, marketplace_purchase: {account: {id, login}, plan: {id, name}}}`
 * （GitHub Marketplace webhook，无 `installation` 信封）。
 *
 * `action` 语义：
 * - `purchased` / `changed` → 该账户 plan 置为 payload 里的新计划，`state = active`；
 * - `cancelled` → 保留原 plan 行（payload 仍带 plan），`state = cancelled`；
 * - 其他（`pending_change` 等）/畸形 payload → 不写库（仍 202，避免 GitHub 重投）。
 */
const MARKETPLACE_PURCHASE_UPSERT =
  "INSERT INTO marketplace_purchases " +
  "(account_id, account_login, plan_id, plan_name, state, updated_at) " +
  "VALUES (?, ?, ?, ?, ?, ?) " +
  "ON CONFLICT(account_id) DO UPDATE SET " +
  "account_login = excluded.account_login, " +
  "plan_id = excluded.plan_id, " +
  "plan_name = excluded.plan_name, " +
  "state = excluded.state, " +
  "updated_at = excluded.updated_at";

interface MarketplacePurchase {
  accountId: number;
  accountLogin: string | null;
  planId: number;
  planName: string | null;
  state: "active" | "cancelled";
}

async function applyMarketplacePurchase(
  env: Env,
  payload: unknown,
): Promise<void> {
  const purchase = parseMarketplacePurchase(payload);
  if (!purchase) return;
  await env.DB.prepare(MARKETPLACE_PURCHASE_UPSERT)
    .bind(
      purchase.accountId,
      purchase.accountLogin,
      purchase.planId,
      purchase.planName,
      purchase.state,
      new Date().toISOString(),
    )
    .run();
}

function parseMarketplacePurchase(
  payload: unknown,
): MarketplacePurchase | null {
  const body = asRecord(payload);
  const action = typeof body?.action === "string" ? body.action : null;
  const state =
    action === "cancelled"
      ? ("cancelled" as const)
      : action === "purchased" || action === "changed"
        ? ("active" as const)
        : null;
  if (!state) return null;

  const purchase = asRecord(body?.marketplace_purchase);
  const account = asRecord(purchase?.account);
  const plan = asRecord(purchase?.plan);
  const accountId = asId(account?.id);
  const planId = asId(plan?.id);
  if (accountId === null || planId === null) return null;

  return {
    accountId,
    accountLogin: asString(account?.login),
    planId,
    planName: asString(plan?.name),
    state,
  };
}

/** payload 窄化helpers（外部 JSON 完全不可信；只在本文件计费分支使用）。 */
function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function asId(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : typeof value === "string" && /^\d+$/.test(value.trim())
      ? Number(value.trim())
      : null;
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

  const res = await githubRequest({
    token,
    path:
      `/repos/${encodeURIComponent(owner)}/` +
      `${encodeURIComponent(repo)}/git/refs/heads/${IMBOT_BRANCH}`,
    init: { method: "DELETE" },
  });

  // 404：分支已不存在（重复投递/已清理），视为成功。
  if (res.status === 404) return;
  if (!res.ok) {
    throw new Error(
      `GitHub DELETE refs/heads/${IMBOT_BRANCH} for ${target.repo} failed: ${res.status}`,
    );
  }
}
