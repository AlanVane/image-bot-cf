/**
 * D10 多租户配额（每 installation 每 UTC 日 run 上限）。
 * 契约：0/缺省/非法 = 不限（且不查 D1）；计数按 UTC 日；used < limit 放行。
 */
import { describe, expect, it } from "vitest";

import { dailyRunLimit, quotaAllowsNewRun } from "../src/quota";
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
