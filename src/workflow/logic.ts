/**
 * Workflow 纯函数（DESIGN.md §5.3 / §2.3 / §2.2）。
 *
 * 这里只放**无副作用、可单测**的编排辅助逻辑：分块、阈值门、repo 拆分、
 * KB 换算、PR 统计组装。任何 I/O（D1 / R2 / GitHub）都留在 optimize-run.ts。
 */

import type { ImageStat } from "../types";
import { formatN2, formatPercent } from "../ux/templates";

/** §5.3：`optimize-batch-{chunk}` 的块大小上限（同时受 80/min 内容写入限速约束，§4.2）。 */
export const BATCH_SIZE = 10;

/** §2.2 PR 明细表总计行的名字（原版 `*Total` 解析后 `name` = `Total`）。 */
export const TOTAL_STAT_NAME = "Total";

/**
 * 按固定大小分块（保持原顺序；最后一块可短）。
 *
 * 用于把 scan-tree 的候选清单切成 `optimize-batch-0..n`，块大小 ≤10 图
 * （§5.3：每块 ≤10 次 blob 写入，规避 80/min 次级限速）。
 */
export function chunk<T>(
  entries: readonly T[],
  size: number = BATCH_SIZE,
): T[][] {
  if (!Number.isInteger(size) || size < 1) {
    throw new RangeError(`chunk size must be a positive integer, got ${size}`);
  }
  const out: T[][] = [];
  for (let i = 0; i < entries.length; i += size) {
    out.push(entries.slice(i, i + size));
  }
  return out;
}

/**
 * §2.1 / §2.3 阈值门：总节省 ≥ `minKBReduced` 才开 PR；`minKBReduced <= 0` 表示无阈值。
 *
 * 语义照抄原版 `Threshold.cs`（`<=0` 恒过），NaN 同样按"无阈值"处理，
 * 与 `parseImgbotConfig`（只接受有限数）保持一致。
 */
export function thresholdGate(
  minKBReduced: number,
  totalKbSaved: number,
): boolean {
  if (!(minKBReduced > 0)) return true;
  return totalKbSaved >= minKBReduced;
}

/**
 * `owner/name` → `{ owner, repo }`。
 *
 * 仓库全名固定两段：缺斜杠、空段或多段都视为描述符损坏（抛出，让 run 记 failed）。
 */
export function splitOwnerRepo(repo: string): { owner: string; repo: string } {
  const trimmed = repo.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) {
    throw new Error(
      `invalid repo full name (expected "owner/name"): ${JSON.stringify(repo)}`,
    );
  }
  const owner = trimmed.slice(0, slash);
  const name = trimmed.slice(slash + 1);
  if (name.includes("/")) {
    throw new Error(
      `invalid repo full name (expected "owner/name"): ${JSON.stringify(repo)}`,
    );
  }
  return { owner, repo: name };
}

/** §2.2：单位是 **KB = bytes / 1024 的 double**（不是 1000，也不是整数）。 */
export function bytesToKb(bytes: number): number {
  return bytes / 1024;
}

/** 参与统计的已优化图片（`optimize-batch-{i}` 的产出，Workflow 步间传递）。 */
export interface OptimizedImage {
  path: string;
  /** 源 blob sha（image_cache 主键的一部分；commit 成功后回填缓存用）。 */
  sourceSha: string;
  /** 优化结果内容指纹（sha256-hex；commit 成功后以真实 blob sha 覆盖入缓存）。 */
  resultHash: string;
  beforeBytes: number;
  afterBytes: number;
  beforeKb: number;
  afterKb: number;
}

/** `buildImageStats` 的最小输入（只要路径与 KB 尺寸）。 */
export type ImageStatInput = Pick<
  OptimizedImage,
  "path" | "beforeKb" | "afterKb"
>;

/**
 * 组装 `createPrBody` 需要的 `ImageStat[]`（§2.2）。
 *
 * 约定（与原版 `Stats.ParseStats` 对 commit message 的回读结果**逐字等价**）：
 * - 单图：只返回该图一行，**没有** Total 行（模板同样走单图特例）
 * - 多图：`[0]` 是 `*Total` 汇总，`[1..]` 是逐图行
 * - `before` / `after` 保留 `kb` 后缀且用 `N2` 格式化（千分位），如 `1,234.56kb`
 * - `percent` 与原版一致，取 `0.##` 格式化后的数值（再交给模板 `formatN2`）
 */
export function buildImageStats(
  results: readonly ImageStatInput[],
): ImageStat[] {
  const toPercent = (beforeKb: number, afterKb: number): number => {
    if (!(beforeKb > 0)) return 0;
    return Number(formatPercent((1 - afterKb / beforeKb) * 100));
  };
  const toStat = (
    name: string,
    beforeKb: number,
    afterKb: number,
  ): ImageStat => ({
    name,
    before: `${formatN2(beforeKb)}kb`,
    after: `${formatN2(afterKb)}kb`,
    percent: toPercent(beforeKb, afterKb),
  });

  if (results.length === 0) return [];
  if (results.length === 1) {
    const only = results[0];
    return [toStat(only.path, only.beforeKb, only.afterKb)];
  }

  let totalBefore = 0;
  let totalAfter = 0;
  for (const result of results) {
    totalBefore += result.beforeKb;
    totalAfter += result.afterKb;
  }

  return [
    toStat(TOTAL_STAT_NAME, totalBefore, totalAfter),
    ...results.map((result) =>
      toStat(result.path, result.beforeKb, result.afterKb),
    ),
  ];
}

/** 汇总已优化图片的字节数（D1 `bytes_before` / `bytes_after`）。 */
export function sumSizes(
  results: readonly Pick<OptimizedImage, "beforeBytes" | "afterBytes">[],
): { beforeBytes: number; afterBytes: number; savedKb: number } {
  let beforeBytes = 0;
  let afterBytes = 0;
  for (const result of results) {
    beforeBytes += result.beforeBytes;
    afterBytes += result.afterBytes;
  }
  return {
    beforeBytes,
    afterBytes,
    savedKb: bytesToKb(beforeBytes - afterBytes),
  };
}

/** 优化结果的内容指纹（§7.3 result_hash 语义）。 */
/**
 * 暂存分支名按 run 唯一（P1 修复）：D5 的"commit 先落暂存分支、再一次性 force 落
 * imgbot"若共享 ref，并发 run（锁租约到期等极端情形）会互踩重建。格式：
 * `heads/imgbot-staging-<runId>`，commit 步用完即删。
 */
export function stagingRefForRun(runId: string): string {
  return `heads/imgbot-staging-${runId}`;
}

/**
 * P1（TOCTOU）人类改动守卫的落地前复核：守卫时刻的 tip 快照与 force 落地前
 * 实测不一致（含分支出现/消失）→ 视为人类改动，中止而不覆盖。
 */
export function tipViolatesGuard(
  guardTipSha: string | null,
  currentTipSha: string | null,
): boolean {
  return guardTipSha !== currentTipSha;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** §2.2 模板消息 → GraphQL message 字段（headline + body）；重组后与原文一致。 */
export function splitCommitMessage(message: string): {
  headline: string;
  body: string;
} {
  const idx = message.indexOf("\n");
  if (idx < 0) return { headline: message, body: "" };
  return {
    headline: message.slice(0, idx),
    body: message.slice(idx + 1).replace(/^\n+|\n+$/g, ""),
  };
}
