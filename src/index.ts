/**
 * Worker 入口接线（DESIGN.md §3.1 / §3.2）。
 *
 *   fetch     POST /api/hook → ingress（HMAC + delivery 去重 + 入队）
 *             GET  /healthz  → 200 `ok`（wrangler dev / 探活）
 *   queue     router 消费者 → RepoLock 漏斗 → Workflow（§5.4）
 *   scheduled 30min 卡死 PR 巡检 + schedule 重优化扫描（P2，§2.4）
 */
import type { Env, RunDescriptor } from "./types";
import { handleWebhook } from "./ingress/webhook";
import { handleAuthRoute } from "./dashboard/auth";
import { handleApiRoute } from "./dashboard/api";
import {
  CRON_PR_POISON,
  CRON_SCHEDULE,
  runPrPoisonSweep,
  runScheduleSweep,
} from "./ingress/scheduled";

export { RepoLock } from "./do/repo-lock";
export { OptimizeRun } from "./workflow/optimize-run";
export { ImageContainer } from "./container/image-container";

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/api/hook") {
      // ctx 让合并删分支能在 202 之后继续跑（waitUntil）。
      return handleWebhook(request, env, ctx);
    }
    // P3 仪表盘：OAuth 三路由（/api/auth/*）
    const auth = await handleAuthRoute(env, request, url);
    if (auth) return auth;
    // P3 仪表盘：REST API（自带 401 守卫；未命中返回 null）
    const api = await handleApiRoute(env, request, url);
    if (api) return api;

    if (url.pathname === "/healthz" && request.method === "GET") {
      return new Response("ok", {
        status: 200,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    // 静态资源（run_worker_first 只保 /api/*；SPA 兜底在资产层）
    return env.ASSETS.fetch(request);
  },

  async queue(batch: MessageBatch<RunDescriptor>, env: Env): Promise<void> {
    // Queues 陷阱：任一消息抛出未捕获错误 → **整批**重试。
    // 因此每条消息独立 try/catch，成功/永久失败各自 ack。
    for (const msg of batch.messages) {
      try {
        const desc = msg.body;
        if (!isRunDescriptor(desc)) {
          console.error("router: malformed message body, dropping", desc);
          msg.ack();
          continue;
        }

        // §5.4 唯一入口漏斗：锁空闲 → 建实例；锁占用 → 防抖合并
        const stub = env.REPO_LOCK.getByName(
          `repo:${desc.installation_id}/${desc.repo}`,
        );
        const result = await stub.submit(desc);
        if (result.quotaExceeded) {
          // D10 配额：不启动、不重试（ack），运维看日志/仪表盘 429
          console.warn(
            `router: quota exceeded, dropping run ${desc.run_id} for ${desc.repo}`,
          );
        }
        msg.ack();
      } catch (error) {
        if (isRetryable(error)) {
          const attempts = Math.max(1, msg.attempts ?? 1);
          msg.retry({ delaySeconds: 30 * attempts });
        } else {
          // 不可重试：ack 掉，避免同一条消息打满 max_retries 进 DLQ
          console.error(
            "router: non-retryable submit failure, dropping",
            error,
          );
          msg.ack();
        }
      }
    }
  },

  async scheduled(
    event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    // §2.4：两个 cron 分工明确，按 event.cron 分派（wrangler.jsonc triggers）。
    if (event.cron === CRON_PR_POISON) {
      ctx.waitUntil(
        runPrPoisonSweep(env).catch((error) => {
          console.error("cron: pr poison sweep failed", error);
        }),
      );
      return;
    }

    if (event.cron === CRON_SCHEDULE) {
      ctx.waitUntil(
        runScheduleSweep(env).catch((error) => {
          console.error("cron: schedule sweep failed", error);
        }),
      );
      return;
    }

    console.warn(`cron: unrecognized schedule ${JSON.stringify(event.cron)}`);
  },
};

function isRunDescriptor(value: unknown): value is RunDescriptor {
  if (value === null || typeof value !== "object") return false;
  const desc = value as Partial<Record<keyof RunDescriptor, unknown>>;
  return (
    typeof desc.run_id === "string" &&
    desc.run_id !== "" &&
    typeof desc.installation_id === "number" &&
    typeof desc.repo === "string" &&
    desc.repo !== "" &&
    typeof desc.trigger === "string" &&
    typeof desc.base_ref === "string"
  );
}

/**
 * 可重试判定：429 / 5xx / 网络与 DO 瞬时故障重试，其余（400/403/422 等）直接丢弃，
 * 防止一条坏消息无限重试把整批拖垮。
 */
function isRetryable(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const err = error as {
    status?: unknown;
    statusCode?: unknown;
    retryable?: unknown;
    name?: unknown;
    message?: unknown;
  };

  if (err.retryable === true) return true;
  if (err.retryable === false) return false;

  const status =
    typeof err.status === "number"
      ? err.status
      : typeof err.statusCode === "number"
        ? err.statusCode
        : null;
  if (status !== null)
    return status === 429 || (status >= 500 && status <= 599);

  const name = typeof err.name === "string" ? err.name : "";
  if (
    name === "TypeError" ||
    name === "NetworkError" ||
    name === "TimeoutError" ||
    name === "AbortError"
  ) {
    return true;
  }

  const message =
    typeof err.message === "string" ? err.message.toLowerCase() : "";
  return /network|timeout|timed out|rate limit|\b429\b|overloaded|internal error|reset|unavailable|temporar/.test(
    message,
  );
}
