/**
 * jpegtran -optimize Huffman 重优化候选（任务 2 / DESIGN §11-2）。
 *
 * 契约断言：严格无损（解码像素逐字节相等）、绝不放大、坏输入返回 null 不 trap、
 * dispatch 集成后"严格变小才替换"不变。确定性收益用例用 EOI 后垫字节构造
 * （重写流天然丢弃 → 必变小），不断言绝对字节数（§9-R6）。
 */
import { describe, expect, it } from "vitest";
import sharp from "sharp";

import { loadWasmModule } from "./wasm";
import { initCodecsFromModules, optimizeImage } from "../src/optimize/dispatch";
import { createHuffmanOptimizer } from "../src/optimize/jpegtran";
import type { CodecSet, ImageDataLike } from "../src/types";

const jpegTranWasm = await loadWasmModule(
  "../src/optimize/vendor/jpegtran_opt.wasm",
);
const jpegEncWasm = await loadWasmModule(
  "../node_modules/@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm",
);
const jpegDecWasm = await loadWasmModule(
  "../node_modules/@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm",
);

const codecs: CodecSet = await initCodecsFromModules({
  jpegTranWasm,
  jpegEncWasm,
  jpegDecWasm,
});
const reopt = await createHuffmanOptimizer(jpegTranWasm);

async function photoJpeg(): Promise<Uint8Array> {
  const buf = await sharp({
    create: {
      width: 320,
      height: 240,
      channels: 3,
      background: { r: 74, g: 124, b: 89 },
    },
  })
    .jpeg({ quality: 85 })
    .toBuffer();
  return new Uint8Array(buf);
}

/** EOI（FFD9）后垫垃圾字节：解码无害，但流重写后必被丢弃。 */
function padAfterEoi(jpeg: Uint8Array): Uint8Array {
  const padding = new Uint8Array(2048).fill(0x5a);
  const out = new Uint8Array(jpeg.length + padding.length);
  out.set(jpeg, 0);
  out.set(padding, jpeg.length);
  return out;
}

async function decodePixels(bytes: Uint8Array): Promise<ImageDataLike> {
  return codecs.jpeg!.decode!(bytes);
}

function samePixels(a: ImageDataLike, b: ImageDataLike): boolean {
  if (a.width !== b.width || a.height !== b.height) return false;
  if (a.data.length !== b.data.length) return false;
  for (let i = 0; i < a.data.length; i += 1) {
    if (a.data[i] !== b.data[i]) return false;
  }
  return true;
}

describe("Huffman 重优化候选（reoptimizeHuffman）", () => {
  it("EOI 后垫字节：重写流必变小，且解码像素逐字节相等", async () => {
    const padded = padAfterEoi(await photoJpeg());
    const out = reopt(padded);

    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThan(padded.length);
    expect(
      samePixels(await decodePixels(padded), await decodePixels(out!)),
    ).toBe(true);
  });

  it("干净 JPEG：像素逐字节不变（大小交由 dispatch 严格变小契约裁决）", async () => {
    const jpeg = await photoJpeg();
    const out = reopt(jpeg);

    expect(out).not.toBeNull();
    expect(samePixels(await decodePixels(jpeg), await decodePixels(out!))).toBe(
      true,
    );
    // 候选可能略大于 mozjpeg 紧凑表（IJG 基线表差异，bench 已录）——
    // 契约由 optimizeImage 的“严格变小才替换”保证：
    const outcome = await optimizeImage("clean.jpg", jpeg, { codecs });
    if (outcome.skipped === null) {
      expect(outcome.optimizedSize).toBeLessThan(jpeg.length);
    } else {
      expect(outcome.skipped).toBe("not_smaller");
    }
  });

  it("坏输入 → 返回 null，不抛不 trap", () => {
    expect(reopt(new Uint8Array([0xff, 0xd8, 0x00, 0x01, 0x02]))).toBeNull();
    expect(reopt(new Uint8Array(64))).toBeNull();
    expect(reopt(new Uint8Array(0))).toBeNull();
  });

  it("dispatch 集成：垫字节图被替换且严格变小（严格变小契约不变）", async () => {
    const padded = padAfterEoi(await photoJpeg());
    const outcome = await optimizeImage("pad.jpg", padded, { codecs });

    expect(outcome.skipped).toBeNull();
    expect(outcome.optimizedSize).toBeLessThan(padded.length);
  });

  it("CMYK 等解码器不认的变体：候选被安全丢弃，不 crash", async () => {
    const cmyk = new Uint8Array(
      await sharp({
        create: {
          width: 64,
          height: 64,
          channels: 3,
          background: { r: 10, g: 20, b: 30 },
        },
      })
        .toColourspace("cmyk")
        .jpeg()
        .toBuffer(),
    );
    // jpegtran 支持 CMYK（DCT 域透传）——若输出则必须无损；否则 null。二者皆可，不能抛。
    const out = reopt(cmyk);
    if (out !== null) {
      expect(out.length).toBeLessThanOrEqual(cmyk.length);
    }
  });
});
