/**
 * PNG aggressive 的"两档取小"回归（§6.1 b 路线）。
 *
 * 说明：本文件原名 `__measure.test.ts`（现场量尺寸的脚手架）。仓库的 delete-test 钩子
 * 拦截了脚手架文件的删除/重命名，故保留文件名并改写成正式用例；内容与
 * `tests/png-lossy.test.ts` 互补，不重复其断言。
 *
 * 断言：`encodeLossy()` 的返回值必须等于 { 无损, 256 色, 128 色 } 三者中的最小者
 * —— 防止将来改动档位逻辑时"多编码一档却忘了参与取小"，或误把更大字节当候选。
 */
import { expect, it } from "vitest";

import type { ImageDataLike } from "../src/types";
import {
  PNG_AGGRESSIVE_MAX_COLORS,
  createPngCodec,
  quantizePngImage,
} from "../src/optimize/png";
import { loadWasmModule } from "./wasm";

const codec = await createPngCodec(
  await loadWasmModule(
    "../node_modules/@jsquash/png/codec/pkg/squoosh_png_bg.wasm",
  ),
);

function gradient(size: number): ImageDataLike {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      data[i] = (x * 255) / (size - 1);
      data[i + 1] = (y * 255) / (size - 1);
      data[i + 2] = ((x ^ y) * 255) / (size - 1);
      data[i + 3] = 255;
    }
  }
  return { data, width: size, height: size };
}

it("encodeLossy = min(无损, 256 色, 128 色)，且每档都可再解码", async () => {
  const img = gradient(512);
  const lossy = await codec.encodeLossy(img);
  const lossless = await codec.encode(img);

  const sizes = [lossless.length];
  for (const maxColors of PNG_AGGRESSIVE_MAX_COLORS) {
    const quantized = quantizePngImage(img, maxColors);
    expect(quantized).not.toBeNull();
    const bytes = await codec.encode(quantized!);
    const decoded = await codec.decode(bytes);
    expect(decoded.width).toBe(img.width);
    expect(decoded.height).toBe(img.height);
    sizes.push(bytes.length);
  }

  expect(lossy.length).toBe(Math.min(...sizes));
  // 有损档必须真的赢过无损（否则接缝就是 no-op）
  expect(lossy.length).toBeLessThan(lossless.length);
}, 60_000);
