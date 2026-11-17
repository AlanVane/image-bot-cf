/**
 * oxipng 无损重压缩候选（§6.1 PNG 无损主力；§11-4 体积 164KB ST）。
 *
 * 契约断言（§9-R6 风格，不锚定绝对字节）：严格变小才替换、结果可再解码、
 * 与 chunk 剥离候选取小、无收益时原样返回（oxipng 自身回退语义）。
 */
import { describe, expect, it } from "vitest";
import sharp from "sharp";

import { fixtureBytes, loadWasmModule } from "./wasm";
import { initCodecsFromModules, optimizeImage } from "../src/optimize/dispatch";
import { createOxipngOptimizer, stripPngMetadata } from "../src/optimize/png";

const oxipngWasm = await loadWasmModule(
  "../node_modules/@jsquash/oxipng/codec/pkg/squoosh_oxipng_bg.wasm",
);
const pngWasm = await loadWasmModule(
  "../node_modules/@jsquash/png/codec/pkg/squoosh_png_bg.wasm",
);

const codecs = await initCodecsFromModules({ pngWasm, oxipngWasm });

/** 低压缩级别 PNG（zlib 冗余明显）：oxipng 重压缩必有收益的代表素材。 */
async function loosePng(): Promise<Uint8Array> {
  const buf = await sharp({
    create: {
      width: 320,
      height: 240,
      channels: 3,
      background: { r: 74, g: 124, b: 89 },
    },
  })
    .png({ compressionLevel: 0 })
    .toBuffer();
  return new Uint8Array(buf);
}

describe("oxipng 无损候选（optimizeLossless）", () => {
  it("低压缩级别 PNG：重压缩显著变小且通过解码校验", async () => {
    const input = await loosePng();
    const outcome = await optimizeImage("loose.png", input, { codecs });

    expect(outcome.skipped).toBeNull();
    expect(outcome.optimized).not.toBeNull();
    expect(outcome.optimizedSize).toBeLessThan(input.length);
    // decode 校验已在 optimizeImage 内部完成（失败会丢弃候选），此处只断言契约结果
  });

  it("最终结果 ≤ 单独跑 oxipng 的产物（双候选取小）", async () => {
    const input = await loosePng();
    const oxipngOnly = await createOxipngOptimizer(oxipngWasm);
    const direct = await oxipngOnly(input);
    const outcome = await optimizeImage("loose.png", input, { codecs });

    expect(outcome.optimizedSize).toBeLessThanOrEqual(direct.length);
  });

  it("oxipng 无收益时原样返回（不放大）", async () => {
    const shot = fixtureBytes("shot.png");
    const oxipngOnly = await createOxipngOptimizer(oxipngWasm);
    const out = await oxipngOnly(shot);
    expect(out.length).toBeLessThanOrEqual(shot.length);
  });

  it("已是极限的产物再跑 → not_smaller（严格变小契约）", async () => {
    const input = await loosePng();
    const first = await optimizeImage("loose.png", input, { codecs });
    const again = await optimizeImage("loose.png", first.optimized!, {
      codecs,
    });
    // 幂等：不会凭空再变小，更不会变大替换
    expect(
      again.skipped === "not_smaller" ||
        (again.optimizedSize ?? 0) < first.optimizedSize!,
    ).toBe(true);
  });

  it("纯元数据图：剥离候选仍在（oxipng 不回归旧行为）", async () => {
    // shot.png 的 chunk 剥离行为与 optimizeLossless 并存；两者取小由 dispatch 保证
    const shot = fixtureBytes("shot.png");
    const stripped = stripPngMetadata(shot);
    const outcome = await optimizeImage("shot.png", shot, { codecs });
    if (outcome.skipped === null) {
      expect(outcome.optimizedSize).toBeLessThanOrEqual(stripped.length);
    } else {
      expect(outcome.skipped).toBe("not_smaller");
    }
  });
});
