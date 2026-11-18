/**
 * D16 运行期私有配额闸门（`src/workflow/private-quota.ts`，load-config 调用）。
 *
 * 覆盖 load-config 的判定路径：计费关闭不查库、公共仓库不查库、
 * 已启用私有仓库数 vs 计划上限、免费档（无购买行 / 已取消）cap = 0。
 */
import { describe, expect, it } from "vitest";

import { checkPrivateQuota } from "../src/workflow/private-quota";
import type { Env } from "../src/types";

interface FakeOptions {
  /** `repos` 聚合计数（`COALESCE(enabled, 1) != 0` 之后）。 */
  count?: number;
  /** `installations.account_login`。 */
  login?: string | null;
  /** marketplace_purchases 行（null = 无购买记录）。 */
  purchase?: {
    plan_id: number;
    plan_name: string | null;
    state: string;
  } | null;
  billing?: string;
  caps?: string;
  free?: string;
}

/** 最小 D1 fake：按 SQL 形态回答三条查询，并记录全部 SQL。 */
function fakeEnv(options: FakeOptions = {}): { env: Env; queries: string[] } {
  const queries: string[] = [];
  const env = {
    BILLING_MODE: options.billing,
    PLAN_PRIVATE_CAPS: options.caps,
    FREE_PRIVATE_CAP: options.free,
    DB: {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            queries.push(`${sql} | ${args.join(",")}`);
            return {
              async first() {
                const norm = sql.replace(/\s+/g, " ").trim();
                if (norm.startsWith("SELECT COUNT(*) AS count FROM repos")) {
                  return { count: options.count ?? 0 };
                }
                if (
                  norm.startsWith("SELECT account_login FROM installations")
                ) {
                  return { account_login: options.login ?? null };
                }
                if (
                  norm.startsWith(
                    "SELECT plan_id, plan_name, state FROM marketplace_purchases",
                  )
                ) {
                  return options.purchase ?? null;
                }
                throw new Error(`unexpected query: ${norm}`);
              },
            };
          },
        };
      },
    },
  } as unknown as Env;
  return { env, queries };
}

describe("checkPrivateQuota（D16 load-config 闸门）", () => {
  it("计费关闭 → 不跳过、不查 D1（self-host 行为不变）", async () => {
    const { env, queries } = fakeEnv({
      billing: "off",
      count: 99,
      login: "acme",
    });
    await expect(checkPrivateQuota(env, 42, true)).resolves.toEqual({
      skip: false,
      count: 0,
      cap: 0,
    });
    expect(queries).toHaveLength(0);
  });

  it("公共仓库 / 可见性未知 → 不查配额", async () => {
    const publicRepo = fakeEnv({ billing: "marketplace", count: 99 });
    await expect(checkPrivateQuota(publicRepo.env, 42, false)).resolves.toEqual(
      { skip: false, count: 0, cap: 0 },
    );
    expect(publicRepo.queries).toHaveLength(0);

    const unknown = fakeEnv({ billing: "marketplace", count: 99 });
    await expect(
      checkPrivateQuota(unknown.env, 42, undefined),
    ).resolves.toEqual({ skip: false, count: 0, cap: 0 });
    expect(unknown.queries).toHaveLength(0);
  });

  it("私有仓库超过计划上限 → skip（count 口径含目标仓库自身）", async () => {
    const { env, queries } = fakeEnv({
      billing: "marketplace",
      caps: '{"1001":3}',
      count: 4,
      login: "acme",
      purchase: { plan_id: 1001, plan_name: "Agency", state: "active" },
    });

    await expect(checkPrivateQuota(env, 42, true)).resolves.toEqual({
      skip: true,
      count: 4,
      cap: 3,
    });

    expect(queries[0]).toContain("FROM repos");
    expect(queries[0]).toContain("is_private = 1");
    expect(queries[0]).toContain("COALESCE(enabled, 1) != 0");
    // run 期没有 account id → 用 installations.account_login 兜底查购买行
    expect(queries.at(-1)).toContain("WHERE account_login = ?");
    expect(queries.at(-1)).toContain("acme");
  });

  it("正好等于计划上限 → 不跳过", async () => {
    const { env } = fakeEnv({
      billing: "marketplace",
      caps: '{"1001":3}',
      count: 3,
      login: "acme",
      purchase: { plan_id: 1001, plan_name: "Agency", state: "active" },
    });
    await expect(checkPrivateQuota(env, 42, true)).resolves.toMatchObject({
      skip: false,
      count: 3,
      cap: 3,
    });
  });

  it("无购买行 / 已取消 → 免费档 cap（缺省 0）→ 私有仓库一律超限", async () => {
    const none = fakeEnv({ billing: "marketplace", count: 1, login: "acme" });
    await expect(checkPrivateQuota(none.env, 42, true)).resolves.toEqual({
      skip: true,
      count: 1,
      cap: 0,
    });

    const cancelled = fakeEnv({
      billing: "marketplace",
      caps: '{"1001":3}',
      count: 1,
      login: "acme",
      purchase: { plan_id: 1001, plan_name: "Agency", state: "cancelled" },
    });
    await expect(checkPrivateQuota(cancelled.env, 42, true)).resolves.toEqual({
      skip: true,
      count: 1,
      cap: 0,
    });
  });
});
