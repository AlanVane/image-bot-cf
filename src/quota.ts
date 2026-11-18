/**
 * 任务 1 / D10：多租户配额 —— 每 installation 每 UTC 日的 run 上限（成本护栏）。
 *
 * 动机（oracle P2-7 / DESIGN §8）：无计费层时唯一的多租户成本闸门；在
 * `RepoLock.submit()` 这个"唯一入口漏斗"收口，webhook/手动/巡检三条线全覆盖。
 *
 * 配置：`QUOTA_DAILY_RUNS`（wrangler vars，字符串）；0 / 缺省 = **不限**（D2 无付费墙）。
 * 计数口径：`runs` 表当日（UTC）该 installation 的行数——近似值（init-run 落账有
 * 数秒延迟），配额语义允许边界误差。
 *
 * P4 计费层（D16）：`BILLING_MODE=marketplace` 时，私有仓库上限改由 GitHub
 * Marketplace 计划决定（`marketplace_purchases` + `PLAN_PRIVATE_CAPS`），
 * 其余模式仍是 `QUOTA_PRIVATE_REPOS` 的 self-host 语义。
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

/* -------------------------------------------------------------------------- */
/* P4 计费层：GitHub Marketplace 计划 → 私有仓库上限                            */
/* -------------------------------------------------------------------------- */

/** 私有仓库上限的来源：计划映射 / Marketplace 免费档 / self-host env。 */
export type PrivateCapSource = "plan" | "free" | "env";

export interface EffectivePrivateCap {
  /** 可同时启用的私有仓库数；0 = Marketplace 免费档不允许私有仓库。 */
  limit: number;
  /** 命中的计划名（仅 `source: "plan"` 有值）。 */
  planName: string | null;
  source: PrivateCapSource;
}

/** 计费账户标识：`accountId` 优先，缺失时退回 `login` 匹配。 */
export interface MarketplaceAccountRef {
  accountId: number | null;
  login?: string | null;
}

interface MarketplacePurchaseRow {
  plan_id: number;
  plan_name: string | null;
  state: string | null;
}

/**
 * 计费开关（`BILLING_MODE`）：只有字面 `marketplace` 才启用。
 * 其他值/缺省 = 关闭，私有仓库上限完全走 `QUOTA_PRIVATE_REPOS`（self-host 行为）。
 */
export function isMarketplaceBilling(env: Env): boolean {
  return (env.BILLING_MODE ?? "").trim() === "marketplace";
}

/** `FREE_PRIVATE_CAP`：无有效 Marketplace 计划时的私有仓库上限；缺省 0。 */
export function freePrivateCap(env: Env): number {
  return parsePositiveIntVar(env.FREE_PRIVATE_CAP);
}

/**
 * 解析 `PLAN_PRIVATE_CAPS`：JSON `{"<plan_id>": <cap>}` → `plan_id → cap`。
 *
 * 值允许 0（Open source 档 = 0 个私有仓库）；非法 JSON/条目静默丢弃
 * （计费配置错误不应让配额变成"不限"，未知 plan_id 会落到 FREE_PRIVATE_CAP）。
 */
export function parsePlanPrivateCaps(
  raw: string | undefined,
): Map<string, number> {
  const caps = new Map<string, number>();
  const text = (raw ?? "").trim();
  if (text === "") return caps;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return caps;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return caps;
  }

  for (const [key, value] of Object.entries(
    parsed as Record<string, unknown>,
  )) {
    const planId = key.trim();
    if (planId === "") continue;
    const cap =
      typeof value === "number"
        ? value
        : typeof value === "string"
          ? Number(value.trim())
          : Number.NaN;
    if (!Number.isFinite(cap) || cap < 0) continue;
    caps.set(planId, Math.floor(cap));
  }
  return caps;
}

/**
 * 生效的私有仓库上限（D16）。
 *
 * - 计费关闭 → `QUOTA_PRIVATE_REPOS`（`source: "env"`，0 = 不限，保持旧语义）；
 * - 计费开启 → `marketplace_purchases` 里该账户的 **active** 计划映射到
 *   `PLAN_PRIVATE_CAPS`；没有行 / 已取消 / plan_id 未映射 → `FREE_PRIVATE_CAP`。
 *
 * 账户解析：先按 `accountId`（GitHub account id）精确查，缺失时按 `login` 兜底
 * （webhook 落库与 run 期只知道 login 的场景）。
 */
export async function effectivePrivateCap(
  env: Env,
  account: MarketplaceAccountRef,
): Promise<EffectivePrivateCap> {
  if (!isMarketplaceBilling(env)) {
    return { limit: privateRepoLimit(env), planName: null, source: "env" };
  }

  const free: EffectivePrivateCap = {
    limit: freePrivateCap(env),
    planName: null,
    source: "free",
  };

  const row = await findMarketplacePurchase(env, account);
  if (!row || row.state !== "active") return free;

  const cap = parsePlanPrivateCaps(env.PLAN_PRIVATE_CAPS).get(
    String(row.plan_id),
  );
  if (cap === undefined) return free;

  return { limit: cap, planName: row.plan_name ?? null, source: "plan" };
}

async function findMarketplacePurchase(
  env: Env,
  account: MarketplaceAccountRef,
): Promise<MarketplacePurchaseRow | null> {
  const accountId = account.accountId;
  if (accountId !== null && accountId !== undefined) {
    return env.DB.prepare(
      "SELECT plan_id, plan_name, state FROM marketplace_purchases WHERE account_id = ?",
    )
      .bind(accountId)
      .first<MarketplacePurchaseRow>();
  }

  const login = (account.login ?? "").trim();
  if (login === "") return null;
  return env.DB.prepare(
    "SELECT plan_id, plan_name, state FROM marketplace_purchases WHERE account_login = ?",
  )
    .bind(login)
    .first<MarketplacePurchaseRow>();
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
