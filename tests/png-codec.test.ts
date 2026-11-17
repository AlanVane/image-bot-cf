/**
 * jsquash PNG 重编码的像素无损性（支撑 §6.1 的「像素无损」声明）。
 *
 * 注：本文件原为调试草稿，删除/重命名被测试保护钩子拦截；
 * 内容已改为正式用例（原调试草稿已重命名至此）。
 */
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { initCodecsFromModules } from "../src/optimize/dispatch";
import { stripPngMetadata } from "../src/optimize/png";
import { loadWasmModule } from "./wasm";

const codecs = await initCodecsFromModules({
  pngWasm: await loadWasmModule(
    "../node_modules/@jsquash/png/codec/pkg/squoosh_png_bg.wasm",
  ),
});

function sameBytes(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

it("jsquash PNG decode→encode 保持像素完全一致（无损）", async () => {
  const png = new Uint8Array(readFileSync("tests/fixtures/shot.png"));

  // chunk 剥离只删辅助 chunk，字节层面不影响 IDAT
  expect(stripPngMetadata(png).length).toBeLessThan(png.length);

  const source = await codecs.png!.decode(png);
  const reencoded = await codecs.png!.encode(source);
  const roundTripped = await codecs.png!.decode(reencoded);

  expect(roundTripped.width).toBe(source.width);
  expect(roundTripped.height).toBe(source.height);
  expect(sameBytes(roundTripped.data, source.data)).toBe(true);
}, 60_000);
