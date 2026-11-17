/**
 * Worker → Containers 调用封装（DESIGN.md §6.3）。
 *
 * 唯一职责：把一张超大图送进容器优化，**永不抛错**。
 * 任何失败（容器没起、超时、5xx、协议不符）都收敛成 `optimized: null`，
 * 调用方按 `too_large` / 跳过处理——单图失败绝不能炸掉整个 run（§5.3 块内 try/catch）。
 *
 * 传输：POST `/optimize`，JSON `{ path, bytes: base64, aggressive }`。
 * （DESIGN §6.3 原文提到"传 R2 key 不传字节"；本实现按 Wave 3 任务书走 base64 直传，
 *   容器无状态、无 R2 绑定；如后续改为 R2 key，只需换本文件的请求体构造。）
 */
import { getRandom } from "@cloudflare/containers";
import type { ImageContainer } from "./image-container";

/** 容器绑定（wrangler.jsonc containers + durable_objects 双声明）。 */
export interface OversizeEnv {
  IMAGE_CONTAINER: DurableObjectNamespace<ImageContainer>;
}

export interface OversizeResult {
  /** 非空 **当且仅当** 严格变小且容器自校验通过；否则 null（调用方跳过）。 */
  optimized: Uint8Array | null;
  /** 实际使用的工具，或 `error:<原因>` / `passthrough`。仅用于日志与统计。 */
  tool: string;
}

/** 单次容器调用墙钟上限。超大图 + 冷启动都在预算内（Workflow 步 10min）。 */
export const OVERSIZE_TIMEOUT_MS = 60_000;

/**
 * 负载均衡的实例数，必须与 wrangler.jsonc `containers[].max_instances` 一致，
 * 否则 getRandom 会把请求分散到超过上限的 DO 上，触发容器反复回收。
 */
export const OVERSIZE_CONTAINER_INSTANCES = 2;

const CONTAINER_URL = "http://image-container/optimize";

/** UTF-8 无关的 base64（分块避免 `String.fromCharCode` 参数上限）。 */
export function encodeBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + chunkSize),
    );
  }
  return btoa(binary);
}

export function decodeBase64(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return (error.message.split("\n")[0] || error.name).slice(0, 80);
  }
  return String(error).split("\n")[0].slice(0, 80);
}

function isTimeout(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name;
  return name === "TimeoutError" || name === "AbortError";
}

interface ContainerResponse {
  bytes?: unknown;
  tool?: unknown;
}

/**
 * 送一张图进容器。失败/超时/无收益 → `optimized: null`（绝不抛错）。
 * HTTP 失败（5xx / 网络）重试 1 次；超时不再重试（省掉第二次 60s 空转）。
 */
export async function optimizeViaContainer(
  env: OversizeEnv,
  path: string,
  bytes: Uint8Array,
  aggressive: boolean,
): Promise<OversizeResult> {
  if (!env?.IMAGE_CONTAINER) {
    return { optimized: null, tool: "error:no_binding" };
  }

  let stub: DurableObjectStub<ImageContainer>;
  try {
    stub = await getRandom(env.IMAGE_CONTAINER, OVERSIZE_CONTAINER_INSTANCES);
    // 容器冷启动：必须等端口就绪再发请求（否则 connection refused → 静默回退）
    await stub.startAndWaitForPorts();
  } catch (error) {
    return { optimized: null, tool: `error:${describeError(error)}` };
  }

  const body = JSON.stringify({
    path,
    bytes: encodeBase64(bytes),
    aggressive,
  });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await stub.fetch(CONTAINER_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(OVERSIZE_TIMEOUT_MS),
      });

      if (!response.ok) {
        // 5xx 可能是冷启动/瞬时故障 → 重试一次；4xx 是请求本身的问题，重试无意义。
        if (attempt === 0 && response.status >= 500) continue;
        return { optimized: null, tool: `error:http_${response.status}` };
      }

      const payload = (await response.json()) as ContainerResponse;
      const tool =
        typeof payload.tool === "string" && payload.tool.length > 0
          ? payload.tool
          : "unknown";
      const encoded = typeof payload.bytes === "string" ? payload.bytes : "";
      if (encoded.length === 0) {
        return { optimized: null, tool };
      }

      const candidate = decodeBase64(encoded);
      // 客户端再守一道：非空且严格更小（容器已保证，双保险不额外花钱）。
      if (candidate.length === 0 || candidate.length >= bytes.length) {
        return { optimized: null, tool };
      }
      return { optimized: candidate, tool };
    } catch (error) {
      if (attempt === 0 && !isTimeout(error)) continue;
      return {
        optimized: null,
        tool: isTimeout(error)
          ? "error:timeout"
          : `error:${describeError(error)}`,
      };
    }
  }

  return { optimized: null, tool: "error:unreachable" };
}
