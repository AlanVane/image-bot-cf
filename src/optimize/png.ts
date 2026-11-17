/**
 * PNG 优化（P1 = 无损；P2 aggressive = 调色板量化）—— 见 DESIGN.md §6.1 / §6.2 / §6.4。
 *
 * P1 无损路径：
 *   ① 字节级 chunk 剥离（tEXt / zTXt / iTXt / eXIf）——纯结构操作，像素不变；
 *   ② `@jsquash/png` decode → encode 重编码（像素无损，压缩率弱于 oxipng，§6.1 已知取舍）。
 * 两者取「严格变小且可校验」的最小者。
 *
 * `aggressive` 的 PNG = 无损候选 + **调色板量化候选**，一起竞争取小者（P2 收尾，2026-11-17）：
 *      RGBA → `gifenc.quantize`（256 色 / 128 色两档，MIT）→ `applyPalette` 还原 RGBA
 *      → `@jsquash/png` encode。jsquash 的 lodepng 侧会对 ≤256 色的 RGBA 自动选择
 *      索引色（PNG color type 3）编码，因此产物显著小于无损 RGBA 重编码。
 *      接缝：`createPngCodec()` 返回的 codec 额外带 `encodeLossy(img)`（见 `PngCodec`），
 *      dispatch 在 aggressive 时把它的返回值并入候选池；其内部已与无损重编码取小，
 *      绝不返回更大的字节。codec 本身不做体积过滤（§6.4 由 dispatch 裁决）。
 *
 * 为什么不用 pngquant / libimagequant（见 LICENSES.md / DESIGN §6.1 / §9-R7）：
 *   ① libimagequant / pngquant 是 **GPL-3**。wasm 静态链接进 Worker bundle 会把
 *      copyleft 传染到整个分发物，开源发布前无法接受（§9-R7）。
 *   ② 评估过 `wasm-image-optimization@2.0.13`（MIT，Skia 内核，有 workerd 入口）：
 *      它的 `quality` 参数只作用于 WebP/JPEG/AVIF（其 README 明示），PNG 走 Skia 的
 *      **纯无损** zlib 编码。实测 `shot.png` 在 quality = 1/30/80/100 下输出字节完全
 *      相同（均为 29,598B），因此无法充当"有损 PNG"，不引入（也省下 ~6.9MB wasm）。
 *      附带发现：它的无损 PNG 输出（29,598B）远小于 `@jsquash/png`（86,913B），
 *      可作为 P1.5 oxipng 的备选/补充，但那属于无损路径，不在本模块的 aggressive 语义内。
 *   ③ 路线记录：
 *      a. ✅ 已落地（2026-11-17）：b 路线 "permissive 量化" —— 复用 GIF 线的
 *         `gifenc.quantize` / `applyPalette`（MIT），零新依赖，见上方 aggressive 段；
 *      b. oxipng-wasm（MIT，§6.1 P1.5）仍待做，用于把**无损**压缩率做对；
 *      c. 若确要用 pngquant，只能放到 §6.3 Containers 里以独立进程调用（GPL 二进制
 *         不静态链接进 Worker bundle），并单独做分发合规评估 —— Wave 3 容器线已并行
 *         落地 sharp 的 palette 量化，属于该路线，不在本模块；
 *      d. 本模块的 aggressive 语义安全：仍然"只小才替换"，量化无收益（低色/灰度图）
 *         或量化后反而更大时落回无损候选，最终由 dispatch 的 `not_smaller` 兜底。
 *
 * 契约（§6.4）：本模块只产出候选，不做体积过滤；"严格变小 + 再解码"由 dispatch 裁决。
 *
 * 注意（§6.2）：编解码器的 wasm 必须由宿主在构建期 import 成 `WebAssembly.Module`
 * 后经 `createPngCodec()` 注入；本模块**不得**调用 WebAssembly.compile/instantiate(bytes)。
 */
import type { CodecSet, ImageDataLike } from "../types";
import pngDecode, { init as initPngDecode } from "@jsquash/png/decode.js";
import pngEncode, { init as initPngEncode } from "@jsquash/png/encode.js";
// oxipng 无损重压缩（§6.1）：直接对 PNG 字节做 IDAT 重压缩，无需解码。
// 注意绕过 @jsquash/oxipng 的 init() 包装——它按浏览器全局猜 ST/MT，
// workerd 必须钉死单线程 pkg（无 Web Worker / SharedArrayBuffer）。
import oxipngInit, {
  optimise as oxipngOptimise,
} from "@jsquash/oxipng/codec/pkg/squoosh_oxipng.js";
// gifenc 无 .d.ts（见 src/optimize/gif.ts 同一处理）；只用到通用 RGBA 量化器。
// @ts-expect-error -- gifenc 无类型声明
import { applyPalette, quantize } from "gifenc";

/** aggressive 的色数档位：两档都试，取最小者（低色图自然退化到无损候选）。 */
export const PNG_AGGRESSIVE_MAX_COLORS = [256, 128] as const;

/**
 * §6.1 接缝（由编排方在 `CodecSet["png"]` 上声明为可选方法）：
 * 返回 aggressive 的有损候选字节；无损候选由 dispatch 照旧产出，两者竞争取小。
 */
export type PngCodec = NonNullable<CodecSet["png"]> & {
  encodeLossy: (img: ImageDataLike) => Promise<Uint8Array>;
};

type Rgb = [number, number, number];

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/** 可安全丢弃的辅助 chunk（对渲染与色彩无影响）。 */
const STRIPPABLE_CHUNKS = new Set(["tEXt", "zTXt", "iTXt", "eXIf"]);

export function hasPngSignature(bytes: Uint8Array): boolean {
  if (bytes.length < PNG_SIGNATURE.length) return false;
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (bytes[i] !== PNG_SIGNATURE[i]) return false;
  }
  return true;
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] << 24) |
      (bytes[offset + 1] << 16) |
      (bytes[offset + 2] << 8) |
      bytes[offset + 3]) >>>
    0
  );
}

/** 读取 IHDR 的宽高；非 PNG 或头部损坏时返回 null。 */
export function readPngSize(
  bytes: Uint8Array,
): { width: number; height: number } | null {
  if (bytes.length < 24 || !hasPngSignature(bytes)) return null;
  // IHDR 必须是第一个 chunk
  if (
    bytes[12] !== 0x49 ||
    bytes[13] !== 0x48 ||
    bytes[14] !== 0x44 ||
    bytes[15] !== 0x52
  ) {
    return null;
  }
  const width = readU32(bytes, 16);
  const height = readU32(bytes, 20);
  if (width === 0 || height === 0) return null;
  return { width, height };
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * 丢弃元数据 chunk 与 IEND 之后的尾随字节。
 * 只整块删除（IDAT 不动），因此不会破坏像素；任何结构异常都原样返回。
 */
export function stripPngMetadata(bytes: Uint8Array): Uint8Array {
  if (!hasPngSignature(bytes) || bytes.length < 8) return bytes;

  const parts: Uint8Array[] = [bytes.subarray(0, 8)];
  let offset = 8;
  let changed = false;
  let sawIend = false;

  while (offset + 8 <= bytes.length) {
    const length = readU32(bytes, offset);
    const type = String.fromCharCode(
      bytes[offset + 4],
      bytes[offset + 5],
      bytes[offset + 6],
      bytes[offset + 7],
    );
    // chunk 总长 = 4(len) + 4(type) + data + 4(crc)
    const end = offset + 12 + length;
    if (length > 0x7fffffff || end > bytes.length) return bytes; // 结构损坏 → 不动

    if (STRIPPABLE_CHUNKS.has(type)) {
      changed = true;
    } else {
      parts.push(bytes.subarray(offset, end));
    }
    offset = end;

    if (type === "IEND") {
      sawIend = true;
      break;
    }
  }

  if (!sawIend) return bytes;
  const hasTrailingBytes = offset < bytes.length;
  if (!changed && !hasTrailingBytes) return bytes;
  return concat(parts);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * 结构校验：签名 + chunk 链完整 + CRC 正确 + 有 IHDR/IEND。
 * 无 wasm 解码器时的兜底校验（§6.4 的降级路径）。
 */
export function validatePngStructure(bytes: Uint8Array): boolean {
  if (!hasPngSignature(bytes)) return false;
  let offset = 8;
  let sawIhdr = false;
  let sawIend = false;

  while (offset + 8 <= bytes.length) {
    const length = readU32(bytes, offset);
    const type = String.fromCharCode(
      bytes[offset + 4],
      bytes[offset + 5],
      bytes[offset + 6],
      bytes[offset + 7],
    );
    const end = offset + 12 + length;
    if (length > 0x7fffffff || end > bytes.length) return false;
    const expected = readU32(bytes, end - 4);
    if (crc32(bytes, offset + 4, end - 4) !== expected) return false;

    if (!sawIhdr && type !== "IHDR") return false; // IHDR 必须最先出现
    if (type === "IHDR") sawIhdr = true;
    offset = end;
    if (type === "IEND") {
      sawIend = true;
      break;
    }
  }
  return sawIhdr && sawIend;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer as ArrayBuffer;
  }
  return bytes.slice().buffer as ArrayBuffer;
}

/**
 * 调色板量化：RGBA → ≤`maxColors` 色 → 还原 RGBA（视觉有损，像素近似）。
 *
 * 约定：
 *   - alpha = 0 的像素不参与量化（不占色位），还原时写 `(0,0,0,0)` —— 透明保持完全透明；
 *   - 部分透明（0 < a < 255）像素按 RGB 参与量化，alpha **原样保留**（不做二值化，
 *     避免边缘出现硬锯齿；代价是这类图不会退化成索引色 PNG，收益小于全不透明图）；
 *   - `gifenc` 的 `quantize`/`applyPalette` 内部按 `new Uint32Array(rgba.buffer)` 读取，
 *     必须是 offset=0 且长度恰好 4×N 的紧凑缓冲区 ⇒ 先拷出不透明像素（同 gif.ts）。
 *
 * 无收益/不适用的情形返回 null（调用方保留无损候选）：全透明、尺寸非法、调色板为空。
 */
export function quantizePngImage(
  img: ImageDataLike,
  maxColors: number,
): ImageDataLike | null {
  const { width, height } = img;
  const source = img.data;
  const pixelCount = width * height;
  if (!Number.isFinite(pixelCount) || pixelCount <= 0) return null;
  if (source.length < pixelCount * 4) return null;

  let visible = 0;
  for (let p = 0; p < pixelCount; p++) {
    if (source[p * 4 + 3] !== 0) visible++;
  }
  if (visible === 0) return null; // 全透明：量化无意义

  const budget = Math.max(2, Math.min(256, Math.floor(maxColors)));
  const compact = new Uint8Array(visible * 4);
  let cursor = 0;
  for (let p = 0; p < pixelCount; p++) {
    const offset = p * 4;
    if (source[offset + 3] === 0) continue;
    compact[cursor++] = source[offset];
    compact[cursor++] = source[offset + 1];
    compact[cursor++] = source[offset + 2];
    compact[cursor++] = 255; // 不透明，避免 alpha 位进入量化
  }

  const palette = quantize(compact, budget) as Rgb[];
  if (!Array.isArray(palette) || palette.length === 0) return null;
  const mapped = applyPalette(compact, palette) as Uint8Array;

  // 初始全 0 ⇒ 透明像素天然是 (0,0,0,0)，且大片透明区更易压缩
  const out = new Uint8ClampedArray(pixelCount * 4);
  let index = 0;
  for (let p = 0; p < pixelCount; p++) {
    const offset = p * 4;
    if (source[offset + 3] === 0) continue;
    const color = palette[mapped[index++]] ?? [0, 0, 0];
    out[offset] = color[0];
    out[offset + 1] = color[1];
    out[offset + 2] = color[2];
    out[offset + 3] = source[offset + 3];
  }
  return { data: out, width, height };
}

/**
 * 由宿主注入的预编译 wasm Module 构造 PNG 编解码器（§6.2：禁止运行时编译 wasm）。
 *
 * - `encode(img)` = 像素无损重编码（行为不变，默认模式仍走这里）；
 * - `encodeLossy(img)` = aggressive 的有损候选：256 / 128 色两档量化各编码一次，与
 *   无损重编码一起取**最小**者（量化抛错/无收益/反而更大时返回无损字节）。
 * 仍然只产出候选：是否替换由 dispatch 的"严格变小 + 再解码"契约裁决（§6.4）。
 */
export async function createPngCodec(
  wasmModule: WebAssembly.Module,
): Promise<PngCodec> {
  await initPngDecode(wasmModule);
  await initPngEncode(wasmModule);

  const encodeLossless = async (img: ImageDataLike): Promise<Uint8Array> =>
    new Uint8Array(await pngEncode(img));

  const encodeLossy = async (img: ImageDataLike): Promise<Uint8Array> => {
    let best = await encodeLossless(img);
    for (const maxColors of PNG_AGGRESSIVE_MAX_COLORS) {
      try {
        const quantized = quantizePngImage(img, maxColors);
        if (!quantized) continue;
        const bytes = await encodeLossless(quantized);
        // 量化反而更大（低色/灰度图）⇒ 保留更小的无损候选
        if (bytes.length > 0 && bytes.length < best.length) best = bytes;
      } catch {
        // 单档失败不影响其他候选；无损候选兜底（§6.4：绝不产出损坏字节）
      }
    }
    return best;
  };

  return {
    decode: (bytes: Uint8Array): Promise<ImageDataLike> =>
      pngDecode(toArrayBuffer(bytes)) as Promise<ImageDataLike>,
    encode: encodeLossless,
    encodeLossy,
  };
}

/**
 * oxipng 无损重压缩候选（§6.1 PNG 无损主力；§11-4：ST wasm 164KB）。
 * 字节进字节出（IDAT 重压缩，不解码像素）；oxipng 自身无收益时原样返回，
 * 由 dispatch 的"严格变小"契约统一裁决。
 *
 * 参数：level 2（oxipng 默认安全档，速度/压缩率均衡）；
 * interlace/optimiseAlpha 关闭——输出隔行与透明像素字节均保持无损语义。
 */
export async function createOxipngOptimizer(
  wasmModule: WebAssembly.Module,
): Promise<(bytes: Uint8Array) => Promise<Uint8Array>> {
  await oxipngInit(wasmModule);
  return async (bytes: Uint8Array): Promise<Uint8Array> =>
    oxipngOptimise(bytes, 2, false, false);
}
