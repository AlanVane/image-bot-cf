/**
 * 任务 1 / D10：多租户配额 —— 每 installation 每 UTC 日的 run 上限（成本护栏）。
 *
 * 动机（oracle P2-7 / DESIGN §8）：无计费层时唯一的多租户成本闸门；在
 * `RepoLock.submit()` 这个"唯一入口漏斗"收口，webhook/手动/巡检三条线全覆盖。
 *
 * 配置：`QUOTA_DAILY_RUNS`（wrangler vars，字符串）；0 / 缺省 = **不限**（D2 无付费墙）。
 * 计数口径：`runs` 表当日（UTC）该 installation 的行数——近似值（init-run 落账有
 * 数秒延迟），配额语义允许边界误差。
 */
import type { Env } from "./types";

export interface QuotaVerdict {
  allowed: boolean;
  /** 当日已用（UTC，含进行中已落账的 run）。 */
  used: number;
  /** 0 = 不限。 */
  limit: number;
}

/** 解析 `QUOTA_DAILY_RUNS`：非正数/缺省/非法 → 0（不限）。 */
export function dailyRunLimit(env: Env): number {
  return parsePositiveIntVar(env.QUOTA_DAILY_RUNS);
}

/**
 * 解析 `QUOTA_PRIVATE_REPOS`：每个 installation 可同时启用的私有仓库数上限。
 * 非正数/缺省/非法 → 0（不限），与 `QUOTA_DAILY_RUNS` 同一解析约定。
 */
export function privateRepoLimit(env: Env): number {
  return parsePositiveIntVar(env.QUOTA_PRIVATE_REPOS);
}

/** 字符串 vars → 正整数；0/缺省/非法/负数 → 0（语义 = 不限）。 */
function parsePositiveIntVar(raw: string | undefined): number {
  const value = Number((raw ?? "").trim());
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** 今天（UTC）的起始时刻，ISO 前缀比较即可。 */
function utcDayStart(): string {
  return `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;
}

/** 是否还允许启动新 run（不限额时短路，不查 D1）。 */
export async function quotaAllowsNewRun(
  env: Env,
  installationId: number,
): Promise<QuotaVerdict> {
  const limit = dailyRunLimit(env);
  if (limit === 0) return { allowed: true, used: 0, limit: 0 };

  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS used FROM runs WHERE installation_id = ? AND created_at >= ?",
  )
    .bind(installationId, utcDayStart())
    .first<{ used: number }>();
  const used = Number(row?.used ?? 0);
  return { allowed: used < limit, used, limit };
}
