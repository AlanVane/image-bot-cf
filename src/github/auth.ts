/**
 * GitHub App 认证（DESIGN.md §4.1）—— 纯 WebCrypto，零依赖。
 *
 * 两条链路：
 * 1. App JWT：RS256（RSASSA-PKCS1-v1_5 + SHA-256），claims `iat=now-60`、`exp=now+600`、`iss=appId`。
 * 2. installation token：`POST /app/installations/{id}/access_tokens`，TTL 1h；
 *    缓存注入 `{get,set}`，提前 300s 轮换（DO / KV 实现由接线方提供）。
 *
 * 注意：`crypto.subtle.importKey` 只认 PKCS#8（`BEGIN PRIVATE KEY`），而 GitHub
 * 后台下载的 App 私钥是 PKCS#1（`BEGIN RSA PRIVATE KEY`）。本模块自动把 PKCS#1
 * 包成 PKCS#8 PrivateKeyInfo（等价于 `openssl pkcs8 -topk8 -nocrypt`），
 * 接入者直接粘贴 GitHub 给的 PEM 即可。
 */

import { GithubApiError, GITHUB_API_BASE, GITHUB_API_VERSION } from "./gitdata";
import type { FetchLike } from "./gitdata";

export const JWT_TTL_SEC = 600;
export const JWT_IAT_SKEW_SEC = 60;
/** token 提前轮换窗口，避免请求途中过期（§4.1）。 */
export const TOKEN_REFRESH_MARGIN_SEC = 300;

export interface InstallationToken {
  token: string;
  /** GitHub 返回的 `expires_at`（ISO-8601）。 */
  expiresAt: string;
}

/**
 * token 缓存的最小契约：字符串进、字符串出，TTL 由实现（DO/KV）执行。
 * 值 = `JSON.stringify(InstallationToken)`。
 */
export interface InstallationTokenCache {
  get(key: string): Promise<string | null> | string | null;
  set(key: string, value: string, ttlSec: number): Promise<void> | void;
}

export function installationTokenCacheKey(installationId: number): string {
  return `github:installation-token:${installationId}`;
}

/** PKCS#8 `AlgorithmIdentifier`：SEQUENCE { OID 1.2.840.113549.1.1.1 (rsaEncryption), NULL }。 */
const RSA_ENCRYPTION_ALGORITHM_ID = new Uint8Array([
  0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,
  0x05, 0x00,
]);

const PEM_LABEL = /-----BEGIN ([A-Z0-9 ]+)-----/i;

/**
 * PEM → PKCS#8 DER。容忍字面 `\n`（环境变量里常见）、CRLF、缺尾换行。
 *
 * - `BEGIN RSA PRIVATE KEY`（PKCS#1，GitHub App 后台的默认格式）→ 自动包裹为 PKCS#8。
 * - `BEGIN PRIVATE KEY`（PKCS#8）→ 原样返回。
 * - `BEGIN ENCRYPTED PRIVATE KEY` / `BEGIN EC PRIVATE KEY` → 可操作的报错。
 * - 无 armor 的裸 base64 → 按 PKCS#8 处理（向后兼容）。
 */
export function pemToPkcs8Der(pem: string): Uint8Array {
  const text = pem.trim();
  if (!text) {
    throw new Error("GitHub App private key is empty");
  }

  const unescaped = text.includes("\\n")
    ? text.replace(/\\r/g, "").replace(/\\n/g, "\n")
    : text;

  const label = PEM_LABEL.exec(unescaped)?.[1]?.trim().toUpperCase() ?? null;

  if (label === "ENCRYPTED PRIVATE KEY") {
    throw new Error(
      "GitHub App private key is an encrypted PEM (`BEGIN ENCRYPTED PRIVATE KEY`), " +
        "which is not supported. GitHub never issues encrypted App keys; if yours is " +
        "encrypted, decrypt it first: openssl pkcs8 -topk8 -nocrypt -in app.pem -out app.pk8.pem",
    );
  }
  if (label === "EC PRIVATE KEY") {
    throw new Error(
      "GitHub App private key is a SEC1 EC key (`BEGIN EC PRIVATE KEY`), which cannot be " +
        "used for RS256 App JWTs. Convert it to PKCS#8: " +
        "openssl pkcs8 -topk8 -nocrypt -in ec.pem -out ec.pk8.pem",
    );
  }

  const body = unescaped
    .replace(/-----BEGIN [A-Z0-9 ]+-----/gi, "")
    .replace(/-----END [A-Z0-9 ]+-----/gi, "")
    .replace(/\s+/g, "");
  if (!body) {
    throw new Error("GitHub App private key PEM has no base64 body");
  }

  const der = parseBase64Body(body);

  if (label === "RSA PRIVATE KEY") {
    return wrapPkcs1InPkcs8(der);
  }

  // PKCS#8 PrivateKeyInfo 是 DER SEQUENCE。
  if (der.length < 2 || der[0] !== 0x30) {
    throw new Error("GitHub App private key is not valid DER/PKCS#8");
  }
  return der;
}

/**
 * PKCS#1 `RSAPrivateKey` → PKCS#8 `PrivateKeyInfo`：
 * `SEQUENCE { INTEGER 0, SEQUENCE { OID rsaEncryption, NULL }, OCTET STRING <pkcs1> }`。
 * 与 `openssl pkcs8 -topk8 -nocrypt` 输出逐字节一致（见测试）。
 */
export function wrapPkcs1InPkcs8(pkcs1Der: Uint8Array): Uint8Array {
  if (pkcs1Der.length < 2 || pkcs1Der[0] !== 0x30) {
    throw new Error("GitHub App private key is not valid DER/PKCS#1");
  }

  const version = new Uint8Array([0x02, 0x01, 0x00]);
  const privateKey = concatBytes([
    new Uint8Array([0x04]), // OCTET STRING
    encodeDerLength(pkcs1Der.length),
    pkcs1Der,
  ]);
  const content = concatBytes([
    version,
    RSA_ENCRYPTION_ALGORITHM_ID,
    privateKey,
  ]);
  return concatBytes([
    new Uint8Array([0x30]), // SEQUENCE
    encodeDerLength(content.length),
    content,
  ]);
}

/** DER 长度字段：<0x80 用短形式，否则长形式（0x80|n + n 个字节）。 */
function encodeDerLength(length: number): Uint8Array {
  if (length < 0x80) {
    return new Uint8Array([length]);
  }
  const bytes: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining = Math.floor(remaining / 256);
  }
  if (bytes.length > 3) {
    throw new Error("GitHub App private key is too large to encode as DER");
  }
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function parseBase64Body(body: string): Uint8Array {
  try {
    return base64ToBytes(body);
  } catch {
    throw new Error(
      "GitHub App private key PEM body is not valid base64 " +
        "(check for truncated paste or stray characters)",
    );
  }
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const der = pemToPkcs8Der(pem);
  return crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

/**
 * 生成 App JWT（RS256）。`nowMs` 可注入以获得确定性（测试/时钟校正）。
 */
export async function generateAppJwt(
  appId: string | number,
  privateKeyPem: string,
  nowMs: number = Date.now(),
): Promise<string> {
  const nowSec = Math.floor(nowMs / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload = {
    iat: nowSec - JWT_IAT_SKEW_SEC,
    exp: nowSec + JWT_TTL_SEC,
    iss: String(appId),
  };

  const signingInput = `${base64UrlEncode(
    new TextEncoder().encode(JSON.stringify(header)),
  )}.${base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)))}`;

  const key = await importPrivateKey(privateKeyPem);
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(signingInput),
  );

  return `${signingInput}.${base64UrlEncode(new Uint8Array(signature))}`;
}

export interface GetInstallationTokenOptions {
  installationId: number;
  appId: string | number;
  privateKeyPem: string;
  fetchImpl?: FetchLike;
  cache?: InstallationTokenCache | null;
  /** 注入时钟，用于 TTL / 缓存命中测试。 */
  nowMs?: number;
  apiBase?: string;
}

/**
 * 取 installation token（优先命中缓存）。
 * 缓存 TTL = 实际剩余寿命 - 300s；剩余不足 300s 时视为未命中并重新签发。
 */
export async function getInstallationToken(
  opts: GetInstallationTokenOptions,
): Promise<InstallationToken> {
  const nowMs = opts.nowMs ?? Date.now();
  const cacheKey = installationTokenCacheKey(opts.installationId);

  if (opts.cache) {
    const cached = await opts.cache.get(cacheKey);
    const parsed = parseCachedToken(cached);
    if (parsed) {
      const expiresMs = Date.parse(parsed.expiresAt);
      if (
        Number.isFinite(expiresMs) &&
        expiresMs - nowMs > TOKEN_REFRESH_MARGIN_SEC * 1000
      ) {
        return parsed;
      }
    }
  }

  const jwt = await generateAppJwt(opts.appId, opts.privateKeyPem, nowMs);
  const apiBase = (opts.apiBase ?? GITHUB_API_BASE).replace(/\/+$/, "");
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as FetchLike);
  if (typeof fetchImpl !== "function") {
    throw new Error("getInstallationToken requires a fetch implementation");
  }

  const res = await fetchImpl(
    `${apiBase}/app/installations/${opts.installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${jwt}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": GITHUB_API_VERSION,
        "content-type": "application/json",
        "user-agent": "image-bot-cf",
      },
      body: "{}",
    },
  );

  if (!res.ok) {
    throw await toTokenError(res, opts.installationId);
  }

  const body = (await res.json()) as {
    token?: unknown;
    expires_at?: unknown;
  };
  if (typeof body.token !== "string" || typeof body.expires_at !== "string") {
    throw new GithubApiError({
      status: res.status,
      message:
        "GitHub installation token response is missing `token` / `expires_at`",
      retryable: true,
    });
  }

  const issued: InstallationToken = {
    token: body.token,
    expiresAt: body.expires_at,
  };

  if (opts.cache) {
    const expiresMs = Date.parse(issued.expiresAt);
    if (Number.isFinite(expiresMs)) {
      const ttlSec =
        Math.floor((expiresMs - nowMs) / 1000) - TOKEN_REFRESH_MARGIN_SEC;
      if (ttlSec > 0) {
        await opts.cache.set(cacheKey, JSON.stringify(issued), ttlSec);
      }
    }
  }

  return issued;
}

async function toTokenError(
  res: Response,
  installationId: number,
): Promise<GithubApiError> {
  const status = res.status;
  const retryAfter = res.headers.get("retry-after");
  let message = `GitHub installation token request for ${installationId} failed: ${status}`;
  try {
    const text = await res.text();
    if (text) {
      try {
        const parsed = JSON.parse(text) as { message?: unknown };
        if (typeof parsed?.message === "string") {
          message += ` ${parsed.message}`;
        }
      } catch {
        message += ` ${text.slice(0, 200)}`;
      }
    }
  } catch {
    // 忽略不可读 body。
  }

  const rateLimited = status === 429 || (status === 403 && retryAfter !== null);
  return new GithubApiError({
    status,
    message,
    retryable: rateLimited || status >= 500,
    retryAfter: retryAfter !== null ? retryAfter.trim() : null,
  });
}

function parseCachedToken(raw: unknown): InstallationToken | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    const parsed = JSON.parse(raw) as {
      token?: unknown;
      expiresAt?: unknown;
    };
    if (
      typeof parsed?.token === "string" &&
      typeof parsed?.expiresAt === "string"
    ) {
      return { token: parsed.token, expiresAt: parsed.expiresAt };
    }
  } catch {
    // 损坏的缓存条目按未命中处理。
  }
  return null;
}

function base64UrlEncode(bytes: Uint8Array): string {
  return base64Encode(bytes)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}
