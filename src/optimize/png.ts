/**
 * PNG 优化（P1 = 无损）—— 见 DESIGN.md §6.1 / §6.2 / §6.4。
 *
 * P1 无损路径：
 *   ① 字节级 chunk 剥离（tEXt / zTXt / iTXt / eXIf）——纯结构操作，像素不变；
 *   ② `@jsquash/png` decode → encode 重编码（像素无损，压缩率弱于 oxipng，§6.1 已知取舍）。
 * 两者取「严格变小且可校验」的最小者。
 *
 * `aggressive` 的 PNG = 暂与无损同路（P1 收尾结论，2026-11-17）。
 *
 * 为什么暂时不做有损 PNG（见 LICENSES.md / DESIGN §6.1 / §9-R7）：
 *   ① 唯一成熟的 PNG 量化器是 pngquant / libimagequant，**GPL-3**。wasm 静态链接进
 *      Worker bundle 会把 copyleft 传染到整个分发物，开源发布前无法接受。
 *   ② 评估过 `wasm-image-optimization@2.0.13`（MIT，Skia 内核，有 workerd 入口）：
 *      它的 `quality` 参数只作用于 WebP/JPEG/AVIF（其 README 明示），PNG 走 Skia 的
 *      **纯无损** zlib 编码。实测 `shot.png` 在 quality = 1/30/80/100 下输出字节完全
 *      相同（均为 29,598B），因此无法充当"有损 PNG"，不引入（也省下 ~6.9MB wasm）。
 *      附带发现：它的无损 PNG 输出（29,598B）远小于 `@jsquash/png`（86,913B），
 *      可作为 P1.5 oxipng 的备选/补充，但那属于无损路径，不在本模块的 aggressive 语义内。
 *   ③ 续作路径（按优先级）：
 *      a. oxipng-wasm（MIT，§6.1 P1.5）先把无损压缩率做对；
 *      b. 有损量化优先找 permissive 实现（如自研调色板量化 + 索引色 PNG，或等待
 *         MIT/Apache 的 libimagequant 替代），须过 §9-R7 许可证评审；
 *      c. 若确要用 pngquant，只能放到 §6.3 Containers 里以独立进程调用（GPL 二进制
 *         不静态链接进 Worker bundle），并单独做分发合规评估；
 *      d. 在此之前 aggressive PNG 与无损完全一致 —— 语义安全（仍然"只小才替换"），
 *         只是省得少。
 *
 * TODO(P2)：PNG 有损 = 调色板量化；落地时在此处新增 encode 候选并补充 aggressive 测试。
 *
 * 注意（§6.2）：编解码器的 wasm 必须由宿主在构建期 import 成 `WebAssembly.Module`
 * 后经 `createPngCodec()` 注入；本模块**不得**调用 WebAssembly.compile/instantiate(bytes)。
 */
import type { CodecSet, ImageDataLike } from "../types";
import pngDecode, { init as initPngDecode } from "@jsquash/png/decode.js";
import pngEncode, { init as initPngEncode } from "@jsquash/png/encode.js";

export type PngCodec = NonNullable<CodecSet["png"]>;

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
 * 由宿主注入的预编译 wasm Module 构造 PNG 编解码器（§6.2：禁止运行时编译 wasm）。
 */
export async function createPngCodec(
  wasmModule: WebAssembly.Module,
): Promise<PngCodec> {
  await initPngDecode(wasmModule);
  await initPngEncode(wasmModule);
  return {
    decode: (bytes: Uint8Array): Promise<ImageDataLike> =>
      pngDecode(toArrayBuffer(bytes)) as Promise<ImageDataLike>,
    encode: async (img: ImageDataLike): Promise<Uint8Array> =>
      new Uint8Array(await pngEncode(img)),
  };
}
