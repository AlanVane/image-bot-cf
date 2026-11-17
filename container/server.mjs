/**
 * Imgbot 超大图兜底容器（DESIGN.md §6.3）。
 *
 * Worker 侧的 WASM 编解码受 128MB 内存墙限制：像素 >8MP 或文件 >15MB 的图交给这里
 * 的原生工具链（jpegtran / optipng / gifsicle / sharp）。
 *
 * 协议（端口 8000）：
 *   GET  /healthz  → 200 `ok`
 *   POST /optimize → JSON `{ path, bytes: base64, aggressive: boolean }`
 *                 ← JSON `{ bytes: base64, tool: string }`
 *                 请求体 >40MB 或解码后输入 >40MB → **413**（硬上限，不进解码器）
 *
 * 契约（与 §6 / §6.4 一致）：
 *   产物必须 **严格更小** 且 **可再解码**，否则原样返回输入字节；
 *   任何异常 → 原字节 + `tool: "error:<原因>"`。调用方永远拿到可提交的字节。
 *
 * 许可（§9-R7 定案）：GPL 的 gifsicle 只在本容器进程内以 CLI 调用，不链接、不分发到
 * Worker 侧代码；Worker 侧仍是 MIT/Apache 的 wasm 编解码。
 *
 * 无状态、无持久卷：临时文件一律落 /tmp 并在请求结束前清理。
 */
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import sharp from "sharp";

const execFile = promisify(execFileCallback);

// 容器只有 0.5 vCPU；限制 sharp 的线程/缓存，把内存留给超大图本身。
sharp.cache(false);
// §6.3：2 线程是 0.5 vCPU 下的吞吐/内存折中（1 线程跑不满，4 线程抢内存）。
sharp.concurrency(2);

/**
 * §6.3 硬上限：sharp 的像素天花板 268402689（≈16383²，sharp 文档默认值）。
 * 显式写出并作为本容器的契约：超过这个像素数宁可拒绝，也不让 libvips 展开到 OOM。
 */
export const SHARP_LIMIT_INPUT_PIXELS = 268402689;

/** 所有 sharp 实例统一的构造选项（`create` 类输入无像素概念，传了也无副作用）。 */
const SHARP_OPTIONS = Object.freeze({
  limitInputPixels: SHARP_LIMIT_INPUT_PIXELS,
});

/** 统一入口：保证**每条** sharp 管线都带硬像素上限。 */
function createSharp(input, options = {}) {
  return sharp(input, { ...SHARP_OPTIONS, ...options });
}

export const DEFAULT_PORT = 8000;

/**
 * §6.3 硬上限：单张输入图 40MB（与 Worker 侧 `src/container/limits.ts` 同步）。
 * 超过 → HTTP 413，绝不进解码器。
 */
export const MAX_INPUT_BYTES = 40 * 1024 * 1024;

/**
 * 请求体上限 = 55MB：JSON + base64 包装（~4/3 膨胀）不算小。取 55MB 是为了
 * **对齐** Worker 侧 `MAX_CONTAINER_INPUT_BYTES`(40MB 原始字节) —— 40×4/3≈53.3MB
 * 加 JSON 头余量，保证 40MB 以内的图都能进容器，不因包装膨胀被误杀（2026-11-18
 * 对齐决策：两段上限同宽，唯一有效闸门是 40MB 原始字节）。仍在**解析前**拦截（413）。
 */
export const MAX_BODY_BYTES = 55 * 1024 * 1024;
/** 单个 CLI 的墙钟上限（gifsicle 对巨帧 GIF 可能跑数十秒）。 */
const CLI_TIMEOUT_MS = 120_000;
/** `error:<原因>` 里原因的最大长度（避免把整段 stderr 塞回 Worker）。 */
const MAX_REASON_CHARS = 80;

/** 按扩展名判定格式（大小写不敏感）。 */
export function detectKind(filePath) {
  const match = /\.([a-z0-9]+)$/i.exec(typeof filePath === "string" ? filePath : "");
  const ext = match ? match[1].toLowerCase() : "";
  switch (ext) {
    case "png":
      return "png";
    case "jpg":
    case "jpeg":
      return "jpeg";
    case "gif":
      return "gif";
    case "svg":
      return "svg";
    default:
      return null;
  }
}

/**
 * 工具选择（纯函数，tests/oversize.test.ts 直接断言）。
 * 返回 null = 不认识的扩展名；"passthrough" = 原样返回。
 *
 * JPEG 无损 = jpegtran（§6.1 的 `-optimize -copy none`）；有损 = sharp mozjpeg q80。
 * PNG 无损 = optipng -o2（CLI 不可用时 sharp 无损重编码兜底）；有损 = 调色板量化。
 * GIF 无损 = gifsicle -O3；有损 = gifsicle --lossy=80（GPL 仅在容器进程内，§9-R7）。
 */
export function pickTool(filePath, aggressive) {
  const kind = detectKind(filePath);
  switch (kind) {
    case "jpeg":
      return aggressive ? "sharp-mozjpeg" : "jpegtran";
    case "png":
      return aggressive ? "sharp-png" : "optipng";
    case "gif":
      return aggressive ? "gifsicle-lossy" : "gifsicle";
    case "svg":
      return "passthrough";
    default:
      return null;
  }
}

/** 异常 → `error:<原因>`（单行、截断）。 */
export function errorReason(error) {
  const raw = error instanceof Error ? error.message : String(error);
  const firstLine = (raw.split("\n")[0] || "").trim();
  return `error:${(firstLine || "unknown").slice(0, MAX_REASON_CHARS)}`;
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  return Buffer.alloc(0);
}

/** 所有 CLI 都在独立临时目录里跑，结束即删（无持久卷）。 */
async function withTempDir(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "imgbot-oversize-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function runCli(command, args) {
  return execFile(command, args, {
    timeout: CLI_TIMEOUT_MS,
    killSignal: "SIGKILL",
    maxBuffer: 1024 * 1024,
  });
}

/** 无损 JPEG：`jpegtran -optimize -copy none`（重排 Huffman + 丢元数据，像素不变）。 */
async function runJpegtran(bytes) {
  return withTempDir(async (dir) => {
    const input = path.join(dir, "in.jpg");
    const output = path.join(dir, "out.jpg");
    await writeFile(input, bytes);
    await runCli("jpegtran", [
      "-optimize",
      "-copy",
      "none",
      "-outfile",
      output,
      input,
    ]);
    return readFile(output);
  });
}

/** 无损 PNG：`optipng -o2`（-out 让输入保持只读）。 */
async function runOptipng(bytes) {
  return withTempDir(async (dir) => {
    const input = path.join(dir, "in.png");
    const output = path.join(dir, "out.png");
    await writeFile(input, bytes);
    await runCli("optipng", ["-o2", "-quiet", "-out", output, input]);
    return readFile(output);
  });
}

/** GIF：无损 `-O3`，有损追加 `--lossy=80`。 */
async function runGifsicle(bytes, aggressive) {
  return withTempDir(async (dir) => {
    const input = path.join(dir, "in.gif");
    const output = path.join(dir, "out.gif");
    await writeFile(input, bytes);
    const args = ["-O3"];
    if (aggressive) args.push("--lossy=80");
    args.push("--output", output, input);
    await runCli("gifsicle", args);
    return readFile(output);
  });
}

function sharpMozjpeg(bytes) {
  return createSharp(bytes).jpeg({ quality: 80, mozjpeg: true }).toBuffer();
}

function sharpPalettePng(bytes) {
  return createSharp(bytes)
    .png({ palette: true, quality: 80, effort: 7, compressionLevel: 9 })
    .toBuffer();
}

function sharpLosslessPng(bytes) {
  return createSharp(bytes)
    .png({ palette: false, effort: 10, compressionLevel: 9 })
    .toBuffer();
}

/**
 * 按工具产出候选字节（可注入，测试用 mock 子进程/编码器）。
 * 返回 null / 空 → 上层按契约回原字节；返回 `{ bytes, tool }` 可上报"实际执行的工具"
 * （如 optipng 缺失时降级到 sharp 无损重编码）。
 */
export async function encodeWithTool(kind, tool, bytes, aggressive) {
  switch (tool) {
    case "jpegtran":
      return runJpegtran(bytes);
    case "sharp-mozjpeg":
      return sharpMozjpeg(bytes);
    case "optipng":
      try {
        return await runOptipng(bytes);
      } catch {
        // 兜底：CLI 缺失/失败时用 sharp 无损重编码（压缩率弱一些，契约不变）
        return { bytes: await sharpLosslessPng(bytes), tool: "sharp-png-lossless" };
      }
    case "sharp-png":
      return sharpPalettePng(bytes);
    case "gifsicle":
    case "gifsicle-lossy":
      return runGifsicle(bytes, aggressive);
    default:
      return null;
  }
}

/**
 * 完整性校验（§6.4）：严格更小 + 能再解码。
 * PNG/JPEG 做整幅解码（raw 到即算解码成功）；GIF 对动画按页数做头校验，
 * 避免多帧 RGBA 展开打爆内存；像素超大时退化为元数据校验。
 */
export async function verifyCandidate(kind, candidate, original) {
  const candidateBytes = toBuffer(candidate);
  const originalBytes = toBuffer(original);
  if (candidateBytes.length === 0) return false;
  if (candidateBytes.length >= originalBytes.length) return false;
  if (kind === "svg") return false;

  try {
    const metadata = await createSharp(candidateBytes, {
      animated: kind === "gif",
    }).metadata();
    if (!metadata.format || !metadata.width || !metadata.height) return false;

    if (kind === "gif") {
      // 多帧：确认页数可读（gifsicle 的产物头部自洽即可，避免展开全部帧）
      return (metadata.pages ?? 1) >= 1;
    }

    const pixels = metadata.width * metadata.height;
    if (pixels > 50_000_000) return true; // 超大图只做头校验，避免 RAW 展开爆内存
    await createSharp(candidateBytes).raw().toBuffer();
    return true;
  } catch {
    return false;
  }
}

export const defaultDeps = {
  encode: encodeWithTool,
  verify: verifyCandidate,
};

/**
 * 纯函数核心（无 HTTP）：输入/输出都是字节，契约在此收口。
 *
 * @param {{ path: string, bytes: Uint8Array, aggressive?: boolean }} payload
 * @param {{ encode?: Function, verify?: Function }} [deps]
 * @returns {Promise<{ bytes: Buffer, tool: string }>}
 */
export async function optimizeBytes(payload, deps = defaultDeps) {
  const original = toBuffer(payload?.bytes);
  const filePath = typeof payload?.path === "string" ? payload.path : "";
  const aggressive = payload?.aggressive === true;
  const kind = detectKind(filePath);
  const tool = pickTool(filePath, aggressive);
  // 允许注入"半套"依赖（测试只 mock encode 时 verify 仍用真实实现）。
  const resolved = deps === defaultDeps ? deps : { ...defaultDeps, ...deps };

  if (!kind || !tool || tool === "passthrough") {
    // 超大 SVG 罕见：原样返回，不冒险改结构。
    return { bytes: original, tool: "passthrough" };
  }

  try {
    const encoded = await resolved.encode(kind, tool, original, aggressive);
    // 编码器可直接回字节，也可回 `{ bytes, tool }` 上报实际执行的工具（降级路径）。
    const isWrapped =
      encoded !== null &&
      typeof encoded === "object" &&
      !Buffer.isBuffer(encoded) &&
      !(encoded instanceof Uint8Array);
    const candidate = encoded
      ? toBuffer(isWrapped ? encoded.bytes : encoded)
      : null;
    const usedTool =
      isWrapped && typeof encoded.tool === "string" && encoded.tool.length > 0
        ? encoded.tool
        : tool;
    if (!candidate || candidate.length === 0) {
      return { bytes: original, tool: "error:empty_output" };
    }
    // 严格变小是契约本身，不委托给 verify（注入的校验器可能只看可解码）。
    if (candidate.length >= original.length) {
      return { bytes: original, tool: "error:not_smaller" };
    }
    const acceptable = await resolved.verify(kind, candidate, original);
    if (!acceptable) {
      return { bytes: original, tool: "error:not_smaller_or_invalid" };
    }
    return { bytes: candidate, tool: usedTool };
  } catch (error) {
    return { bytes: original, tool: errorReason(error) };
  }
}

/** 请求体超过 `MAX_BODY_BYTES` 时的专用错误（handler 映射成 413）。 */
export class BodyTooLargeError extends Error {
  constructor(limit) {
    super(`body_too_large: exceeds ${limit} bytes`);
    this.name = "BodyTooLargeError";
    this.code = "body_too_large";
  }
}

function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    // 有 Content-Length 就在**读第一个字节之前**拒绝（这条路径覆盖绝大多数请求）。
    const declared = Number(req.headers?.["content-length"]);
    if (Number.isFinite(declared) && declared > limit) {
      req.on("error", () => {}); // 客户端中途断开不应变成未处理的 stream error
      req.resume(); // 排空但不缓存：让连接保持可用，413 才能被客户端读到
      reject(new BodyTooLargeError(limit));
      return;
    }

    const chunks = [];
    let size = 0;
    let failed = false;
    req.on("data", (chunk) => {
      if (failed) return; // 已超限：继续排空但不再累积
      size += chunk.length;
      if (size > limit) {
        failed = true;
        chunks.length = 0;
        reject(new BodyTooLargeError(limit));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!failed) resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

/** Node request handler（导出以便测试起随机端口）。 */
export function createOptimizeHandler(options = {}) {
  const deps = options.deps ?? defaultDeps;
  const maxBodyBytes =
    Number.isFinite(options.maxBodyBytes) && options.maxBodyBytes > 0
      ? options.maxBodyBytes
      : MAX_BODY_BYTES;

  return async function handler(req, res) {
    try {
      const url = new URL(req.url ?? "/", "http://container.local");

      if (req.method === "GET" && url.pathname === "/healthz") {
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        res.end("ok");
        return;
      }

      if (req.method !== "POST" || url.pathname !== "/optimize") {
        sendJson(res, 404, { error: "not_found" });
        return;
      }

      // 硬上限在 JSON 解析前拦（413），超大 body 不占解析/解码内存。
      const raw = await readBody(req, maxBodyBytes);
      let payload;
      try {
        payload = JSON.parse(raw.toString("utf8"));
      } catch {
        sendJson(res, 400, { error: "invalid_json" });
        return;
      }

      if (
        !payload ||
        typeof payload.path !== "string" ||
        typeof payload.bytes !== "string"
      ) {
        sendJson(res, 400, { error: "invalid_payload" });
        return;
      }

      const input = Buffer.from(payload.bytes, "base64");
      if (input.length === 0) {
        sendJson(res, 400, { error: "empty_bytes" });
        return;
      }
      if (input.length > MAX_INPUT_BYTES) {
        sendJson(res, 413, { error: "input_too_large" });
        return;
      }

      const result = await optimizeBytes(
        {
          path: payload.path,
          bytes: input,
          aggressive: payload.aggressive === true,
        },
        deps,
      );

      sendJson(res, 200, {
        bytes: result.bytes.toString("base64"),
        tool: result.tool,
      });
    } catch (error) {
      // 协议层失败：体积超限给 413（Worker 侧映射成跳过），其余仍是错误码，由 Worker 回退跳过。
      if (error instanceof BodyTooLargeError) {
        sendJson(res, 413, { error: "body_too_large" });
        return;
      }
      const reason = errorReason(error);
      sendJson(res, 500, { error: reason });
    }
  };
}

/** 供容器入口与测试共用。 */
export function createOptimizeServer(options = {}) {
  return createServer(createOptimizeHandler(options));
}

const isMain =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const port = Number(process.env.PORT) || DEFAULT_PORT;
  const server = createOptimizeServer();
  server.listen(port, "0.0.0.0", () => {
    console.log(`imgbot-oversize container listening on 0.0.0.0:${port}`);
  });
  for (const signal of ["SIGTERM", "SIGINT"]) {
    process.on(signal, () => {
      server.close(() => process.exit(0));
    });
  }
}
