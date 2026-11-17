/**
 * 静态资源完整性护栏（2026-11-18 事故回归：批量改样式脚本丢了 `}`，
 * 整页 CSS 报废而单测/e2e 全绿）。只做廉价的结构断言，不做像素级校验。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) =>
  readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

describe("public/ 静态资源完整性", () => {
  it("styles.css 花括号配平（丢 } = 整页裸奔）", () => {
    const css = read("public/styles.css");
    expect(css.length).toBeGreaterThan(1000);
    expect(css.split("{").length - 1).toBe(css.split("}").length - 1);
  });

  it("入口 HTML 引用的脚本/样式真实存在", () => {
    const html = read("public/index.html");
    expect(html).toContain('src="/app.js"');
    expect(html).toContain('href="/styles.css"');
    expect(read("public/app.js").length).toBeGreaterThan(1000);
  });

  it("docs 页存在且带标题（资产层 /docs/ 路由的实体）", () => {
    const docs = read("public/docs/index.html");
    expect(docs).toContain("<title>ImageBot documentation</title>");
  });

  it("_headers 覆盖安全头五件套（资产层 CSP 来源）", () => {
    const headers = read("public/_headers");
    for (const name of [
      "X-Content-Type-Options",
      "X-Frame-Options",
      "Content-Security-Policy",
      "Referrer-Policy",
      "Permissions-Policy",
    ]) {
      expect(headers).toContain(name);
    }
  });
});
