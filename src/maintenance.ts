/**
 * 保留策略 + DLQ 捕获（P0 加固，无 DESIGN 章节依赖，纯运维语义）。
 *
 * 两块职责，都是「不留无限增长的表」：
 *
 * 1. `pruneExpired(env, nowMs)` —— 每日 cron 命中时跑一次（`src/ingress/scheduled.ts`
 *    的 03:00 分支）。每条 DELETE 独立一条语句（D1 友好，单条失败不连坐），
 *    返回各表删除行数。时间比较用 ISO 字符串：D1 里所有时间列都是
 *    `toISOString()` 写的，字典序 = 时间序。
 *
 * 2. `handleDeadLetterBatch` —— `router-dlq` 消费者：队列重试耗尽的消息落
 *    `dead_letters`（含原始 body 与 attempts），只 console.error + ack，
 *    **不再重试**（进 DLQ 说明重试已无意义，留着证据给人看）。
 *
 * 表与列的来源：`db/schema.sql`。image_cache 的 `optimized_at` 是 TEXT（可空），
 * 因此只按它判定陈旧；NULL 行不动（无法判定年龄，且它们本就是无害的候选缓存）。
 */
import type { Env } from "./types";

/* -------------------------------------------------------------------------- */
/* 常量                                                                        */
/* -------------------------------------------------------------------------- */

const DAY_MS = 24 * 60 * 60 * 1000;

/** 各表保留窗口（天）。改这里就是改策略，正则/测试都按这些常量断言。 */
export const RETENTION_DAYS = {
  deliveries: 30,
  runs: 365,
  deadLetters: 90,
  imageCache: 180,
} as const;

/** DLQ 队列名（wrangler.jsonc `queues.consumers[].dead_letter_queue`）。 */
export const DEAD_LETTER_QUEUE = "router-dlq";

/** DLQ 落库时写的错误摘要：进 DLQ = 重试已用尽，没有可重试路径。 */
export const DEAD_LETTER_ERROR = "no retryable";

/* -------------------------------------------------------------------------- */
/* 保留策略                                                                    */
/* -------------------------------------------------------------------------- */

/** 各表删除行数（D1 `meta.changes`）。 */
export interface PruneCounts {
  sessions: number;
  deliveries: number;
  runs: number;
  deadLetters: number;
  imageCache: number;
}

interface PruneSpec {
  /** `PruneCounts` 的键（也用于日志）。 */
  key: keyof PruneCounts;
  sql: string;
  /** SQL 绑定参数（时间界）。 */
  args: unknown[];
}

/**
 * 清理过期行；`nowMs` 显式传入便于测试（生产走 `Date.now()`）。
 *
 * 单条 DELETE 失败（例如远端 DDL 尚未应用导致 `dead_letters` 不存在）只记日志
 * 并记 0，不影响其他表——否则一次 DDL 滞后会让整个保留策略停摆。
 */
export async function pruneExpired(
  env: Env,
  nowMs: number = Date.now(),
): Promise<PruneCounts> {
  const counts: PruneCounts = {
    sessions: 0,
    deliveries: 0,
    runs: 0,
    deadLetters: 0,
    imageCache: 0,
  };

  const specs: PruneSpec[] = [
    {
      key: "sessions",
      sql: "DELETE FROM sessions WHERE expires_at < ?",
      args: [new Date(nowMs).toISOString()],
    },
    {
      key: "deliveries",
      sql: "DELETE FROM deliveries WHERE received_at < ?",
      args: [cutoff(nowMs, RETENTION_DAYS.deliveries)],
    },
    {
      key: "runs",
      sql: "DELETE FROM runs WHERE created_at < ?",
      args: [cutoff(nowMs, RETENTION_DAYS.runs)],
    },
    {
      key: "deadLetters",
      sql: "DELETE FROM dead_letters WHERE received_at < ?",
      args: [cutoff(nowMs, RETENTION_DAYS.deadLetters)],
    },
    {
      // 只清「能判定年龄」的行：optimized_at 为 NULL 的历史行保留。
      key: "imageCache",
      sql: "DELETE FROM image_cache WHERE optimized_at IS NOT NULL AND optimized_at < ?",
      args: [cutoff(nowMs, RETENTION_DAYS.imageCache)],
    },
  ];

  for (const spec of specs) {
    try {
      const result = await env.DB.prepare(spec.sql)
        .bind(...spec.args)
        .run();
      counts[spec.key] = result?.meta?.changes ?? 0;
    } catch (error) {
      console.error(`maintenance: prune ${spec.key} failed`, error);
    }
  }

  return counts;
}

function cutoff(nowMs: number, days: number): string {
  return new Date(nowMs - days * DAY_MS).toISOString();
}

/* -------------------------------------------------------------------------- */
/* DLQ 捕获                                                                    */
/* -------------------------------------------------------------------------- */

/** `dead_letters` 的一行（`id` 归 D1，`received_at` 由本模块生成）。 */
export interface DeadLetterEntry {
  queue: string;
  attempts: number | null;
  body: string;
  error: string;
}

const INSERT_DEAD_LETTER_SQL =
  "INSERT INTO dead_letters (queue, attempts, body, error, received_at) VALUES (?, ?, ?, ?, ?)";

/** 落一条 DLQ 记录（调用方决定失败语义）。 */
export async function recordDeadLetter(
  env: Env,
  entry: DeadLetterEntry,
  nowMs: number = Date.now(),
): Promise<void> {
  await env.DB.prepare(INSERT_DEAD_LETTER_SQL)
    .bind(
      entry.queue,
      entry.attempts,
      entry.body,
      entry.error,
      new Date(nowMs).toISOString(),
    )
    .run();
}

/** 消费者只需要的最小消息形状（便于用极简 fake 单测）。 */
export interface DeadLetterMessage {
  readonly attempts?: number;
  readonly body: unknown;
  ack(): void;
}

/** 同上：`MessageBatch` 的结构子集。 */
export interface DeadLetterBatch {
  readonly queue: string;
  readonly messages: ReadonlyArray<DeadLetterMessage>;
}

/**
 * `router-dlq` 消费者：逐条落库 + 日志 + ack。
 *
 * 落库失败也必须 ack（否则 DLQ 会再重试，而我们已无处可放证据）；
 * 只在日志里带上 body 摘要，避免静默丢弃。
 */
export async function handleDeadLetterBatch(
  batch: DeadLetterBatch,
  env: Env,
  nowMs: number = Date.now(),
): Promise<void> {
  for (const msg of batch.messages) {
    const body = describeBody(msg.body);
    try {
      await recordDeadLetter(
        env,
        {
          queue: batch.queue,
          attempts:
            typeof msg.attempts === "number" && Number.isFinite(msg.attempts)
              ? msg.attempts
              : null,
          body,
          error: DEAD_LETTER_ERROR,
        },
        nowMs,
      );
    } catch (error) {
      console.error("dlq: failed to persist dead letter", error);
    }
    console.error(
      `dlq: ${batch.queue} message exhausted retries (attempts=${
        msg.attempts ?? "?"
      }): ${body.slice(0, 500)}`,
    );
    msg.ack();
  }
}

/** body 转字符串：原本就是字符串就照抄，否则 JSON（不可序列化再退 String）。 */
function describeBody(body: unknown): string {
  if (typeof body === "string") return body;
  try {
    const json = JSON.stringify(body);
    if (typeof json === "string") return json;
  } catch {
    // 循环引用等：退回 String()。
  }
  return String(body);
}
