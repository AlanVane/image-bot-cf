/**
 * GitHub HTTP 传输层——**唯一**的出口（DESIGN.md §4）。
 *
 * 合并前的四份并行实现（Git Data 客户端、cron sweep、仪表盘 API、OAuth）各自
 * 维护 headers / 分页 / URL 拼接；这里收口成一份，行为保持逐字一致：
 *
 * - 非 2xx **不抛**（返回 `ok: false` + `status`），由调用方决定错误语义：
 *   Git Data 用 `toGithubApiError` 映射成 `GithubApiError`，OAuth 看状态码分支；
 * - body 解析是"尽力而为"的 JSON：空体 / 非 JSON → `body: null`（原始文本留在
 *   `text` 里，OAuth 的错误文案与 gitdata 的错误映射都要用到它）；
 * - `raw: true` 时不读 body（二进制下载），调用方自行消费 `response`；
 * - 网络失败抛 `GithubNetworkError`（status 0 语义），由调用方包装。
 *
 * ⚠️ workerd 陷阱：绝不能以成员调用（`opts.fetchImpl(...)`）调用原生 fetch——
 * `this` 会变成 options 对象，触发 WebIDL "Illegal invocation"。统一先取到局部
 * 变量再裸调用（同 gitdata.ts / dashboard/auth.ts 的历史教训）。
 */

/** 与 `typeof fetch` 结构一致；测试注入 mock 时使用。 */
export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export const GITHUB_API_BASE = "https://api.github.com";
export const GITHUB_API_VERSION = "2022-11-28";

/** 分页上限：100 条/页 × 10 页，足够覆盖当前规模且防止死循环。 */
export const MAX_PAGES = 10;
/** 每页条数（GitHub 允许的最大值）。 */
export const PER_PAGE = "100";
/** 仪表盘 API / cron sweep 历史的单次请求超时（毫秒）。 */
export const REQUEST_TIMEOUT_MS = 20_000;

/**
 * 默认 header 集合。
 * `token` 缺省（OAuth 交换 / 刷新走 body 凭据）时不发 authorization。
 */
export function githubHeaders(
  token?: string | null,
  accept = "application/vnd.github+json",
): Record<string, string> {
  const headers: Record<string, string> = {
    accept,
    "x-github-api-version": GITHUB_API_VERSION,
    "user-agent": "image-bot-cf",
  };
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

/** RFC 5988 `Link: <…>; rel="next"` → next URL。 */
export function nextLink(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(",")) {
    if (!/rel="?next"?/.test(part)) continue;
    const match = /<([^>]+)>/.exec(part);
    if (match?.[1]) return match[1];
  }
  return null;
}

/** 网络层失败（fetch 抛错 / 超时）；HTTP 状态码语义由调用方赋予（通常 0）。 */
export class GithubNetworkError extends Error {
  readonly method: string;
  /** 调用方传入的 path 或完整 URL。 */
  readonly path: string;
  /** 原始失败的描述（不含前缀，便于调用方拼自己的 detail）。 */
  readonly reason: string;

  constructor(opts: {
    method: string;
    path: string;
    reason: string;
    cause?: unknown;
  }) {
    super(`GitHub ${opts.method} ${opts.path} network error: ${opts.reason}`);
    this.name = "GithubNetworkError";
    this.method = opts.method;
    this.path = opts.path;
    this.reason = opts.reason;
    if (opts.cause !== undefined) this.cause = opts.cause;
  }
}

/** `githubRequest` 的返回值：状态 + 尽力解析的 JSON + 分页链接 + 原始文本。 */
export interface GithubHttpResult {
  status: number;
  ok: boolean;
  /** `JSON.parse` 成功才有值；空体 / 非 JSON → null。 */
  body: unknown;
  /** `Link` 响应头原样（未解析）。 */
  link: string | null;
  /** 原始响应文本；`raw: true` 时未读取 → null（body 仍可用）。 */
  text: string | null;
  /** 原始响应；`raw: true` 时 body 未被消费（二进制下载用）。 */
  response: Response;
}

export interface GithubRequestOptions {
  /** installation token / App JWT / user token；OAuth 端点缺省。 */
  token?: string | null;
  /** 相对 path（拼到 `base` 后）或完整 URL。 */
  path: string;
  init?: RequestInit;
  fetchImpl?: FetchLike;
  /** 默认 `GITHUB_API_BASE`；OAuth 等其它 host 显式传入。 */
  base?: string;
  /** accept 覆盖（OAuth 用 `application/json`）。 */
  accept?: string;
  /** true → 不读 body（二进制），调用方用 `response` 自行消费。 */
  raw?: boolean;
  /**
   * 超时毫秒；缺省 / 0 = 不设超时。
   * 只有历史上就带超时的调用方（仪表盘 API、cron sweep）传 `REQUEST_TIMEOUT_MS`；
   * Git Data / OAuth 保持原本的"由调用方策略决定"语义（大 blob 不能被一刀切掐断）。
   */
  timeoutMs?: number;
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function resolveFetch(fetchImpl?: FetchLike): FetchLike {
  const impl = fetchImpl ?? (globalThis.fetch as FetchLike | undefined);
  if (typeof impl !== "function") {
    throw new Error("githubRequest requires a fetch implementation");
  }
  return impl;
}

/**
 * 单一 HTTP 入口。
 * 非 2xx 不抛（`ok: false`）；网络失败抛 `GithubNetworkError`。
 */
export async function githubRequest(
  opts: GithubRequestOptions,
): Promise<GithubHttpResult> {
  // 先落到局部变量：裸调用，避免 `opts.fetchImpl(...)` 的成员调用陷阱。
  const impl = resolveFetch(opts.fetchImpl);
  const base = (opts.base ?? GITHUB_API_BASE).replace(/\/+$/, "");
  const url = opts.path.startsWith("http") ? opts.path : `${base}${opts.path}`;
  const init = opts.init ?? {};
  const method = init.method ?? "GET";

  const timeoutMs = opts.timeoutMs ?? 0;
  const signal =
    init.signal !== undefined && init.signal !== null
      ? init.signal
      : timeoutMs > 0
        ? AbortSignal.timeout(timeoutMs)
        : undefined;

  const requestInit: RequestInit = {
    ...init,
    headers: {
      ...githubHeaders(opts.token, opts.accept),
      ...((init.headers as Record<string, string> | undefined) ?? {}),
    },
    ...(signal ? { signal } : {}),
  };

  let res: Response;
  try {
    res = await impl(url, requestInit);
  } catch (err) {
    throw new GithubNetworkError({
      method,
      path: opts.path,
      reason: describeError(err),
      cause: err,
    });
  }

  if (opts.raw === true) {
    return {
      status: res.status,
      ok: res.ok,
      body: null,
      link: res.headers.get("link"),
      text: null,
      response: res,
    };
  }

  const text = await res.text();
  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }

  return {
    status: res.status,
    ok: res.ok,
    body,
    link: res.headers.get("link"),
    text,
    response: res,
  };
}
