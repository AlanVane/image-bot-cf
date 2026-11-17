/**
 * GIF 优化（P2）—— 见 DESIGN.md §6.1 / §6.4、§9-R3 / R6。
 *
 * 选型（已定型）：**纯 JS**，`omggif` 解码（MIT）+ `gifenc` 编码（MIT）。
 * 原版 Imgbot 用 gifsicle `-O3` / `--lossy`（**GPL-2**，传染性见 LICENSES.md §9-R7）；
 * 这里换成 permissive 实现，代价是压缩率与 gifsicle 有差距（见文末"与 gifsicle 的差距"）。
 * 本模块不依赖 wasm，因此不需要 `WebAssembly.Module` 注入（§6.2 只约束 wasm 路径）。
 *
 * 两条路径：
 *   ① 默认（`aggressive: false`）= **像素无损**：逐帧按原调色板重建索引（颜色全部来自
 *      原调色板，映射精确 ⇒ 像素零误差），保留每帧 delay / disposal / 透明色，
 *      保留循环次数；只重打 LZW、去掉注释/未知扩展、裁掉未用到的色表尾部。
 *      "表示更优"而非"内容改变"。
 *   ② `aggressive: true` = 允许视觉近似：每帧 RGBA 用 `quantize` 降到
 *      `AGGRESSIVE_MAX_COLORS` 色再编码（并与无损候选取小者）。仍须过 dispatch 的
 *      "严格变小 + 再解码"契约（§6.4）。
 *
 * 保真要点：
 *   - 帧窗口（x/y/width/height 非全屏）：gifenc 的 `writeFrame` 只能写 (0,0) 起点，
 *     因此这类 GIF 走"合成绝对帧"路径 —— 按原 disposal 逐帧合成整屏显示状态，
 *     再输出全屏帧（dispose=2 清底）。显示序列与原件一致。
 *   - 透明：`omggif` 的 `decodeAndBlitFrameRGBA` 对透明像素不写（保留 0,0,0,0），
 *     故 alpha=0 即透明；编码时重新分配一个未使用的调色板槽做透明索引。
 *   - 非法/截断 GIF：`GifReader` 构造或解码抛错 → 原样返回输入（dispatch 会判
 *     `not_smaller`），绝不产出损坏文件（§6.4）。
 *
 * 注意：codec 只负责产出"最小的编码"，**不做**体积过滤；"严格变小才替换"由
 * `dispatch.optimizeImage` 统一裁决（§6 契约）。因此默认模式对已经用 giflib 级
 * LZW 写好的 GIF 常常得到同样长度（→ `not_smaller`），收益来自扩展块清除、
 * 色表裁剪与局部色表去重 —— 这正是 §9-R6 登记的"压缩率不完全一致"。
 */

import type { CodecSet } from "../types";
// 上游两包都不带 .d.ts（package.json 无 types 字段），这里只用到很窄的 API，
// 在下方用本地接口描述；`@ts-expect-error` 仅抑制 TS7016 "无声明文件"。
// @ts-expect-error -- omggif 无类型声明
import { GifReader } from "omggif";
// @ts-expect-error -- gifenc 无类型声明
import { GIFEncoder, applyPalette, nearestColorIndex, quantize } from "gifenc";

/** §6.2 像素墙（RGBA 4B/px；与 dispatch 的 MAX_PIXELS 同值，避免循环依赖）。 */
const MAX_DECODE_PIXELS = 8_000_000;
/**
 * 合成路径（帧窗口）额外持有 canvas + 还原快照 + 窗口缓冲，峰值约为 4×RGBA；
 * 只在存在非全屏帧时生效，故单独设更保守的上限（超限则原样返回输入）。
 */
const MAX_COMPOSE_PIXELS = 2_000_000;
/** aggressive 每帧目标色数（gifenc quantize）。 */
const AGGRESSIVE_MAX_COLORS = 128;

type Rgb = [number, number, number];

/** omggif `frameInfo()` 的实际字段（见 node_modules/omggif/omggif.js）。 */
interface GifFrameInfo {
  x: number;
  y: number;
  width: number;
  height: number;
  has_local_palette: boolean;
  palette_offset: number | null;
  palette_size: number | null;
  data_offset: number;
  data_length: number;
  transparent_index: number | null;
  interlaced: boolean;
  /** 单位：1/100 秒（GIF 原生）；gifenc 的 `delay` 单位是毫秒。 */
  delay: number;
  disposal: number;
}

interface GifReaderLike {
  width: number;
  height: number;
  numFrames(): number;
  loopCount(): number | null;
  frameInfo(index: number): GifFrameInfo;
  decodeAndBlitFrameRGBA(index: number, pixels: Uint8Array): void;
}

/** 一帧的编码中间产物：紧凑调色板 + 索引流 + 透明索引（-1 = 无透明）。 */
interface PackedFrame {
  palette: Rgb[];
  indices: Uint8Array;
  transparentIndex: number;
}

function packRgb(rgb: Rgb): number {
  return (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];
}

/** 色表位深：gifenc 用 `max(2, colorDepth)` 作为 LZW 初始码宽。 */
function colorDepthFor(palette: Rgb[]): number {
  return Math.max(2, Math.ceil(Math.log2(Math.max(palette.length, 1))));
}

/**
 * 帧调色板是否是全局色表的前缀。
 *
 * 是 → 该帧的索引流可以**直接复用**全局色表（不写局部色表）：索引都落在前缀内，
 * 且每个索引对应的 RGB 完全一致。这比"整表相等"更宽松，能兼顾"全局表被裁短"与
 * "后续帧只用前若干色"的常见情形。
 */
function isPalettePrefix(framePalette: Rgb[], globalPalette: Rgb[]): boolean {
  if (framePalette.length > globalPalette.length) return false;
  for (let i = 0; i < framePalette.length; i++) {
    const a = framePalette[i];
    const b = globalPalette[i];
    if (a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2]) return false;
  }
  return true;
}

/**
 * 收尾：裁掉未用到的色表尾部 + 安排透明索引。
 *
 * 透明索引优先复用"最小未使用槽"（GIF 的透明色本身不参与渲染，颜色任意），
 * 这样既能保证索引落在重建后的色表内，又常能顺带缩小色表。
 * 返回 null 表示无法表示（256 槽全被不透明像素占满，或空调色板）。
 */
function finalizeFrame(
  indices: Uint8Array,
  palette: Rgb[],
  transparentMask: Uint8Array | null,
): PackedFrame | null {
  const used = new Uint8Array(256);
  let maxUsed = -1;
  for (let p = 0; p < indices.length; p++) {
    if (transparentMask !== null && transparentMask[p] !== 0) continue;
    const index = indices[p];
    used[index] = 1;
    if (index > maxUsed) maxUsed = index;
  }

  if (transparentMask === null) {
    if (maxUsed < 0) return null;
    return {
      palette: palette.slice(0, maxUsed + 1),
      indices,
      transparentIndex: -1,
    };
  }

  let transparentIndex = -1;
  for (let i = 0; i < 256; i++) {
    if (used[i] === 0) {
      transparentIndex = i;
      break;
    }
  }
  if (transparentIndex < 0) return null; // 256 色全用满，无槽位放透明

  const length = Math.max(maxUsed, transparentIndex) + 1;
  const trimmed = palette.slice(0, Math.min(length, palette.length));
  while (trimmed.length < length) trimmed.push([0, 0, 0]);
  for (let p = 0; p < indices.length; p++) {
    if (transparentMask[p] !== 0) indices[p] = transparentIndex;
  }
  return { palette: trimmed, indices, transparentIndex };
}

/**
 * 无损打包：颜色映射回**原帧调色板**（`nearestColorIndex` 精确命中 ⇒ 像素零误差）。
 *
 * 解码出的 RGBA 颜色一定来自原调色板，因此查表即可命中；查不到（索引越界的损坏帧）
 * 才用 `nearestColorIndex` 兜底，避免产出不可编码的索引流。
 */
function packFromSourcePalette(
  rgba: Uint8Array,
  palette: Rgb[],
  sourceTransparentIndex: number | null,
): PackedFrame | null {
  const pixelCount = rgba.length >>> 2;
  const lookup = new Map<number, number>();
  const opaqueColors: Rgb[] = [];
  const opaqueIndices: number[] = [];
  for (let i = 0; i < palette.length; i++) {
    if (i === sourceTransparentIndex) continue;
    const key = packRgb(palette[i]);
    if (lookup.has(key)) continue;
    lookup.set(key, i);
    opaqueColors.push(palette[i]);
    opaqueIndices.push(i);
  }

  const indices = new Uint8Array(pixelCount);
  let transparentMask: Uint8Array | null = null;
  let transparentCount = 0;
  for (let p = 0; p < pixelCount; p++) {
    const offset = p * 4;
    if (rgba[offset + 3] === 0) {
      if (transparentMask === null)
        transparentMask = new Uint8Array(pixelCount);
      transparentMask[p] = 1;
      transparentCount++;
      continue;
    }
    const key =
      (rgba[offset] << 16) | (rgba[offset + 1] << 8) | rgba[offset + 2];
    let index = lookup.get(key);
    if (index === undefined) {
      if (opaqueColors.length === 0) return null;
      index =
        opaqueIndices[
          nearestColorIndex(opaqueColors, [
            rgba[offset],
            rgba[offset + 1],
            rgba[offset + 2],
          ]) as number
        ];
    }
    indices[p] = index;
  }

  return finalizeFrame(
    indices,
    palette,
    transparentCount > 0 ? transparentMask : null,
  );
}

/**
 * 无损打包（合成帧）：显示状态的颜色可能来自多帧调色板，按首次出现顺序建表。
 * 颜色取自解码后的 RGBA 像素值本身 ⇒ 仍然像素零误差。
 */
function packDerivedPalette(rgba: Uint8Array): PackedFrame | null {
  const pixelCount = rgba.length >>> 2;
  let transparentCount = 0;
  for (let p = 0; p < pixelCount; p++) {
    if (rgba[p * 4 + 3] === 0) transparentCount++;
  }
  // 有透明像素时要留一个槽给透明索引；否则可用满 256 色
  const capacity = transparentCount > 0 ? 255 : 256;

  const palette: Rgb[] = [];
  const lookup = new Map<number, number>();
  const indices = new Uint8Array(pixelCount);
  let transparentMask: Uint8Array | null = null;

  for (let p = 0; p < pixelCount; p++) {
    const offset = p * 4;
    if (rgba[offset + 3] === 0) {
      if (transparentMask === null)
        transparentMask = new Uint8Array(pixelCount);
      transparentMask[p] = 1;
      continue;
    }
    const color: Rgb = [rgba[offset], rgba[offset + 1], rgba[offset + 2]];
    const key = packRgb(color);
    let index = lookup.get(key);
    if (index === undefined) {
      // 颜色数超容量 ⇒ 无法无损表示，放弃优化（原样返回输入）
      if (palette.length >= capacity) return null;
      index = palette.length;
      lookup.set(key, index);
      palette.push(color);
    }
    indices[p] = index;
  }

  return finalizeFrame(
    indices,
    palette,
    transparentCount > 0 ? transparentMask : null,
  );
}

/** aggressive 打包：quantize 到更小调色板（允许视觉近似）。 */
function packQuantized(
  rgba: Uint8Array,
  maxColors: number,
): PackedFrame | null {
  const pixelCount = rgba.length >>> 2;
  let opaqueCount = 0;
  let transparentCount = 0;
  const transparentMask = new Uint8Array(pixelCount);
  for (let p = 0; p < pixelCount; p++) {
    if (rgba[p * 4 + 3] === 0) {
      transparentMask[p] = 1;
      transparentCount++;
    } else {
      opaqueCount++;
    }
  }

  if (opaqueCount === 0) {
    // 全透明帧：给一个占位色 + 透明索引即可
    return finalizeFrame(new Uint8Array(pixelCount), [], transparentMask);
  }

  // gifenc 的 quantize/applyPalette 都按 `new Uint32Array(rgba.buffer)` 读取，
  // 必须是紧凑、offset=0 的缓冲区 ⇒ 先把不透明像素拷出来。
  const compact = new Uint8Array(opaqueCount * 4);
  let cursor = 0;
  for (let p = 0; p < pixelCount; p++) {
    if (transparentMask[p] !== 0) continue;
    const offset = p * 4;
    compact[cursor++] = rgba[offset];
    compact[cursor++] = rgba[offset + 1];
    compact[cursor++] = rgba[offset + 2];
    compact[cursor++] = 255;
  }

  const budget = Math.max(2, transparentCount > 0 ? maxColors - 1 : maxColors);
  const palette = quantize(compact, budget) as Rgb[];
  if (!Array.isArray(palette) || palette.length === 0) return null;

  const mapped = applyPalette(compact, palette) as Uint8Array;
  const indices = new Uint8Array(pixelCount);
  let mappedIndex = 0;
  for (let p = 0; p < pixelCount; p++) {
    if (transparentMask[p] !== 0) continue;
    indices[p] = mapped[mappedIndex++];
  }

  return finalizeFrame(
    indices,
    palette,
    transparentCount > 0 ? transparentMask : null,
  );
}

/** 读取帧的调色板（局部优先，其次全局）。越界/缺失 → 空表（随后会放弃优化）。 */
function readFramePalette(
  bytes: Uint8Array,
  info: GifFrameInfo,
): { palette: Rgb[]; transparentIndex: number | null } {
  const offset = info.palette_offset;
  const size = info.palette_size;
  if (offset === null || size === null || size <= 0) {
    return { palette: [], transparentIndex: info.transparent_index };
  }
  if (offset < 0 || offset + size * 3 > bytes.length) {
    return { palette: [], transparentIndex: info.transparent_index };
  }
  const palette: Rgb[] = [];
  for (let i = 0; i < size; i++) {
    const p = offset + i * 3;
    palette.push([bytes[p], bytes[p + 1], bytes[p + 2]]);
  }
  return { palette, transparentIndex: info.transparent_index };
}

function writePackedFrame(
  encoder: any,
  packed: PackedFrame,
  width: number,
  height: number,
  info: GifFrameInfo,
  palette: Rgb[] | null,
  repeat: number | undefined,
): void {
  const options: Record<string, unknown> = {
    palette,
    // gifenc 的 delay 单位是毫秒，GIF 原生是 1/100s；它内部再 Math.round(/10)。
    delay: info.delay * 10,
    dispose: info.disposal,
    colorDepth: colorDepthFor(packed.palette),
    transparent: packed.transparentIndex >= 0,
    transparentIndex:
      packed.transparentIndex >= 0 ? packed.transparentIndex : 0,
  };
  if (repeat !== undefined) options.repeat = repeat;
  encoder.writeFrame(packed.indices, width, height, options);
}

/** 全屏帧（常见情形）：逐帧原样重建，保留各自的 disposal / 透明 / delay。 */
function encodeFullScreenFrames(
  reader: GifReaderLike,
  infos: GifFrameInfo[],
  bytes: Uint8Array,
  maxColors: number | null,
): Uint8Array {
  const width = reader.width;
  const height = reader.height;
  const encoder = GIFEncoder();
  const rgba = new Uint8Array(width * height * 4);
  const loopCount = reader.loopCount();
  let globalPalette: Rgb[] | null = null;

  for (let i = 0; i < infos.length; i++) {
    const info = infos[i];
    rgba.fill(0);
    reader.decodeAndBlitFrameRGBA(i, rgba);

    let packed: PackedFrame | null;
    if (maxColors === null) {
      const source = readFramePalette(bytes, info);
      packed = packFromSourcePalette(
        rgba,
        source.palette,
        source.transparentIndex,
      );
    } else {
      packed = packQuantized(rgba, maxColors);
    }
    if (packed === null) throw new Error("gif frame not representable");

    // 索引流能落到全局色表里就不再重复写局部色表（省 3B/色）
    let palette: Rgb[] | null = packed.palette;
    if (i === 0) {
      globalPalette = packed.palette;
    } else if (
      globalPalette !== null &&
      isPalettePrefix(packed.palette, globalPalette)
    ) {
      palette = null;
    }

    writePackedFrame(
      encoder,
      packed,
      width,
      height,
      info,
      palette,
      i === 0 ? (loopCount === null ? -1 : loopCount) : undefined,
    );
  }

  encoder.finish();
  return encoder.bytes() as Uint8Array;
}

/**
 * 帧窗口（非全屏帧）路径：gifenc 不能写 x/y 偏移，因此按原 disposal 合成
 * 整屏"显示状态"再输出全屏绝对帧（dispose=2 清底）。
 *
 * 已知语义近似：disposal=2 的"恢复背景色"在主流播放器里等价于恢复透明，
 * 这里按透明处理（与 gifsicle 行为一致）。
 */
function encodeComposedFrames(
  reader: GifReaderLike,
  infos: GifFrameInfo[],
  maxColors: number | null,
): Uint8Array {
  const width = reader.width;
  const height = reader.height;
  const encoder = GIFEncoder();
  const canvas = new Uint8Array(width * height * 4);
  const loopCount = reader.loopCount();
  let restore: Uint8Array | null = null;
  let globalPalette: Rgb[] | null = null;

  for (let i = 0; i < infos.length; i++) {
    const info = infos[i];
    if (info.disposal === 3) restore = canvas.slice();

    const window = new Uint8Array(info.width * info.height * 4);
    reader.decodeAndBlitFrameRGBA(i, window);
    for (let row = 0; row < info.height; row++) {
      const sourceRow = row * info.width * 4;
      const targetRow = ((info.y + row) * width + info.x) * 4;
      for (let col = 0; col < info.width; col++) {
        const s = sourceRow + col * 4;
        if (window[s + 3] === 0) continue; // 透明：保留底图
        const d = targetRow + col * 4;
        canvas[d] = window[s];
        canvas[d + 1] = window[s + 1];
        canvas[d + 2] = window[s + 2];
        canvas[d + 3] = 255;
      }
    }

    // 绝对帧：pack 只读 canvas，因此随后可以就地按原 disposal 更新底图
    const packed =
      maxColors === null
        ? packDerivedPalette(canvas)
        : packQuantized(canvas, maxColors);
    if (packed === null) throw new Error("gif frame not representable");

    let palette: Rgb[] | null = packed.palette;
    if (i === 0) {
      globalPalette = packed.palette;
    } else if (
      globalPalette !== null &&
      isPalettePrefix(packed.palette, globalPalette)
    ) {
      palette = null;
    }

    // 绝对帧 + 清底：下一帧的透明像素显示的就是背景（透明）
    writePackedFrame(
      encoder,
      { ...packed },
      width,
      height,
      { ...info, disposal: 2 },
      palette,
      i === 0 ? (loopCount === null ? -1 : loopCount) : undefined,
    );

    // 按**原** disposal 维护合成底图（决定下一帧叠加时的背景）
    if (info.disposal === 2) {
      for (let row = 0; row < info.height; row++) {
        const start = ((info.y + row) * width + info.x) * 4;
        canvas.fill(0, start, start + info.width * 4);
      }
    } else if (info.disposal === 3 && restore !== null) {
      canvas.set(restore);
    }
  }

  encoder.finish();
  return encoder.bytes() as Uint8Array;
}

function readFrameInfos(reader: GifReaderLike): GifFrameInfo[] | null {
  const count = reader.numFrames();
  if (!Number.isFinite(count) || count <= 0) return null;
  const infos: GifFrameInfo[] = [];
  for (let i = 0; i < count; i++) {
    const info = reader.frameInfo(i);
    if (info.width <= 0 || info.height <= 0) return null;
    if (info.x < 0 || info.y < 0) return null;
    // 帧窗口越界属于损坏文件，交给调用方原样返回
    if (info.x + info.width > reader.width) return null;
    if (info.y + info.height > reader.height) return null;
    infos.push(info);
  }
  return infos;
}

/**
 * 核心实现。任何异常都向上抛，由 `createGifCodec().optimize` 兜底成"原样返回"。
 */
function optimizeGif(bytes: Uint8Array, aggressive: boolean): Uint8Array {
  const reader = new GifReader(bytes) as GifReaderLike;
  if (!reader.width || !reader.height) return bytes;
  const pixels = reader.width * reader.height;
  if (pixels > MAX_DECODE_PIXELS) return bytes;

  const infos = readFrameInfos(reader);
  if (infos === null) return bytes;

  const fullScreen = infos.every(
    (info) =>
      info.x === 0 &&
      info.y === 0 &&
      info.width === reader.width &&
      info.height === reader.height,
  );
  // 合成路径内存峰值 ≈ 4×RGBA，保守设墙（超限宁可不动）
  if (!fullScreen && pixels > MAX_COMPOSE_PIXELS) return bytes;

  // 候选：无损（必做）；aggressive 时再加一个有损候选，最终取小者
  const budgets: Array<number | null> = aggressive
    ? [null, AGGRESSIVE_MAX_COLORS]
    : [null];

  let best: Uint8Array | null = null;
  for (const budget of budgets) {
    let candidate: Uint8Array | null = null;
    try {
      candidate = fullScreen
        ? encodeFullScreenFrames(reader, infos, bytes, budget)
        : encodeComposedFrames(reader, infos, budget);
    } catch {
      candidate = null;
    }
    if (
      candidate !== null &&
      candidate.length > 0 &&
      (best === null || candidate.length < best.length)
    ) {
      best = candidate;
    }
  }
  return best ?? bytes;
}

/** §6 契约：注入到 `CodecSet.gif`。 */
export function createGifCodec(): NonNullable<CodecSet["gif"]> {
  return {
    optimize(bytes, opts) {
      try {
        return optimizeGif(bytes, opts.aggressive === true);
      } catch {
        // 结构非法 / 截断 / 不支持的边角情形：原样返回（dispatch 判 not_smaller）
        return bytes;
      }
    },
  };
}

/**
 * §6.2 像素守卫用：从 GIF 逻辑屏幕描述符读宽高（不解码）。
 * 非 GIF / 过短 → null。
 */
export function readGifSize(
  bytes: Uint8Array,
): { width: number; height: number } | null {
  if (bytes.length < 10) return null;
  if (
    bytes[0] !== 0x47 || // G
    bytes[1] !== 0x49 || // I
    bytes[2] !== 0x46 || // F
    bytes[3] !== 0x38 // 8
  ) {
    return null;
  }
  const version = bytes[4];
  if (version !== 0x37 && version !== 0x39) return null; // '7' | '9'
  if (bytes[5] !== 0x61) return null; // 'a'
  const width = bytes[6] | (bytes[7] << 8);
  const height = bytes[8] | (bytes[9] << 8);
  return { width, height };
}

/**
 * §6.4 再解码校验：解析全部块 + 逐帧真解码一次（不比对像素，只求不抛错）。
 * 坏 LZW / 截断 / 帧窗口越界 → false。
 */
export function validateGifStructure(bytes: Uint8Array): boolean {
  try {
    const reader = new GifReader(bytes) as GifReaderLike;
    const infos = readFrameInfos(reader);
    if (infos === null) return false;
    const pixels = reader.width * reader.height;
    if (!Number.isFinite(pixels) || pixels <= 0) return false;
    if (pixels > MAX_DECODE_PIXELS) return true; // 结构已解析成功，解码交给守卫
    const scratch = new Uint8Array(pixels * 4);
    for (let i = 0; i < infos.length; i++) {
      scratch.fill(0);
      reader.decodeAndBlitFrameRGBA(i, scratch);
    }
    return true;
  } catch {
    return false;
  }
}

/*
 * 与原版 gifsicle 的差距（§9-R6 容忍；gifsicle 级优化归 Containers 线，wave 3）：
 *   - 无跨帧差分 / 帧间像素合并（gifsicle -O2/-O3 会把公共区域收缩成更小的帧窗口）；
 *   - 无"透明色复用 + 调色板合并"（gifsicle 的 -O3 会把多帧局部色表合并成全局表）；
 *   - 无 --lossy 的误差扩散量化（只有 gifenc 的中位切分 + 最近色）；
 *   - 不重排/删帧，不改 delay 与循环次数（语义保持优先）。
 * 因此压缩率通常低于 gifsicle -O3；契约仍是"严格变小才替换"，不会变差。
 */
