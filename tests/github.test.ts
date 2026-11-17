/**
 * GitHub 集成层测试（DESIGN.md §4.1 / §4.2 / §9-R2）。
 *
 * 全部使用 Node 自带 WebCrypto + `node:crypto` 交叉验证，不引新依赖。
 */

import { beforeAll, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";

import {
  TOKEN_REFRESH_MARGIN_SEC,
  generateAppJwt,
  getInstallationToken,
  installationTokenCacheKey,
  pemToPkcs8Der,
  type InstallationTokenCache,
} from "../src/github/auth";
import {
  parseDeliveryHeaders,
  verifyWebhookSignature,
} from "../src/github/webhook";
import {
  GitDataClient,
  GithubApiError,
  normalizeRef,
  type FetchLike,
} from "../src/github/gitdata";

// ---------------------------------------------------------------------------
// 共享夹具
// ---------------------------------------------------------------------------

const NOW_MS = 1_700_000_000_000; // 2023-11-14T22:13:20Z，固定时钟

let testKey: {
  privatePem: string;
  publicKey: CryptoKey;
  pkcs8: Uint8Array;
  pkcs1: Uint8Array;
};

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;

  const pkcs8 = new Uint8Array(
    (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer,
  );
  testKey = {
    privatePem: toPem(pkcs8),
    publicKey: pair.publicKey,
    pkcs8,
    pkcs1: extractPkcs1FromPkcs8(pkcs8),
  };
});

function toPem(der: Uint8Array): string {
  return toPemLabeled(der, "PRIVATE KEY");
}

function toPemLabeled(der: Uint8Array, label: string): string {
  const b64 = Buffer.from(der).toString("base64");
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

/** 极简 DER 读取器（仅测试用）：读一个 tag-length-value 的 length 字段。 */
function readDerLength(
  bytes: Uint8Array,
  offset: number,
): { length: number; headerSize: number } {
  const first = bytes[offset] as number;
  if (first < 0x80) return { length: first, headerSize: 1 };
  const count = first & 0x7f;
  let length = 0;
  for (let i = 0; i < count; i += 1) {
    length = length * 256 + (bytes[offset + 1 + i] as number);
  }
  return { length, headerSize: 1 + count };
}

/** 从 `exportKey("pkcs8")` 的 DER 中剥出内层 PKCS#1（RSAPrivateKey）。 */
function extractPkcs1FromPkcs8(pkcs8: Uint8Array): Uint8Array {
  expect(pkcs8[0]).toBe(0x30);
  const outer = readDerLength(pkcs8, 1);
  expect(1 + outer.headerSize + outer.length).toBe(pkcs8.length);
  let offset = 1 + outer.headerSize;

  expect(pkcs8[offset]).toBe(0x02); // version INTEGER
  const version = readDerLength(pkcs8, offset + 1);
  offset += 1 + version.headerSize + version.length;

  expect(pkcs8[offset]).toBe(0x30); // AlgorithmIdentifier
  const alg = readDerLength(pkcs8, offset + 1);
  offset += 1 + alg.headerSize + alg.length;

  expect(pkcs8[offset]).toBe(0x04); // privateKey OCTET STRING
  const octet = readDerLength(pkcs8, offset + 1);
  const start = offset + 1 + octet.headerSize;
  return pkcs8.slice(start, start + octet.length);
}

function base64UrlToBytes(input: string): Uint8Array {
  const b64 =
    input.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - (input.length % 4)) % 4);
  return new Uint8Array(Buffer.from(b64, "base64"));
}

function base64UrlToString(input: string): string {
  return Buffer.from(base64UrlToBytes(input)).toString("utf8");
}

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  json: unknown;
}

function createFetchMock(
  handler: (req: RecordedRequest) => Response | Promise<Response>,
): { impl: FetchLike; calls: RecordedRequest[] } {
  const calls: RecordedRequest[] = [];
  const impl: FetchLike = async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? {}).forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    const body = typeof init?.body === "string" ? init.body : null;
    const req: RecordedRequest = {
      url,
      method: init?.method ?? "GET",
      headers,
      body,
      json: body ? (JSON.parse(body) as unknown) : undefined,
    };
    calls.push(req);
    return handler(req);
  };
  return { impl, calls };
}

function jsonResponse(
  payload: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

async function captureError(
  fn: () => Promise<unknown>,
): Promise<GithubApiError> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof GithubApiError) return err;
    throw err;
  }
  throw new Error("expected a GithubApiError, but the call succeeded");
}

function makeClient(impl: FetchLike): GitDataClient {
  return new GitDataClient({ token: "ghs_test_token", fetchImpl: impl });
}

// ---------------------------------------------------------------------------
// §4.1.3 webhook HMAC
// ---------------------------------------------------------------------------

describe("webhook / verifyWebhookSignature", () => {
  const secret = "s3cr3t-webhook-key";
  // 故意保留不规则空白与 Unicode：重序列化会改变字节，必须失败。
  const payloadText = `{
  "action": "opened",
    "note": "中文 ✨ \\u00e9",
  "nested": { "b": 1, "a": 2 }
}`;
  const rawBytes = new TextEncoder().encode(payloadText);

  const hmacHex = (key: string, data: Uint8Array): string =>
    createHmac("sha256", key).update(data).digest("hex");
  const goodSignature = `sha256=${hmacHex(secret, rawBytes)}`;

  it("接受对原始字节计算出的正确签名（Uint8Array）", async () => {
    await expect(
      verifyWebhookSignature(secret, rawBytes, goodSignature),
    ).resolves.toBe(true);
  });

  it("接受 ArrayBuffer 形态的原始 body", async () => {
    const buffer = rawBytes.slice().buffer as ArrayBuffer;
    await expect(
      verifyWebhookSignature(secret, buffer, goodSignature),
    ).resolves.toBe(true);
  });

  it("签名大小写不敏感（hex 解码后按字节比较）", async () => {
    const upper = `sha256=${hmacHex(secret, rawBytes).toUpperCase()}`;
    await expect(verifyWebhookSignature(secret, rawBytes, upper)).resolves.toBe(
      true,
    );
  });

  it("body 被篡改则失败", async () => {
    const tampered = new TextEncoder().encode(
      payloadText.replace('"opened"', '"closed"'),
    );
    await expect(
      verifyWebhookSignature(secret, tampered, goodSignature),
    ).resolves.toBe(false);
  });

  it("对 parse 后重新序列化的字符串取摘要必须失败（绝不允许的路径）", async () => {
    const reserialized = new TextEncoder().encode(
      JSON.stringify(JSON.parse(payloadText)),
    );
    await expect(
      verifyWebhookSignature(secret, reserialized, goodSignature),
    ).resolves.toBe(false);
  });

  it("错误 secret 失败", async () => {
    await expect(
      verifyWebhookSignature("other-secret", rawBytes, goodSignature),
    ).resolves.toBe(false);
  });

  it("缺失/畸形签名头一律失败（fail-closed）", async () => {
    const cases: Array<string | null | undefined> = [
      null,
      undefined,
      "",
      "   ",
      "sha256=",
      "sha256=zzzz",
      `sha256=${hmacHex(secret, rawBytes).slice(0, 63)}`,
      `sha1=${hmacHex(secret, rawBytes).slice(0, 40)}`,
      hmacHex(secret, rawBytes), // 缺算法前缀
      goodSignature.replace("sha256", "sha512"),
    ];
    for (const header of cases) {
      await expect(
        verifyWebhookSignature(secret, rawBytes, header),
      ).resolves.toBe(false);
    }
  });

  it("空 secret 不会意外通过", async () => {
    const sig = `sha256=${hmacHex("", rawBytes)}`;
    await expect(verifyWebhookSignature("", rawBytes, sig)).resolves.toBe(
      false,
    );
  });
});

describe("webhook / parseDeliveryHeaders", () => {
  it("从 Headers 读取事件与投递 id", () => {
    const headers = new Headers({
      "X-GitHub-Event": "push",
      "X-GitHub-Delivery": "72d3162e-cc78-11e3-81ab-4c9367dc0958",
    });
    expect(parseDeliveryHeaders(headers)).toEqual({
      event: "push",
      deliveryId: "72d3162e-cc78-11e3-81ab-4c9367dc0958",
    });
  });

  it("从普通对象读取（大小写不敏感 + trim）", () => {
    expect(
      parseDeliveryHeaders({
        "x-github-event": " installation ",
        "X-GitHub-Delivery": "abc-123",
      }),
    ).toEqual({ event: "installation", deliveryId: "abc-123" });
  });

  it("缺失时返回 null（由 ingress 决定拒绝策略）", () => {
    expect(parseDeliveryHeaders({})).toEqual({
      event: null,
      deliveryId: null,
    });
    expect(parseDeliveryHeaders({ "x-github-event": "  " })).toEqual({
      event: null,
      deliveryId: null,
    });
  });
});

// ---------------------------------------------------------------------------
// §4.1.1 App JWT
// ---------------------------------------------------------------------------

describe("auth / generateAppJwt", () => {
  it("生成 RS256 JWT，claims 与 exp 窗口符合 §4.1", async () => {
    const jwt = await generateAppJwt("123456", testKey.privatePem, NOW_MS);
    const parts = jwt.split(".");
    expect(parts).toHaveLength(3);
    for (const part of parts) {
      expect(part).toMatch(/^[A-Za-z0-9\-_]+$/); // base64url，无 padding
    }

    const header = JSON.parse(base64UrlToString(parts[0])) as Record<
      string,
      unknown
    >;
    expect(header).toEqual({ alg: "RS256", typ: "JWT" });

    const claims = JSON.parse(base64UrlToString(parts[1])) as Record<
      string,
      unknown
    >;
    const nowSec = Math.floor(NOW_MS / 1000);
    expect(claims.iss).toBe("123456");
    expect(claims.iat).toBe(nowSec - 60);
    expect(claims.exp).toBe(nowSec + 600);
    expect((claims.exp as number) - nowSec).toBe(600);
  });

  it("签名可用导出的公钥验证", async () => {
    const jwt = await generateAppJwt(123456, testKey.privatePem, NOW_MS);
    const [header, payload, signature] = jwt.split(".");
    const ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      testKey.publicKey,
      base64UrlToBytes(signature),
      new TextEncoder().encode(`${header}.${payload}`),
    );
    expect(ok).toBe(true);

    // 翻转签名中的一个字符 → 验证必须失败
    const flipped =
      signature.slice(0, 10) +
      (signature[10] === "A" ? "B" : "A") +
      signature.slice(11);
    await expect(
      crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        testKey.publicKey,
        base64UrlToBytes(flipped),
        new TextEncoder().encode(`${header}.${payload}`),
      ),
    ).resolves.toBe(false);
  });

  it("注入 nowMs → 完全确定性（同输入同输出）", async () => {
    const a = await generateAppJwt("42", testKey.privatePem, NOW_MS);
    const b = await generateAppJwt("42", testKey.privatePem, NOW_MS);
    expect(a).toBe(b);
    const later = await generateAppJwt("42", testKey.privatePem, NOW_MS + 1000);
    expect(later).not.toBe(a);
  });

  it("数字与字符串 appId 等价（iss 统一为字符串）", async () => {
    const numeric = await generateAppJwt(42, testKey.privatePem, NOW_MS);
    const textual = await generateAppJwt("42", testKey.privatePem, NOW_MS);
    expect(numeric).toBe(textual);
  });

  it("PEM 中的字面 `\\n` 转义可还原", async () => {
    const escaped = testKey.privatePem.replace(/\n/g, "\\n");
    const a = await generateAppJwt("1", escaped, NOW_MS);
    const b = await generateAppJwt("1", testKey.privatePem, NOW_MS);
    expect(a).toBe(b);
  });

  it("CRLF 与缺失尾换行的 PEM 同样可用", async () => {
    const crlf = testKey.privatePem.replace(/\n/g, "\r\n").trimEnd();
    await expect(generateAppJwt("1", crlf, NOW_MS)).resolves.toBeTypeOf(
      "string",
    );
  });

  it("PKCS#1 PEM（GitHub 默认格式）可签名且验签通过", async () => {
    const pkcs1Pem = toPemLabeled(testKey.pkcs1, "RSA PRIVATE KEY");
    const jwt = await generateAppJwt("123456", pkcs1Pem, NOW_MS);

    // 与 PKCS#8 输入产生完全一致的 JWT（RS256 是确定性签名）
    expect(jwt).toBe(
      await generateAppJwt("123456", testKey.privatePem, NOW_MS),
    );

    const [header, payload, signature] = jwt.split(".");
    await expect(
      crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        testKey.publicKey,
        base64UrlToBytes(signature),
        new TextEncoder().encode(`${header}.${payload}`),
      ),
    ).resolves.toBe(true);
    expect(
      JSON.parse(base64UrlToString(payload)) as Record<string, unknown>,
    ).toMatchObject({ iss: "123456" });
  });

  it("PKCS#1 的 `\\n` 转义同样还原", async () => {
    const pkcs1Pem = toPemLabeled(testKey.pkcs1, "RSA PRIVATE KEY");
    const escaped = pkcs1Pem.replace(/\n/g, "\\n");
    expect(await generateAppJwt("9", escaped, NOW_MS)).toBe(
      await generateAppJwt("9", pkcs1Pem, NOW_MS),
    );
  });
});

describe("auth / pemToPkcs8Der", () => {
  it("PKCS#8 解码出与 exportKey 一致的 DER（回归）", () => {
    expect(Array.from(pemToPkcs8Der(testKey.privatePem))).toEqual(
      Array.from(testKey.pkcs8),
    );
  });

  it("空 PEM 抛错", () => {
    expect(() => pemToPkcs8Der("   ")).toThrow(/empty/i);
  });

  it("无 armor 的裸 base64 按 PKCS#8 处理（向后兼容）", () => {
    const bare = Buffer.from(testKey.pkcs8).toString("base64");
    expect(Buffer.from(pemToPkcs8Der(bare)).toString("hex")).toBe(
      Buffer.from(testKey.pkcs8).toString("hex"),
    );
  });

  it("PKCS#1 → PKCS#8 包裹结果与 exportKey 逐字节一致", () => {
    const pkcs1Pem = toPemLabeled(testKey.pkcs1, "RSA PRIVATE KEY");
    const wrapped = pemToPkcs8Der(pkcs1Pem);
    expect(Buffer.from(wrapped).toString("hex")).toBe(
      Buffer.from(testKey.pkcs8).toString("hex"),
    );
  });

  it("短 PKCS#1 也按 DER 规则包裹（短形式长度）", () => {
    const tinyPkcs1 = new Uint8Array([0x30, 0x03, 0x02, 0x01, 0x00]);
    const der = pemToPkcs8Der(toPemLabeled(tinyPkcs1, "RSA PRIVATE KEY"));
    const expected =
      "3019" + // SEQUENCE, 25 bytes
      "020100" + // INTEGER 0
      "300d06092a864886f70d0101010500" + // rsaEncryption + NULL
      "0405" + // OCTET STRING, 5 bytes
      "3003020100"; // 内层 PKCS#1
    expect(Buffer.from(der).toString("hex")).toBe(expected);
  });

  it("加密 PEM 抛可操作错误（明确不支持 + 指向 openssl）", () => {
    const encrypted =
      "-----BEGIN ENCRYPTED PRIVATE KEY-----\nMIIB\n-----END ENCRYPTED PRIVATE KEY-----";
    expect(() => pemToPkcs8Der(encrypted)).toThrow(/encrypted/i);
    expect(() => pemToPkcs8Der(encrypted)).toThrow(/openssl/);
  });

  it("SEC1 EC 私钥抛可操作错误", () => {
    expect(() =>
      pemToPkcs8Der(
        "-----BEGIN EC PRIVATE KEY-----\nMIIB\n-----END EC PRIVATE KEY-----",
      ),
    ).toThrow(/openssl/);
  });

  it("非 base64 body 抛可操作错误", () => {
    expect(() =>
      pemToPkcs8Der(
        "-----BEGIN PRIVATE KEY-----\n@@@@\n-----END PRIVATE KEY-----",
      ),
    ).toThrow(/base64/i);
  });

  it("非 SEQUENCE 的 PKCS#8 body 抛错", () => {
    expect(() =>
      pemToPkcs8Der(
        toPemLabeled(new Uint8Array([0x01, 0x02, 0x03]), "PRIVATE KEY"),
      ),
    ).toThrow(/DER/);
  });
});

// ---------------------------------------------------------------------------
// §4.1.2 installation token
// ---------------------------------------------------------------------------

function memoryCache(): InstallationTokenCache & {
  store: Map<string, string>;
  sets: Array<{ key: string; ttlSec: number }>;
} {
  const store = new Map<string, string>();
  const sets: Array<{ key: string; ttlSec: number }> = [];
  return {
    store,
    sets,
    get(key) {
      return store.get(key) ?? null;
    },
    set(key, value, ttlSec) {
      store.set(key, value);
      sets.push({ key, ttlSec });
    },
  };
}

describe("auth / getInstallationToken", () => {
  const cacheKey = installationTokenCacheKey(987);

  it("签发 token：POST 正确端点并携带 App JWT", async () => {
    const expiresAt = new Date(NOW_MS + 3600_000).toISOString();
    const { impl, calls } = createFetchMock(() =>
      jsonResponse({
        token: "ghs_install_token",
        expires_at: expiresAt,
      }),
    );
    const cache = memoryCache();

    const token = await getInstallationToken({
      installationId: 987,
      appId: "123456",
      privateKeyPem: testKey.privatePem,
      fetchImpl: impl,
      cache,
      nowMs: NOW_MS,
    });

    expect(token).toEqual({ token: "ghs_install_token", expiresAt });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe(
      "https://api.github.com/app/installations/987/access_tokens",
    );
    expect(calls[0].headers.authorization).toMatch(
      /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/,
    );
    expect(calls[0].headers.accept).toBe("application/vnd.github+json");

    // TTL = 剩余寿命 - 300s
    expect(cache.sets).toEqual([
      { key: cacheKey, ttlSec: 3600 - TOKEN_REFRESH_MARGIN_SEC },
    ]);
    expect(JSON.parse(cache.store.get(cacheKey) as string)).toEqual(token);
  });

  it("缓存命中时不再打网络", async () => {
    const expiresAt = new Date(NOW_MS + 3600_000).toISOString();
    const { impl, calls } = createFetchMock(() =>
      jsonResponse({ token: "ghs_cached", expires_at: expiresAt }),
    );
    const cache = memoryCache();

    const opts = {
      installationId: 987,
      appId: "123456",
      privateKeyPem: testKey.privatePem,
      fetchImpl: impl,
      cache,
      nowMs: NOW_MS,
    };
    const first = await getInstallationToken(opts);
    const second = await getInstallationToken({
      ...opts,
      nowMs: NOW_MS + 1000,
    });

    expect(second).toEqual(first);
    expect(calls).toHaveLength(1);
  });

  it("剩余寿命不足 300s 时提前轮换", async () => {
    const expiresAt = new Date(NOW_MS + 200_000).toISOString(); // < margin
    const { impl, calls } = createFetchMock(() =>
      jsonResponse({ token: "ghs_rotated", expires_at: expiresAt }),
    );
    const cache = memoryCache();
    cache.store.set(cacheKey, JSON.stringify({ token: "ghs_old", expiresAt }));

    const token = await getInstallationToken({
      installationId: 987,
      appId: "123456",
      privateKeyPem: testKey.privatePem,
      fetchImpl: impl,
      cache,
      nowMs: NOW_MS,
    });

    expect(token.token).toBe("ghs_rotated");
    expect(calls).toHaveLength(1);
    // TTL 非正 → 不写入（由实现侧 TTL 兜底）
    expect(cache.sets).toHaveLength(0);
  });

  it("损坏的缓存条目按未命中处理", async () => {
    const { impl, calls } = createFetchMock(() =>
      jsonResponse({
        token: "ghs_fresh",
        expires_at: new Date(NOW_MS + 3600_000).toISOString(),
      }),
    );
    const cache = memoryCache();
    cache.store.set(cacheKey, "not-json");

    const token = await getInstallationToken({
      installationId: 987,
      appId: "123456",
      privateKeyPem: testKey.privatePem,
      fetchImpl: impl,
      cache,
      nowMs: NOW_MS,
    });

    expect(token.token).toBe("ghs_fresh");
    expect(calls).toHaveLength(1);
  });

  it("401 → 不可重试的 GithubApiError", async () => {
    const { impl } = createFetchMock(() =>
      jsonResponse({ message: "A JSON web token could not be decoded" }, 401),
    );

    const err = await captureError(() =>
      getInstallationToken({
        installationId: 987,
        appId: "123456",
        privateKeyPem: testKey.privatePem,
        fetchImpl: impl,
        nowMs: NOW_MS,
      }),
    );

    expect(err.status).toBe(401);
    expect(err.retryable).toBe(false);
    expect(err.message).toContain("401");
    expect(err.message).toContain("could not be decoded");
  });

  it("429 透出 Retry-After 且标记可重试", async () => {
    const { impl } = createFetchMock(() =>
      jsonResponse({ message: "Too Many Requests" }, 429, {
        "retry-after": "45",
      }),
    );

    const err = await captureError(() =>
      getInstallationToken({
        installationId: 987,
        appId: "123456",
        privateKeyPem: testKey.privatePem,
        fetchImpl: impl,
        nowMs: NOW_MS,
      }),
    );

    expect(err.status).toBe(429);
    expect(err.retryable).toBe(true);
    expect(err.retryAfter).toBe("45");
  });
});

// ---------------------------------------------------------------------------
// §4.2 Git Data 读写
// ---------------------------------------------------------------------------

describe("gitdata / ref 归一化", () => {
  it("接受 imgbot / heads/ / refs/heads/ 三种写法", () => {
    expect(normalizeRef("imgbot")).toBe("heads/imgbot");
    expect(normalizeRef("heads/imgbot")).toBe("heads/imgbot");
    expect(normalizeRef("refs/heads/imgbot")).toBe("heads/imgbot");
    expect(normalizeRef("refs/tags/v1")).toBe("tags/v1");
  });
});

describe("gitdata / 读路径", () => {
  it("getTreeRecursive 只保留 blob 并透出 truncated", async () => {
    const { impl, calls } = createFetchMock(() =>
      jsonResponse({
        sha: "root-tree",
        truncated: true,
        tree: [
          {
            path: "assets/a.png",
            mode: "100644",
            type: "blob",
            sha: "blob-a",
            size: 1024,
          },
          { path: "assets", mode: "040000", type: "tree", sha: "tree-a" },
          {
            path: "scripts/run.sh",
            mode: "100755",
            type: "blob",
            sha: "blob-s",
          },
          {
            path: "submodule",
            mode: "160000",
            type: "commit",
            sha: "commit-a",
          },
        ],
      }),
    );

    const result = await makeClient(impl).getTreeRecursive(
      "acme",
      "site",
      "main-sha",
    );

    expect(result.truncated).toBe(true);
    expect(result.tree).toEqual([
      { path: "assets/a.png", sha: "blob-a", size: 1024 },
      { path: "scripts/run.sh", sha: "blob-s", size: 0 },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toBe(
      "https://api.github.com/repos/acme/site/git/trees/main-sha?recursive=1",
    );
    expect(calls[0].headers.authorization).toBe("Bearer ghs_test_token");
    expect(calls[0].headers.accept).toBe("application/vnd.github+json");
    expect(calls[0].headers["x-github-api-version"]).toBe("2022-11-28");
  });

  it("getTreeRecursive 未截断时 truncated=false", async () => {
    const { impl } = createFetchMock(() =>
      jsonResponse({ sha: "t", tree: [], truncated: false }),
    );
    await expect(
      makeClient(impl).getTreeRecursive("acme", "site", "s"),
    ).resolves.toEqual({ tree: [], truncated: false });
  });

  it("getBlobRaw 使用 raw Accept 头并返回原始字节", async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x10]);
    const { impl, calls } = createFetchMock(
      () => new Response(bytes, { status: 200 }),
    );

    const out = await makeClient(impl).getBlobRaw("acme", "site", "blob-sha");

    expect(Array.from(out)).toEqual(Array.from(bytes));
    expect(calls[0].headers.accept).toBe("application/vnd.github.raw");
    expect(calls[0].url).toBe(
      "https://api.github.com/repos/acme/site/git/blobs/blob-sha",
    );
  });
});

describe("gitdata / 写路径", () => {
  it("createTreeWithContent：N 个 entry 只发一次 POST 且内联 content", async () => {
    const { impl, calls } = createFetchMock(() =>
      jsonResponse({ sha: "new-tree-sha" }),
    );

    const treeSha = await makeClient(impl).createTreeWithContent(
      "acme",
      "site",
      "base-tree-sha",
      [
        { path: "assets/a.png", contentBase64: "iVBORw0KGgo=" },
        { path: "assets/b.jpg", contentBase64: "AAAA", mode: "100755" },
        { path: "assets/c.svg", contentBase64: "PHN2Zz4=", type: "blob" },
      ],
    );

    expect(treeSha).toBe("new-tree-sha");
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe(
      "https://api.github.com/repos/acme/site/git/trees",
    );
    expect(calls[0].headers["content-type"]).toBe("application/json");
    expect(calls[0].json).toEqual({
      base_tree: "base-tree-sha",
      tree: [
        {
          path: "assets/a.png",
          mode: "100644",
          type: "blob",
          content: "iVBORw0KGgo=",
        },
        { path: "assets/b.jpg", mode: "100755", type: "blob", content: "AAAA" },
        {
          path: "assets/c.svg",
          mode: "100644",
          type: "blob",
          content: "PHN2Zz4=",
        },
      ],
    });
  });

  it("createTreeWithContent 空 entries 直接抛错且不烧配额", async () => {
    const { impl, calls } = createFetchMock(() => jsonResponse({ sha: "x" }));
    await expect(
      makeClient(impl).createTreeWithContent("acme", "site", "base", []),
    ).rejects.toThrow(/at least one entry/);
    expect(calls).toHaveLength(0);
  });

  it("createCommit 组装 parents / tree / author", async () => {
    const { impl, calls } = createFetchMock(() =>
      jsonResponse({ sha: "commit-sha" }),
    );
    const author = {
      name: "imgbot",
      email: "imgbot@users.noreply.github.com",
      date: "2023-11-14T22:00:00Z",
    };

    const sha = await makeClient(impl).createCommit("acme", "site", {
      message: "imgbot optimize",
      treeSha: "tree-sha",
      parentSha: "parent-sha",
      author,
    });

    expect(sha).toBe("commit-sha");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe(
      "https://api.github.com/repos/acme/site/git/commits",
    );
    expect(calls[0].json).toEqual({
      message: "imgbot optimize",
      tree: "tree-sha",
      parents: ["parent-sha"],
      author,
    });
  });

  it("updateRef：PATCH 到 git/refs/heads/imgbot 并带 force", async () => {
    const { impl, calls } = createFetchMock(() =>
      jsonResponse({ ref: "refs/heads/imgbot", object: { sha: "commit-sha" } }),
    );

    const result = await makeClient(impl).updateRef(
      "acme",
      "site",
      "imgbot",
      "commit-sha",
      { force: true },
    );

    expect(result).toEqual({ ref: "refs/heads/imgbot", sha: "commit-sha" });
    expect(calls[0].method).toBe("PATCH");
    expect(calls[0].url).toBe(
      "https://api.github.com/repos/acme/site/git/refs/heads/imgbot",
    );
    expect(calls[0].json).toEqual({ sha: "commit-sha", force: true });
  });

  it("updateRef 默认 force=false", async () => {
    const { impl, calls } = createFetchMock(() =>
      jsonResponse({ ref: "refs/heads/imgbot", object: { sha: "s" } }),
    );
    await makeClient(impl).updateRef("acme", "site", "refs/heads/imgbot", "s");
    expect(calls[0].json).toEqual({ sha: "s", force: false });
  });

  it("ensureRef：首次创建成功", async () => {
    const { impl, calls } = createFetchMock(() =>
      jsonResponse({ ref: "refs/heads/imgbot", object: { sha: "s" } }, 201),
    );

    const result = await makeClient(impl).ensureRef(
      "acme",
      "site",
      "imgbot",
      "s",
    );

    expect(result).toEqual({
      created: true,
      ref: "refs/heads/imgbot",
      sha: "s",
    });
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe(
      "https://api.github.com/repos/acme/site/git/refs",
    );
    expect(calls[0].json).toEqual({ ref: "refs/heads/imgbot", sha: "s" });
  });

  it("ensureRef：422 → 已存在，视为幂等成功（§5.4）", async () => {
    const { impl, calls } = createFetchMock(() =>
      jsonResponse(
        {
          message: "Reference already exists",
          documentation_url: "https://docs.github.com/rest/git/refs",
        },
        422,
      ),
    );

    const result = await makeClient(impl).ensureRef(
      "acme",
      "site",
      "refs/heads/imgbot",
      "s",
    );

    expect(result).toEqual({
      created: false,
      ref: "refs/heads/imgbot",
      sha: "s",
    });
    expect(calls).toHaveLength(1); // 不做额外探测调用
  });

  it("findOpenPullByHead：查询形状与结果映射", async () => {
    const { impl, calls } = createFetchMock(() =>
      jsonResponse([{ number: 42, title: "imgbot" }]),
    );

    const found = await makeClient(impl).findOpenPullByHead(
      "acme",
      "site",
      "imgbot",
    );

    expect(found).toEqual({ number: 42 });
    expect(calls[0].method).toBe("GET");
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/repos/acme/site/pulls");
    expect(url.searchParams.get("state")).toBe("open");
    expect(url.searchParams.get("head")).toBe("acme:imgbot");
    expect(url.searchParams.get("per_page")).toBe("1");
  });

  it("findOpenPullByHead：空列表 → null，且透传 owner:branch 形式", async () => {
    const { impl, calls } = createFetchMock(() => jsonResponse([]));

    await expect(
      makeClient(impl).findOpenPullByHead("acme", "site", "other:imgbot"),
    ).resolves.toBeNull();

    expect(new URL(calls[0].url).searchParams.get("head")).toBe("other:imgbot");
  });

  it("createPull：head/base 归一化并返回 number", async () => {
    const { impl, calls } = createFetchMock(() =>
      jsonResponse({
        number: 7,
        html_url: "https://github.com/acme/site/pull/7",
      }),
    );

    const pr = await makeClient(impl).createPull("acme", "site", {
      title: "imgbot",
      body: "body",
      head: "refs/heads/imgbot",
      base: "main",
    });

    expect(pr).toEqual({
      number: 7,
      htmlUrl: "https://github.com/acme/site/pull/7",
    });
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("https://api.github.com/repos/acme/site/pulls");
    expect(calls[0].json).toEqual({
      title: "imgbot",
      body: "body",
      head: "imgbot",
      base: "main",
    });
  });

  it("updatePullBody：只 PATCH body 字段", async () => {
    const { impl, calls } = createFetchMock(() =>
      jsonResponse({ number: 42, body: "new body" }),
    );

    await expect(
      makeClient(impl).updatePullBody("acme", "site", 42, "new body"),
    ).resolves.toEqual({ number: 42 });

    expect(calls[0].method).toBe("PATCH");
    expect(calls[0].url).toBe(
      "https://api.github.com/repos/acme/site/pulls/42",
    );
    expect(Object.keys(calls[0].json as object)).toEqual(["body"]);
    expect(calls[0].json).toEqual({ body: "new body" });
  });
});

// ---------------------------------------------------------------------------
// §4.2 / §9-R2 错误映射（不自动重试）
// ---------------------------------------------------------------------------

describe("gitdata / 错误映射", () => {
  const table: Array<{
    status: number;
    headers?: Record<string, string>;
    message: string;
    retryable: boolean;
    retryAfter: string | null;
  }> = [
    {
      status: 401,
      message: "Bad credentials",
      retryable: false,
      retryAfter: null,
    },
    {
      status: 403,
      message: "Resource not accessible by integration",
      retryable: false,
      retryAfter: null,
    },
    {
      status: 403,
      headers: { "retry-after": "60" },
      message: "You have exceeded a secondary rate limit",
      retryable: true,
      retryAfter: "60",
    },
    {
      status: 404,
      message: "Not Found",
      retryable: false,
      retryAfter: null,
    },
    {
      status: 422,
      message: "Invalid request",
      retryable: false,
      retryAfter: null,
    },
    {
      status: 429,
      headers: { "retry-after": "30" },
      message: "Too Many Requests",
      retryable: true,
      retryAfter: "30",
    },
    {
      status: 500,
      message: "Server Error",
      retryable: true,
      retryAfter: null,
    },
    {
      status: 502,
      message: "Bad Gateway",
      retryable: true,
      retryAfter: null,
    },
  ];

  for (const row of table) {
    it(`${row.status} → retryable=${row.retryable}，retryAfter=${row.retryAfter}`, async () => {
      const { impl, calls } = createFetchMock(() =>
        jsonResponse({ message: row.message }, row.status, row.headers),
      );

      const err = await captureError(() =>
        makeClient(impl).getTreeRecursive("acme", "site", "s"),
      );

      expect(err).toBeInstanceOf(GithubApiError);
      expect(err.status).toBe(row.status);
      expect(err.retryable).toBe(row.retryable);
      expect(err.retryAfter).toBe(row.retryAfter);
      expect(err.message).toContain(String(row.status));
      expect(err.message).toContain(row.message);
      // 不做自动重试循环：失败即返回
      expect(calls).toHaveLength(1);
    });
  }

  it("403 primary rate limit（x-ratelimit-remaining: 0）可重试并折算等待秒数", async () => {
    const resetSec = Math.floor(Date.now() / 1000) + 120;
    const { impl } = createFetchMock(() =>
      jsonResponse({ message: "API rate limit exceeded" }, 403, {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(resetSec),
      }),
    );

    const err = await captureError(() =>
      makeClient(impl).getTreeRecursive("acme", "site", "s"),
    );

    expect(err.retryable).toBe(true);
    const wait = Number(err.retryAfter);
    expect(Number.isFinite(wait)).toBe(true);
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(120);
  });

  it("网络失败 → status 0 且可重试", async () => {
    const impl: FetchLike = async () => {
      throw new Error("connection reset");
    };
    const err = await captureError(() =>
      makeClient(impl).getTreeRecursive("acme", "site", "s"),
    );

    expect(err.status).toBe(0);
    expect(err.retryable).toBe(true);
    expect(err.message).toContain("connection reset");
  });

  it("非 JSON 错误体不会污染类型（保留状态码）", async () => {
    const { impl } = createFetchMock(
      () => new Response("<html>gateway</html>", { status: 503 }),
    );
    const err = await captureError(() =>
      makeClient(impl).getTreeRecursive("acme", "site", "s"),
    );
    expect(err.status).toBe(503);
    expect(err.retryable).toBe(true);
  });

  it("构造时拒绝空 token", () => {
    expect(
      () =>
        new GitDataClient({
          token: "",
          fetchImpl: async () => jsonResponse({}),
        }),
    ).toThrow(/token/);
  });

  it("apiBase 可覆盖（GitHub Enterprise）", async () => {
    const { impl, calls } = createFetchMock(() =>
      jsonResponse({ sha: "t", tree: [], truncated: false }),
    );
    const client = new GitDataClient({
      token: "t",
      fetchImpl: impl,
      apiBase: "https://ghe.example.com/api/v3/",
    });
    await client.getTreeRecursive("acme", "site", "s");
    expect(calls[0].url).toBe(
      "https://ghe.example.com/api/v3/repos/acme/site/git/trees/s?recursive=1",
    );
  });
});
