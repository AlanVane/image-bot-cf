/**
 * Workflow 纯函数（DESIGN.md §5.3 / §2.3 / §2.2）。
 *
 * 这里只放**无副作用、可单测**的编排辅助逻辑：分块、阈值门、repo 拆分、
 * KB 换算、PR 统计组装。任何 I/O（D1 / R2 / GitHub）都留在 optimize-run.ts。
 */

import type { ImageStat } from "../types";
import { MAX_CONTAINER_INPUT_BYTES } from "../container/limits";
import { formatN2, formatPercent } from "../ux/templates";

/** §5.3：`optimize-batch-{chunk}` 的块大小上限（同时受 80/min 内容写入限速约束，§4.2）。 */
export const BATCH_SIZE = 10;

/**
 * PR 负载预算（§4.3）：单 PR 的图片数上限。
 *
 * `createCommitOnBranch` 的 additions 在 GraphQL 里一次提交，超过这个量级后
 * 请求体/解析都进入危险区（实测良好区间），宁可显式失败也不静默 OOM。
 */
export const MAX_PR_IMAGES = 500;

/**
 * PR 负载预算（§4.3）：单 PR 的**原始文件字节**上限（additions 含重放）。
 *
 * 口径 = 待提交文件的字节数（不是 base64 长度），与实测可用的 GraphQL envelope 对齐。
 */
export const MAX_PR_TOTAL_BYTES = 10 * 1024 * 1024;

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

/**
 * 超大图兜底闸门（§6.3）：字节数 ≤40MB 才值得送容器。
 *
 * dispatch 的 15MB 守卫只说明"WASM 跑不动"，不代表"容器能跑"：40MB 是容器侧的硬上限
 * （`container/server.mjs` 的请求体上限与解码上限）。超过就直接按 `too_large` 跳过，
 * 免得白付一次 base64 膨胀 + 容器内存峰值。
 */
export function withinContainerInputCap(
  byteSize: number,
  maxBytes: number = MAX_CONTAINER_INPUT_BYTES,
): boolean {
  return byteSize <= maxBytes;
}

/**
 * PR 负载预算（§4.3）：图片数与原始字节同时 ≤ 上限才算通过（边界值算通过）。
 *
 * 在**读取任何 staged blob 之前**预检，超限就让 run 显式失败——巨型 payload 一旦开始
 * 组装，OOM 会在 step 里炸掉，既不可重试也看不到原因。
 */
export function withinPrBudget(
  imageCount: number,
  totalBytes: number,
  maxCount: number = MAX_PR_IMAGES,
  maxBytes: number = MAX_PR_TOTAL_BYTES,
): boolean {
  return imageCount <= maxCount && totalBytes <= maxBytes;
}

/**
 * 重放丢失的静默回滚闸门（P1 架构评审发现）。
 *
 * 提交步从旧 `imgbot` tip 的树里取重放产物；该树被 GitHub 截断（§9-R10，`treeTruncated`）
 * 时，找不到 `oldSha` 的重放会被丢弃，而 base 里是原图 → PR 里这些文件会静默退回未优化版本。
 * 截断树对同一 base 快照是确定性的（重试无用），所以必须显式中止。
 *
 * 非截断树下的缺失只是陈旧缓存行，交给后续轮自愈（不中止）。
 */
export function shouldAbortForTruncatedReplays(
  treeTruncated: boolean,
  droppedReplays: number,
): boolean {
  return treeTruncated && droppedReplays > 0;
}

/**
 * 仪表盘开关的运行时语义（§10）：`repos.enabled = 0` 的仓库本轮直接收尾。
 * 缺行（`null`/`undefined`）= 默认启用，保持原有行为；只有显式 0 才跳过。
 */
export function shouldSkipDisabled(
  enabled: number | null | undefined,
): boolean {
  return enabled === 0;
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
