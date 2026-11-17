/**
 * SVG 优化 —— 见 DESIGN.md §6.1。
 *
 * 用 svgo v4 的纯 JS API（`svgo/browser`：不依赖 node:fs，可在 workerd 打包）。
 * 默认 preset + `multipass: true`。
 *
 * §9-R6：svgo 4.x 与原版 Imgbot 使用的 svgo 1.x 输出必然有差异（数字会变，契约不变：
 * 只有严格变小才替换）。这里刻意不逐插件复刻 1.x 的 preset——1.x 的部分插件已移除，
 * 强绑只会锁死依赖。
 */
import { optimize as svgoOptimize } from "svgo/browser";
import type { CodecSet } from "../types";

export type SvgCodec = NonNullable<CodecSet["svg"]>;

/** 轻量 XML 检查：能定位到 `<svg` 根且以 `</svg>` / `/>` 收尾。 */
const LEADING_NOISE =
  /^(?:\uFEFF)?\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE[^>[]*(?:\[[\s\S]*?\])?[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*/i;

export function looksLikeSvg(text: string): boolean {
  const body = text.replace(LEADING_NOISE, "").trim();
  if (!/^<svg[\s/>]/i.test(body)) return false;
  return /(?:<\/svg\s*>|\/>)\s*$/i.test(body);
}

export function optimizeSvg(input: string): string {
  const result = svgoOptimize(input, {
    multipass: true,
    plugins: [{ name: "preset-default" }],
  });
  return result.data;
}

/** 内置 svg codec（纯 JS，无需 wasm 注入）。 */
export const svgCodec: SvgCodec = { optimize: optimizeSvg };

/**
 * 从任意源（文件 / R2）拿到的 SVG 文本做优化；非法输入抛错，由 dispatch 归一为 skipped。
 */
export function optimizeSvgBytes(bytes: Uint8Array): string {
  const input = new TextDecoder().decode(bytes);
  return optimizeSvg(input);
}
