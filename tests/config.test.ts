import { describe, expect, it } from "vitest";

import {
  compileIgnorePatterns,
  defaultConfig,
  filterIgnoredPaths,
  globToRegExp,
  isPathIgnored,
  normalizeIgnorePattern,
  parseImgbotConfig,
} from "../src/config/imgbotconfig";

describe("parseImgbotConfig：全默认", () => {
  it.each<[string, string | null | undefined]>([
    ["缺文件（null）", null],
    ["缺文件（undefined）", undefined],
    ["空字符串", ""],
    ["纯空白", "  \n\t "],
    ["JSON 语法错误", "{ not json"],
    ["顶层数组", "[]"],
    ["顶层 null", "null"],
    ["顶层标量", "42"],
  ])("%s ⇒ 全默认值", (_label, raw) => {
    expect(parseImgbotConfig(raw)).toEqual({
      schedule: null,
      ignoredFiles: [],
      aggressiveCompression: false,
      compressWiki: false,
      minKBReduced: 10,
      prTitle: null,
      prBody: null,
    });
  });

  it("默认值是独立对象，可安全修改", () => {
    const a = defaultConfig();
    a.ignoredFiles.push("x.png");
    a.minKBReduced = 0;
    expect(defaultConfig()).toEqual({
      schedule: null,
      ignoredFiles: [],
      aggressiveCompression: false,
      compressWiki: false,
      minKBReduced: 10,
      prTitle: null,
      prBody: null,
    });
    expect(parseImgbotConfig(null).ignoredFiles).toEqual([]);
  });
});

describe("parseImgbotConfig：字段语义（§2.3）", () => {
  it("全字段 + 未知键忽略 + BOM", () => {
    const raw =
      "\uFEFF" +
      JSON.stringify({
        schedule: "weekly",
        ignoredFiles: ["docs/**", "*.png"],
        aggressiveCompression: true,
        compressWiki: true,
        minKBReduced: 25,
        prTitle: "Shrink images",
        prBody: "body {optimization_ratio}",
        labels: ["stub"],
        unknownKey: { nested: true },
      });

    expect(parseImgbotConfig(raw)).toEqual({
      schedule: "weekly",
      ignoredFiles: ["docs/**", "*.png"],
      aggressiveCompression: true,
      compressWiki: true,
      minKBReduced: 25,
      prTitle: "Shrink images",
      prBody: "body {optimization_ratio}",
    });
  });

  it("minKBReduced <= 0 原样保留（表示无阈值）", () => {
    expect(parseImgbotConfig('{"minKBReduced":0}').minKBReduced).toBe(0);
    expect(parseImgbotConfig('{"minKBReduced":-5}').minKBReduced).toBe(-5);
  });

  it("非法 schedule 退化为 null；非法类型不污染其他字段", () => {
    const config = parseImgbotConfig(
      '{"schedule":"hourly","minKBReduced":"20","aggressiveCompression":"yes","ignoredFiles":"*.png"}',
    );
    expect(config.schedule).toBeNull();
    expect(config.minKBReduced).toBe(10);
    expect(config.aggressiveCompression).toBe(false);
    expect(config.ignoredFiles).toEqual([]);
  });

  it("ignoredFiles 过滤非字符串项", () => {
    expect(
      parseImgbotConfig('{"ignoredFiles":["a.png",1,null,"b/**"]}')
        .ignoredFiles,
    ).toEqual(["a.png", "b/**"]);
  });

  it("空串是合法的 prTitle/prBody 覆盖（只有缺省才是 null）", () => {
    const config = parseImgbotConfig('{"prTitle":"","prBody":""}');
    expect(config.prTitle).toBe("");
    expect(config.prBody).toBe("");
  });
});

describe("ignoredFiles：与原版 NormalizePattern 逐行为等价", () => {
  // 对拍基准：imgbot/Imgbot Test/ImageQueryTests.cs（FindImages 的先扩展名过滤在
  // 本模块之外，这里直接喂它枚举出的图片路径，等价于 FilterOutIgnoredFiles 的输入）。
  const dataImages = [
    "data/a.jpg",
    "data/b.png",
    "data/c.png",
    "data/folder/item1.png",
    "data/folder/item2.png",
    "data/folder/item3.jpg",
    "data/folder/deep/nested/deepimage.png",
  ];

  const keep = (patterns: string[], paths: string[] = dataImages): string[] =>
    filterIgnoredPaths(paths, compileIgnorePatterns(patterns));

  const without = (...removed: string[]): string[] =>
    dataImages.filter((path) => !removed.includes(path));

  it.each<[string, string[], string[]]>([
    // GivenDefaultConfiguration_ShouldFindAllImages
    ["无配置", [], dataImages],
    // GivenFullIgnoreFullPath_ShouldIgnoreImage
    ["完整路径", ["data/folder/item2.png"], without("data/folder/item2.png")],
    // GivenFolderSlash_ShouldIgnoreImages
    [
      "目录 + 斜杠",
      ["data/folder/"],
      ["data/a.jpg", "data/b.png", "data/c.png"],
    ],
    // GivenFolderWildcard_ShouldIgnoreImages
    [
      "目录 + 星号",
      ["data/folder/*"],
      ["data/a.jpg", "data/b.png", "data/c.png"],
    ],
    // GivenFolderWildcardWithNoSlash_ShouldIgnoreImages
    [
      "目录前缀 + 星号",
      ["data/folder*"],
      ["data/a.jpg", "data/b.png", "data/c.png"],
    ],
    // GivenWildcardExtension_ShouldIgnoreImages
    ["*.png", ["*.png"], ["data/a.jpg", "data/folder/item3.jpg"]],
    // GivenWildcard_ShouldIgnoreAllImages
    ["*", ["*"], []],
    // GivenRegexAll_ShouldIgnoreAllImages
    [".*", [".*"], []],
    // GivenDifferentSlashPath_ShouldIgnoreImages
    [
      "反斜杠 + 多模式",
      ["data/folder/item2.png", "data\\folder\\item3.jpg"],
      without("data/folder/item2.png", "data/folder/item3.jpg"),
    ],
    // GivenDeeplyNestedImage_ShouldIgnoreImage（裸文件名 = 子串匹配）
    [
      "裸文件名",
      ["deepimage.png"],
      without("data/folder/deep/nested/deepimage.png"),
    ],
    // GivenDeeplyNestedPath_ShouldIgnoreImages
    [
      "嵌套目录 + 星号",
      ["data/folder/deep/nested/*"],
      without("data/folder/deep/nested/deepimage.png"),
    ],
    // GivenDeeplyNestedPathOneUp_ShouldIgnoreImages
    // 反直觉：`/*` 里的 `*` 是量词，等价于「deep 前缀即可」，因此也命中 nested 下的文件
    [
      "上一级目录 + 星号",
      ["data/folder/deep/*"],
      without("data/folder/deep/nested/deepimage.png"),
    ],
  ])("%s（上游向量）", (_label, patterns, expected) => {
    expect(keep(patterns)).toEqual(expected);
  });

  it("GivenNestedIgnoreFolder_ShouldIgnoreImages（`**/test_images/**`）", () => {
    const nestedImages = [
      "data_samenested/folder1/f1_a.jpg",
      "data_samenested/folder1/test_images/f1_test_a.jpg",
      "data_samenested/folder2/f2_b.png",
      "data_samenested/folder2/test_images/f2_test_b.png",
      "data_samenested/folder3/f3_c.png",
      "data_samenested/folder3/test_images/f3_test_c.png",
    ];

    expect(
      filterIgnoredPaths(
        nestedImages,
        compileIgnorePatterns(["**/test_images/**"]),
      ),
    ).toEqual([
      "data_samenested/folder1/f1_a.jpg",
      "data_samenested/folder2/f2_b.png",
      "data_samenested/folder3/f3_c.png",
    ]);
  });

  it("GivenWronglyCasedIgnore_ShouldIgnoreImages（大小写不敏感）", () => {
    const casedImages = [
      "cased-data/uppercase-jpg.JPG",
      "cased-data/uppercase-png.PNG",
    ];

    expect(
      filterIgnoredPaths(
        casedImages,
        compileIgnorePatterns(["uppercase-jpg.jpg"]),
      ),
    ).toEqual(["cased-data/uppercase-png.PNG"]);
  });

  // 原版宽松语义的反直觉用例（由 NormalizePattern 直接推导，锁定行为不倒退）
  it.each<[string, string, boolean]>([
    // `.` 是通配符：真正的点号只是"碰巧"被通配到
    ["logo.png", "data/logoxpng", true],
    ["logo.png", "data/logopng", false],
    ["*.png", "data/.png", true],
    // `.*` 至少要吃一个字符：整串就是 "png" 时命中不了
    ["*.png", "png", false],
    ["*.png", "data/xapng", true],
    // `+` 是量词，不是字面量
    ["a+b.png", "a+b.png", false],
    ["a+b.png", "aabxpng", true],
    // 单星号跟在斜杠后没有通配语义（`*` 只重复 `/`），几乎匹配不到东西；
    // 但斜杠本身可以被 `.` 吃掉，于是 "docs/png" 反而命中
    ["docs/*.png", "docs/x.png", false],
    ["docs/*.png", "docs/png", true],
    // `**` 才是跨目录通配
    ["docs/**", "docs/a/b.png", true],
    // 子串匹配：不要求从仓库根开始
    ["docs/**", "src/docs/a.png", true],
    ["img/logo.png", "prefix/img/logo.png.bak", true],
  ])("%s 匹配 %s === %s（反直觉）", (pattern, path, expected) => {
    expect(isPathIgnored(path, compileIgnorePatterns([pattern]))).toBe(
      expected,
    );
  });

  it("normalizeIgnorePattern 与 C# 字符串操作一致", () => {
    expect(normalizeIgnorePattern("*.png")).toBe(".*.png");
    expect(normalizeIgnorePattern("**/test_images/**")).toBe(
      ".*/test_images/.*",
    );
    expect(normalizeIgnorePattern("docs/**")).toBe("docs/.*");
    expect(normalizeIgnorePattern("data\\folder\\item3.jpg")).toBe(
      "data/folder/item3.jpg",
    );
    expect(normalizeIgnorePattern("*")).toBe(".*");
    // `**` 替换成 `.*` 后不再以 `*` 开头，不会重复补点
    expect(normalizeIgnorePattern("**")).toBe(".*");
  });

  it("正则为子串匹配（未锚定）且大小写不敏感", () => {
    const regex = globToRegExp("img/logo.png");
    expect(regex.ignoreCase).toBe(true);
    expect(regex.test("some/IMG/LOGOXPNG/path")).toBe(true);
    expect(regex.test("some/other.png")).toBe(false);
  });

  it("非法正则抛错（等价于原版 new Regex 的 ArgumentException，不做降级）", () => {
    expect(() => globToRegExp("(")).toThrow();
  });

  it("空模式列表不忽略任何路径；路径反斜杠归一", () => {
    expect(isPathIgnored("any/path.png", compileIgnorePatterns([]))).toBe(
      false,
    );
    expect(
      filterIgnoredPaths(["docs\\a.png"], compileIgnorePatterns(["docs/**"])),
    ).toEqual([]);
  });
});
