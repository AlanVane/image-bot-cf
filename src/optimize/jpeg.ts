/**
 * JPEG 优化 —— 见 DESIGN.md §6.1 / §6.4。
 *
 * P1 无损 = 字节级段剥离（等价于原版 `jpegtran -optimize -copy none` 里"去元数据"的一半）：
 *   - 丢弃 COM(FFFE) 与 APP1..APP15(FFE1..FFEF)
 *   - 保留 APP0(JFIF, FFE0)、DQT/DHT/SOF/DRI 等
 *   - 保留 SOI，SOS 之后的熵编码数据逐字节保留，止于 EOI
 *   - 丢弃 EOI 之后的尾随杂字节
 * 熵编码数据一个字节都不改 → 像素完全不变。
 *
 * aggressive 且注入了 jsquash 的 decoder + encoder 时走 decode → encode(q≈80)；
 * 该候选仍必须满足 dispatch 的「严格变小 + 再解码通过」契约。
 *
 * §9-R6：wasm/段剥离与原版二进制（mozjpeg/jpegtran）的压缩数字不完全一致，契约不变。
 *
 * 已知取舍：APP14(Adobe, FFEE) 按本文档规范随 APP1–APP15 一起丢弃（与原版 -copy none 对齐）。
 * 对 4 分量（CMYK/YCCK）JPEG，APP14 的 transform 标志会影响色彩解释；P1 夹具集不含此类文件，
 * 若后续接入需改为对 4 分量图保留 APP14。
 *
 * §6.2：wasm 模块必须由宿主构建期 import 后经 `createJpegCodec()` 注入，
 * 本模块**不得**调用 WebAssembly.compile/instantiate(bytes)。
 */
import type { CodecSet, ImageDataLike } from "../types";
import jpegDecode, { init as initJpegDecode } from "@jsquash/jpeg/decode.js";
import jpegEncode, { init as initJpegEncode } from "@jsquash/jpeg/encode.js";

export type JpegCodec = NonNullable<CodecSet["jpeg"]>;

const M_TEM = 0x01;
const M_SOF0 = 0xc0;
const M_SOF15 = 0xcf;
const M_SOS = 0xda;
const M_EOI = 0xd9;
const M_SOI = 0xd8;
const M_COM = 0xfe;

/** 这些 0xCn 标记不是 SOF（DHT/JPG/DAC）。 */
const NON_SOF = new Set([0xc4, 0xc8, 0xcc]);

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

function isStandalone(marker: number): boolean {
  // RST0..RST7 与 TEM 没有长度字段
  return (marker >= 0xd0 && marker <= 0xd7) || marker === M_TEM;
}

/** 从 `from` 起找下一个 EOI（FF D9）；熵编码数据内的 FF 只会是 00/RST 填充，故安全。 */
function findEoi(bytes: Uint8Array, from: number): number {
  for (let i = from; i + 1 < bytes.length; i++) {
    if (bytes[i] === 0xff && bytes[i + 1] === M_EOI) return i;
  }
  return -1;
}

interface MarkerRef {
  /** 0xFF 的位置 */
  start: number;
  marker: number;
  /** 段总长（含 marker 前缀与长度字段）；standalone 时为 2 */
  end: number;
}

/**
 * 逐段遍历 JPEG 头。返回段列表；遇到 SOS 就停下（`scanStart` 指向 SOS 段之后）。
 * 结构异常返回 null（调用方保持原字节不动）。
 */
function walkMarkers(
  bytes: Uint8Array,
): { segments: MarkerRef[]; scanStart: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== M_SOI) return null;
  const segments: MarkerRef[] = [];
  let offset = 2;

  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    let markerAt = offset;
    while (markerAt < bytes.length && bytes[markerAt] === 0xff) markerAt++;
    if (markerAt >= bytes.length) return null;
    const marker = bytes[markerAt];

    if (marker === M_EOI) {
      segments.push({ start: offset, marker, end: markerAt + 1 });
      return { segments, scanStart: -1 };
    }
    if (isStandalone(marker)) {
      segments.push({ start: offset, marker, end: markerAt + 1 });
      offset = markerAt + 1;
      continue;
    }
    if (marker === 0x00 || marker === M_SOI) return null; // 头部不该出现
    if (markerAt + 2 >= bytes.length) return null;
    const length = (bytes[markerAt + 1] << 8) | bytes[markerAt + 2];
    if (length < 2) return null;
    const end = markerAt + 1 + length;
    if (end > bytes.length) return null;
    segments.push({ start: offset, marker, end });
    offset = end;
    if (marker === M_SOS) {
      // 熵编码数据从 SOS 段之后开始；后续（progressive 的更多 SOS）整体按字节保留
      return { segments, scanStart: end };
    }
  }
  return { segments, scanStart: -1 };
}

/** 无损剥离：只删整段 + 尾部杂字节，其余字节原样拷贝。 */
export function stripJpegMetadata(bytes: Uint8Array): Uint8Array {
  const walk = walkMarkers(bytes);
  if (!walk) return bytes;
  const { segments, scanStart } = walk;
  if (scanStart < 0) return bytes; // 没有 SOS：不像可优化的正常 JPEG

  const eoi = findEoi(bytes, scanStart);
  if (eoi < 0) return bytes; // 没有 EOI → 不碰

  const parts: Uint8Array[] = [bytes.subarray(0, 2)]; // SOI
  let changed = false;
  for (const seg of segments) {
    const drop =
      seg.marker === M_COM || (seg.marker >= 0xe1 && seg.marker <= 0xef);
    if (drop) {
      changed = true;
      continue;
    }
    parts.push(bytes.subarray(seg.start, seg.end));
  }
  parts.push(bytes.subarray(scanStart, eoi + 2));
  if (!changed && eoi + 2 === bytes.length) return bytes;
  return concat(parts);
}

/** 结构校验：marker 链可解析、有 SOF、有 SOS、以 EOI 收尾。 */
export function validateJpegStructure(bytes: Uint8Array): boolean {
  const walk = walkMarkers(bytes);
  if (!walk) return false;
  if (walk.scanStart < 0) return false;
  const hasSof = walk.segments.some(
    (seg) =>
      seg.marker >= M_SOF0 && seg.marker <= M_SOF15 && !NON_SOF.has(seg.marker),
  );
  if (!hasSof) return false;
  const eoi = findEoi(bytes, walk.scanStart);
  return eoi >= 0 && eoi + 2 === bytes.length;
}

/** 读取 SOF 里的宽高；失败返回 null。 */
export function readJpegSize(
  bytes: Uint8Array,
): { width: number; height: number } | null {
  const walk = walkMarkers(bytes);
  if (!walk) return null;
  for (const seg of walk.segments) {
    if (seg.marker < M_SOF0 || seg.marker > M_SOF15) continue;
    if (NON_SOF.has(seg.marker)) continue;
    // marker(2) + len(2) + precision(1) + height(2) + width(2)
    const at = seg.start + 5;
    if (at + 4 > seg.end) return null;
    const height = (bytes[at] << 8) | bytes[at + 1];
    const width = (bytes[at + 2] << 8) | bytes[at + 3];
    if (width === 0 || height === 0) return null;
    return { width, height };
  }
  return null;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer as ArrayBuffer;
  }
  return bytes.slice().buffer as ArrayBuffer;
}

/**
 * `@jsquash/jpeg` 的 init 实现接受 `WebAssembly.Module`，但 1.6.0 的 d.ts 只声明了
 * moduleOptionOverrides，故此处做一次签名收窄。
 */
type JsquashJpegInit = (module: WebAssembly.Module) => Promise<void>;

/**
 * 由宿注入的预编译 wasm Module 构造 JPEG codec。
 * 无损剥离始终可用；decode/encode 仅在两个模块都给出时启用（aggressive）。
 */
export async function createJpegCodec(
  modules: {
    encodeWasm?: WebAssembly.Module;
    decodeWasm?: WebAssembly.Module;
  } = {},
): Promise<JpegCodec> {
  const codec: JpegCodec = { stripMetadata: stripJpegMetadata };

  if (modules.encodeWasm && modules.decodeWasm) {
    await (initJpegDecode as unknown as JsquashJpegInit)(modules.decodeWasm);
    await (initJpegEncode as unknown as JsquashJpegInit)(modules.encodeWasm);

    codec.decode = (bytes: Uint8Array): Promise<ImageDataLike> =>
      // preserveOrientation=false：像素网格保持原样（EXIF 会被剥离，不重排像素）
      jpegDecode(toArrayBuffer(bytes), {
        preserveOrientation: false,
      }) as Promise<ImageDataLike>;
    codec.encode = async (img: ImageDataLike, opts: { quality: number }) =>
      new Uint8Array(
        await jpegEncode(img, {
          quality: opts.quality,
        }),
      );
  }

  return codec;
}
