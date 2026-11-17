/**
 * GitHub webhook 校验（DESIGN.md §4.1.3 / §4.1.4）—— 纯 WebCrypto，零依赖。
 *
 * 关键点：HMAC 必须对**原始字节**（`request.arrayBuffer()` 的结果）计算。
 * 任何 `JSON.parse` → `JSON.stringify` 的重序列化都会改变空白/键序/Unicode 转义，
 * 从而毁掉摘要 —— 本模块只接受原始字节，绝不接受已解析对象。
 */

/** webhook 投递信封头；缺失时为 null（由 ingress 决定 400 还是静默丢弃）。 */
export interface DeliveryHeaders {
  event: string | null;
  deliveryId: string | null;
}

/**
 * 读取 `X-GitHub-Event` / `X-GitHub-Delivery`。
 * 兼容 `Headers` 与普通对象（大小写不敏感）。
 */
export function parseDeliveryHeaders(
  headers: Headers | Record<string, string | null | undefined>,
): DeliveryHeaders {
  const get = (name: string): string | null => {
    const withGet = headers as { get?: (key: string) => string | null };
    if (typeof withGet.get === "function") {
      return normalize(withGet.get(name));
    }
    const record = headers as Record<string, string | null | undefined>;
    for (const key of Object.keys(record)) {
      if (key.toLowerCase() === name) {
        return normalize(record[key] ?? null);
      }
    }
    return null;
  };

  return {
    event: get("x-github-event"),
    deliveryId: get("x-github-delivery"),
  };
}

/**
 * 校验 `X-Hub-Signature-256`。
 * 仅接受 `sha256=<64 hex>`；sha1/sha512、畸形 hex、缺失头一律 false（fail-closed）。
 * 比较由 `crypto.subtle.verify` 完成（常量时间）。
 */
export async function verifyWebhookSignature(
  secret: string,
  rawBody: ArrayBuffer | Uint8Array,
  headerValue: string | null | undefined,
): Promise<boolean> {
  if (!secret) return false;

  const signature = decodeSignature(headerValue);
  if (!signature) return false;

  const body =
    rawBody instanceof Uint8Array ? rawBody : new Uint8Array(rawBody);

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );

  try {
    return await crypto.subtle.verify("HMAC", key, signature, body);
  } catch {
    // 某些实现会对长度不符的签名抛错；一律视作校验失败。
    return false;
  }
}

function decodeSignature(
  headerValue: string | null | undefined,
): Uint8Array | null {
  if (typeof headerValue !== "string") return null;
  const value = headerValue.trim();
  if (!value) return null;

  const separator = value.indexOf("=");
  if (separator <= 0) return null;

  const algo = value.slice(0, separator).trim().toLowerCase();
  // 明确拒绝 sha1/sha512 等形式，避免降级攻击。
  if (algo !== "sha256") return null;

  const hex = value.slice(separator + 1).trim();
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return null;

  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function normalize(value: string | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}
