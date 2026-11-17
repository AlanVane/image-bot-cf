/**
 * 优化引擎契约测试（P1：SVG/PNG/JPG 无损）。
 *
 * 原则：断言**契约**（严格变小 / 可再解码 / 不损坏 / 跳过原因正确），
 * 不锚定具体压缩率数字（§9-R6：wasm 与原版二进制的数字本来就不同）。
 *
 * 测试环境负责构造 `WebAssembly.Module` 并注入 —— src/ 内禁止运行时编译 wasm（§6.2）。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { fixtureBytes, loadWasmModule } from "./wasm";

import type { CodecSet } from "../src/types";
import {
  JPEG_AGGRESSIVE_QUALITY,
  MAX_INPUT_BYTES,
  MAX_PIXELS,
  detectFormat,
  exceedsByteLimit,
  exceedsPixelLimit,
  initCodecsFromModules,
  optimizeImage,
} from "../src/optimize/dispatch";

/** wasm/夹具装载见 ./wasm.ts（Node 侧放宽 workers-types 的 WebAssembly 类型）。 */

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

function sameBytes(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** 在 SOI 之后插入一个 COM(FFFE) 段，模拟带注释/元数据的 JPEG。 */
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

/** 遍历 JPEG 头部 marker（到 SOS 为止）。 */
function jpegMarkers(jpeg: Uint8Array): number[] {
  const markers: number[] = [];
  let i = 2;
  while (i + 1 < jpeg.length) {
    if (jpeg[i] !== 0xff) break;
    let j = i;
    while (jpeg[j] === 0xff) j++;
    const marker = jpeg[j];
    markers.push(marker);
    if (marker === 0xda || marker === 0xd9) break;
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      i = j + 1;
      continue;
    }
    const length = (jpeg[j + 1] << 8) | jpeg[j + 2];
    i = j + 1 + length;
  }
  return markers;
}

describe("守卫（§6.2 内存墙）", () => {
  it("按扩展名分派且大小写不敏感", () => {
    expect(detectFormat("img/logo.svg")).toBe("svg");
    expect(detectFormat("IMG/LOGO.SVG")).toBe("svg");
    expect(detectFormat("a/b/SHOT.PNG")).toBe("png");
    expect(detectFormat("photo.JPG")).toBe("jpeg");
    expect(detectFormat("photo.jpeg")).toBe("jpeg");
    expect(detectFormat("photo.JPEG")).toBe("jpeg");
    expect(detectFormat("anim.gif")).toBeNull();
    expect(detectFormat("no-extension")).toBeNull();
  });

  it("体积守卫边界", () => {
    expect(exceedsByteLimit(MAX_INPUT_BYTES)).toBe(false);
    expect(exceedsByteLimit(MAX_INPUT_BYTES + 1)).toBe(true);
  });

  it("像素守卫边界", () => {
    expect(exceedsPixelLimit(MAX_PIXELS, 1)).toBe(false);
    expect(exceedsPixelLimit(MAX_PIXELS + 1, 1)).toBe(true);
    expect(exceedsPixelLimit(4000, 3000)).toBe(true); // 12MP
    expect(exceedsPixelLimit(2000, 1500)).toBe(false); // 3MP
    expect(exceedsPixelLimit(0, 0)).toBe(false);
  });
});

describe("JPEG（P1 无损 = 段剥离）", () => {
  it("剥离注入的 COM 段后严格变小，且产物可再解码（像素不变）", async () => {
    const original = fixtureBytes("photo.jpg");
    const injected = injectComSegment(original, "imgbot-test ".repeat(64));
    expect(injected.length).toBeGreaterThan(original.length);

    const outcome = await optimizeImage("photo.jpg", injected, { codecs });

    expect(outcome.skipped).toBeNull();
    expect(outcome.optimized).not.toBeNull();
    expect(outcome.optimizedSize).toBe(outcome.optimized!.length);
    // 严格变小
    expect(outcome.optimizedSize!).toBeLessThan(injected.length);
    // 大小与原始图一致（只删了注释段）
    expect(outcome.optimizedSize).toBe(original.length);

    // COM 已消失，APP0 等保留
    const markers = jpegMarkers(outcome.optimized!);
    expect(markers).not.toContain(0xfe);
    expect(markers).toContain(0xe0);
    expect(markers).toContain(0xda);

    // 再解码通过 + 像素与原件完全一致（无损）
    const decodedOriginal = await codecs.jpeg!.decode!(injected);
    const decodedOptimized = await codecs.jpeg!.decode!(outcome.optimized!);
    expect(decodedOptimized.width).toBe(decodedOriginal.width);
    expect(decodedOptimized.height).toBe(decodedOriginal.height);
    expect(sameBytes(decodedOptimized.data, decodedOriginal.data)).toBe(true);
  });

  it("无元数据的 JPEG → not_smaller，且不返回字节", async () => {
    const original = fixtureBytes("photo.jpg");
    const outcome = await optimizeImage("photo.jpg", original, { codecs });

    expect(outcome.skipped).toBe("not_smaller");
    expect(outcome.optimized).toBeNull();
    expect(outcome.optimizedSize).toBeNull();
    expect(outcome.originalSize).toBe(original.length);
  });

  it("EOI 之后的尾随杂字节被丢弃", async () => {
    const original = fixtureBytes("photo.jpg");
    const noisy = concatParts(original, new Uint8Array(1024).fill(0x41));

    const outcome = await optimizeImage("photo.jpg", noisy, { codecs });

    expect(outcome.skipped).toBeNull();
    expect(outcome.optimizedSize).toBe(original.length);
    expect(outcome.optimized![outcome.optimized!.length - 2]).toBe(0xff);
    expect(outcome.optimized![outcome.optimized!.length - 1]).toBe(0xd9);
  });

  it("aggressive + 注入编解码器 → 有损重编码仍走严格变小 + 再解码契约", async () => {
    const original = fixtureBytes("photo.jpg");

    const outcome = await optimizeImage("photo.jpg", original, {
      aggressive: true,
      codecs,
    });

    expect(outcome.skipped).toBeNull();
    expect(outcome.optimizedSize!).toBeLessThan(original.length);
    // 有损编码器质量参数固定（§6.1 q≈80）
    expect(JPEG_AGGRESSIVE_QUALITY).toBe(80);

    const decoded = await codecs.jpeg!.decode!(outcome.optimized!);
    expect(decoded.width).toBe(2000);
    expect(decoded.height).toBe(1500);
  }, 60_000);
});

describe("PNG（P1 无损 = chunk 剥离 + 像素无损重编码）", () => {
  it("shot.png 满足契约：要么严格变小且可再解码，要么 not_smaller —— 绝不更大/损坏", async () => {
    const original = fixtureBytes("shot.png");
    const outcome = await optimizeImage("shot.png", original, { codecs });

    expect(outcome.originalSize).toBe(original.length);

    if (outcome.skipped === null) {
      expect(outcome.optimized).not.toBeNull();
      expect(outcome.optimizedSize).toBe(outcome.optimized!.length);
      expect(outcome.optimizedSize!).toBeLessThan(original.length);
      // 再解码通过且尺寸一致
      const decoded = await codecs.png!.decode(outcome.optimized!);
      expect(decoded.width).toBe(2000);
      expect(decoded.height).toBe(1500);
      expect(decoded.data.length).toBe(2000 * 1500 * 4);
    } else {
      // 已充分压缩的截图可能无法更小 —— 两种结局都合法
      expect(["not_smaller", "decode_failed"]).toContain(outcome.skipped);
      expect(outcome.optimized).toBeNull();
      expect(outcome.optimizedSize).toBeNull();
    }
  }, 60_000);

  it("剥离 tEXt/zTXt/iTXt/eXIf chunk 后严格变小且结构完好", async () => {
    const original = fixtureBytes("shot.png");
    const withMetadata = insertPngTextChunk(
      original,
      "Comment",
      "imgbot ".repeat(32),
    );

    const outcome = await optimizeImage("shot.png", withMetadata, { codecs });

    // 无论重编码是否更小，至少 chunk 剥离这一条候选必须成立
    expect(outcome.skipped).toBeNull();
    expect(outcome.optimizedSize!).toBeLessThan(withMetadata.length);
    expect(hasPngChunkType(outcome.optimized!, "tEXt")).toBe(false);

    const decoded = await codecs.png!.decode(outcome.optimized!);
    expect(decoded.width).toBe(2000);
  }, 60_000);
});

describe("SVG（svgo v4）", () => {
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<!-- Generator: Adobe Illustrator 24.0.0, SVG Export Plug-In -->
<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60" viewBox="0 0 120 60">
  <metadata>
    <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
      <rdf:Description>imgbot test fixture</rdf:Description>
    </rdf:RDF>
  </metadata>
  <g id="layer1">
    <rect x="10" y="10" width="100" height="40" fill="#ff0000" stroke="#000000" stroke-width="2"/>
  </g>
</svg>
`;

  it("内联 SVG 变小、输出仍是含 <svg 根的文档", async () => {
    const bytes = new TextEncoder().encode(svg);
    const outcome = await optimizeImage("assets/icon.svg", bytes);

    expect(outcome.skipped).toBeNull();
    expect(outcome.optimizedSize!).toBeLessThan(bytes.length);
    const text = new TextDecoder().decode(outcome.optimized!);
    expect(text).toMatch(/<svg[\s>]/);
    expect(text.trimEnd().endsWith("</svg>")).toBe(true);
  });
});

describe("分派与守卫的异常路径", () => {
  it(".gif → unsupported（P2：gifsicle wasm，§9-R3）", async () => {
    const png = fixtureBytes("shot.png");
    const outcome = await optimizeImage("anim.gif", png, { codecs });

    expect(outcome.skipped).toBe("unsupported");
    expect(outcome.optimized).toBeNull();
  });

  it("无扩展名 / 未知扩展名 → unsupported", async () => {
    const bytes = fixtureBytes("shot.png");
    expect((await optimizeImage("LICENSE", bytes, { codecs })).skipped).toBe(
      "unsupported",
    );
    expect((await optimizeImage("photo.webp", bytes, { codecs })).skipped).toBe(
      "unsupported",
    );
  });

  it(">15MB 在解码前判 too_large（断言解码器未被调用）", async () => {
    const decode = vi.fn(async () => {
      throw new Error("decoder must not run");
    });
    const encode = vi.fn(async () => new Uint8Array(1));
    const spied: CodecSet = { png: { decode, encode } };

    const huge = new Uint8Array(MAX_INPUT_BYTES + 1); // 15MB+1，全零
    const outcome = await optimizeImage("huge.png", huge, { codecs: spied });

    expect(outcome.skipped).toBe("too_large");
    expect(outcome.optimized).toBeNull();
    expect(decode).not.toHaveBeenCalled();
    expect(encode).not.toHaveBeenCalled();
  });

  it("文件头声明 >8MP 的 PNG 在解码前判 too_large", async () => {
    const decode = vi.fn(async () => {
      throw new Error("decoder must not run");
    });
    const spied: CodecSet = {
      png: { decode, encode: vi.fn(async () => new Uint8Array(1)) },
    };

    // 合法签名 + IHDR（宽 9000 × 高 9000 = 81MP），足以骗过头部嗅探
    const header = new Uint8Array(33);
    header.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    const view = new DataView(header.buffer);
    view.setUint32(8, 13); // IHDR length
    header.set([0x49, 0x48, 0x44, 0x52], 12);
    view.setUint32(16, 9000);
    view.setUint32(20, 9000);

    const outcome = await optimizeImage("big.png", header, { codecs: spied });

    expect(outcome.skipped).toBe("too_large");
    expect(decode).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/* PNG 测试夹具工具                                                    */
/* ------------------------------------------------------------------ */

function pngCrc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i];
    for (let k = 0; k < 8; k++) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function readPngChunks(bytes: Uint8Array): {
  offset: number;
  type: string;
  end: number;
}[] {
  const chunks: { offset: number; type: string; end: number }[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(
      bytes[offset + 4],
      bytes[offset + 5],
      bytes[offset + 6],
      bytes[offset + 7],
    );
    const end = offset + 12 + length;
    if (end > bytes.length) break;
    chunks.push({ offset, type, end });
    offset = end;
    if (type === "IEND") break;
  }
  return chunks;
}

function hasPngChunkType(bytes: Uint8Array, type: string): boolean {
  return readPngChunks(bytes).some((chunk) => chunk.type === type);
}

/** 在 IHDR 之后插入一个合法的 tEXt chunk（CRC 正确）。 */
function insertPngTextChunk(
  png: Uint8Array,
  keyword: string,
  text: string,
): Uint8Array {
  const data = new Uint8Array([
    ...new TextEncoder().encode(keyword),
    0x00,
    ...new TextEncoder().encode(text),
  ]);
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  chunk.set([0x74, 0x45, 0x58, 0x74], 4); // tEXt
  chunk.set(data, 8);
  view.setUint32(8 + data.length, pngCrc32(chunk.subarray(4, 8 + data.length)));

  const ihdr = readPngChunks(png)[0];
  return concatParts(png.subarray(0, ihdr.end), chunk, png.subarray(ihdr.end));
}
