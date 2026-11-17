/**
 * GraphQL `createCommitOnBranch`（§4.3 方案 A）与消息拆分工具的测试。
 * 实测结论（2026-11-17 真仓探针）：GitHub 自动 PGP 签名 → Verified 徽章；
 * `contents` 强制 Base64，二进制逐字节保真。
 */
import { describe, expect, it } from "vitest";
import { GitDataClient, type FetchLike } from "../src/github/gitdata";
import { sha256Hex, splitCommitMessage } from "../src/workflow/logic";

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

describe("createCommitOnBranch", () => {
  it("POST /graphql：base64 contents + expectedHeadOid，branchName 剥前缀", async () => {
    const { impl, calls } = capturing(() =>
      jsonRes({
        data: { createCommitOnBranch: { commit: { oid: "newsha" } } },
      }),
    );
    const client = new GitDataClient({ token: "t", fetchImpl: impl });

    const oid = await client.createCommitOnBranch("o", "r", {
      branchName: "heads/imgbot",
      headline: "[ImgBot] Optimize images",
      body: "*a.png -- 1.00kb -> 0.50kb (50%)",
      additions: [{ path: "a.png", contentsBase64: "aGVsbG8=" }],
      expectedHeadOid: "basehead",
    });

    expect(oid).toBe("newsha");
    expect(calls[0].url).toBe("https://api.github.com/graphql");
    const input = (
      calls[0].body?.variables as { input: Record<string, unknown> }
    ).input;
    const branch = input.branch as Record<string, string>;
    expect(branch.branchName).toBe("imgbot");
    expect(branch.repositoryNameWithOwner).toBe("o/r");
    expect(input.expectedHeadOid).toBe("basehead");
    const fc = input.fileChanges as {
      additions: Array<Record<string, string>>;
    };
    expect(fc.additions).toEqual([{ path: "a.png", contents: "aGVsbG8=" }]);
  });

  it("GraphQL errors（确定性）→ 抛错且不可重试", async () => {
    const { impl } = capturing(() =>
      jsonRes({ errors: [{ type: "FORBIDDEN", message: "invalid value" }] }),
    );
    const client = new GitDataClient({ token: "t", fetchImpl: impl });
    await expect(
      client.createCommitOnBranch("o", "r", {
        branchName: "imgbot",
        headline: "x",
        additions: [],
        expectedHeadOid: "h",
      }),
    ).rejects.toThrow(/createCommitOnBranch failed/);
  });
});

describe("splitCommitMessage（§2.2 模板 → GraphQL headline/body）", () => {
  it("标题 + 正文拆分，重组与原文一致（边界空白归一）", () => {
    const message =
      "[ImgBot] Optimize images\n\n*a.png -- 1.00kb -> 0.50kb (50%)\n\nSigned-off-by: ImgBotApp <ImgBotHelp@gmail.com>\n";
    const { headline, body } = splitCommitMessage(message);
    expect(headline).toBe("[ImgBot] Optimize images");
    expect(body).toBe(
      "*a.png -- 1.00kb -> 0.50kb (50%)\n\nSigned-off-by: ImgBotApp <ImgBotHelp@gmail.com>",
    );
    // Git 的 message = headline + "\n\n" + body
    expect(`${headline}\n\n${body}`).toBe(message.trimEnd());
  });

  it("单行消息", () => {
    expect(splitCommitMessage("only")).toEqual({ headline: "only", body: "" });
  });
});

describe("sha256Hex", () => {
  it("已知向量：abc", async () => {
    expect(await sha256Hex(new TextEncoder().encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});
