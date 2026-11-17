/**
 * 优化引擎分派层 —— 见 DESIGN.md §6。
 *
 * 契约（§6 / §6.4）：
 *   `optimized` 非空 **当且仅当** 产物 ① 严格小于原文件，且 ② 再解码（无解码器时退化为
 *   结构校验）通过。任何异常路径都回到 `skipped`，绝不产出变大或损坏的字节。
 *
 * 守卫（§6.2 / §9-R4，128MB 内存墙）：
 *   - 输入 > 15MB：解码**前**直接 `too_large`（用体积换安全）；
 *   - 像素 > 8MP：优先在解码前从文件头（PNG IHDR / JPEG SOF）读出宽高拦截，
 *     解码后再用实际宽高复核一次（双保险）。
 *
 * 分派（大小写不敏感）：`.svg`→svg，`.png`→png，`.jpg`/`.jpeg`→jpeg，
 * `.gif`→gif（**纯 JS**：omggif 解码 + gifenc 编码，见 `src/optimize/gif.ts`、§9-R3）。
 * GIF 需要宿主显式注入 `codecs.gif`；未注入时仍是 `unsupported`（与 P1 行为一致）。
 *
 * §6.2：workerd 禁止运行时编译 wasm。编解码器必须由宿主构建期 import 成
 * `WebAssembly.Module` 后经 `initCodecsFromModules()` 注入；本文件（以及 src/ 下所有代码）
 * 严禁调用 `WebAssembly.compile` / `instantiate(bytes)` / fetch wasm。
 */
import type { CodecSet, OptimizeOutcome, SkipReason } from "../types";
import {
  createJpegCodec,
  readJpegSize,
  stripJpegMetadata,
  validateJpegStructure,
} from "./jpeg";
import {
  createOxipngOptimizer,
  createPngCodec,
  readPngSize,
  stripPngMetadata,
  validatePngStructure,
} from "./png";
import { readGifSize, validateGifStructure } from "./gif";
import { looksLikeSvg, svgCodec } from "./svg";

/** §6.2：单文件体积墙（解码前判定）。 */
export const MAX_INPUT_BYTES = 15 * 1024 * 1024;
/** §6.2：单图像素墙（≈8MP → RGBA ≈32MB，峰值 ~3× 仍在 128MB 内）。 */
export const MAX_PIXELS = 8_000_000;
/** aggressive 模式的有损质量（§6.1 实测推荐值）。 */
export const JPEG_AGGRESSIVE_QUALITY = 80;

export type ImageFormat = "svg" | "png" | "jpeg";

/**
 * 内部格式集合：GIF 的 codec 是纯 JS（omggif + gifenc），但按 §6 契约需要宿主显式
 * 注入 `codecs.gif` 才参与竞争，故 `detectFormat`（P1 公开契约）仍不报告 `.gif`；
 * `optimizeImage` 在这里单独识别。
 */
type InternalFormat = ImageFormat | "gif";

/** `.gif` 扩展名判定（大小写不敏感）。 */
export function isGifPath(path: string): boolean {
  return /\.gif$/i.test(path);
}

/** 按扩展名分派（大小写不敏感）。返回 null 表示无内置 codec（含 .gif，需注入）。 */
export function detectFormat(path: string): ImageFormat | null {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return null;
  switch (path.slice(dot + 1).toLowerCase()) {
    case "svg":
      return "svg";
    case "png":
      return "png";
    case "jpg":
    case "jpeg":
      return "jpeg";
    default:
      // .gif：codec 为纯 JS（omggif + gifenc），但需注入 codecs.gif，见 optimizeImage
      return null;
  }
}

/** §6.2 体积守卫。 */
export function exceedsByteLimit(size: number): boolean {
  return size > MAX_INPUT_BYTES;
}

/** §6.2 像素守卫。 */
export function exceedsPixelLimit(width: number, height: number): boolean {
  return width > 0 && height > 0 && width * height > MAX_PIXELS;
}

export interface OptimizeOptions {
  /** `.imgbotconfig` 的 aggressiveCompression */
  aggressive?: boolean;
  /** 宿主注入的编解码器（§6.2）。缺省时 SVG 用内置 svgo，JPEG 用内置段剥离。 */
  codecs?: CodecSet;
}

export interface CodecWasmModules {
  pngWasm?: WebAssembly.Module;
  jpegEncWasm?: WebAssembly.Module;
  jpegDecWasm?: WebAssembly.Module;
  /** §11-4/§11-7：oxipng 无损重压缩（ST wasm 164KB，构建期 import）。 */
  oxipngWasm?: WebAssembly.Module;
}

/**
 * 宿主（worker / 测试）把构建期 import 的 wasm Module 注入到这里。
 * 这是 workerd 上唯一可用的加载路径（§6.2）。
 */
export async function initCodecsFromModules(
  modules: CodecWasmModules,
): Promise<CodecSet> {
  const codecs: CodecSet = {};
  if (modules.pngWasm) {
    codecs.png = await createPngCodec(modules.pngWasm);
    if (modules.oxipngWasm) {
      codecs.png.optimizeLossless = await createOxipngOptimizer(
        modules.oxipngWasm,
      );
    }
  }
  codecs.jpeg = await createJpegCodec({
    ...(modules.jpegEncWasm ? { encodeWasm: modules.jpegEncWasm } : {}),
    ...(modules.jpegDecWasm ? { decodeWasm: modules.jpegDecWasm } : {}),
  });
  return codecs;
}

function withDefaults(codecs: CodecSet | undefined): CodecSet {
  return {
    svg: codecs?.svg ?? svgCodec,
    // 段剥离是纯 JS，永远可用；注入的 codec 只补充 decode/encode
    jpeg: { stripMetadata: stripJpegMetadata, ...codecs?.jpeg },
    png: codecs?.png,
    // GIF 的纯 JS codec 也由宿主决定是否注入（未注入 → unsupported，保持 P1 行为）
    gif: codecs?.gif,
  };
}

/**
 * 候选是否可接受（§6.4）。有 wasm 解码器时真的解一遍；没有时退化为结构校验
 * （PNG：chunk 链 + CRC；JPEG：marker 链 + SOF/SOS/EOI；GIF：块链 + 逐帧 LZW 解码）。
 */
async function validateCandidate(
  format: InternalFormat,
  bytes: Uint8Array,
  codecs: CodecSet,
): Promise<boolean> {
  if (format === "svg") {
    return looksLikeSvg(new TextDecoder().decode(bytes));
  }
  if (format === "gif") {
    // GIF 解码器是纯 JS（omggif），始终可用 ⇒ 每次都真解码校验
    return validateGifStructure(bytes);
  }
  if (format === "jpeg") {
    if (!validateJpegStructure(bytes)) return false;
    if (codecs.jpeg?.decode) {
      try {
        await codecs.jpeg.decode(bytes);
      } catch {
        return false;
      }
    }
    return true;
  }
  if (!validatePngStructure(bytes)) return false;
  if (codecs.png) {
    try {
      await codecs.png.decode(bytes);
    } catch {
      return false;
    }
  }
  return true;
}

export async function optimizeImage(
  path: string,
  bytes: Uint8Array,
  options: OptimizeOptions = {},
): Promise<OptimizeOutcome> {
  const originalSize = bytes.length;
  const skip = (reason: SkipReason): OptimizeOutcome => ({
    path,
    originalSize,
    optimizedSize: null,
    optimized: null,
    skipped: reason,
  });

  const format: InternalFormat | null =
    detectFormat(path) ?? (isGifPath(path) ? "gif" : null);
  if (!format) return skip("unsupported");
  // GIF 走纯 JS codec，但需宿主注入（§6 契约）；未注入时与 P1 一致 → unsupported
  if (format === "gif" && !options.codecs?.gif) return skip("unsupported");

  // —— 解码前守卫（§6.2）——
  if (exceedsByteLimit(originalSize)) return skip("too_large");
  const declared =
    format === "png"
      ? readPngSize(bytes)
      : format === "jpeg"
        ? readJpegSize(bytes)
        : format === "gif"
          ? readGifSize(bytes)
          : null;
  if (declared && exceedsPixelLimit(declared.width, declared.height)) {
    return skip("too_large");
  }

  const codecs = withDefaults(options.codecs);
  const aggressive = options.aggressive === true;

  let candidates: Uint8Array[];
  try {
    candidates = await buildCandidates(bytes, format, aggressive, codecs);
  } catch {
    // 解码失败 / 编码抛错：宁可不优化
    return skip("decode_failed");
  }

  const smaller = candidates
    .filter(
      (candidate) => candidate.length > 0 && candidate.length < originalSize,
    )
    .sort((a, b) => a.length - b.length);

  if (smaller.length === 0) return skip("not_smaller");

  for (const candidate of smaller) {
    if (await validateCandidate(format, candidate, codecs)) {
      return {
        path,
        originalSize,
        optimizedSize: candidate.length,
        optimized: candidate,
        skipped: null,
      };
    }
  }
  // 有更小的候选但没有一个通过校验 → 丢弃全部（§6.4：宁可少优化，不可损坏）
  return skip("decode_failed");
}

/** 各格式的候选产物（可能多个，dispatch 选最小且可校验者）。 */
async function buildCandidates(
  bytes: Uint8Array,
  format: InternalFormat,
  aggressive: boolean,
  codecs: CodecSet,
): Promise<Uint8Array[]> {
  if (format === "svg") {
    const input = new TextDecoder().decode(bytes);
    const optimized = codecs.svg?.optimize(input) ?? svgCodec.optimize(input);
    // 先确认是合法 SVG 根，再落成字节
    if (!looksLikeSvg(optimized)) return [];
    return [new TextEncoder().encode(optimized)];
  }

  if (format === "gif") {
    // 未注入时 optimizeImage 已提前返回 unsupported，这里只是类型兜底
    if (!codecs.gif) return [];
    // codec 内部已按 aggressive 产出候选（有损模式下会与无损候选取小者）
    return [await codecs.gif.optimize(bytes, { aggressive })];
  }

  if (format === "jpeg") {
    const candidates: Uint8Array[] = [codecs.jpeg!.stripMetadata(bytes)];
    if (aggressive && codecs.jpeg?.decode && codecs.jpeg?.encode) {
      const img = await codecs.jpeg.decode(bytes);
      if (exceedsPixelLimit(img.width, img.height)) return candidates; // 解码后复核
      candidates.push(
        await codecs.jpeg.encode(img, { quality: JPEG_AGGRESSIVE_QUALITY }),
      );
    }
    return candidates;
  }

  // PNG
  const candidates: Uint8Array[] = [stripPngMetadata(bytes)];
  if (codecs.png) {
    // 无损重压缩候选（oxipng，§6.1 PNG 无损主力）：与 chunk 剥离同场竞争取小。
    // 单个候选失败不影响其余（坏文件/不认识的变体 → 只丢这路候选）。
    if (codecs.png.optimizeLossless) {
      try {
        candidates.push(await codecs.png.optimizeLossless(bytes));
      } catch {
        // oxipng 不接受该文件 → 丢弃此候选
      }
    }
    const img = await codecs.png.decode(bytes);
    if (exceedsPixelLimit(img.width, img.height)) return candidates; // 解码后复核
    // 注：像素无损重编码（@jsquash/png）。压缩率弱于 oxipng，仅作兜底候选。
    candidates.push(await codecs.png.encode(img));
    // aggressive 的有损候选（调色板量化，§6.1 b 路线）：与无损候选同场竞争取小
    if (aggressive && codecs.png.encodeLossy) {
      candidates.push(await codecs.png.encodeLossy(img));
    }
  }
  return candidates;
}
