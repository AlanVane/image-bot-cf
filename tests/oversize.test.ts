/**
 * Containers 兜底通道（DESIGN.md §6.3）单测。
 *
 * 覆盖：
 *   1. `container/server.mjs` 的纯函数：扩展名判定、工具选择（pickTool）、错误原因。
 *   2. 契约函数 `optimizeBytes`：严格变小 + 可解码才替换；任何异常/无收益 → 原字节。
 *   3. HTTP JSON 协议：`GET /healthz`、`POST /optimize` 的编解码、错误码与失败回原字节。
 *
 * 不测 Docker 构建与真实 CLI（jpegtran/optipng/gifsicle）——本机不保证安装，
 * 端到端交给编排方的容器 e2e。真实编码路径只断言"不违约"（产物可解码且不变大）。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import sharp from "sharp";

import { MAX_CONTAINER_INPUT_BYTES } from "../src/container/limits";

// `oversize-client` 依赖 @cloudflare/containers（workerd 侧）；node 测试里用空实现替换，
// 这样就能断言"超大输入在**碰绑定之前**就被拒绝"。
vi.mock("@cloudflare/containers", () => ({
  getRandom: vi.fn(async () => {
    throw new Error("container binding must not be reached");
  }),
}));

const { optimizeViaContainer } =
  (await import("../src/container/oversize-client")) as typeof import("../src/container/oversize-client");

interface OptimizeDeps {
  encode?: (
    kind: string,
    tool: string,
    bytes: Buffer,
    aggressive: boolean,
  ) =>
    | Promise<Buffer | Uint8Array | { bytes: Uint8Array; tool: string } | null>
    | Buffer
    | Uint8Array
    | { bytes: Uint8Array; tool: string }
    | null;
  verify?: (
    kind: string,
    candidate: Uint8Array,
    original: Uint8Array,
  ) => Promise<boolean> | boolean;
}

interface OptimizeResult {
  bytes: Buffer;
  tool: string;
}

interface ServerModule {
  detectKind(filePath: string): string | null;
  pickTool(filePath: string, aggressive: boolean): string | null;
  errorReason(error: unknown): string;
  optimizeBytes(
    payload: { path: string; bytes: Uint8Array; aggressive?: boolean },
    deps?: OptimizeDeps,
  ): Promise<OptimizeResult>;
  verifyCandidate(
    kind: string,
    candidate: Uint8Array,
    original: Uint8Array,
  ): Promise<boolean>;
  createOptimizeServer(options?: {
    deps?: OptimizeDeps;
    maxBodyBytes?: number;
  }): Server;
  MAX_BODY_BYTES: number;
  MAX_INPUT_BYTES: number;
  SHARP_LIMIT_INPUT_PIXELS: number;
}

// server.mjs 是容器内 JS（不在 tsconfig 的 include 里），用变量 specifier 动态导入，
// 避免 tsc 去解析一个没有声明文件的 .mjs。
const serverUrl = new URL("../container/server.mjs", import.meta.url).href;
const server = (await import(serverUrl)) as unknown as ServerModule;

const {
  detectKind,
  pickTool,
  errorReason,
  optimizeBytes,
  createOptimizeServer,
} = server;

async function pngBytes(width = 12, height = 12): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 200, g: 30, b: 90 },
    },
  })
    .png()
    .toBuffer();
}

describe("detectKind / pickTool（§6.1 工具选型）", () => {
  it("按扩展名判定格式，大小写不敏感", () => {
    expect(detectKind("a.png")).toBe("png");
    expect(detectKind("a.PNG")).toBe("png");
    expect(detectKind("dir/a.jpg")).toBe("jpeg");
    expect(detectKind("dir/a.JpEg")).toBe("jpeg");
    expect(detectKind("a.gif")).toBe("gif");
    expect(detectKind("a.svg")).toBe("svg");
    expect(detectKind("a.webp")).toBeNull();
    expect(detectKind("Makefile")).toBeNull();
  });

  it("无损/有损走不同工具", () => {
    expect(pickTool("a.png", false)).toBe("optipng");
    expect(pickTool("a.png", true)).toBe("sharp-png");
    expect(pickTool("a.jpg", false)).toBe("jpegtran");
    expect(pickTool("a.jpg", true)).toBe("sharp-mozjpeg");
    expect(pickTool("a.gif", false)).toBe("gifsicle");
    expect(pickTool("a.gif", true)).toBe("gifsicle-lossy");
  });

  it("SVG 原样返回，未知扩展名没有工具", () => {
    expect(pickTool("logo.svg", false)).toBe("passthrough");
    expect(pickTool("logo.svg", true)).toBe("passthrough");
    expect(pickTool("a.webp", true)).toBeNull();
    expect(pickTool("a.webp", false)).toBeNull();
  });
});

describe("errorReason（error:<原因> 归一化）", () => {
  it("取首行并截断，避免回传整段 stderr", () => {
    expect(errorReason(new Error("spawn optipng ENOENT"))).toBe(
      "error:spawn optipng ENOENT",
    );
    const long = errorReason(new Error(`boom\n${"x".repeat(200)}`));
    expect(long.startsWith("error:boom")).toBe(true);
    expect(long.includes("\n")).toBe(false);
    expect(long.length).toBeLessThanOrEqual("error:".length + 80);
  });

  it("非 Error 值也有可读原因", () => {
    expect(errorReason("nope")).toBe("error:nope");
  });
});

describe("optimizeBytes 契约（§6.4：宁可少优化，不可损坏）", () => {
  const original = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);

  it("更小且可解码 → 采用候选并报告工具", async () => {
    const candidate = Buffer.from([9, 9, 9]);
    const result = await optimizeBytes(
      { path: "big.PNG", bytes: original, aggressive: false },
      {
        encode: async (kind, tool, bytes, aggressive) => {
          expect(kind).toBe("png");
          expect(tool).toBe("optipng");
          expect(aggressive).toBe(false);
          expect(Buffer.from(bytes).equals(original)).toBe(true);
          return candidate;
        },
        verify: () => true,
      },
    );
    expect(result.tool).toBe("optipng");
    expect(Buffer.from(result.bytes).equals(candidate)).toBe(true);
  });

  it("候选没有严格变小 → 原字节 + error", async () => {
    const result = await optimizeBytes(
      { path: "a.jpg", bytes: original },
      {
        // 与原件等长也算失败（严格变小）
        encode: () => Buffer.from(original),
        verify: () => true,
      },
    );
    expect(result.tool.startsWith("error:")).toBe(true);
    expect(result.bytes.equals(original)).toBe(true);
  });

  it("校验不通过（解不开）→ 原字节 + error", async () => {
    const result = await optimizeBytes(
      { path: "a.gif", bytes: original, aggressive: true },
      {
        encode: async (kind, tool) => {
          expect(tool).toBe("gifsicle-lossy");
          return Buffer.from([7, 7]);
        },
        verify: () => false,
      },
    );
    expect(result.tool).toBe("error:not_smaller_or_invalid");
    expect(result.bytes.equals(original)).toBe(true);
  });

  it("编码抛错 → 原字节 + error:<原因>，不向外抛", async () => {
    const result = await optimizeBytes(
      { path: "a.jpg", bytes: original },
      {
        encode: () => {
          throw new Error("spawn jpegtran ENOENT");
        },
        verify: () => true,
      },
    );
    expect(result.tool).toBe("error:spawn jpegtran ENOENT");
    expect(result.bytes.equals(original)).toBe(true);
  });

  it("编码产出空字节 → 原字节", async () => {
    const result = await optimizeBytes(
      { path: "a.png", bytes: original },
      { encode: () => Buffer.alloc(0), verify: () => true },
    );
    expect(result.tool).toBe("error:empty_output");
    expect(result.bytes.equals(original)).toBe(true);
  });

  it("SVG / 未知扩展名一律 passthrough", async () => {
    for (const path of ["logo.svg", "a.webp"]) {
      const result = await optimizeBytes({ path, bytes: original });
      expect(result.tool).toBe("passthrough");
      expect(result.bytes.equals(original)).toBe(true);
    }
  });

  it("aggressive 透传到编码器（PNG 调色板量化）", async () => {
    const seen: boolean[] = [];
    await optimizeBytes(
      { path: "a.png", bytes: original, aggressive: true },
      {
        encode: (kind, tool, _bytes, aggressive) => {
          expect(tool).toBe("sharp-png");
          seen.push(aggressive);
          return Buffer.from([1]);
        },
        verify: () => true,
      },
    );
    expect(seen).toEqual([true]);
  });

  it("编码器可上报实际执行的工具（optipng → sharp 降级）", async () => {
    const result = await optimizeBytes(
      { path: "a.png", bytes: original },
      {
        encode: () => ({
          bytes: Buffer.from([5, 5, 5]),
          tool: "sharp-png-lossless",
        }),
        verify: () => true,
      },
    );
    expect(result.tool).toBe("sharp-png-lossless");
    expect(result.bytes.equals(Buffer.from([5, 5, 5]))).toBe(true);
  });

  it("真实 sharp 产物也满足契约（可解码且不变大）", async () => {
    const input = await pngBytes();
    const result = await optimizeBytes({
      path: "fixture.png",
      bytes: input,
    });
    expect(result.bytes.length).toBeLessThanOrEqual(input.length);
    const metadata = await sharp(result.bytes).metadata();
    expect(metadata.format).toBe("png");
    expect(metadata.width).toBe(12);
    expect(metadata.height).toBe(12);

    // 若真的变小，工具不能是 error:*
    if (result.bytes.length < input.length) {
      expect(result.tool.startsWith("error:")).toBe(false);
    }
  });
});

describe("verifyCandidate（严格更小 + 可再解码）", () => {
  it("空/等长/更大 → false", async () => {
    const original = await pngBytes();
    expect(await server.verifyCandidate("png", Buffer.alloc(0), original)).toBe(
      false,
    );
    expect(await server.verifyCandidate("png", original, original)).toBe(false);
    expect(
      await server.verifyCandidate(
        "png",
        Buffer.concat([original, Buffer.from([0])]),
        original,
      ),
    ).toBe(false);
  });

  it("损坏字节 → false（不许把坏图当优化结果）", async () => {
    const original = await pngBytes();
    const corrupt = Buffer.from(original);
    corrupt.fill(0, 8, 40);
    expect(await server.verifyCandidate("png", corrupt, original)).toBe(false);
  });

  it("真实更小的合法 PNG → true", async () => {
    const original = await sharp({
      create: {
        width: 8,
        height: 8,
        channels: 3,
        background: { r: 0, g: 0, b: 0 },
      },
    })
      .png({ compressionLevel: 0 })
      .toBuffer();
    const recompressed = await sharp(original)
      .png({ compressionLevel: 9, palette: true })
      .toBuffer();
    expect(recompressed.length).toBeLessThan(original.length);
    expect(await server.verifyCandidate("png", recompressed, original)).toBe(
      true,
    );
  });
});

describe("HTTP 协议（POST /optimize · GET /healthz）", () => {
  let httpServer: Server;
  let baseUrl: string;

  beforeAll(async () => {
    httpServer = createOptimizeServer();
    await new Promise<void>((resolve) => {
      httpServer.listen(0, "127.0.0.1", resolve);
    });
    const address = httpServer.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      httpServer.close((error) => (error ? reject(error) : resolve()));
    });
  });

  async function post(body: string): Promise<Response> {
    return fetch(`${baseUrl}/optimize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
  }

  it("healthz → ok", async () => {
    const response = await fetch(`${baseUrl}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });

  it("未知路由 → 404", async () => {
    const response = await fetch(`${baseUrl}/nope`);
    expect(response.status).toBe(404);
  });

  it("JSON 编解码：合法 PNG 往返后仍可解码且不变大", async () => {
    const input = await pngBytes(24, 24);
    const response = await post(
      JSON.stringify({
        path: "img/huge.png",
        bytes: input.toString("base64"),
        aggressive: false,
      }),
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { bytes: string; tool: string };
    expect(typeof payload.tool).toBe("string");

    const output = Buffer.from(payload.bytes, "base64");
    expect(output.length).toBeLessThanOrEqual(input.length);
    const metadata = await sharp(output).metadata();
    expect(metadata.format).toBe("png");
    expect(metadata.width).toBe(24);
    expect(metadata.height).toBe(24);
  });

  it("损坏输入 → 200 + 原字节 + error:<原因>（不炸调用方）", async () => {
    const garbage = Buffer.from("definitely-not-a-png");
    const response = await post(
      JSON.stringify({
        path: "broken.png",
        bytes: garbage.toString("base64"),
        aggressive: false,
      }),
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { bytes: string; tool: string };
    expect(payload.tool.startsWith("error:")).toBe(true);
    expect(Buffer.from(payload.bytes, "base64").equals(garbage)).toBe(true);
  });

  it("未知扩展名 → passthrough（原字节）", async () => {
    const input = Buffer.from([1, 2, 3, 4]);
    const response = await post(
      JSON.stringify({
        path: "weird.tiff",
        bytes: input.toString("base64"),
        aggressive: true,
      }),
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { bytes: string; tool: string };
    expect(payload.tool).toBe("passthrough");
    expect(Buffer.from(payload.bytes, "base64").equals(input)).toBe(true);
  });

  it("非法 JSON → 400，缺字段 → 400", async () => {
    expect((await post("{not json")).status).toBe(400);
    expect((await post(JSON.stringify({ path: "a.png" }))).status).toBe(400);
    expect(
      (
        await post(
          JSON.stringify({ path: "a.png", bytes: "", aggressive: false }),
        )
      ).status,
    ).toBe(400);
  });

  it("成功路径按注入的 deps 走（协议接线与 tool 回传）", async () => {
    const injected = createOptimizeServer({
      deps: {
        encode: () => Buffer.from([42, 42]),
        verify: () => true,
      },
    });
    await new Promise<void>((resolve) => {
      injected.listen(0, "127.0.0.1", resolve);
    });
    const { port } = injected.address() as AddressInfo;
    try {
      const input = Buffer.from([1, 2, 3, 4, 5]);
      const response = await fetch(`http://127.0.0.1:${port}/optimize`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path: "x.png",
          bytes: input.toString("base64"),
          aggressive: false,
        }),
      });
      const payload = (await response.json()) as {
        bytes: string;
        tool: string;
      };
      expect(response.status).toBe(200);
      expect(payload.tool).toBe("optipng");
      expect(Buffer.from(payload.bytes, "base64")).toEqual(
        Buffer.from([42, 42]),
      );
    } finally {
      await new Promise<void>((resolve) => injected.close(() => resolve()));
    }
  });

  it("注入的编码器抛错 → 200 + 原字节 + error", async () => {
    const injected = createOptimizeServer({
      deps: {
        encode: () => {
          throw new Error("gifsicle timed out");
        },
        verify: () => true,
      },
    });
    await new Promise<void>((resolve) => {
      injected.listen(0, "127.0.0.1", resolve);
    });
    const { port } = injected.address() as AddressInfo;
    try {
      const input = Buffer.from([9, 8, 7]);
      const response = await fetch(`http://127.0.0.1:${port}/optimize`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          path: "x.gif",
          bytes: input.toString("base64"),
          aggressive: true,
        }),
      });
      const payload = (await response.json()) as {
        bytes: string;
        tool: string;
      };
      expect(response.status).toBe(200);
      expect(payload.tool).toBe("error:gifsicle timed out");
      expect(Buffer.from(payload.bytes, "base64").equals(input)).toBe(true);
    } finally {
      await new Promise<void>((resolve) => injected.close(() => resolve()));
    }
  });
});

describe("容器输入硬上限（§6.3：40MB 天花板）", () => {
  it("Worker 侧常量 = 40MB；容器侧解码上限一致，body 上限含 base64 膨胀余量", () => {
    expect(MAX_CONTAINER_INPUT_BYTES).toBe(40 * 1024 * 1024);
    expect(server.MAX_INPUT_BYTES).toBe(40 * 1024 * 1024);
    // body = 40MB 原始 × 4/3 base64 + JSON 头余量（两段上限对齐决策，2026-11-18）
    expect(server.MAX_BODY_BYTES).toBe(55 * 1024 * 1024);
    // sharp 文档默认值（≈16383²）作为硬像素上限显式写死。
    expect(server.SHARP_LIMIT_INPUT_PIXELS).toBe(268402689);
  });

  it("客户端 >40MB 本地拒绝，不碰容器绑定（tool=error:input_too_large）", async () => {
    // 40MB+1 字节：若闸门失效就会走到 getRandom（mock 抛错 → 不同的 tool），断言能区分。
    const oversized = new Uint8Array(MAX_CONTAINER_INPUT_BYTES + 1);
    const result = await optimizeViaContainer(
      {} as never,
      "img/huge.png",
      oversized,
      false,
    );
    expect(result.optimized).toBeNull();
    expect(result.tool).toBe("error:input_too_large");
  });

  it("恰好 40MB 仍放行（卡在绑定缺失这一步，而不是体积闸门）", async () => {
    const atCap = new Uint8Array(MAX_CONTAINER_INPUT_BYTES + 1).subarray(
      0,
      MAX_CONTAINER_INPUT_BYTES,
    );
    const result = await optimizeViaContainer(
      {} as never,
      "img/edge.png",
      atCap,
      false,
    );
    expect(result.optimized).toBeNull();
    expect(result.tool).toBe("error:no_binding");
  });

  it("容器侧请求体超限 → 413（解析前拦截，不进解码器）", async () => {
    // 注入小上限，避免测试里真的构造 40MB 请求体；真实上限由上一条常量断言钉住。
    const limited = createOptimizeServer({ maxBodyBytes: 1024 });
    await new Promise<void>((resolve) => {
      limited.listen(0, "127.0.0.1", resolve);
    });
    const { port } = limited.address() as AddressInfo;
    try {
      const body = JSON.stringify({
        path: "img/huge.png",
        bytes: "A".repeat(4096),
        aggressive: false,
      });
      const response = await fetch(`http://127.0.0.1:${port}/optimize`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      expect(response.status).toBe(413);
      expect((await response.json()) as { error: string }).toEqual({
        error: "body_too_large",
      });
    } finally {
      await new Promise<void>((resolve) => limited.close(() => resolve()));
    }
  });
});
