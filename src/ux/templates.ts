/**
 * commit message 与 PR body 生成/解析（DESIGN.md §2.2）。
 *
 * 逐字复刻原版：
 * - `CompressImagesFunction/CommitMessage.cs`（Create/Parse）
 * - `CompressImagesFunction/CompressionResult.cs`（行格式 + PercentSaved）
 * - `OpenPrFunction/PullRequestBody.cs`（PR body 模板 + magic tags）
 * - `OpenPrFunction/Stats.cs`（commit body → ImageStat[]）
 *
 * 格式化等价于 .NET：
 * - `N2`：en-US 千分位 + 2 位小数（`1234.56` → `1,234.56`）
 * - `N0`：四舍五入（远离零）+ 千分位
 * - `0.##`：最多 2 位小数、去尾零（`20.00` → `20`）
 * - 比例行门槛用 `Math.Round` 默认的 banker's rounding（ToEven）：`4.5` → 4（不显示），
 *   `4.6` → 5（显示）
 */

import type { CompressionResult, ImageStat } from "../types";

/** §2.1 / §2.2 PR 与 commit 的标题（原版 `KnownGitHubs.CommitMessageTitle`） */
export const COMMIT_MESSAGE_TITLE = "[ImgBot] Optimize images";

/** §2.2 内置 PR 标题（`prTitle` 未设置时使用） */
export const DEFAULT_PR_TITLE = COMMIT_MESSAGE_TITLE;

/** §2.2 DCO 行（D6 只替换提交者身份，文案保持原版） */
export const SIGN_OFF = "Signed-off-by: ImgBotApp <ImgBotHelp@gmail.com>";

/** §2.2 多图时 commit message 的总计行标题 */
export const TOTAL_TITLE = "*Total";

/** §2.2 magic tags（`prBody` 覆盖模板同样支持） */
export const RATIO_TAG = "{optimization_ratio}";
export const DETAILS_TAG = "{optimization_details}";

/** §2.2 无统计时的兜底文案（原版末尾还补两个换行） */
export const EMPTY_BODY_MESSAGE =
  "Beep boop. Optimizing your images is my life. https://imgbot.net/ for more information.";

// D7：页脚指向本项目（品牌归属），排版结构与原版一致。
// 2026-11-17 定稿：真实仓库地址（AlanVane/image-bot-cf）；docs 指 README（用户文档入口）。
export const DOCS_URL = "https://github.com/AlanVane/image-bot-cf#readme";
export const REPO_URL = "https://github.com/AlanVane/image-bot-cf";
export const ISSUES_URL = "https://github.com/AlanVane/image-bot-cf/issues";
// 未上架 Marketplace（D2/D3 无付费墙）→ 指向本 App 安装/管理页，与仪表盘 installUrl 同址。
export const MARKETPLACE_URL =
  "https://github.com/apps/image-bot-cf/installations/new";

/* -------------------------------------------------------------------------- */
/* .NET 格式化等价                                                             */
/* -------------------------------------------------------------------------- */

/** 在整数部分的每三位插入千分位。 */
function groupThousands(intPart: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * `.NET` `N2`：千分位 + 固定 2 位小数。
 * 例：`1234.56` → `"1,234.56"`，`0` → `"0.00"`。
 */
export function formatN2(value: number): string {
  if (!Number.isFinite(value)) return "0.00";
  const negative = value < 0;
  const [intPart, fracPart] = Math.abs(value).toFixed(2).split(".");
  return `${negative ? "-" : ""}${groupThousands(intPart)}.${fracPart}`;
}

/**
 * `.NET` `N0`：四舍五入（远离零）+ 千分位。
 * 例：`1234.5` → `"1,235"`。
 */
export function formatN0(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const negative = value < 0;
  const intPart = Math.abs(value).toFixed(0);
  return `${negative ? "-" : ""}${groupThousands(intPart)}`;
}

/**
 * `.NET` `0.##`：最多 2 位小数、去尾零。
 * 例：`47.37` → `"47.37"`，`24.1` → `"24.1"`，`20` → `"20"`。
 */
export function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const trimmed = Math.abs(value)
    .toFixed(2)
    .replace(/0+$/, "")
    .replace(/\.$/, "");
  return `${value < 0 ? "-" : ""}${trimmed}`;
}

/**
 * .NET `Math.Round(double)` 默认行为：banker's rounding（MidpointRounding.ToEven）。
 * 只用于 §2.2 的比例显示门槛，例：`4.5` → 4、`4.6` → 5、`5.5` → 6。
 */
export function roundHalfToEven(value: number): number {
  if (!Number.isFinite(value)) return value;
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/* -------------------------------------------------------------------------- */
/* commit message                                                              */
/* -------------------------------------------------------------------------- */

/** `CompressionResult.PercentSaved`：`(1 - after/before) * 100`。 */
export function percentSaved(result: CompressionResult): number {
  return (1 - result.sizeAfterKb / result.sizeBeforeKb) * 100;
}

/** `CompressionResult.ToString()`，只把反斜杠换成正斜杠。 */
export function formatCompressionLine(result: CompressionResult): string {
  const title = result.title.replace(/\\/g, "/");
  const before = formatN2(result.sizeBeforeKb);
  const after = formatN2(result.sizeAfterKb);
  const percent = formatPercent(percentSaved(result));
  return `${title} -- ${before}kb -> ${after}kb (${percent}%)`;
}

/**
 * 生成 commit message（`CommitMessage.Create`）。
 *
 * 结构（2 张图）：
 * ```
 * [ImgBot] Optimize images
 *
 * *Total -- …kb -> …kb (…%)
 *
 * *img/a.png -- …kb -> …kb (…%)      ← 按 PercentSaved 降序
 * *img/b.png -- …kb -> …kb (…%)
 *
 * Signed-off-by: ImgBotApp <ImgBotHelp@gmail.com>
 * ```
 * 仅 1 张图时没有 `*Total` 行；空输入返回 `""`（与原版一致）。末尾保留换行。
 */
export function createCommitMessage(
  optimizedImages: readonly CompressionResult[] | null | undefined,
): string {
  if (!optimizedImages || optimizedImages.length === 0) return "";

  let message = `${COMMIT_MESSAGE_TITLE}\n\n`;

  if (optimizedImages.length > 1) {
    let totalBefore = 0;
    let totalAfter = 0;
    for (const image of optimizedImages) {
      totalBefore += image.sizeBeforeKb;
      totalAfter += image.sizeAfterKb;
    }
    const totalPercent = (1 - totalAfter / totalBefore) * 100;
    message +=
      `${TOTAL_TITLE} -- ${formatN2(totalBefore)}kb -> ${formatN2(totalAfter)}kb ` +
      `(${formatPercent(totalPercent)}%)\n\n`;
  }

  // Array.prototype.sort 是稳定排序，与原版 OrderByDescending 一致
  const sorted = [...optimizedImages].sort(
    (a, b) => percentSaved(b) - percentSaved(a),
  );
  for (const image of sorted) {
    message += `${formatCompressionLine(image)}\n`;
  }

  message += `\n${SIGN_OFF}\n`;
  return message;
}

/** `\*?(.*) -- (.*)kb -> (.*)kb \((.*)%\)`（原版未加锚点，这里保持一致）。 */
const COMPRESSION_LINE_PATTERN = /\*?(.*) -- (.*)kb -> (.*)kb \((.*)%\)/;

/**
 * 解析 commit message（`CommitMessage.Parse`）。
 *
 * - 跳过首行（标题）、空行、`Signed-off-by:` 行、`*Total --` 行
 * - 任意一行解析失败 ⇒ 返回 `null`（原版 catch 后同样返回 null）
 * - 标题按原版正则语义去掉前导 `*`（`*img/a.png` → `img/a.png`）
 */
export function parseCommitMessage(
  commitBody: string | null | undefined,
): CompressionResult[] | null {
  try {
    if (commitBody == null) return null;

    const results: CompressionResult[] = [];
    // 与原版 `Split(new[] { '\r', '\n' })` 等价（CRLF 会切出空行，随后被跳过）
    const lines = commitBody.split(/[\r\n]/);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (i === 0 || line.trim() === "") continue;
      if (line.startsWith("Signed-off-by:")) continue;
      if (line.startsWith("*Total --")) continue;

      const match = COMPRESSION_LINE_PATTERN.exec(line);
      if (!match) return null;

      // Convert.ToDouble(en-US)：千分位逗号需要剥离
      const sizeBeforeKb = Number(match[2].replace(/,/g, ""));
      const sizeAfterKb = Number(match[3].replace(/,/g, ""));
      if (!Number.isFinite(sizeBeforeKb) || !Number.isFinite(sizeAfterKb)) {
        return null;
      }

      results.push({
        title: match[1],
        sizeBeforeKb,
        sizeAfterKb,
      });
    }

    return results;
  } catch {
    // 原版注释：commit messages can be out of our control
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* PR body                                                                     */
/* -------------------------------------------------------------------------- */

/** `prTitle` / `prBody` 覆盖（D2：不设付费墙，全员可用）。 */
export interface PrTemplateSettings {
  prTitle?: string | null;
  prBody?: string | null;
}

/** §2.1 PR 标题：`prTitle` 覆盖优先（空串也算覆盖，与原版 `!= null` 判断一致）。 */
export function createPrTitle(settings?: PrTemplateSettings | null): string {
  const override = settings?.prTitle;
  return override != null ? override : DEFAULT_PR_TITLE;
}

const FOOTER_LINE =
  `[📝 docs](${DOCS_URL}) | ` +
  `[:octocat: repo](${REPO_URL}) | ` +
  `[🙋🏾 issues](${ISSUES_URL}) | ` +
  `[🏪 marketplace](${MARKETPLACE_URL})`;

/**
 * 内置模板（`PullRequestBody.BasicPr`）。
 * 注意：模板里没有空行分隔 `{optimization_details}` 与页脚——明细块自己以 `---` 结尾。
 */
const PR_BODY_TEMPLATE =
  "## Beep boop. Your images are optimized!\n" +
  "\n" +
  `${RATIO_TAG}\n` +
  "\n" +
  `${DETAILS_TAG}\n` +
  `${FOOTER_LINE}\n` +
  "\n" +
  "<i>~image-bot-cf</i>\n";

function prDetailsBlock(imageStats: readonly ImageStat[]): string {
  let details = "<details>\n<summary>\nDetails\n</summary>\n\n";
  details += "| File | Before | After | Percent reduction |\n";
  details += "|:--|:--|:--|:--|\n";

  if (imageStats.length === 1) {
    const image = imageStats[0];
    details +=
      `| ${image.name} | ${image.before} | ${image.after} | ` +
      `${formatN2(image.percent)}% |\n`;
  } else {
    // 第 0 条统计是 Total，逐行从第 1 条打起，总计行放表尾
    for (let i = 1; i < imageStats.length; i++) {
      const image = imageStats[i];
      details +=
        `| ${image.name} | ${image.before} | ${image.after} | ` +
        `${formatN2(image.percent)}% |\n`;
    }
    details += "| | | | |\n";
    const total = imageStats[0];
    details +=
      `| **Total :** | **${total.before}** | **${total.after}** | ` +
      `**${formatN2(total.percent)}%** |\n`;
  }

  details += "</details>\n\n---\n";
  return details;
}

function replacePrMagicTags(
  imageStats: readonly ImageStat[] | null | undefined,
  prBody: string,
): string {
  if (!imageStats || imageStats.length === 0) {
    return prBody
      .split(RATIO_TAG)
      .join("Your image file size has been reduced!")
      .split(DETAILS_TAG)
      .join("");
  }

  let body = prBody;

  if (body.includes(RATIO_TAG)) {
    const ratio = imageStats[0].percent;
    let replace = "Your image file size has been reduced ";
    if (roundHalfToEven(ratio) >= 5) {
      replace += `by **${formatN0(ratio)}%** `;
    }
    replace += "🎉";
    body = body.split(RATIO_TAG).join(replace);
  }

  if (body.includes(DETAILS_TAG)) {
    body = body.split(DETAILS_TAG).join(prDetailsBlock(imageStats));
  }

  return body;
}

/**
 * 生成 PR body（`PullRequestBody.Generate`）。
 *
 * - 无统计：返回兜底文案 + 两个换行（若提供了 `prBody` 覆盖，仍做 magic tag 替换）
 * - 有统计：内置模板 → （可选）`prBody` 整体替换 → magic tag 替换
 */
export function createPrBody(
  imageStats: readonly ImageStat[] | null | undefined,
  settings?: PrTemplateSettings | null,
): string {
  let body =
    !imageStats || imageStats.length === 0
      ? `${EMPTY_BODY_MESSAGE}\n\n`
      : PR_BODY_TEMPLATE;

  if (settings?.prBody != null) {
    body = settings.prBody;
  }

  return replacePrMagicTags(imageStats, body);
}

/* -------------------------------------------------------------------------- */
/* commit body → ImageStat[]（OpenPrFunction/Stats.cs）                        */
/* -------------------------------------------------------------------------- */

/** `\*?(.*) -- (.*) -> (.*) \((.*)%\)`（`Stats.ParseStats`，注意没有 `kb`）。 */
const STAT_LINE_PATTERN = /\*?(.*) -- (.*) -> (.*) \((.*)%\)/;

/**
 * 把 commit body 转成 PR 明细统计（`Stats.ParseStats`）。
 * 第 0 条即 `*Total`；任意行解析失败返回 `null`。
 */
export function parseStats(
  commitBody: string | null | undefined,
): ImageStat[] | null {
  try {
    if (commitBody == null) return null;

    const imageStats: ImageStat[] = [];
    const lines = commitBody.split(/[\r\n]/);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (i === 0 || line.trim() === "") continue;
      if (line.startsWith("Signed-off-by:")) continue;

      const match = STAT_LINE_PATTERN.exec(line);
      if (!match) return null;

      const percent = Number(match[4].replace(/,/g, ""));
      if (!Number.isFinite(percent)) return null;

      imageStats.push({
        name: match[1],
        before: match[2],
        after: match[3],
        percent,
      });
    }

    return imageStats;
  } catch {
    // 原版注释：commit messages can be out of our control
    return null;
  }
}
