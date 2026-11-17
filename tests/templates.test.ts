import { describe, expect, it } from "vitest";

import {
  createCommitMessage,
  createPrBody,
  createPrTitle,
  DEFAULT_PR_TITLE,
  DOCS_URL,
  EMPTY_BODY_MESSAGE,
  formatN0,
  formatN2,
  formatPercent,
  ISSUES_URL,
  MARKETPLACE_URL,
  parseCommitMessage,
  parseStats,
  REPO_URL,
  roundHalfToEven,
  SIGN_OFF,
} from "../src/ux/templates";
import type { CompressionResult, ImageStat } from "../src/types";

describe(".NET 格式化等价", () => {
  // 验收基准：C# `{value:N2}`
  it.each<[number, string]>([
    [1234.56, "1,234.56"],
    [1234567.891, "1,234,567.89"],
    [0, "0.00"],
    [100, "100.00"],
    [1234.5, "1,234.50"],
    [999.999, "1,000.00"],
    [-1234.56, "-1,234.56"],
  ])("N2(%s) === %s", (value, expected) => {
    expect(formatN2(value)).toBe(expected);
  });

  // `0.##`：最多两位小数、去尾零
  it.each<[number, string]>([
    [47.37, "47.37"],
    [20, "20"],
    [20.0, "20"],
    [24.1, "24.1"],
    [4.564, "4.56"],
    [0, "0"],
    [100, "100"],
    [0.5, "0.5"],
  ])("0.##(%s) === %s", (value, expected) => {
    expect(formatPercent(value)).toBe(expected);
  });

  it("N0 四舍五入并加千分位", () => {
    expect(formatN0(20)).toBe("20");
    expect(formatN0(4.6)).toBe("5");
    expect(formatN0(1234.5)).toBe("1,235");
  });

  it("比例门槛用 banker's rounding（ToEven）", () => {
    expect(roundHalfToEven(4.5)).toBe(4);
    expect(roundHalfToEven(4.6)).toBe(5);
    expect(roundHalfToEven(5.5)).toBe(6);
    expect(roundHalfToEven(2.5)).toBe(2);
  });
});

describe("commit message", () => {
  // 原版 Test/CommitMessageTests.GivenImages_ShouldReportEach 的向量
  it("多图：*Total + 按降幅降序 + DCO", () => {
    const images: CompressionResult[] = [
      {
        title: "path/to/image.png",
        sizeBeforeKb: 100.3678,
        sizeAfterKb: 95.78743,
      },
      {
        title: "path/to/image2.png",
        sizeBeforeKb: 500.3234,
        sizeAfterKb: 360.1321987,
      },
    ];

    const expected =
      "[ImgBot] Optimize images\n" +
      "\n" +
      "*Total -- 600.69kb -> 455.92kb (24.1%)\n" +
      "\n" +
      "path/to/image2.png -- 500.32kb -> 360.13kb (28.02%)\n" +
      "path/to/image.png -- 100.37kb -> 95.79kb (4.56%)\n" +
      "\n" +
      "Signed-off-by: ImgBotApp <ImgBotHelp@gmail.com>\n";

    expect(createCommitMessage(images)).toBe(expected);
  });

  // 原版 Test/CommitMessageTests.GivenOneImage_ShouldReportSingleImageNoTotal
  it("单图：没有 *Total 行", () => {
    const message = createCommitMessage([
      { title: "path/to/image.png", sizeBeforeKb: 100.3, sizeAfterKb: 95.7 },
    ]);

    expect(message).not.toContain("*Total");
    expect(message).toBe(
      "[ImgBot] Optimize images\n" +
        "\n" +
        "path/to/image.png -- 100.30kb -> 95.70kb (4.59%)\n" +
        "\n" +
        SIGN_OFF +
        "\n",
    );
  });

  it("反斜杠渲染为正斜杠，千分位保留", () => {
    const message = createCommitMessage([
      {
        title: "path\\to\\image.png",
        sizeBeforeKb: 200.9678,
        sizeAfterKb: 195.12365354,
      },
      {
        title: "path\\to\\image2.png",
        sizeBeforeKb: 300.9234,
        sizeAfterKb: 260.555,
      },
    ]);

    expect(message).toContain(
      "path/to/image2.png -- 300.92kb -> 260.56kb (13.41%)",
    );
    expect(message).toContain(
      "path/to/image.png -- 200.97kb -> 195.12kb (2.91%)",
    );
    expect(message).toContain("*Total -- 501.89kb -> 455.68kb (9.21%)");
    expect(message).not.toContain("\\");
  });

  it("空输入返回空串", () => {
    expect(createCommitMessage([])).toBe("");
    expect(createCommitMessage(null)).toBe("");
  });

  it("Create → Parse 往返：数字一致（含千分位逗号）", () => {
    const images: CompressionResult[] = [
      { title: "*img/logo.png", sizeBeforeKb: 1234.56, sizeAfterKb: 987.65 },
      { title: "*docs/shot.jpg", sizeBeforeKb: 1000, sizeAfterKb: 864.2 },
    ];

    const parsed = parseCommitMessage(createCommitMessage(images));

    expect(parsed).not.toBeNull();
    expect(parsed).toHaveLength(2);
    // 降序：logo（20%）在 shot（13.58%）之前；标题按原版正则去掉前导 `*`
    expect(parsed?.[0].title).toBe("img/logo.png");
    expect(parsed?.[0].sizeBeforeKb).toBeCloseTo(1234.56, 2);
    expect(parsed?.[0].sizeAfterKb).toBeCloseTo(987.65, 2);
    expect(parsed?.[1].title).toBe("docs/shot.jpg");
    expect(parsed?.[1].sizeBeforeKb).toBeCloseTo(1000, 2);
    expect(parsed?.[1].sizeAfterKb).toBeCloseTo(864.2, 2);
  });

  it("Parse 对脏数据返回 null，而不是抛异常", () => {
    expect(
      parseCommitMessage("[ImgBot] Optimize images\n\nnot a compression line"),
    ).toBeNull();
    expect(parseCommitMessage("")).toEqual([]);
    expect(
      parseCommitMessage(
        "[ImgBot] Optimize images\n\n*Total -- 1.00kb -> 0.50kb (50%)\n\n" +
          "Signed-off-by: ImgBotApp <ImgBotHelp@gmail.com>\n",
      ),
    ).toEqual([]);
  });

  it("Parse 兼容 CRLF", () => {
    const message = createCommitMessage([
      { title: "*a.png", sizeBeforeKb: 20, sizeAfterKb: 10 },
      { title: "*b.png", sizeBeforeKb: 30, sizeAfterKb: 20 },
    ]).replace(/\n/g, "\r\n");

    expect(parseCommitMessage(message)).toHaveLength(2);
  });
});

const footerLine =
  `[📝 docs](${DOCS_URL}) | ` +
  `[:octocat: repo](${REPO_URL}) | ` +
  `[🙋🏾 issues](${ISSUES_URL}) | ` +
  `[🏪 marketplace](${MARKETPLACE_URL})`;

describe("PR body", () => {
  // 原版 Test/PullRequestBodyTests.GivenSingleImageCommitMessage_ShouldFormatMarkdownTable
  // 注意：明细单元格的 before/after 原样取自 commit 行，因此带 `kb` 后缀
  //（DESIGN §2.2 的示例省略了后缀；以 C# 源码与上游测试为准）。
  it("单图：明细只有一行、没有 Total 行", () => {
    const stats = parseStats(
      "[ImgBot] Optimize images\n" +
        "\n" +
        "/featured-marketplace.png -- 163.11kb -> 133.44kb (18.19%)\n" +
        "\n" +
        "Signed-off-by: ImgBotApp <ImgBotHelp@gmail.com>\n",
    );

    const body = createPrBody(stats);

    expect(body).toBe(
      "## Beep boop. Your images are optimized!\n" +
        "\n" +
        "Your image file size has been reduced by **18%** 🎉\n" +
        "\n" +
        "<details>\n" +
        "<summary>\n" +
        "Details\n" +
        "</summary>\n" +
        "\n" +
        "| File | Before | After | Percent reduction |\n" +
        "|:--|:--|:--|:--|\n" +
        "| /featured-marketplace.png | 163.11kb | 133.44kb | 18.19% |\n" +
        "</details>\n" +
        "\n" +
        "---\n" +
        "\n" +
        footerLine +
        "\n" +
        "\n" +
        "<i>~image-bot-cf</i>\n",
    );
    expect(body).not.toContain("Total");
  });

  it("多图：第 0 条是 Total，明细从第 1 条打起，表尾 N2 总计", () => {
    const stats = parseStats(
      "[ImgBot] Optimize images\n" +
        "\n" +
        "*Total -- 854.23kb -> 308.28kb (63.91%)\n" +
        "\n" +
        "/featurecard.png -- 542.34kb -> 86.13kb (84.12%)\n" +
        "/graph.png -- 148.78kb -> 88.71kb (40.38%)\n" +
        "/featured-marketplace.png -- 163.11kb -> 133.44kb (18.19%)\n" +
        "\n" +
        "Signed-off-by: ImgBotApp <ImgBotHelp@gmail.com>\n",
    );

    const lines = createPrBody(stats).split("\n");
    const start = lines.indexOf(
      "| File | Before | After | Percent reduction |",
    );

    expect(start).toBeGreaterThan(-1);
    expect(lines.slice(start, start + 6)).toEqual([
      "| File | Before | After | Percent reduction |",
      "|:--|:--|:--|:--|",
      "| /featurecard.png | 542.34kb | 86.13kb | 84.12% |",
      "| /graph.png | 148.78kb | 88.71kb | 40.38% |",
      "| /featured-marketplace.png | 163.11kb | 133.44kb | 18.19% |",
      "| | | | |",
    ]);
    expect(lines).toContain(
      "| **Total :** | **854.23kb** | **308.28kb** | **63.91%** |",
    );
    expect(lines).toContain(
      "Your image file size has been reduced by **64%** 🎉",
    );
    expect(lines.filter((line) => line.includes("Total"))).toHaveLength(1);
  });

  it("比例行门槛：4.5 不显示百分比，4.6 显示", () => {
    const stat = (percent: number): ImageStat[] => [
      { name: "a.png", before: "100.00kb", after: "95.00kb", percent },
    ];

    const noPercent = createPrBody(stat(4.5));
    expect(noPercent).toContain("Your image file size has been reduced 🎉\n");
    expect(noPercent).not.toContain("**5%**");

    const withPercent = createPrBody(stat(4.6));
    expect(withPercent).toContain(
      "Your image file size has been reduced by **5%** 🎉\n",
    );

    // banker's rounding：5.5 → 6（ToEven 的偶数侧）
    expect(createPrBody(stat(5.5))).toContain("by **6%** 🎉");
  });

  it("比例用 N0 千分位格式", () => {
    const body = createPrBody([
      {
        name: "a.png",
        before: "10,000.00kb",
        after: "1,000.00kb",
        percent: 1234.5,
      },
    ]);
    expect(body).toContain("by **1,235%** 🎉");
  });

  it("无统计：兜底文案 + 两个换行", () => {
    expect(createPrBody([])).toBe(`${EMPTY_BODY_MESSAGE}\n\n`);
    expect(createPrBody(null)).toBe(`${EMPTY_BODY_MESSAGE}\n\n`);
  });

  it("prBody 覆盖：整体替换但仍替换 magic tags", () => {
    const body = createPrBody(
      [{ name: "a.png", before: "10.00kb", after: "5.00kb", percent: 50 }],
      { prBody: "ratio={optimization_ratio}\ndetails={optimization_details}" },
    );

    expect(
      body.startsWith(
        "ratio=Your image file size has been reduced by **50%** 🎉\ndetails=<details>\n",
      ),
    ).toBe(true);
    expect(body).toContain("| a.png | 10.00kb | 5.00kb | 50.00% |");
  });

  it("prBody 覆盖 + 无统计：tag 退化为原版兜底串", () => {
    expect(
      createPrBody([], {
        prBody: "{optimization_ratio}|{optimization_details}",
      }),
    ).toBe("Your image file size has been reduced!|");
  });

  it("prTitle 覆盖，未设置时用内置标题", () => {
    expect(createPrTitle()).toBe(DEFAULT_PR_TITLE);
    expect(createPrTitle({ prTitle: null })).toBe(DEFAULT_PR_TITLE);
    expect(createPrTitle({ prTitle: "[Custom] shrink" })).toBe(
      "[Custom] shrink",
    );
  });
});

describe("Stats.ParseStats（commit body → ImageStat[]）", () => {
  it("第 0 条是 Total；before/after 保留 kb 后缀", () => {
    const stats = parseStats(
      createCommitMessage([
        { title: "*a.png", sizeBeforeKb: 20, sizeAfterKb: 10 },
        { title: "*b.png", sizeBeforeKb: 30, sizeAfterKb: 20 },
      ]),
    );

    expect(stats).toHaveLength(3);
    expect(stats?.[0]).toEqual({
      name: "Total",
      before: "50.00kb",
      after: "30.00kb",
      percent: 40,
    });
    expect(stats?.[1].name).toBe("a.png");
    expect(stats?.[1].before).toBe("20.00kb");
  });

  it("脏数据返回 null", () => {
    expect(parseStats("[ImgBot] Optimize images\n\nnope")).toBeNull();
  });
});
