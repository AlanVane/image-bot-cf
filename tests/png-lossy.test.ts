/**
 * PNG aggressive（P2 有损 = 调色板量化）—— 见 DESIGN.md §6.1 / §6.4、§9-R7。
 *
 * 落地方案（2026-11-17，零新依赖）：`gifenc.quantize`（MIT）把 RGBA 压到 ≤256 / ≤128 色
 * → `applyPalette` 还原 RGBA → `@jsquash/png` encode（lodepng 对 ≤256 色自动选索引色）。
 * 断言只锚定"关系"而非具体字节数（§9-R6：不同 wasm/压缩器版本字节数会漂移）：
 *   - 高色深夹具：aggressive 明显小于无损候选，且可再解码、像素近似；
 *   - 低色块夹具：量化无收益（等大/不更大），契约由 dispatch 的 `not_smaller` 兜住；
 *   - 透明 PNG：alpha=0 的像素在产物里仍为 0（透明槽保留）；
 *   - 任意夹具：aggressive ≤ 无损候选（内部取小者，绝不产出更大字节）。
 *
 * 夹具在测试内用 `@jsquash/png` 现场合成，避免引入二进制样本。
 */
import { describe, expect, it } from "vitest";

import type { CodecSet, ImageDataLike } from "../src/types";
import { optimizeImage } from "../src/optimize/dispatch";
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
/** dispatch 侧的注入形态：`encodeLossy` 由 codec 提供（§6.1 接缝）。 */
const codecs: CodecSet = { png: codec };

/** 高色深夹具：双轴渐变（≈6.5 万种颜色），PNG 只能按 RGBA 逐像素压。 */
function gradientImage(size = 512): ImageDataLike {
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

/** 低色夹具：2×2 纯色块（远少于 256 色，量化不可能带来收益）。 */
function blocksImage(size = 256): ImageDataLike {
  const palette = [
    [255, 0, 0],
    [0, 255, 0],
    [0, 0, 255],
    [250, 250, 250],
  ] as const;
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const block = (y < size / 2 ? 0 : 2) + (x < size / 2 ? 0 : 1);
      const [r, g, b] = palette[block];
      const i = (y * size + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return { data, width: size, height: size };
}

/** 透明夹具：左半 alpha=0（透明槽），右半不透明渐变 + 一条半透明带。 */
function transparentImage(size = 256): ImageDataLike {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      data[i] = (x * 255) / (size - 1);
      data[i + 1] = (y * 255) / (size - 1);
      data[i + 2] = 128;
      if (x < size / 2) {
        data[i + 3] = 0; // 左侧全透明（RGB 也清零，模拟常见导出）
      } else if (y < size / 8) {
        data[i + 3] = 128; // 顶部半透明带
      } else {
        data[i + 3] = 255;
      }
    }
  }
  return { data, width: size, height: size };
}

/** 平均每通道误差（只统计 alpha>0 的可见像素）。 */
function meanChannelError(a: ImageDataLike, b: ImageDataLike): number {
  const count = Math.min(a.data.length, b.data.length) >>> 2;
  let sum = 0;
  let samples = 0;
  for (let p = 0; p < count; p++) {
    const i = p * 4;
    if (a.data[i + 3] === 0) continue;
    sum += Math.abs(a.data[i] - b.data[i]);
    sum += Math.abs(a.data[i + 1] - b.data[i + 1]);
    sum += Math.abs(a.data[i + 2] - b.data[i + 2]);
    samples += 3;
  }
  return samples === 0 ? 0 : sum / samples;
}

describe("PNG aggressive（gifenc 调色板量化 + jsquash 索引色编码）", () => {
  it("高色深渐变：aggressive 显著小于无损候选，且可再解码、像素近似", async () => {
    const img = gradientImage(512);
    const lossless = await codec.encode(img);
    const aggressive = await codec.encodeLossy(img);

    // 关系断言：量化必须带来体积收益，但不锚定具体字节数
    expect(aggressive.length).toBeLessThan(lossless.length);

    const decoded = await codec.decode(aggressive);
    expect(decoded.width).toBe(512);
    expect(decoded.height).toBe(512);
    // 像素近似：允许调色板误差，但要求"肉眼可接受"（平均每通道误差 < 16/255）
    expect(meanChannelError(img, decoded)).toBeLessThan(16);
    // 不透明图的 alpha 必须全部保留
    for (let p = 0; p < decoded.data.length; p += 4) {
      if (decoded.data[p + 3] !== 255) {
        expect(decoded.data[p + 3]).toBe(255);
      }
    }
  }, 60_000);

  it("aggressive ≤ 无损候选（内部取小者：量化反而更大时落回无损）", async () => {
    for (const fixture of [gradientImage(128), blocksImage(128)]) {
      const lossless = await codec.encode(fixture);
      const aggressive = await codec.encodeLossy(fixture);
      expect(aggressive.length).toBeLessThanOrEqual(lossless.length);
    }
  }, 60_000);

  it("低色块：量化无收益（不产生更小字节，dispatch 侧落 not_smaller）", async () => {
    const img = blocksImage(256);
    const lossless = await codec.encode(img);
    const aggressive = await codec.encodeLossy(img);

    // 已是索引色友好的图：无损重编码就等于最好结果，量化不会更小
    expect(aggressive.length).toBeGreaterThanOrEqual(lossless.length);
    expect(aggressive.length).toBeLessThanOrEqual(lossless.length);
    // 像素必须完全不变（只有 4 色，调色板无损覆盖）
    const decoded = await codec.decode(aggressive);
    expect(meanChannelError(img, decoded)).toBe(0);
  }, 60_000);

  it("透明 PNG：alpha=0 像素在产物中仍为 0（透明槽保留）", async () => {
    const img = transparentImage(256);
    const lossless = await codec.encode(img);
    const aggressive = await codec.encodeLossy(img);

    const decoded = await codec.decode(aggressive);
    expect(decoded.width).toBe(256);
    expect(decoded.height).toBe(256);

    // 左侧整列透明：量化后仍是全透明（不会被量化成不透明的某个颜色）
    for (let y = 0; y < 256; y++) {
      for (let x = 0; x < 128; x++) {
        expect(decoded.data[(y * 256 + x) * 4 + 3]).toBe(0);
      }
    }
    // 可见区像素近似（含半透明带的 alpha 原样保留）
    expect(meanChannelError(img, decoded)).toBeLessThan(16);
    const midAlpha = decoded.data[(8 * 256 + 200) * 4 + 3];
    expect(midAlpha).toBe(128);
    // 透明图同样要满足"不更大"的关系（量化无收益时落回无损）
    expect(aggressive.length).toBeLessThanOrEqual(lossless.length);
  }, 60_000);

  it("调色板档位：256→128 色两档都在跑，且档位越小不保证更小（取小者兜底）", () => {
    expect(PNG_AGGRESSIVE_MAX_COLORS).toEqual([256, 128]);
    const img = gradientImage(64);
    const wide = quantizePngImage(img, 256);
    const narrow = quantizePngImage(img, 128);
    expect(wide).not.toBeNull();
    expect(narrow).not.toBeNull();
    expect(wide!.width).toBe(64);
    expect(narrow!.height).toBe(64);
  });

  it("端到端：optimizeImage 仅在 aggressive 下产出有损候选（§6.4 契约不变）", async () => {
    const img = gradientImage(512);
    const source = await codec.encode(img); // 无损重编码即原字节（同编码器合成）

    const lossless = await optimizeImage("gradient.png", source, { codecs });
    // 无损重编码不会更小 ⇒ 契约要求 not_smaller，且绝不能替换成有损字节
    expect(lossless.skipped).toBe("not_smaller");
    expect(lossless.optimized).toBeNull();

    const aggressive = await optimizeImage("gradient.png", source, {
      codecs,
      aggressive: true,
    });
    expect(aggressive.skipped).toBeNull();
    expect(aggressive.optimized).not.toBeNull();
    expect(aggressive.optimizedSize!).toBeLessThan(source.length);
    // 再解码校验（dispatch 已做一次，这里独立验证产物可用）
    const decoded = await codec.decode(aggressive.optimized!);
    expect(decoded.width).toBe(512);
    expect(meanChannelError(img, decoded)).toBeLessThan(16);
  }, 60_000);

  it("端到端：低色图 aggressive 也无收益（not_smaller，不产出更大/损坏字节）", async () => {
    const source = await codec.encode(blocksImage(256));
    const aggressive = await optimizeImage("blocks.png", source, {
      codecs,
      aggressive: true,
    });
    expect(aggressive.skipped).toBe("not_smaller");
    expect(aggressive.optimized).toBeNull();
  }, 60_000);
});
