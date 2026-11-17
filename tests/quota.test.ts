/**
 * D10 多租户配额（每 installation 每 UTC 日 run 上限）。
 * 契约：0/缺省/非法 = 不限（且不查 D1）；计数按 UTC 日；used < limit 放行。
 */
import { describe, expect, it } from "vitest";

import {
  dailyRunLimit,
  effectivePrivateCap,
  freePrivateCap,
  isMarketplaceBilling,
  parsePlanPrivateCaps,
  privateRepoLimit,
  quotaAllowsNewRun,
} from "../src/quota";
import type { Env } from "../src/types";

function fakeEnv(
  quota: string | undefined,
  count: number,
): { env: Env; queries: string[] } {
  const queries: string[] = [];
  const env = {
    QUOTA_DAILY_RUNS: quota,
    DB: {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            queries.push(`${sql} | ${args.join(",")}`);
            return {
              async first() {
                return { used: count };
              },
            };
          },
        };
      },
    },
  } as unknown as Env;
  return { env, queries };
}

describe("dailyRunLimit 解析", () => {
  it("0 / 缺省 / 非法 / 负数 → 0（不限）", () => {
    expect(dailyRunLimit({} as Env)).toBe(0);
    expect(dailyRunLimit({ QUOTA_DAILY_RUNS: "" } as Env)).toBe(0);
    expect(dailyRunLimit({ QUOTA_DAILY_RUNS: "0" } as Env)).toBe(0);
    expect(dailyRunLimit({ QUOTA_DAILY_RUNS: "abc" } as Env)).toBe(0);
    expect(dailyRunLimit({ QUOTA_DAILY_RUNS: "-3" } as Env)).toBe(0);
  });

  it("正数取整（字符串 vars）", () => {
    expect(dailyRunLimit({ QUOTA_DAILY_RUNS: "25" } as Env)).toBe(25);
    expect(dailyRunLimit({ QUOTA_DAILY_RUNS: " 7.9 " } as Env)).toBe(7);
  });
});

describe("privateRepoLimit 解析（与 dailyRunLimit 共用解析约定）", () => {
  it("0 / 缺省 / 非法 / 负数 → 0（不限）", () => {
    expect(privateRepoLimit({} as Env)).toBe(0);
    expect(privateRepoLimit({ QUOTA_PRIVATE_REPOS: "" } as Env)).toBe(0);
    expect(privateRepoLimit({ QUOTA_PRIVATE_REPOS: "0" } as Env)).toBe(0);
    expect(privateRepoLimit({ QUOTA_PRIVATE_REPOS: "abc" } as Env)).toBe(0);
    expect(privateRepoLimit({ QUOTA_PRIVATE_REPOS: "-2" } as Env)).toBe(0);
  });

  it("正数取整（字符串 vars），与 QUOTA_DAILY_RUNS 互不影响", () => {
    expect(privateRepoLimit({ QUOTA_PRIVATE_REPOS: "3" } as Env)).toBe(3);
    expect(privateRepoLimit({ QUOTA_PRIVATE_REPOS: " 2.9 " } as Env)).toBe(2);
    expect(
      privateRepoLimit({
        QUOTA_DAILY_RUNS: "50",
        QUOTA_PRIVATE_REPOS: "4",
      } as Env),
    ).toBe(4);
    expect(privateRepoLimit({ QUOTA_DAILY_RUNS: "50" } as Env)).toBe(0);
  });
});

describe("quotaAllowsNewRun", () => {
  it("不限额 → 直接放行且不查 D1", async () => {
    const { env, queries } = fakeEnv("0", 999);
    const verdict = await quotaAllowsNewRun(env, 42);
    expect(verdict).toEqual({ allowed: true, used: 0, limit: 0 });
    expect(queries).toHaveLength(0);
  });

  it("used < limit → 放行；used >= limit → 拦截（计数按 UTC 日）", async () => {
    const under = await quotaAllowsNewRun(fakeEnv("3", 2).env, 42);
    expect(under).toMatchObject({ allowed: true, used: 2, limit: 3 });

    const at = await quotaAllowsNewRun(fakeEnv("3", 3).env, 42);
    expect(at).toMatchObject({ allowed: false, used: 3, limit: 3 });

    const over = await quotaAllowsNewRun(fakeEnv("3", 10).env, 42);
    expect(over.allowed).toBe(false);
  });

  it("查询按 installation 隔离 + UTC 日界", async () => {
    const { env, queries } = fakeEnv("5", 1);
    await quotaAllowsNewRun(env, 99);
    expect(queries[0]).toContain("installation_id = ?");
    expect(queries[0]).toContain("99");
    expect(queries[0]).toMatch(/T00:00:00\.000Z/);
  });
});

/* -------------------------------------------------------------------------- */
/* P4 计费层：Marketplace 计划 → 私有仓库上限                                   */
/* -------------------------------------------------------------------------- */

interface PurchaseRow {
  plan_id: number;
  plan_name: string | null;
  state: string;
}

/** marketplace_purchases 读查询的最小 fake（记录 SQL + 绑定参数）。 */
function billingEnv(options: {
  row?: PurchaseRow | null;
  billing?: string;
  caps?: string;
  free?: string;
  quotaPrivateRepos?: string;
}): { env: Env; queries: Array<{ sql: string; args: unknown[] }> } {
  const queries: Array<{ sql: string; args: unknown[] }> = [];
  const env = {
    BILLING_MODE: options.billing,
    PLAN_PRIVATE_CAPS: options.caps,
    FREE_PRIVATE_CAP: options.free,
    QUOTA_PRIVATE_REPOS: options.quotaPrivateRepos,
    DB: {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return {
              async first() {
                queries.push({ sql, args });
                return options.row ?? null;
              },
            };
          },
        };
      },
    },
  } as unknown as Env;
  return { env, queries };
}

describe("parsePlanPrivateCaps / freePrivateCap", () => {
  it("JSON 计划映射：数字与字符串值、0 保留、非法条目丢弃", () => {
    const caps = parsePlanPrivateCaps(
      '{"123456":3,"123457":"10","123458":0,"bad":-1,"x":"abc"}',
    );
    expect(caps.get("123456")).toBe(3);
    expect(caps.get("123457")).toBe(10);
    expect(caps.get("123458")).toBe(0);
    expect(caps.has("bad")).toBe(false);
    expect(caps.has("x")).toBe(false);
  });

  it("缺省/非法 JSON/数组 → 空映射", () => {
    expect(parsePlanPrivateCaps(undefined).size).toBe(0);
    expect(parsePlanPrivateCaps("").size).toBe(0);
    expect(parsePlanPrivateCaps("not json").size).toBe(0);
    expect(parsePlanPrivateCaps("[1,2]").size).toBe(0);
  });

  it("FREE_PRIVATE_CAP 缺省 0（免费档不允许私有仓库）", () => {
    expect(freePrivateCap({} as Env)).toBe(0);
    expect(freePrivateCap({ FREE_PRIVATE_CAP: "2" } as Env)).toBe(2);
  });

  it("BILLING_MODE 只有字面 marketplace 才启用", () => {
    expect(isMarketplaceBilling({ BILLING_MODE: "marketplace" } as Env)).toBe(
      true,
    );
    expect(isMarketplaceBilling({ BILLING_MODE: "off" } as Env)).toBe(false);
    expect(isMarketplaceBilling({} as Env)).toBe(false);
  });
});

describe("effectivePrivateCap", () => {
  it("计费关闭 → env 上限（0 = 不限），且不查 D1", async () => {
    const { env, queries } = billingEnv({ quotaPrivateRepos: "5" });
    await expect(
      effectivePrivateCap(env, { accountId: 1, login: "acme" }),
    ).resolves.toEqual({ limit: 5, planName: null, source: "env" });
    expect(queries).toHaveLength(0);

    const off = billingEnv({ billing: "off", row: null });
    await expect(
      effectivePrivateCap(off.env, { accountId: 1 }),
    ).resolves.toEqual({ limit: 0, planName: null, source: "env" });
  });

  it("marketplace + active 计划 → 映射上限 + 计划名", async () => {
    const { env, queries } = billingEnv({
      billing: "marketplace",
      caps: '{"123456":3,"123457":10}',
      row: { plan_id: 123456, plan_name: "Agency", state: "active" },
    });
    await expect(
      effectivePrivateCap(env, { accountId: 9001 }),
    ).resolves.toEqual({ limit: 3, planName: "Agency", source: "plan" });
    expect(queries[0].sql).toContain("WHERE account_id = ?");
    expect(queries[0].args).toEqual([9001]);
  });

  it("已取消 → 免费档（FREE_PRIVATE_CAP）", async () => {
    const { env } = billingEnv({
      billing: "marketplace",
      caps: '{"123456":3}',
      row: { plan_id: 123456, plan_name: "Agency", state: "cancelled" },
    });
    await expect(
      effectivePrivateCap(env, { accountId: 9001 }),
    ).resolves.toEqual({ limit: 0, planName: null, source: "free" });

    const paidFree = billingEnv({
      billing: "marketplace",
      caps: '{"123456":3}',
      free: "1",
      row: { plan_id: 123456, plan_name: "Agency", state: "cancelled" },
    });
    await expect(
      effectivePrivateCap(paidFree.env, { accountId: 9001 }),
    ).resolves.toEqual({ limit: 1, planName: null, source: "free" });
  });

  it("未知 plan_id / 无购买行 → 免费档（缺省 0）", async () => {
    const unknown = billingEnv({
      billing: "marketplace",
      caps: '{"123456":3}',
      row: { plan_id: 999999, plan_name: "Mystery", state: "active" },
    });
    await expect(
      effectivePrivateCap(unknown.env, { accountId: 9001 }),
    ).resolves.toEqual({ limit: 0, planName: null, source: "free" });

    const none = billingEnv({ billing: "marketplace", row: null });
    await expect(
      effectivePrivateCap(none.env, { accountId: 9001 }),
    ).resolves.toEqual({ limit: 0, planName: null, source: "free" });
  });

  it("accountId 缺失 → 按 account_login 兜底查询", async () => {
    const { env, queries } = billingEnv({
      billing: "marketplace",
      caps: '{"123456":3}',
      row: { plan_id: 123456, plan_name: "Agency", state: "active" },
    });
    await expect(
      effectivePrivateCap(env, { accountId: null, login: "acme" }),
    ).resolves.toMatchObject({ limit: 3, source: "plan" });
    expect(queries[0].sql).toContain("WHERE account_login = ?");
    expect(queries[0].args).toEqual(["acme"]);
  });

  it("accountId 与 login 都缺失 → 免费档，不查 D1", async () => {
    const { env, queries } = billingEnv({ billing: "marketplace" });
    await expect(
      effectivePrivateCap(env, { accountId: null, login: null }),
    ).resolves.toEqual({ limit: 0, planName: null, source: "free" });
    expect(queries).toHaveLength(0);
  });
});
