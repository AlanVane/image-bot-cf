/**
 * `.imgbotconfig` 解析（DESIGN.md §2.3）。
 *
 * 语义基准是原版 Imgbot 的 `Common/RepoConfiguration.cs` + `CompressImagesFunction/ImageQuery.cs`：
 * - 缺文件 / 空文件 / JSON 语法错误 ⇒ 全默认值（原版反序列化异常后走默认构造）
 * - 未知键忽略（向前兼容）
 * - `minKBReduced` 为整数，默认 10；`<= 0` 表示无阈值（由调用方判断，见 §2.1）
 *
 * `ignoredFiles` 的匹配**逐行为等价**于原版 `ImageQuery.NormalizePattern` +
 * `new Regex(pattern, RegexOptions.IgnoreCase)` + `Regex.IsMatch(path)`，即：
 * - `\` → `/`
 * - `**` → `.*`（全部出现处）
 * - 替换后若以 `*` 开头，补一个 `.` 前缀（把 `*` 变成 `.*`）
 * - **不转义**其余正则元字符（`.`/`+`/`(` 等仍是正则语法）
 * - **子串匹配**（不锚定），大小写不敏感
 *
 * 该等价性由上游 `Test/ImageQueryTests.cs` 的夹具向量对拍确认（见 tests/config.test.ts）。
 * 已知副作用（原版即如此）：`docs/*.png` 这类「单星号跟在斜杠后」的模式几乎匹配不到，
 * 因为 `*` 是正则量词、作用于前一个字符；只有 `**` 与「前导 `*`」具备通配语义。
 */

import type { RepoConfig } from "../types";

/** §2.3 默认 `minKBReduced`（KB） */
export const DEFAULT_MIN_KB_REDUCED = 10;

/** §2.3 合法 schedule 取值 */
export const SCHEDULE_VALUES = ["daily", "weekly", "monthly"] as const;

/**
 * 全默认配置（每次返回新对象：调用方可以安全修改，不必担心共享可变状态）。
 */
export function defaultConfig(): RepoConfig {
  return {
    schedule: null,
    ignoredFiles: [],
    aggressiveCompression: false,
    compressWiki: false,
    minKBReduced: DEFAULT_MIN_KB_REDUCED,
    prTitle: null,
    prBody: null,
  };
}

/**
 * 解析 `.imgbotconfig` 文本。
 *
 * 绝不抛异常：任何解析失败都退化为默认值（「配置坏掉不该让 run 失败」）。
 */
export function parseImgbotConfig(raw: string | null | undefined): RepoConfig {
  const config = defaultConfig();
  if (raw == null) return config;

  // 与 File.ReadAllText 对齐：容忍 UTF-8 BOM
  const text = raw.replace(/^\uFEFF/, "");
  if (text.trim() === "") return config;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return config;
  }

  // JSON 顶层必须是对象；null / 数组 / 标量都视为无效配置
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return config;
  }
  const obj = parsed as Record<string, unknown>;

  if (
    obj.schedule === "daily" ||
    obj.schedule === "weekly" ||
    obj.schedule === "monthly"
  ) {
    config.schedule = obj.schedule;
  }

  if (Array.isArray(obj.ignoredFiles)) {
    config.ignoredFiles = obj.ignoredFiles.filter(
      (pattern): pattern is string => typeof pattern === "string",
    );
  }

  if (typeof obj.aggressiveCompression === "boolean") {
    config.aggressiveCompression = obj.aggressiveCompression;
  }

  if (typeof obj.compressWiki === "boolean") {
    config.compressWiki = obj.compressWiki;
  }

  if (
    typeof obj.minKBReduced === "number" &&
    Number.isFinite(obj.minKBReduced)
  ) {
    // C# 侧是 int；非整数值按截断处理
    config.minKBReduced = Math.trunc(obj.minKBReduced);
  }

  if (typeof obj.prTitle === "string") {
    // 空串是合法的「覆盖为空」，只有缺省才是 null
    config.prTitle = obj.prTitle;
  }

  if (typeof obj.prBody === "string") {
    config.prBody = obj.prBody;
  }

  return config;
}

/**
 * 复刻原版 `ImageQuery.NormalizePattern`（逐字符等价，含保留正则元字符）。
 *
 * 例：`*.png` → `.*.png`（前导 `*` 补点），`**\/test_images/**` → `.*\/test_images/.*`。
 */
export function normalizeIgnorePattern(ignorePattern: string): string {
  const slashesNormalized = ignorePattern.replace(/\\/g, "/");
  // 等价于 C# string.Replace("**", ".*")（替换全部非重叠出现）
  const doubleStarNormalized = slashesNormalized.split("**").join(".*");
  if (doubleStarNormalized.startsWith("*")) {
    return `.${doubleStarNormalized}`;
  }
  return doubleStarNormalized;
}

/**
 * 将 ignore 模式编译为正则：`new Regex(NormalizePattern(p), RegexOptions.IgnoreCase)`。
 *
 * 注意（与原版一致）：模式本身是正则片段，非法正则（如 `(`）会抛 `SyntaxError`
 * —— 原版同样会在 `new Regex(...)` 处抛 `ArgumentException`，不做降级。
 */
export function globToRegExp(pattern: string): RegExp {
  return new RegExp(normalizeIgnorePattern(pattern), "i");
}

/** 批量编译 ignore 模式（顺序与配置一致）。 */
export function compileIgnorePatterns(patterns: readonly string[]): RegExp[] {
  return patterns.map(globToRegExp);
}

/** 仓库相对路径归一化：反斜杠 → 正斜杠，去掉前导 `./`。 */
export function normalizeRepoPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * 判断仓库相对路径是否命中任一 ignore 模式（已编译）。
 *
 * 原版 `Regex.IsMatch` 为子串匹配（未锚定）；这里用 `RegExp.test` 保持一致。
 * 路径在 `FindImages` 里已归一为正斜杠，这里再做一次归一以便独立调用。
 */
export function isPathIgnored(
  path: string,
  patterns: readonly RegExp[],
): boolean {
  const normalized = normalizeRepoPath(path);
  return patterns.some((pattern) => pattern.test(normalized));
}

/** 过滤掉命中 ignore 模式的路径（镜像 `ImageQuery.FilterOutIgnoredFiles`）。 */
export function filterIgnoredPaths(
  paths: readonly string[],
  patterns: readonly RegExp[],
): string[] {
  return paths.filter((path) => !isPathIgnored(path, patterns));
}
