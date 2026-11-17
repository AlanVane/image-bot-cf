/**
 * `aggressiveCompression: true` 的端到端契约测试（DESIGN §2.3 / §6.1 / §6.4）。
 *
 * 重点：
 *   - JPEG：build-time import 的 mozjpeg enc/dec 经 `initCodecsFromModules()` 注入后，
 *     `aggressive: true` 必须产出 q80 有损候选，并且该候选**始终**满足
 *     「严格变小 + 再解码通过」；与无损段剥离候选**竞争取小**。
 *   - PNG：P2 有损尚未落地（pngquant GPL-3 不采纳；wasm-image-optimization 的 PNG 编码
 *     实测是无损），因此 aggressive 与无损同路 —— 断言两者结果一致且仍然只小才替换。
 *
 * 测试宿主负责构造 `WebAssembly.Module`（src/ 内禁止运行时编译 wasm，§6.2）。
 */
import { describe, expect, it, vi } from "vitest";
import { fixtureBytes, loadWasmModule } from "./wasm";

import type { CodecSet } from "../src/types";
import {
  JPEG_AGGRESSIVE_QUALITY,
  initCodecsFromModules,
  optimizeImage,
} from "../src/optimize/dispatch";
import { stripJpegMetadata } from "../src/optimize/jpeg";

const codecs: CodecSet = await initCodecsFromModules({
  pngWasm: await loadWasmModule(
    "../node_modules/@jsquash/png/codec/pkg/squoosh_png_bg.wasm",
  ),
  jpegEncWasm: await loadWasmModule(
    "../node_modules/@jsquash/jpeg/codec/enc/mozjpeg_enc.wasm",
  ),
  jpegDecWasm: await loadWasmModule(
    "../node_modules/@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm",
  ),
});

function concatParts(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** 在 SOI 之后插入 COM(FFFE) 段，模拟带注释/元数据的 JPEG。 */
function injectComSegment(jpeg: Uint8Array, text: string): Uint8Array {
  const payload = new TextEncoder().encode(text);
  const segment = new Uint8Array(4 + payload.length);
  segment[0] = 0xff;
  segment[1] = 0xfe;
  const length = payload.length + 2; // 含长度字段自身
  segment[2] = (length >> 8) & 0xff;
  segment[3] = length & 0xff;
  segment.set(payload, 4);
  return concatParts(jpeg.subarray(0, 2), segment, jpeg.subarray(2));
}

describe("JPEG aggressive（mozjpeg q80，端到端）", () => {
  it("带元数据的照片：有损候选显著变小，且再解码通过、尺寸不变", async () => {
    const original = fixtureBytes("photo.jpg");
    const injected = injectComSegment(
      original,
      "imgbot aggressive test ".repeat(256),
    );
    expect(injected.length).toBeGreaterThan(original.length);

    const outcome = await optimizeImage("photo.jpg", injected, {
      aggressive: true,
      codecs,
    });

    expect(outcome.skipped).toBeNull();
    expect(outcome.optimized).not.toBeNull();
    expect(outcome.optimizedSize).toBe(outcome.optimized!.length);
    // 契约①：严格变小
    expect(outcome.optimizedSize!).toBeLessThan(injected.length);
    // q80 重编码应"显著"小于含元数据原图（不是只删掉几 KB 注释）
    expect(outcome.optimizedSize!).toBeLessThan(injected.length * 0.9);

    // 契约②：再解码通过，像素网格尺寸不变
    const decoded = await codecs.jpeg!.decode!(outcome.optimized!);
    expect(decoded.width).toBe(2000);
    expect(decoded.height).toBe(1500);
    expect(decoded.data.length).toBe(2000 * 1500 * 4);
    expect(JPEG_AGGRESSIVE_QUALITY).toBe(80);
  }, 60_000);

  it("与无损段剥离候选竞争：dispatch 取更小者（aggressive 候选胜出）", async () => {
    const original = fixtureBytes("photo.jpg");
    const injected = injectComSegment(
      original,
      "imgbot aggressive test ".repeat(64),
    );

    const lossless = await optimizeImage("photo.jpg", injected, { codecs });
    const aggressive = await optimizeImage("photo.jpg", injected, {
      aggressive: true,
      codecs,
    });

    // 无损路径只删注释段，产物 = 原始照片大小
    expect(lossless.skipped).toBeNull();
    expect(lossless.optimizedSize).toBe(original.length);

    // 有损候选更小 → 竞争中胜出
    expect(aggressive.skipped).toBeNull();
    expect(aggressive.optimizedSize!).toBeLessThan(lossless.optimizedSize!);

    // 产物应恰好是 dispatch 内部那枚 q80 候选（同一输入 → 同一编码参数）
    const img = await codecs.jpeg!.decode!(injected);
    const q80 = await codecs.jpeg!.encode!(img, {
      quality: JPEG_AGGRESSIVE_QUALITY,
    });
    expect(aggressive.optimizedSize!).toBe(q80.length);

    // 最终字节仍可解码
    const decoded = await codecs.jpeg!.decode!(aggressive.optimized!);
    expect(decoded.width).toBe(2000);
    expect(decoded.height).toBe(1500);
  }, 60_000);

  it("无元数据照片：无损 not_smaller，aggressive 仍能变小并满足契约", async () => {
    const original = fixtureBytes("photo.jpg");

    const lossless = await optimizeImage("photo.jpg", original, { codecs });
    expect(lossless.skipped).toBe("not_smaller");
    expect(lossless.optimized).toBeNull();

    const aggressive = await optimizeImage("photo.jpg", original, {
      aggressive: true,
      codecs,
    });
    expect(aggressive.skipped).toBeNull();
    expect(aggressive.optimizedSize!).toBeLessThan(original.length);
    expect(aggressive.optimizedSize!).toBeLessThan(original.length * 0.9);

    const decoded = await codecs.jpeg!.decode!(aggressive.optimized!);
    expect(decoded.width).toBe(2000);
    expect(decoded.height).toBe(1500);
  }, 60_000);

  it("aggressive=false 时不触发有损编码（只走段剥离）", async () => {
    // 解码器仍会用于 §6.4 的候选校验，因此保留真解码；只监视编码器。
    const encode = vi.fn(async () => new Uint8Array(1));
    const spied: CodecSet = {
      jpeg: {
        stripMetadata: stripJpegMetadata,
        decode: codecs.jpeg!.decode,
        encode,
      },
    };

    const original = fixtureBytes("photo.jpg");
    const injected = injectComSegment(original, "lossless only ".repeat(16));
    const outcome = await optimizeImage("photo.jpg", injected, {
      aggressive: false,
      codecs: spied,
    });

    expect(outcome.skipped).toBeNull();
    expect(outcome.optimizedSize).toBe(original.length);
    expect(encode).not.toHaveBeenCalled();
  }, 60_000);
});

describe("PNG aggressive（P2 有损未落地：暂与无损同路）", () => {
  it("aggressive 与无损输出完全一致，且仍然只小才替换", async () => {
    const original = fixtureBytes("shot.png");

    const lossless = await optimizeImage("shot.png", original, { codecs });
    const aggressive = await optimizeImage("shot.png", original, {
      aggressive: true,
      codecs,
    });

    // 当前实现：aggressive 不分流（见 src/optimize/png.ts 头注释）。
    // P2 落地 PNG 有损后，这条断言应改为「aggressive 严格更小」。
    expect(aggressive.skipped).toBe(lossless.skipped);
    expect(aggressive.optimizedSize).toBe(lossless.optimizedSize);
    expect(aggressive.optimized).toEqual(lossless.optimized);

    if (aggressive.optimized) {
      // 契约①：严格变小
      expect(aggressive.optimizedSize!).toBeLessThan(original.length);
      // 契约②：再解码通过
      const decoded = await codecs.png!.decode(aggressive.optimized);
      expect(decoded.width).toBe(2000);
      expect(decoded.height).toBe(1500);
      expect(decoded.data.length).toBe(2000 * 1500 * 4);
    } else {
      expect(["not_smaller", "decode_failed"]).toContain(aggressive.skipped);
    }
  }, 60_000);
});
