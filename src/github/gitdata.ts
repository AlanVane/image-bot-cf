/**
 * GitHub Git Data API 客户端（DESIGN.md §4.2）—— 纯 fetch，零依赖。
 *
 * 设计约束：
 * - 写入路径只用 ~4 次内容类调用：一次内联 content 的 `POST /git/trees`（N 个 blob 一次提交，
 *   规避 80/min、500/hr 的二级限速，§9-R2）→ commit → ref → PR。
 * - **不做自动重试**。错误统一抛 `GithubApiError`，由调用方（Workflow 步）决定重试；
 *   429 / 次级限速映射为 `retryable: true` 并透出 `Retry-After`。
 * - 所有网络访问走注入的 `fetchImpl`，便于测试与本文件以外的策略包装。
 */

import type { TreeBlob } from "../types";
import {
  GITHUB_API_BASE,
  GithubNetworkError,
  githubRequest,
  type FetchLike,
  type GithubHttpResult,
} from "./http";

// 传输层已上移到 ./http.ts；这里保留转出，既有 import 路径（github/auth.ts、
// tests/github.test.ts 等）不用改。
export { GITHUB_API_BASE, GITHUB_API_VERSION } from "./http";
export type { FetchLike } from "./http";

export interface GithubApiErrorOptions {
  /** HTTP 状态码；网络层失败（fetch 抛错）用 0。 */
  status: number;
  message: string;
  /** 调用方是否值得重试（429 / 次级限速 / 5xx / 网络抖动）。 */
  retryable?: boolean;
  /** GitHub 的 `Retry-After`（秒数字符串），或由 `x-ratelimit-reset` 折算的等待秒数。 */
  retryAfter?: string | null;
  cause?: unknown;
}

/**
 * GitHub API 的类型化错误。
 * 401/403/404/422 属于"不可重试"语义错误；429（含 secondary rate limit）、5xx、
 * 网络失败属于可重试。v1 不做内部重试循环，避免与 Workflow 步重试叠加。
 */
export class GithubApiError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  readonly retryAfter: string | null;

  constructor(opts: GithubApiErrorOptions) {
    super(opts.message);
    this.name = "GithubApiError";
    this.status = opts.status;
    this.retryable = opts.retryable ?? false;
    this.retryAfter = opts.retryAfter ?? null;
    if (opts.cause !== undefined) {
      this.cause = opts.cause;
    }
  }
}

export function isGithubApiError(err: unknown): err is GithubApiError {
  return err instanceof GithubApiError;
}

/** `POST /git/trees` 的 entry；content 为 base64（GitHub 内联写入，无需先建 blob）。 */
/** `createTreeWithShas` 的条目：引用已创建的 blob（二进制安全写路径，§4.2）。 */
export interface TreeShaEntryInput {
  path: string;
  sha: string;
  /** 默认 `100644`；可执行文件用 `100755`，符号链接用 `120000`。 */
  mode?: "100644" | "100755" | "120000";
  type?: "blob" | "tree";
}

export interface TreeEntryInput {
  path: string;
  contentBase64: string;
  /** 默认 `100644`；可执行文件用 `100755`，符号链接用 `120000`。 */
  mode?: "100644" | "100755" | "120000";
  type?: "blob";
}

export interface CommitInput {
  message: string;
  treeSha: string;
  parentSha: string;
  author?: CommitAuthor;
}

export interface CommitAuthor {
  name: string;
  email: string;
  /** ISO-8601；缺省由 GitHub 以服务器时间填充。 */
  date?: string;
}

export interface TreeEntryResponse {
  path?: string;
  mode?: string;
  type?: string;
  sha?: string;
  size?: number;
}

export interface GitDataClientOptions {
  /** installation token（见 ./auth.ts）。 */
  token: string;
  fetchImpl?: FetchLike;
  /** 默认 https://api.github.com；GitHub Enterprise 可覆盖。 */
  apiBase?: string;
}

function encodeSegment(value: string): string {
  return encodeURIComponent(value);
}

function repoPath(owner: string, repo: string, suffix: string): string {
  return `/repos/${encodeSegment(owner)}/${encodeSegment(repo)}${suffix}`;
}

/**
 * 归一化 ref 为 `heads/imgbot` / `tags/v1` 形式（GitHub `git/refs/*` 端点期待的相对路径）。
 * 接受 `imgbot`、`heads/imgbot`、`refs/heads/imgbot`。
 */
export function normalizeRef(ref: string): string {
  let value = ref.trim();
  if (value.startsWith("refs/")) {
    value = value.slice("refs/".length);
  }
  if (!value.startsWith("heads/") && !value.startsWith("tags/")) {
    value = `heads/${value}`;
  }
  return value;
}

function requireSha(body: unknown, what: string): string {
  const sha = (body as { sha?: unknown } | null)?.sha;
  if (typeof sha !== "string" || sha.length === 0) {
    throw new GithubApiError({
      status: 502,
      message: `GitHub ${what} response is missing \`sha\``,
      retryable: true,
    });
  }
  return sha;
}

/**
 * 把非 2xx 响应映射为类型化错误。消息体只在能解析出 `message` 时使用，避免把整页 HTML 塞进日志。
 * `bodyText`：响应体已被传输层读走时传入原始文本（Response 的 body 不可重复读取）。
 */
export async function toGithubApiError(
  res: Response,
  method: string,
  path: string,
  bodyText?: string,
): Promise<GithubApiError> {
  const status = res.status;
  const retryAfterHeader = res.headers.get("retry-after");
  const remainingHeader = res.headers.get("x-ratelimit-remaining");
  const resetHeader = res.headers.get("x-ratelimit-reset");

  let bodyMessage = "";
  let bodyRetryAfter: number | undefined;
  try {
    const text = bodyText !== undefined ? bodyText : await res.text();
    if (text) {
      try {
        const parsed = JSON.parse(text) as {
          message?: unknown;
          retry_after?: unknown;
        };
        if (typeof parsed?.message === "string") bodyMessage = parsed.message;
        if (typeof parsed?.retry_after === "number") {
          bodyRetryAfter = parsed.retry_after;
        }
      } catch {
        bodyMessage = text.slice(0, 200);
      }
    }
  } catch {
    // 读不出 body 不影响错误类型。
  }

  const rateLimited =
    status === 429 ||
    (status === 403 &&
      (retryAfterHeader !== null ||
        remainingHeader === "0" ||
        /rate limit|secondary rate/i.test(bodyMessage)));

  let retryAfter: string | null = null;
  if (retryAfterHeader !== null) {
    retryAfter = retryAfterHeader.trim();
  } else if (bodyRetryAfter !== undefined) {
    retryAfter = String(bodyRetryAfter);
  } else if (status === 403 && resetHeader !== null) {
    const resetSec = Number(resetHeader);
    if (Number.isFinite(resetSec)) {
      retryAfter = String(
        Math.max(0, Math.floor(resetSec - Date.now() / 1000)),
      );
    }
  }

  const retryable = rateLimited || status >= 500;
  const reason = bodyMessage || res.statusText || "unknown error";
  return new GithubApiError({
    status,
    message: `GitHub ${method} ${path} failed: ${status} ${reason}`,
    retryable,
    retryAfter,
  });
}

/**
 * Git Data API + Pulls API 客户端。
 * 所有方法都对 4xx 抛 `GithubApiError`；调用方负责幂等与重试策略（见 §5.3）。
 */
/** base64 编码（Workers 无 Buffer；分块避免超长参数）。 */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export class GitDataClient {
  private readonly token: string;
  private readonly fetchImpl: FetchLike;
  private readonly apiBase: string;

  constructor(opts: GitDataClientOptions) {
    if (!opts.token) {
      throw new Error("GitDataClient requires an installation token");
    }
    const impl = opts.fetchImpl ?? (globalThis.fetch as FetchLike | undefined);
    if (typeof impl !== "function") {
      throw new Error("GitDataClient requires a fetch implementation");
    }
    this.token = opts.token;
    // ⚠️ workerd 陷阱：绝不能以成员调用（`this.fetchImpl(...)`）调用原生 fetch——
    // `this` 会变成 client 实例，触发 WebIDL "Illegal invocation"。统一封一层箭头裸调用。
    this.fetchImpl = (input, init) => impl(input, init);
    this.apiBase = (opts.apiBase ?? GITHUB_API_BASE).replace(/\/+$/, "");
  }

  private async request(
    method: string,
    path: string,
    opts: { accept?: string; body?: unknown; raw?: boolean } = {},
  ): Promise<GithubHttpResult> {
    const serialized =
      opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
    const init: RequestInit =
      serialized !== undefined
        ? {
            method,
            headers: { "content-type": "application/json" },
            body: serialized,
          }
        : { method };

    let result: GithubHttpResult;
    try {
      result = await githubRequest({
        token: this.token,
        path,
        init,
        fetchImpl: this.fetchImpl,
        base: this.apiBase,
        accept: opts.accept,
        raw: opts.raw === true,
      });
    } catch (err) {
      if (err instanceof GithubNetworkError) {
        throw new GithubApiError({
          status: 0,
          message: err.message,
          retryable: true,
          cause: err.cause ?? err,
        });
      }
      throw err;
    }
    if (!result.ok) {
      throw await toGithubApiError(
        result.response,
        method,
        path,
        result.text ?? undefined,
      );
    }
    return result;
  }

  /**
   * 递归列出一棵树，只保留 `blob` 条目（§4.2 读路径）。
   * `truncated` 必须透出：超大仓需要退化为分目录递归（§9-R10）。
   */
  async getTreeRecursive(
    owner: string,
    repo: string,
    sha: string,
  ): Promise<{ tree: TreeBlob[]; truncated: boolean }> {
    const out = await this.request(
      "GET",
      `${repoPath(owner, repo, `/git/trees/${encodeSegment(sha)}`)}?recursive=1`,
    );
    const body = out.body as {
      tree?: TreeEntryResponse[];
      truncated?: unknown;
    };
    const tree: TreeBlob[] = [];
    for (const entry of body.tree ?? []) {
      if (entry.type !== "blob") continue;
      if (typeof entry.path !== "string" || typeof entry.sha !== "string") {
        continue;
      }
      tree.push({
        path: entry.path,
        sha: entry.sha,
        size: typeof entry.size === "number" ? entry.size : 0,
      });
    }
    return { tree, truncated: body.truncated === true };
  }

  /** 取原始字节（`Accept: application/vnd.github.raw`）；>1MB 的 blob 只能走这里。 */
  async getBlobRaw(
    owner: string,
    repo: string,
    sha: string,
  ): Promise<Uint8Array> {
    const out = await this.request(
      "GET",
      repoPath(owner, repo, `/git/blobs/${encodeSegment(sha)}`),
      { accept: "application/vnd.github.raw", raw: true },
    );
    return new Uint8Array(await out.response.arrayBuffer());
  }

  /**
   * **一次** `POST /git/trees` 内联 blob 内容。⚠️ 仅适用于**文本**条目：
   * GitHub 对内联 `content` 按 "treats this as text" 处理，二进制（图片字节）
   * 必须走 `createBlob` + `createTreeWithShas`（见 §4.2 二进制安全写路径）。
   * 返回新的 tree sha；空 entries 视为编程错误（会白烧一次内容写入配额）。
   */
  async createTreeWithContent(
    owner: string,
    repo: string,
    baseTreeSha: string,
    entries: TreeEntryInput[],
  ): Promise<string> {
    if (entries.length === 0) {
      throw new Error("createTreeWithContent requires at least one entry");
    }
    const out = await this.request(
      "POST",
      repoPath(owner, repo, "/git/trees"),
      {
        body: {
          base_tree: baseTreeSha,
          tree: entries.map((entry) => ({
            path: entry.path,
            mode: entry.mode ?? "100644",
            type: entry.type ?? "blob",
            content: entry.contentBase64,
          })),
        },
      },
    );
    return requireSha(out.body, "POST /git/trees");
  }

  /**
   * `POST /git/blobs` 创建单个 blob（base64）。二进制**必须**走此路径
   * （`createTree` 内联 content 会损坏二进制，见上）。
   * 内容写入二级限速 80/min、500/hr（§9-R2）：按批分散调用，依赖步进重试消化 429。
   */
  async createBlob(
    owner: string,
    repo: string,
    bytes: Uint8Array,
  ): Promise<string> {
    const out = await this.request(
      "POST",
      repoPath(owner, repo, "/git/blobs"),
      {
        body: {
          content: toBase64(bytes),
          encoding: "base64",
        },
      },
    );
    return requireSha(out.body, "POST /git/blobs");
  }

  /**
   * `POST /git/trees` 以 sha 引用组装树（二进制安全写路径，§4.2）：
   * 条目引用 `createBlob` 的产物，不再内联内容。空 entries 视为编程错误。
   */
  async createTreeWithShas(
    owner: string,
    repo: string,
    baseTreeSha: string,
    entries: TreeShaEntryInput[],
  ): Promise<string> {
    if (entries.length === 0) {
      throw new Error("createTreeWithShas requires at least one entry");
    }
    const out = await this.request(
      "POST",
      repoPath(owner, repo, "/git/trees"),
      {
        body: {
          base_tree: baseTreeSha,
          tree: entries.map((entry) => ({
            path: entry.path,
            mode: entry.mode ?? "100644",
            type: entry.type ?? "blob",
            sha: entry.sha,
          })),
        },
      },
    );
    return requireSha(out.body, "POST /git/trees");
  }

  /**
   * GraphQL `createCommitOnBranch`（§4.3 方案 A，实测：GitHub 自动 PGP 签名 →
   * Verified 徽章；`contents` 强制 Base64，二进制逐字节保真）。
   * 一次调用 = 一个 commit；超大 PR 的请求体体积是唯一风险点（见 §4.3 注记）。
   */
  async createCommitOnBranch(
    owner: string,
    repo: string,
    input: {
      branchName: string;
      headline: string;
      body?: string;
      additions: Array<{ path: string; contentsBase64: string }>;
      deletions?: string[];
      expectedHeadOid: string;
    },
  ): Promise<string> {
    const query = `mutation($input: CreateCommitOnBranchInput!) {
  createCommitOnBranch(input: $input) {
    commit { oid }
  }
}`;
    const out = await this.request("POST", "/graphql", {
      body: {
        query,
        variables: {
          input: {
            branch: {
              repositoryNameWithOwner: `${owner}/${repo}`,
              // PR/ref API 的教训同样适用：这里只认裸分支名
              branchName: input.branchName.replace(
                /^(?:refs\/heads\/|heads\/)/,
                "",
              ),
            },
            message: {
              headline: input.headline,
              ...(input.body ? { body: input.body } : {}),
            },
            fileChanges: {
              additions: input.additions.map((a) => ({
                path: a.path,
                contents: a.contentsBase64,
              })),
              ...(input.deletions?.length
                ? { deletions: input.deletions.map((p) => ({ path: p })) }
                : {}),
            },
            expectedHeadOid: input.expectedHeadOid,
          },
        },
      },
    });
    const json = out.body as {
      data?: { createCommitOnBranch?: { commit?: { oid?: unknown } } };
      errors?: Array<{ message?: string; type?: string }>;
    };
    const oid = json.data?.createCommitOnBranch?.commit?.oid;
    if (typeof oid !== "string") {
      const detail = JSON.stringify(json.errors ?? []).slice(0, 300);
      const retryable = /rate limit|timeout|unavailable/i.test(detail);
      throw new GithubApiError({
        status: 502,
        message: `GraphQL createCommitOnBranch failed: ${detail}`,
        retryable,
      });
    }
    return oid;
  }

  /** ref → commit sha（`GET /git/ref`；不存在抛 404 类 `GithubApiError`）。 */
  async getRefCommitSha(
    owner: string,
    repo: string,
    ref: string,
  ): Promise<string> {
    // 注意：分支名里的 `/` 保持未编码（GitHub 的 `:ref` 语义），故不用 encodeSegment。
    const out = await this.request(
      "GET",
      `/repos/${encodeSegment(owner)}/${encodeSegment(repo)}/git/ref/${normalizeRef(ref)}`,
    );
    const body = out.body as { object?: { sha?: unknown } };
    if (typeof body.object?.sha !== "string") {
      throw new GithubApiError({
        status: 502,
        message: `GET /git/ref/${ref}: missing object.sha`,
        retryable: true,
      });
    }
    return body.object.sha;
  }

  /** commit 的作者身份与消息（人类改动中止守卫 + 幂等续传用，§2.1）。 */
  async getCommitAuthor(
    owner: string,
    repo: string,
    commitSha: string,
  ): Promise<{ name: string; email: string; message: string }> {
    const out = await this.request(
      "GET",
      repoPath(owner, repo, `/git/commits/${encodeSegment(commitSha)}`),
    );
    const body = out.body as {
      author?: { name?: unknown; email?: unknown };
      message?: unknown;
    };
    return {
      name: typeof body.author?.name === "string" ? body.author.name : "",
      email: typeof body.author?.email === "string" ? body.author.email : "",
      message: typeof body.message === "string" ? body.message : "",
    };
  }

  /** 删除 ref（暂存分支清理用；404 由调用方决定是否静默）。 */
  async deleteRef(owner: string, repo: string, ref: string): Promise<void> {
    await this.request(
      "DELETE",
      repoPath(owner, repo, `/git/refs/${normalizeRef(ref)}`),
    );
  }

  /** `GET /repos/{owner}/{repo}` → 默认分支名（RunDescriptor.base_ref 缺失时兜底）。 */
  async getDefaultBranch(owner: string, repo: string): Promise<string> {
    const out = await this.request("GET", repoPath(owner, repo, ""));
    const body = out.body as { default_branch?: string };
    if (typeof body.default_branch !== "string" || !body.default_branch) {
      throw new GithubApiError({
        status: 0,
        message: `GET /repos/${owner}/${repo}: missing default_branch`,
        retryable: false,
      });
    }
    return body.default_branch;
  }

  /** 根树 sha（`createTreeWithShas` 的 `base_tree` 需要树 SHA 而非 commit SHA）。 */
  async getTreeRootSha(
    owner: string,
    repo: string,
    ref: string,
  ): Promise<string> {
    const out = await this.request(
      "GET",
      repoPath(owner, repo, `/git/trees/${encodeSegment(ref)}`),
    );
    return requireSha(out.body, "GET /git/trees");
  }

  async createCommit(
    owner: string,
    repo: string,
    input: CommitInput,
  ): Promise<string> {
    const out = await this.request(
      "POST",
      repoPath(owner, repo, "/git/commits"),
      {
        body: {
          message: input.message,
          tree: input.treeSha,
          parents: [input.parentSha],
          ...(input.author ? { author: input.author } : {}),
        },
      },
    );
    return requireSha(out.body, "POST /git/commits");
  }

  /** `PATCH /git/refs/{ref}`；重建 imgbot 分支时 `force: true`（D5）。 */
  async updateRef(
    owner: string,
    repo: string,
    ref: string,
    sha: string,
    opts: { force?: boolean } = {},
  ): Promise<{ ref: string; sha: string }> {
    const full = normalizeRef(ref);
    const out = await this.request(
      "PATCH",
      repoPath(owner, repo, `/git/refs/${full}`),
      { body: { sha, force: opts.force === true } },
    );
    const body = out.body as {
      ref?: string;
      object?: { sha?: string };
    };
    return {
      ref: typeof body.ref === "string" ? body.ref : `refs/${full}`,
      sha: typeof body.object?.sha === "string" ? body.object.sha : sha,
    };
  }

  /**
   * 幂等创建 ref：`POST /git/refs`，**422 视为已存在**（§4.2 第 3 步 / §5.4 注记）。
   * 注意 422 在 GitHub 上也可能是非法 sha；本层按契约只做"已存在"解释，
   * 需要区分时调用方再查 `getRef` 语义（v1 不额外烧调用）。
   */
  async ensureRef(
    owner: string,
    repo: string,
    ref: string,
    sha: string,
  ): Promise<{ created: boolean; ref: string; sha: string }> {
    const full = normalizeRef(ref);
    try {
      await this.request("POST", repoPath(owner, repo, "/git/refs"), {
        body: { ref: `refs/${full}`, sha },
      });
      return { created: true, ref: `refs/${full}`, sha };
    } catch (err) {
      if (err instanceof GithubApiError && err.status === 422) {
        return { created: false, ref: `refs/${full}`, sha };
      }
      throw err;
    }
  }

  /**
   * 查同 head 的 open PR。GitHub 的 `head` 过滤器形如 `owner:branch`。
   * 只取 1 条；`number` 用于之后的原地 body 更新（避免重复 PR，§9-R9）。
   */
  async findOpenPullByHead(
    owner: string,
    repo: string,
    headRef: string,
  ): Promise<{ number: number } | null> {
    const head = headRef.includes(":")
      ? headRef
      : `${owner}:${headRef.replace(/^(?:refs\/heads\/|heads\/)/, "")}`;
    const query = new URLSearchParams({
      state: "open",
      head,
      per_page: "1",
    });
    const out = await this.request(
      "GET",
      `${repoPath(owner, repo, "/pulls")}?${query.toString()}`,
    );
    const list = out.body as unknown;
    if (!Array.isArray(list) || list.length === 0) return null;
    const number = (list[0] as { number?: unknown })?.number;
    return typeof number === "number" ? { number } : null;
  }

  async createPull(
    owner: string,
    repo: string,
    input: { title: string; body: string; head: string; base: string },
  ): Promise<{ number: number; htmlUrl: string | null }> {
    const out = await this.request("POST", repoPath(owner, repo, "/pulls"), {
      body: {
        title: input.title,
        body: input.body,
        // PR API 只认裸分支名：`heads/imgbot`（git refs 归一化形式）与 `refs/heads/imgbot` 都要剥
        head: input.head.replace(/^(?:refs\/heads\/|heads\/)/, ""),
        base: input.base.replace(/^(?:refs\/heads\/|heads\/)/, ""),
      },
    });
    const body = out.body as {
      number?: unknown;
      html_url?: unknown;
    };
    if (typeof body.number !== "number") {
      throw new GithubApiError({
        status: 502,
        message: "GitHub POST /pulls response is missing `number`",
        retryable: true,
      });
    }
    return {
      number: body.number,
      htmlUrl: typeof body.html_url === "string" ? body.html_url : null,
    };
  }

  /** 原地更新 PR 描述（只 PATCH body，标题/分支不动）。 */
  async updatePullBody(
    owner: string,
    repo: string,
    number: number,
    body: string,
  ): Promise<{ number: number }> {
    await this.request("PATCH", repoPath(owner, repo, `/pulls/${number}`), {
      body: { body },
    });
    return { number };
  }
}
