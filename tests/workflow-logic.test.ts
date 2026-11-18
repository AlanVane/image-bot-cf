/**
 * `src/workflow/logic.ts` 纯函数向量（DESIGN.md §5.3 / §2.3 / §2.2）。
 *
 * 只测无副作用逻辑：分块边界、阈值门、repo 拆分、KB 换算、PR 统计组装。
 * 编排/DO 的 I/O 路径不在本文件（需 workerd harness，P2）。
 */
import { describe, expect, it } from "vitest";

import {
  BATCH_SIZE,
  MAX_PR_IMAGES,
  MAX_PR_TOTAL_BYTES,
  buildImageStats,
  bytesToKb,
  chunk,
  shouldAbortForTruncatedReplays,
  shouldSkipDisabled,
  shouldSkipPrivateQuota,
  splitOwnerRepo,
  stagingRefForRun,
  sumSizes,
  thresholdGate,
  tipViolatesGuard,
  withinContainerInputCap,
  withinPrBudget,
  TOTAL_STAT_NAME,
} from "../src/workflow/logic";
import { createPrBody } from "../src/ux/templates";

describe("chunk（§5.3 每块 ≤10 图）", () => {
  it("空输入得到空清单", () => {
    expect(chunk([])).toEqual([]);
    expect(chunk([], 3)).toEqual([]);
  });

  it("不足一块、恰好一块、跨块边界", () => {
    expect(chunk([1, 2, 3])).toEqual([[1, 2, 3]]);
    expect(chunk(Array.from({ length: 10 }, (_, i) => i))).toHaveLength(1);
    expect(chunk(Array.from({ length: 11 }, (_, i) => i))).toEqual([
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
      [10],
    ]);
  });

  it("默认块大小是 10（= BATCH_SIZE）", () => {
    const entries = Array.from({ length: 25 }, (_, i) => i);
    const chunks = chunk(entries);
    expect(BATCH_SIZE).toBe(10);
    expect(chunks.map((c) => c.length)).toEqual([10, 10, 5]);
  });

  it("保持原顺序且不重复", () => {
    const entries = ["a", "b", "c", "d", "e"];
    expect(chunk(entries, 2)).toEqual([["a", "b"], ["c", "d"], ["e"]]);
    expect(chunk(entries, 2).flat()).toEqual(entries);
  });

  it("接受任意正块大小，拒绝非法块大小", () => {
    expect(chunk([1, 2, 3, 4], 1)).toEqual([[1], [2], [3], [4]]);
    expect(chunk([1, 2, 3, 4], 4)).toEqual([[1, 2, 3, 4]]);
    expect(chunk([1, 2, 3, 4], 9)).toEqual([[1, 2, 3, 4]]);
    expect(() => chunk([1], 0)).toThrow(RangeError);
    expect(() => chunk([1], -1)).toThrow(RangeError);
    expect(() => chunk([1], 1.5)).toThrow(RangeError);
  });
});

describe("thresholdGate（§2.3 minKBReduced）", () => {
  it("≤0 恒过（无阈值），包括负值与 0 节省", () => {
    expect(thresholdGate(0, 0)).toBe(true);
    expect(thresholdGate(0, -50)).toBe(true);
    expect(thresholdGate(-1, -1e9)).toBe(true);
    expect(thresholdGate(-10, 0)).toBe(true);
  });

  it("默认 10KB：不足不过，恰好等于即过", () => {
    expect(thresholdGate(10, 9.99)).toBe(false);
    expect(thresholdGate(10, 10)).toBe(true);
    expect(thresholdGate(10, 10.01)).toBe(true);
    expect(thresholdGate(10, 0)).toBe(false);
  });

  it("负节省（不可能开 PR）不通过正阈值", () => {
    expect(thresholdGate(10, -3)).toBe(false);
    expect(thresholdGate(1, -0.0001)).toBe(false);
  });

  it("NaN 阈值按无阈值处理（与 config 解析只接受有限数一致）", () => {
    expect(thresholdGate(Number.NaN, 0)).toBe(true);
  });
});

describe("splitOwnerRepo（RunDescriptor.repo）", () => {
  it("拆出 owner / repo", () => {
    expect(splitOwnerRepo("imgbot/Imgbot")).toEqual({
      owner: "imgbot",
      repo: "Imgbot",
    });
    expect(splitOwnerRepo("  owner/name.png  ")).toEqual({
      owner: "owner",
      repo: "name.png",
    });
  });

  it("缺斜杠 / 空段 / 多段都视为描述符损坏", () => {
    for (const bad of ["", "owner", "owner/", "/name", "a/b/c", "  "]) {
      expect(() => splitOwnerRepo(bad)).toThrow();
    }
  });
});

describe("bytesToKb（§2.2 单位 = bytes/1024）", () => {
  it("按 1024 换算（double，不取整）", () => {
    expect(bytesToKb(0)).toBe(0);
    expect(bytesToKb(1024)).toBe(1);
    expect(bytesToKb(1536)).toBe(1.5);
    expect(bytesToKb(1023)).toBe(1023 / 1024);
    expect(bytesToKb(1024 * 1024)).toBe(1024);
  });
});

describe("buildImageStats（§2.2 PR 明细，`[0]` = Total 约定）", () => {
  it("无统计返回空数组", () => {
    expect(buildImageStats([])).toEqual([]);
  });

  it("单图：只有一行、无 Total（模板走单图特例）", () => {
    const stats = buildImageStats([
      { path: "img/logo.png", beforeKb: 234.56, afterKb: 123.45 },
    ]);

    expect(stats).toHaveLength(1);
    expect(stats[0]).toEqual({
      name: "img/logo.png",
      before: "234.56kb",
      after: "123.45kb",
      percent: 47.37,
    });
    expect(stats[0].name).not.toBe(TOTAL_STAT_NAME);
  });

  it("多图：`[0]` 是 Total 汇总，其后逐图，尺寸用 N2（千分位）", () => {
    const stats = buildImageStats([
      { path: "img/logo.png", beforeKb: 234.56, afterKb: 123.45 },
      { path: "docs/shot.jpg", beforeKb: 1000, afterKb: 864.2 },
    ]);

    expect(stats).toHaveLength(3);
    expect(stats[0]).toEqual({
      name: TOTAL_STAT_NAME,
      before: "1,234.56kb",
      after: "987.65kb",
      percent: 20,
    });
    expect(stats[1]).toEqual({
      name: "img/logo.png",
      before: "234.56kb",
      after: "123.45kb",
      percent: 47.37,
    });
    expect(stats[2]).toEqual({
      name: "docs/shot.jpg",
      before: "1,000.00kb",
      after: "864.20kb",
      percent: 13.58,
    });
  });

  it("percent 与原版 0.## 截断一致（最多两位小数、去尾零）", () => {
    const stats = buildImageStats([
      { path: "a.png", beforeKb: 100, afterKb: 90 },
      { path: "b.png", beforeKb: 100, afterKb: 75.9 },
    ]);

    // b: 24.1% → 数值 24.1（不是 24.1000001）；total: 17.05%
    expect(stats[2].percent).toBe(24.1);
    expect(stats[0].percent).toBe(17.05);
  });

  it("before 为 0 时 percent 归零（不产出 NaN）", () => {
    const stats = buildImageStats([
      { path: "empty.png", beforeKb: 0, afterKb: 0 },
      { path: "b.png", beforeKb: 0, afterKb: 0 },
    ]);

    expect(stats[0].percent).toBe(0);
    expect(stats[1].percent).toBe(0);
  });

  it("组装结果可直接喂给 createPrBody（多图出 Total 行）", () => {
    const stats = buildImageStats([
      { path: "img/logo.png", beforeKb: 234.56, afterKb: 123.45 },
      { path: "docs/shot.jpg", beforeKb: 1000, afterKb: 864.2 },
    ]);
    const body = createPrBody(stats);

    expect(body).toContain(
      "Your image file size has been reduced by **20%** 🎉",
    );
    expect(body).toContain("| img/logo.png | 234.56kb | 123.45kb | 47.37% |");
    expect(body).toContain(
      "| **Total :** | **1,234.56kb** | **987.65kb** | **20.00%** |",
    );
  });

  it("单图喂给 createPrBody 时没有 Total 行", () => {
    const body = createPrBody(
      buildImageStats([
        { path: "img/logo.png", beforeKb: 234.56, afterKb: 123.45 },
      ]),
    );

    expect(body).toContain("| img/logo.png | 234.56kb | 123.45kb | 47.37% |");
    expect(body).not.toContain("Total :");
  });
});

describe("sumSizes（D1 bytes_before / bytes_after / 阈值用 KB）", () => {
  it("累计字节并换算节省 KB", () => {
    expect(sumSizes([])).toEqual({ beforeBytes: 0, afterBytes: 0, savedKb: 0 });

    const summary = sumSizes([
      { beforeBytes: 4096, afterBytes: 2048 },
      { beforeBytes: 1024, afterBytes: 1024 },
    ]);
    expect(summary.beforeBytes).toBe(5120);
    expect(summary.afterBytes).toBe(3072);
    expect(summary.savedKb).toBe(2);
  });
});

describe("P1 修复辅助（staging ref 按 run 唯一 / tip 守卫复核）", () => {
  it("stagingRefForRun：含 run_id 且与共享名不同", () => {
    const ref = stagingRefForRun("abc-123");
    expect(ref).toBe("heads/imgbot-staging-abc-123");
    expect(stagingRefForRun("other")).not.toBe(ref);
  });

  it("tipViolatesGuard：快照与实测不一致（含出现/消失）→ 违约", () => {
    expect(tipViolatesGuard("aaa", "aaa")).toBe(false);
    expect(tipViolatesGuard(null, null)).toBe(false);
    expect(tipViolatesGuard("aaa", "bbb")).toBe(true);
    expect(tipViolatesGuard("aaa", null)).toBe(true);
    expect(tipViolatesGuard(null, "aaa")).toBe(true);
  });
});

describe("PR 负载预算（§4.3：张数 + 原始字节双上限）", () => {
  it("常量按任务书口径：500 张 / 10MB", () => {
    expect(MAX_PR_IMAGES).toBe(500);
    expect(MAX_PR_TOTAL_BYTES).toBe(10 * 1024 * 1024);
  });

  it("边界：恰好等于上限通过，超一个单位失败", () => {
    expect(withinPrBudget(MAX_PR_IMAGES, MAX_PR_TOTAL_BYTES)).toBe(true);
    expect(withinPrBudget(MAX_PR_IMAGES + 1, 0)).toBe(false);
    expect(withinPrBudget(0, MAX_PR_TOTAL_BYTES + 1)).toBe(false);
  });

  it("常规区间与空负载都通过", () => {
    expect(withinPrBudget(0, 0)).toBe(true);
    expect(withinPrBudget(1, 1)).toBe(true);
    expect(withinPrBudget(MAX_PR_IMAGES - 1, MAX_PR_TOTAL_BYTES - 1)).toBe(
      true,
    );
  });

  it("两个维度任一超限即不通过（张数够但体积爆、反之亦然）", () => {
    expect(withinPrBudget(MAX_PR_IMAGES + 1, 1)).toBe(false);
    expect(withinPrBudget(1, MAX_PR_TOTAL_BYTES + 1)).toBe(false);
  });

  it("支持自定义上限（便于测试/未来配置化）", () => {
    expect(withinPrBudget(2, 100, 2, 100)).toBe(true);
    expect(withinPrBudget(3, 100, 2, 100)).toBe(false);
    expect(withinPrBudget(2, 101, 2, 100)).toBe(false);
  });
});

describe("容器输入硬上限（§6.3：>40MB 不送容器）", () => {
  it("40MB 是边界：等于通过，超一字节不通过", () => {
    const cap = 40 * 1024 * 1024;
    expect(withinContainerInputCap(0)).toBe(true);
    expect(withinContainerInputCap(cap)).toBe(true);
    expect(withinContainerInputCap(cap + 1)).toBe(false);
  });

  it("自定义上限（默认值可被调用方覆盖）", () => {
    expect(withinContainerInputCap(10, 10)).toBe(true);
    expect(withinContainerInputCap(11, 10)).toBe(false);
  });
});

describe("截断树丢重放的显式中止（P1 静默回滚修复）", () => {
  it("树被截断且确有重放被丢弃 → 中止（否则 PR 会静默退回原图）", () => {
    expect(shouldAbortForTruncatedReplays(true, 1)).toBe(true);
    expect(shouldAbortForTruncatedReplays(true, 37)).toBe(true);
  });

  it("树被截断但没有丢重放 → 不中止（截断本身不算失败）", () => {
    expect(shouldAbortForTruncatedReplays(true, 0)).toBe(false);
  });

  it("非截断树的缺失只是陈旧缓存行 → 不中止（交给后续轮自愈）", () => {
    expect(shouldAbortForTruncatedReplays(false, 5)).toBe(false);
    expect(shouldAbortForTruncatedReplays(false, 0)).toBe(false);
  });
});

describe("仪表盘停用开关的运行时语义（repos.enabled）", () => {
  it("显式 0（行存在且停用）→ 跳过本轮", () => {
    expect(shouldSkipDisabled(0)).toBe(true);
  });

  it("1（行存在且启用）→ 照常跑", () => {
    expect(shouldSkipDisabled(1)).toBe(false);
  });

  it("缺行 / NULL（默认启用）→ 照常跑（保持原行为）", () => {
    expect(shouldSkipDisabled(null)).toBe(false);
    expect(shouldSkipDisabled(undefined)).toBe(false);
  });
});

describe("D16 私有配额运行期闸门（shouldSkipPrivateQuota）", () => {
  it("私有仓库超过计划上限 → 跳过", () => {
    expect(shouldSkipPrivateQuota(true, true, 4, 3)).toBe(true);
  });

  it("正好达到上限 → 放行（cap = 3 允许第 1..3 个）", () => {
    expect(shouldSkipPrivateQuota(true, true, 3, 3)).toBe(false);
    expect(shouldSkipPrivateQuota(true, true, 1, 3)).toBe(false);
  });

  it("免费档 cap = 0：任何私有仓库都超限", () => {
    expect(shouldSkipPrivateQuota(true, true, 1, 0)).toBe(true);
  });

  it("计费关闭（self-host）→ run 期不拦（env 上限只在开关时刻生效）", () => {
    expect(shouldSkipPrivateQuota(true, false, 99, 0)).toBe(false);
  });

  it("公共仓库不受私有配额约束", () => {
    expect(shouldSkipPrivateQuota(false, true, 99, 0)).toBe(false);
  });
});
