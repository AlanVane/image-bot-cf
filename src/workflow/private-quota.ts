/**
 * D16 运行期私有配额闸门（load-config 调用）。
 *
 * 与 `logic.ts` 的分工：判定本身（`shouldSkipPrivateQuota`）是纯函数；这里只负责
 * D1 读取（该 installation 已启用的私有仓库数 + 账户的生效计划上限）。
 *
 * 语义：**只在计费开启（`BILLING_MODE=marketplace`）时生效**；self-host 的
 * `QUOTA_PRIVATE_REPOS` 仍只在仪表盘启用时刻做闸门（不拦 run，保持旧行为）。
 */
import { effectivePrivateCap, isMarketplaceBilling } from "../quota";
import type { Env } from "../types";
import { shouldSkipPrivateQuota } from "./logic";

export interface PrivateQuotaGate {
  /** true = 本轮应直接收尾（`skipped_disabled` + `private_quota_exceeded`）。 */
  skip: boolean;
  /** 该 installation 已启用（`COALESCE(enabled, 1) != 0`）的私有仓库数。 */
  count: number;
  /** 生效上限（计费关闭/公共仓库时为 0，仅作诊断）。 */
  cap: number;
}

/**
 * 计数口径：`repos.installation_id = ? AND is_private = 1 AND enabled != 0`。
 * 目标仓库自身也算（它即将/已经启用），所以 cap = 3 时第 4 个私有仓库开始超限。
 * 账户计划解析：`installations.account_login` 兜底（run 期没有 account id）。
 */
export async function checkPrivateQuota(
  env: Env,
  installationId: number,
  isPrivate: boolean | undefined,
): Promise<PrivateQuotaGate> {
  const billingOn = isMarketplaceBilling(env);
  if (isPrivate !== true || !billingOn) {
    return { skip: false, count: 0, cap: 0 };
  }

  const counted = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM repos " +
      "WHERE installation_id = ? AND is_private = 1 " +
      "AND COALESCE(enabled, 1) != 0",
  )
    .bind(installationId)
    .first<{ count: number | null }>();
  const count = Number(counted?.count ?? 0);

  const installation = await env.DB.prepare(
    "SELECT account_login FROM installations WHERE installation_id = ?",
  )
    .bind(installationId)
    .first<{ account_login: string | null }>();

  const cap = await effectivePrivateCap(env, {
    accountId: null,
    login: installation?.account_login ?? null,
  });

  return {
    skip: shouldSkipPrivateQuota(true, billingOn, count, cap.limit),
    count,
    cap: cap.limit,
  };
}
