/**
 * 二进制安全写路径的补充测试（createBlob / createTreeWithShas / getTreeRootSha / getDefaultBranch）。
 * 背景：GitHub `createTree` 内联 content 按 "treats this as text" 处理，
 * 图片字节必须走 `POST /git/blobs`（base64）→ tree 引用 sha（DESIGN.md §4.2）。
 */
import { describe, expect, it } from "vitest";
import { GitDataClient, type FetchLike } from "../src/github/gitdata";

function jsonRes(body: unknown, status = 201): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

interface CapturedCall {
  url: string;
  method: string;
  body?: Record<string, unknown>;
}

function capturing(
  handler: (url: string, body?: Record<string, unknown>) => Response,
): { impl: FetchLike; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const impl: FetchLike = async (input, init) => {
    const url = String(input);
    const body = init?.body
      ? (JSON.parse(init.body as string) as Record<string, unknown>)
      : undefined;
    calls.push({ url, method: init?.method ?? "GET", body });
    return handler(url, body);
  };
  return { impl, calls };
}

describe("createBlob（二进制安全写路径）", () => {
  it("以 base64 POST /git/blobs 并返回 sha", async () => {
    const { impl, calls } = capturing(() => jsonRes({ sha: "blobsha123" }));
    const client = new GitDataClient({ token: "t", fetchImpl: impl });

    // 含 0x00 / 0xFF 的二进制字节，验证 base64 正确性
    const bytes = new Uint8Array([
      0x00, 0xff, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const sha = await client.createBlob("o", "r", bytes);

    expect(sha).toBe("blobsha123");
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toBe("https://api.github.com/repos/o/r/git/blobs");
    expect(calls[0].body?.encoding).toBe("base64");
    expect(calls[0].body?.content).toBe(Buffer.from(bytes).toString("base64"));
  });
});

describe("createTreeWithShas（sha 引用组树）", () => {
  it("entry 携带 sha 而非 content，mode 默认 100644", async () => {
    const { impl, calls } = capturing(() => jsonRes({ sha: "treesha" }));
    const client = new GitDataClient({ token: "t", fetchImpl: impl });

    const sha = await client.createTreeWithShas("o", "r", "basesha", [
      { path: "a.png", sha: "b1" },
      { path: "b.jpg", sha: "b2", mode: "100755" },
    ]);

    expect(sha).toBe("treesha");
    const tree = calls[0].body?.tree as Array<Record<string, string>>;
    expect(calls[0].body?.base_tree).toBe("basesha");
    expect(tree).toEqual([
      { path: "a.png", mode: "100644", type: "blob", sha: "b1" },
      { path: "b.jpg", mode: "100755", type: "blob", sha: "b2" },
    ]);
    expect(tree.every((e) => e.content === undefined)).toBe(true);
  });

  it("空 entries 抛错（不白烧内容写入配额）", async () => {
    const { impl } = capturing(() => jsonRes({}));
    const client = new GitDataClient({ token: "t", fetchImpl: impl });
    await expect(
      client.createTreeWithShas("o", "r", "basesha", []),
    ).rejects.toThrow(/at least one entry/);
  });
});

describe("getTreeRootSha / getDefaultBranch", () => {
  it("getTreeRootSha 取根树 sha（base_tree 用）", async () => {
    const { impl, calls } = capturing(() => jsonRes({ sha: "rootsha" }));
    const client = new GitDataClient({ token: "t", fetchImpl: impl });
    const sha = await client.getTreeRootSha("o", "r", "main");
    expect(sha).toBe("rootsha");
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url).toBe(
      "https://api.github.com/repos/o/r/git/trees/main",
    );
  });

  it("getDefaultBranch 返回默认分支；缺失时抛可操作错误", async () => {
    const ok = capturing(() => jsonRes({ default_branch: "main" }, 200));
    const clientOk = new GitDataClient({ token: "t", fetchImpl: ok.impl });
    await expect(clientOk.getDefaultBranch("o", "r")).resolves.toBe("main");

    const bad = capturing(() => jsonRes({}, 200));
    const clientBad = new GitDataClient({ token: "t", fetchImpl: bad.impl });
    await expect(clientBad.getDefaultBranch("o", "r")).rejects.toThrow(
      /default_branch/,
    );
  });
});
