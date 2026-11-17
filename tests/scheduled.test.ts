/**
 * cron 侧纯函数测试（DESIGN.md §2.1 / §2.3 / §2.4 / D8）。
 *
 * 覆盖：
 *  - `scheduleGate`：daily/weekly/monthly × 命中/未命中/从未跑过；
 *  - `buildRecoveredPr`：巡检重建 PR 的统计必须来自 tip commit message；
 *  - `shouldRebuildPr` / `isBotAuthor`：卡死 PR 巡检判定；
 *  - GitHub 列表响应解析。
 */
import { describe, expect, it } from "vitest";

import {
  SCHEDULE_PERIOD_MS,
  buildRecoveredPr,
  isBotAuthor,
  parseInstallationIds,
  parseInstallationRepos,
  prOverridesFromConfig,
  scheduleGate,
  shouldRebuildPr,
} from "../src/ingress/scheduled-logic";
import {
  COMMIT_MESSAGE_TITLE,
  createPrBody,
  parseStats,
} from "../src/ux/templates";

const NOW = Date.parse("2026-11-17T03:00:00Z");

function ago(ms: number): string {
  return new Date(NOW - ms).toISOString();
}

// ---------------------------------------------------------------------------
// scheduleGate
// ---------------------------------------------------------------------------

describe("scheduleGate", () => {
  it("daily：23h 前跑过 → 跳过", () => {
    expect(scheduleGate("daily", ago(23 * 3600_000), NOW)).toBe(false);
  });

  it("daily：25h 前跑过 → 放行", () => {
    expect(scheduleGate("daily", ago(25 * 3600_000), NOW)).toBe(true);
  });

  it("daily：从未跑过 → 放行", () => {
    expect(scheduleGate("daily", null, NOW)).toBe(true);
  });

  it("weekly：6 天前跑过 → 跳过", () => {
    expect(scheduleGate("weekly", ago(6 * 24 * 3600_000), NOW)).toBe(false);
  });

  it("weekly：8 天前跑过 → 放行", () => {
    expect(scheduleGate("weekly", ago(8 * 24 * 3600_000), NOW)).toBe(true);
  });

  it("weekly：从未跑过 → 放行", () => {
    expect(scheduleGate("weekly", undefined, NOW)).toBe(true);
  });

  it("monthly：29 天前跑过 → 跳过", () => {
    expect(scheduleGate("monthly", ago(29 * 24 * 3600_000), NOW)).toBe(false);
  });

  it("monthly：31 天前跑过 → 放行", () => {
    expect(scheduleGate("monthly", ago(31 * 24 * 3600_000), NOW)).toBe(true);
  });

  it("monthly：从未跑过 → 放行", () => {
    expect(scheduleGate("monthly", new Date(NOW - 1000), NOW)).toBe(false);
    expect(scheduleGate("monthly", null, NOW)).toBe(true);
  });

  it("schedule 未开启（null/未知值）→ 恒 false", () => {
    expect(scheduleGate(null, null, NOW)).toBe(false);
    expect(scheduleGate(undefined, null, NOW)).toBe(false);
    expect(scheduleGate("hourly" as unknown as "daily", null, NOW)).toBe(false);
  });

  it("lastRunAt 无法解析 → 视为从未跑过", () => {
    expect(scheduleGate("daily", "not-a-date", NOW)).toBe(true);
  });

  it("周期与 D8 常量一致", () => {
    expect(SCHEDULE_PERIOD_MS.daily).toBe(24 * 3600_000);
    expect(SCHEDULE_PERIOD_MS.weekly).toBe(7 * 24 * 3600_000);
    expect(SCHEDULE_PERIOD_MS.monthly).toBe(30 * 24 * 3600_000);
  });
});

// ---------------------------------------------------------------------------
// 卡死 PR 重建内容
// ---------------------------------------------------------------------------

const MULTI_COMMIT = [
  COMMIT_MESSAGE_TITLE,
  "",
  "*Total -- 300.00kb -> 240.00kb (20%)",
  "",
  "*img/a.png -- 200.00kb -> 160.00kb (20%)",
  "*img/b.jpg -- 100.00kb -> 80.00kb (20%)",
  "",
  "Signed-off-by: ImgBotApp <ImgBotHelp@gmail.com>",
  "",
].join("\n");

const SINGLE_COMMIT = [
  COMMIT_MESSAGE_TITLE,
  "",
  "*img/a.png -- 200.00kb -> 160.00kb (20%)",
  "",
  "Signed-off-by: ImgBotApp <ImgBotHelp@gmail.com>",
  "",
].join("\n");

describe("buildRecoveredPr", () => {
  it("多图：body 与 createPrBody(parseStats(message)) 逐字一致", () => {
    const stats = parseStats(MULTI_COMMIT);
    expect(stats).not.toBeNull();

    const recovered = buildRecoveredPr(MULTI_COMMIT);
    expect(recovered).not.toBeNull();
    expect(recovered!.stats).toEqual(stats);
    expect(recovered!.title).toBe(COMMIT_MESSAGE_TITLE);
    expect(recovered!.body).toBe(createPrBody(stats));
    // 统计确实来自 commit message：Total 在 [0]，明细行保留 kb 后缀。
    expect(recovered!.stats[0]).toMatchObject({
      name: "Total",
      before: "300.00kb",
      after: "240.00kb",
      percent: 20,
    });
    expect(recovered!.body).toContain("**Total :**");
    expect(recovered!.body).toContain(
      "| img/a.png | 200.00kb | 160.00kb | 20.00% |",
    );
  });

  it("单图：走模板单图特例（无 Total 行）", () => {
    const recovered = buildRecoveredPr(SINGLE_COMMIT);
    expect(recovered).not.toBeNull();
    expect(recovered!.stats).toHaveLength(1);
    expect(recovered!.body).not.toContain("**Total :**");
    expect(recovered!.body).toContain(
      "| img/a.png | 200.00kb | 160.00kb | 20.00% |",
    );
  });

  it("config 的 prTitle / prBody 覆盖生效（支持 magic tags）", () => {
    const overrides = prOverridesFromConfig(
      JSON.stringify({
        prTitle: "Custom title",
        prBody: "ratio={optimization_ratio}\n{optimization_details}\n",
      }),
    );
    expect(overrides).toEqual({
      prTitle: "Custom title",
      prBody: "ratio={optimization_ratio}\n{optimization_details}\n",
    });

    const recovered = buildRecoveredPr(MULTI_COMMIT, overrides);
    expect(recovered!.title).toBe("Custom title");
    expect(recovered!.body).toContain(
      "ratio=Your image file size has been reduced by **20%** 🎉",
    );
    expect(recovered!.body).toContain(
      "| img/a.png | 200.00kb | 160.00kb | 20.00% |",
    );
  });

  it("人类 commit message（无 ImgBot 统计）→ null", () => {
    expect(buildRecoveredPr("feat: add landing page")).toBeNull();
    expect(buildRecoveredPr(null)).toBeNull();
  });

  it("只有标题、没有统计行 → null（不重建空 PR）", () => {
    expect(buildRecoveredPr(COMMIT_MESSAGE_TITLE)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// shouldRebuildPr / isBotAuthor
// ---------------------------------------------------------------------------

describe("isBotAuthor", () => {
  it("GitHub App bot 身份（type=Bot / login 后缀 [bot] / 旧 ImgBotApp）", () => {
    expect(isBotAuthor({ type: "Bot", login: "image-bot-cf[bot]" })).toBe(true);
    expect(isBotAuthor({ type: "User", login: "image-bot-cf[bot]" })).toBe(
      true,
    );
    expect(isBotAuthor({ name: "image-bot-cf[bot]" })).toBe(true);
    expect(isBotAuthor({ name: "ImgBotApp" })).toBe(true);
    expect(isBotAuthor({ email: "ImgBotHelp@gmail.com" })).toBe(true);
  });

  it("人类作者 → false", () => {
    expect(
      isBotAuthor({
        name: "Ada Lovelace",
        email: "ada@example.com",
        login: "ada",
        type: "User",
      }),
    ).toBe(false);
    expect(isBotAuthor(null)).toBe(false);
  });
});

describe("shouldRebuildPr", () => {
  const base = {
    branchExists: true,
    hasOpenPull: false,
    tipAuthor: { type: "Bot", login: "image-bot-cf[bot]" },
    tipCommittedAt: "2026-11-17T02:00:00Z",
    lastClosedPrAt: "2026-11-16T00:00:00Z",
  } as const;

  it("有分支、无 open PR、tip 是 bot、比上次 closed 新 → 重建", () => {
    expect(shouldRebuildPr(base)).toBe(true);
  });

  it("没有 imgbot 分支 → 不重建", () => {
    expect(shouldRebuildPr({ ...base, branchExists: false })).toBe(false);
  });

  it("已有 open PR → 不重建", () => {
    expect(shouldRebuildPr({ ...base, hasOpenPull: true })).toBe(false);
  });

  it("tip 作者是人类 → 不重建（防误开 PR）", () => {
    expect(
      shouldRebuildPr({
        ...base,
        tipAuthor: { type: "User", login: "ada" },
      }),
    ).toBe(false);
  });

  it("分支 tip 早于最近一次 closed PR → 跳过", () => {
    expect(
      shouldRebuildPr({
        ...base,
        tipCommittedAt: "2026-11-15T00:00:00Z",
        lastClosedPrAt: "2026-11-16T00:00:00Z",
      }),
    ).toBe(false);
  });

  it("tip 与 closed PR 同一时刻 → 跳过（不严格新）", () => {
    expect(
      shouldRebuildPr({
        ...base,
        tipCommittedAt: "2026-11-16T00:00:00Z",
        lastClosedPrAt: "2026-11-16T00:00:00Z",
      }),
    ).toBe(false);
  });

  it("从未有 closed PR → 重建", () => {
    expect(shouldRebuildPr({ ...base, lastClosedPrAt: null })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 列表响应解析
// ---------------------------------------------------------------------------

describe("GitHub 列表响应解析", () => {
  it("parseInstallationIds 只取合法 id", () => {
    expect(
      parseInstallationIds([
        { id: 1 },
        { id: "2" },
        { id: null },
        null,
        { id: 3.5 },
      ]),
    ).toEqual([1, 2, 3.5]);
    expect(parseInstallationIds(null)).toEqual([]);
  });

  it("parseInstallationRepos 取 full_name + default_branch", () => {
    expect(
      parseInstallationRepos({
        total_count: 2,
        repositories: [
          { full_name: "acme/site", default_branch: "main" },
          { full_name: "acme/docs", default_branch: null },
          { full_name: "" },
        ],
      }),
    ).toEqual([
      { repo: "acme/site", defaultBranch: "main" },
      { repo: "acme/docs", defaultBranch: null },
    ]);
    expect(parseInstallationRepos({})).toEqual([]);
  });
});
