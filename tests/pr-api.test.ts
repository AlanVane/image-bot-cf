/**
 * PR API 边界归一化测试。
 * 背景：`ensureRef`/`updateRef` 的归一化形式是 `heads/imgbot`（git refs API 正确），
 * 但 `POST /pulls` 只认裸分支名——直接透传会 422 Validation Failed（e2e 实测踩坑）。
 */
import { describe, expect, it } from "vitest";
import { GitDataClient, type FetchLike } from "../src/github/gitdata";

function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function capturing(
  handler: (url: string, body?: Record<string, unknown>) => Response,
): {
  impl: FetchLike;
  calls: Array<{ url: string; method: string; body?: Record<string, unknown> }>;
} {
  const calls: Array<{
    url: string;
    method: string;
    body?: Record<string, unknown>;
  }> = [];
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

describe("createPull 的 head/base 归一化", () => {
  it.each([
    ["heads/imgbot", "imgbot"],
    ["refs/heads/imgbot", "imgbot"],
    ["imgbot", "imgbot"],
  ])("head=%s → %s", async (input, expected) => {
    const { impl, calls } = capturing(() => jsonRes({ number: 7 }, 201));
    const client = new GitDataClient({ token: "t", fetchImpl: impl });
    await client.createPull("o", "r", {
      title: "t",
      body: "b",
      head: input,
      base: "heads/master",
    });
    expect(calls[0].body?.head).toBe(expected);
    expect(calls[0].body?.base).toBe("master");
  });
});

describe("findOpenPullByHead 的 head 归一化", () => {
  it("heads/imgbot → 查询 owner:imgbot（而非 owner:heads/imgbot）", async () => {
    const { impl, calls } = capturing(() => jsonRes([]));
    const client = new GitDataClient({ token: "t", fetchImpl: impl });
    await client.findOpenPullByHead("o", "r", "heads/imgbot");
    expect(calls[0].url).toContain("head=o%3Aimgbot");
    expect(calls[0].url).not.toContain("heads%2Fimgbot");
  });

  it("显式 owner:branch 形式原样保留", async () => {
    const { impl, calls } = capturing(() => jsonRes([{ number: 3 }]));
    const client = new GitDataClient({ token: "t", fetchImpl: impl });
    const found = await client.findOpenPullByHead("o", "r", "fork:feature");
    expect(found).toEqual({ number: 3 });
    expect(calls[0].url).toContain("head=fork%3Afeature");
  });
});
