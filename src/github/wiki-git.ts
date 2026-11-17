/**
 * Wiki 的 git 协议层（DESIGN.md §2.3 compressWiki / §9-R5）。
 *
 * 背景（已实测）：REST Git Data API **不支持** `.wiki` 仓（公共 wiki 也返回 404），
 * wiki 只能走 git smart-HTTP 协议。因此这里用 isomorphic-git（官方支持 Workers）
 * + 自备的**纯内存文件系统**，单次请求内完成 clone → 改文件 → commit → push。
 *
 * 语义（与原版 Imgbot 对齐）：
 * - 直接推送到 wiki 仓的默认分支，**无 PR、无阈值门**（DESIGN.md §2.3）。
 * - git 协议本身没有"部分提交"之外的保护：调用方在 push 被拒（non-fast-forward）
 *   时按需重新 clone + 重新优化；本模块**不自动重试**，只抛类型化错误。
 *
 * 运行时约束（Workers，DESIGN.md §6.2）：
 * - isomorphic-git 的 ESM 构建依赖全局 `Buffer` → wrangler 需 `nodejs_compat`
 *   （见官方 Workers 指南的 Troubleshooting）。
 * - 无 IndexedDB/CORS 代理：内存 fs + 原生 fetch（`corsProxy: undefined`）。
 * - 整个仓库在内存中：wiki 通常只有 Markdown，几百 KB 级别；128MB/隔离足够。
 */

import git, { Errors, type FsClient, type HttpClient } from "isomorphic-git";
import httpWeb from "isomorphic-git/http/web";

// ---------------------------------------------------------------------------
// 常量 / 类型
// ---------------------------------------------------------------------------

/** wiki 仓默认分支探测顺序（GitHub 老仓为 master，新仓可能是 main）。 */
export const WIKI_BRANCH_CANDIDATES = ["master", "main"] as const;

/** 与 `typeof fetch` 结构一致；测试注入 mock 时使用。 */
export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/** bot 提交身份（与 API 提交路径保持一致）。 */
export const WIKI_BOT_IDENTITY = {
  name: "image-bot-cf[bot]",
  email: "image-bot-cf[bot]@users.noreply.github.com",
} as const;

export interface WikiAuthor {
  name: string;
  email: string;
  timestamp?: number;
  timezoneOffset?: number;
}

/** `cloneWiki` 返回的快照；`files` 的 key 是仓内相对路径（无前导 `/`）。 */
export interface WikiSnapshot {
  files: Map<string, Uint8Array>;
  branch: string;
  headSha: string;
  /** 复用给 `pushWikiChanges`，避免二次 clone。 */
  fs: MemoryFs;
  dir: string;
}

export interface CloneWikiArgs {
  owner: string;
  /** 形如 `org-notes.wiki`（不含 `.git` 后缀）。 */
  wikiRepo: string;
  token: string;
  /** 优先探测的分支；默认按 `master` → `main`。 */
  defaultBranch?: string;
  /** 测试用：替换全局 fetch（isomorphic-git 的 http 适配器本身不接收 fetch）。 */
  fetchImpl?: FetchLike;
}

export interface PushWikiChangesArgs {
  owner: string;
  wikiRepo: string;
  token: string;
  /** wiki 分支（`cloneWiki` 返回的 `branch`）。 */
  branch: string;
  /** clone 得到的 head；与当前远端不一致时先抛 stale-base 冲突。 */
  baseSha: string;
  /** 绝对内容：`Uint8Array` = 写入/覆盖，`null` = 删除。 */
  changes: Map<string, Uint8Array | null>;
  message: string;
  /** 可选：复用 `cloneWiki` 的 fs/dir，省掉一次 clone。 */
  fs?: MemoryFs;
  dir?: string;
  /** 覆盖作者身份（默认 `WIKI_BOT_IDENTITY`）。 */
  author?: WikiAuthor;
  fetchImpl?: FetchLike;
}

export interface PushWikiResult {
  /** push 成功后的分支 head。 */
  headSha: string;
  branch: string;
  /** 本次 commit 的 SHA；没有实际变更时为 `null`。 */
  commitSha: string | null;
  /** 是否真的产生了 commit + push。 */
  committed: boolean;
}

// ---------------------------------------------------------------------------
// 错误契约
// ---------------------------------------------------------------------------

/** wiki-git 层所有类型化错误的基类（`instanceof` 一次即可捕获）。 */
export class WikiGitError extends Error {
  readonly code: string = "WikiGitError";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "WikiGitError";
    if (options && "cause" in options) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

export type WikiNotFoundReason = "http-404" | "empty-repo" | "no-branch";

/**
 * wiki 仓不存在 / 为空 / 两个候选分支都没有。
 * 调用方据此静默跳过 compressWiki（原版对无 wiki 的仓库也是 no-op）。
 */
export class WikiNotFoundError extends WikiGitError {
  override readonly code = "WikiNotFoundError";
  readonly reason: WikiNotFoundReason;
  readonly owner: string;
  readonly wikiRepo: string;

  constructor(
    reason: WikiNotFoundReason,
    args: { owner: string; wikiRepo: string; cause?: unknown },
  ) {
    super(
      `Wiki repository ${args.owner}/${args.wikiRepo} is not available (${reason})`,
      args.cause === undefined ? undefined : { cause: args.cause },
    );
    this.name = "WikiNotFoundError";
    this.reason = reason;
    this.owner = args.owner;
    this.wikiRepo = args.wikiRepo;
  }
}

export type WikiPushConflictReason = "non-fast-forward" | "stale-base";

/**
 * push 冲突：远端在 base clone 之后前进（non-fast-forward），
 * 或调用方给的 `baseSha` 与当前 head 不一致（stale-base）。
 * 调用方决定是否重新 clone / 重新优化；本模块不重试。
 */
export class WikiPushConflictError extends WikiGitError {
  override readonly code = "WikiPushConflictError";
  readonly reason: WikiPushConflictReason;

  constructor(
    reason: WikiPushConflictReason,
    args: {
      owner: string;
      wikiRepo: string;
      branch: string;
      expectedSha?: string;
      actualSha?: string;
      cause?: unknown;
    },
  ) {
    const detail =
      reason === "stale-base"
        ? `expected base ${args.expectedSha ?? "(unknown)"} but head is ${args.actualSha ?? "(unknown)"}`
        : "remote rejected the push because it was not a fast-forward";
    super(
      `Wiki push conflict on ${args.owner}/${args.wikiRepo}@${args.branch}: ${detail}`,
      {
        cause: args.cause,
      },
    );
    this.name = "WikiPushConflictError";
    this.reason = reason;
  }
}

/** 变更路径非法（绝对路径 / `..` / 触碰 `.git`）。 */
export class WikiPathError extends WikiGitError {
  override readonly code = "WikiPathError";
  readonly filepath: string;

  constructor(filepath: string) {
    super(`Refusing to write illegal wiki path: ${JSON.stringify(filepath)}`);
    this.name = "WikiPathError";
    this.filepath = filepath;
  }
}

// ---------------------------------------------------------------------------
// 纯内存文件系统（isomorphic-git 的 fs 子集）
// ---------------------------------------------------------------------------

export type MemoryEntryType = "file" | "dir" | "symlink";

export interface MemoryStats {
  type: MemoryEntryType;
  mode: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  mtimeSeconds: number;
  mtimeNanoseconds: number;
  ctimeSeconds: number;
  ctimeNanoseconds: number;
  dev: number;
  ino: number;
  uid: number;
  gid: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

interface MemoryEntry {
  type: MemoryEntryType;
  mode: number;
  /** file 内容。 */
  data?: Uint8Array;
  /** symlink 目标。 */
  target?: string;
  mtimeMs: number;
  ctimeMs: number;
  ino: number;
}

const S_IFREG = 0o100644;
const S_IFDIR = 0o040755;
const S_IFLNK = 0o120000;

/** `code` 是 isomorphic-git 唯一依赖的错误判别字段（ENOENT / ENOTDIR / EEXIST …）。 */
function fsError(code: string, path: string, message?: string): Error {
  const err = new Error(message ?? `${code}: ${path}`);
  Object.assign(err, { code, path, errno: code === "ENOENT" ? -2 : -1 });
  return err;
}

/** 归一化成绝对路径：`a/./b/../c` → `/a/c`；根为 `/`。 */
export function normalizeFsPath(input: string): string {
  if (typeof input !== "string" || input.length === 0) {
    throw fsError("EINVAL", String(input), "path must be a non-empty string");
  }
  const out: string[] = [];
  for (const part of input.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      out.pop();
      continue;
    }
    out.push(part);
  }
  return `/${out.join("/")}`;
}

function parentOf(path: string): string {
  if (path === "/") return "/";
  const idx = path.lastIndexOf("/");
  return idx <= 0 ? "/" : path.slice(0, idx);
}

function basenameOf(path: string): string {
  if (path === "/") return "";
  return path.slice(path.lastIndexOf("/") + 1);
}

type Encoding = string | null;

function encodingFrom(
  options?: string | { encoding?: string | null } | null,
): Encoding {
  if (typeof options === "string") return options;
  if (options && typeof options === "object") return options.encoding ?? null;
  return null;
}

function toBytes(data: Uint8Array | ArrayBuffer | string): Uint8Array {
  if (typeof data === "string") return new TextEncoder().encode(data);
  if (data instanceof Uint8Array) return new Uint8Array(data); // 拷贝，避免调用方后续改写
  if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
  throw fsError("EINVAL", "<data>", "unsupported write payload");
}

/**
 * isomorphic-git 需要的最小 `fs.promises` 实现，纯 Map 支撑、无第三方依赖。
 *
 * 设计要点：
 * - 所有方法都是 async（isomorphic-git 用 `fs.readFile()` 是否返回 thenable 来判断
 *   promise/callback 形态，同步 throw 会被误判为 callback fs）。
 * - `mtimeMs` 用单调递增计数器，保证 index 的 racy-git 检测一定看到变更。
 * - 只支持"一次请求内"的生命周期；没有锁/持久化，跨请求不共享。
 */
export class MemoryFs {
  private readonly entries = new Map<string, MemoryEntry>();
  private clock = 1_700_000_000_000;
  private inoSeq = 1;

  /** `fs.promises` 形态：isomorphic-git 的 PromiseFsClient 契约。 */
  readonly promises = {
    readFile: this.readFile.bind(this),
    writeFile: this.writeFile.bind(this),
    unlink: this.unlink.bind(this),
    readdir: this.readdir.bind(this),
    mkdir: this.mkdir.bind(this),
    rmdir: this.rmdir.bind(this),
    stat: this.stat.bind(this),
    lstat: this.lstat.bind(this),
    readlink: this.readlink.bind(this),
    symlink: this.symlink.bind(this),
    rm: this.rm.bind(this),
  };

  constructor() {
    this.entries.set("/", {
      type: "dir",
      mode: S_IFDIR,
      mtimeMs: this.tick(),
      ctimeMs: this.clock,
      ino: 0,
    });
  }

  private tick(): number {
    this.clock += 1;
    return this.clock;
  }

  private nextIno(): number {
    return this.inoSeq++;
  }

  private entry(path: string): MemoryEntry | undefined {
    return this.entries.get(normalizeFsPath(path));
  }

  private requireEntry(path: string): MemoryEntry {
    const key = normalizeFsPath(path);
    const found = this.entries.get(key);
    if (!found) throw fsError("ENOENT", key);
    return found;
  }

  private ensureParents(key: string): void {
    const parents: string[] = [];
    let current = parentOf(key);
    while (current !== "/") {
      parents.unshift(current);
      current = parentOf(current);
    }
    for (const dir of parents) {
      const existing = this.entries.get(dir);
      if (!existing) {
        this.entries.set(dir, {
          type: "dir",
          mode: S_IFDIR,
          mtimeMs: this.tick(),
          ctimeMs: this.clock,
          ino: this.nextIno(),
        });
      } else if (existing.type !== "dir") {
        throw fsError("ENOTDIR", dir);
      }
    }
  }

  private statsOf(path: string, entry: MemoryEntry): MemoryStats {
    const isDir = entry.type === "dir";
    const size = isDir
      ? 0
      : entry.type === "file"
        ? (entry.data?.byteLength ?? 0)
        : (entry.target?.length ?? 0);
    const seconds = Math.floor(entry.mtimeMs / 1000);
    const nanos = Math.floor((entry.mtimeMs - seconds * 1000) * 1_000_000);
    const cseconds = Math.floor(entry.ctimeMs / 1000);
    const cnanos = Math.floor((entry.ctimeMs - cseconds * 1000) * 1_000_000);
    return {
      type: entry.type,
      mode: entry.mode,
      size,
      mtimeMs: entry.mtimeMs,
      ctimeMs: entry.ctimeMs,
      mtimeSeconds: seconds,
      mtimeNanoseconds: nanos,
      ctimeSeconds: cseconds,
      ctimeNanoseconds: cnanos,
      dev: 0,
      ino: entry.ino,
      uid: 0,
      gid: 0,
      isFile: () => entry.type === "file",
      isDirectory: () => isDir,
      isSymbolicLink: () => entry.type === "symlink",
    };
  }

  async readFile(
    path: string,
    options?: string | { encoding?: string | null } | null,
  ): Promise<Uint8Array | string> {
    const key = normalizeFsPath(path);
    const entry = this.requireEntry(key);
    if (entry.type === "dir") throw fsError("EISDIR", key);
    const bytes =
      entry.type === "symlink"
        ? new TextEncoder().encode(entry.target ?? "")
        : (entry.data ?? new Uint8Array(0));
    const encoding = encodingFrom(options);
    if (encoding === "utf8" || encoding === "utf-8") {
      return new TextDecoder().decode(bytes);
    }
    return new Uint8Array(bytes);
  }

  async writeFile(
    path: string,
    data: Uint8Array | ArrayBuffer | string,
    options?: string | { encoding?: string | null; mode?: number } | null,
  ): Promise<void> {
    const key = normalizeFsPath(path);
    if (key === "/") throw fsError("EISDIR", key);
    this.ensureParents(key);
    const existing = this.entries.get(key);
    if (existing?.type === "dir") throw fsError("EISDIR", key);
    if (existing?.type === "symlink") {
      // 覆盖 symlink 本身而不是目标（与 node fs 的默认行为不同，但符合 git 语义）。
      this.entries.delete(key);
    }
    const mode =
      options && typeof options === "object" && typeof options.mode === "number"
        ? options.mode & 0o7777
        : S_IFREG;
    const now = this.tick();
    this.entries.set(key, {
      type: "file",
      mode: mode === 0 ? S_IFREG : (S_IFREG & 0o170000) | mode,
      data: toBytes(data),
      mtimeMs: now,
      ctimeMs: now,
      ino: existing?.ino ?? this.nextIno(),
    });
  }

  async unlink(path: string): Promise<void> {
    const key = normalizeFsPath(path);
    const entry = this.entries.get(key);
    if (!entry) throw fsError("ENOENT", key);
    if (entry.type === "dir") throw fsError("EISDIR", key);
    this.entries.delete(key);
  }

  async readdir(path: string, options?: unknown): Promise<string[]> {
    const key = normalizeFsPath(path);
    const entry = this.requireEntry(key);
    if (entry.type !== "dir") throw fsError("ENOTDIR", key);
    const prefix = key === "/" ? "/" : `${key}/`;
    const names: string[] = [];
    for (const candidate of this.entries.keys()) {
      if (candidate === key || !candidate.startsWith(prefix)) continue;
      const rest = candidate.slice(prefix.length);
      if (rest.length === 0 || rest.includes("/")) continue;
      names.push(rest);
    }
    names.sort();
    if (
      options &&
      typeof options === "object" &&
      (options as { withFileTypes?: boolean }).withFileTypes
    ) {
      // isomorphic-git 不使用 withFileTypes；但保持返回字符串数组的契约。
      return names;
    }
    return names;
  }

  async mkdir(
    path: string,
    options?: { recursive?: boolean } | null,
  ): Promise<void> {
    const key = normalizeFsPath(path);
    if (this.entries.has(key)) {
      const existing = this.entries.get(key)!;
      if (existing.type === "dir") throw fsError("EEXIST", key);
      throw fsError("ENOTDIR", key);
    }
    if (options?.recursive) {
      this.ensureParents(key);
    } else {
      const parent = this.entries.get(parentOf(key));
      if (!parent) throw fsError("ENOENT", key);
      if (parent.type !== "dir") throw fsError("ENOTDIR", key);
    }
    const now = this.tick();
    this.entries.set(key, {
      type: "dir",
      mode: S_IFDIR,
      mtimeMs: now,
      ctimeMs: now,
      ino: this.nextIno(),
    });
  }

  async rmdir(
    path: string,
    options?: { recursive?: boolean } | null,
  ): Promise<void> {
    const key = normalizeFsPath(path);
    const entry = this.entries.get(key);
    if (!entry) throw fsError("ENOENT", key);
    if (entry.type !== "dir") throw fsError("ENOTDIR", key);
    const prefix = key === "/" ? "/" : `${key}/`;
    const children = [...this.entries.keys()].filter(
      (p) => p !== key && p.startsWith(prefix),
    );
    if (children.length > 0 && !options?.recursive) {
      throw fsError("ENOTEMPTY", key);
    }
    for (const child of children) this.entries.delete(child);
    if (key !== "/") this.entries.delete(key);
  }

  /** 供 isomorphic-git 的 `_rm(path, opts)` 兜底（`rmdir.length > 1` 时也会用它）。 */
  async rm(
    path: string,
    options?: { recursive?: boolean; force?: boolean } | null,
  ): Promise<void> {
    const key = normalizeFsPath(path);
    const entry = this.entries.get(key);
    if (!entry) {
      if (options?.force) return;
      throw fsError("ENOENT", key);
    }
    if (entry.type === "dir") {
      await this.rmdir(key, { recursive: options?.recursive ?? true });
      return;
    }
    this.entries.delete(key);
  }

  async stat(path: string): Promise<MemoryStats> {
    const key = normalizeFsPath(path);
    const entry = this.requireEntry(key);
    if (entry.type === "symlink") {
      const targetKey = normalizeFsPath(
        entry.target && entry.target.startsWith("/")
          ? entry.target
          : `${parentOf(key)}/${entry.target ?? ""}`,
      );
      const resolved = this.entries.get(targetKey);
      if (!resolved) throw fsError("ENOENT", key);
      return this.statsOf(key, resolved);
    }
    return this.statsOf(key, entry);
  }

  async lstat(path: string): Promise<MemoryStats> {
    const key = normalizeFsPath(path);
    return this.statsOf(key, this.requireEntry(key));
  }

  async readlink(path: string): Promise<string> {
    const key = normalizeFsPath(path);
    const entry = this.requireEntry(key);
    if (entry.type !== "symlink") throw fsError("EINVAL", key);
    return entry.target ?? "";
  }

  async symlink(target: string, path: string): Promise<void> {
    const key = normalizeFsPath(path);
    if (this.entries.has(key)) throw fsError("EEXIST", key);
    this.ensureParents(key);
    const now = this.tick();
    this.entries.set(key, {
      type: "symlink",
      mode: S_IFLNK,
      target,
      mtimeMs: now,
      ctimeMs: now,
      ino: this.nextIno(),
    });
  }

  /** 测试/调用方辅助：是否存在。 */
  async exists(path: string): Promise<boolean> {
    try {
      await this.stat(path);
      return true;
    } catch {
      return false;
    }
  }

  /** 测试/调用方辅助：递归列出所有文件（绝对路径）。 */
  async listFiles(path = "/"): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const name of await this.readdir(dir)) {
        const full = dir === "/" ? `/${name}` : `${dir}/${name}`;
        const stats = await this.lstat(full);
        if (stats.isDirectory()) await walk(full);
        else out.push(full);
      }
    };
    await walk(normalizeFsPath(path));
    return out.sort();
  }

  /** 测试/调用方辅助：读取整个工作区（跳过 `.git`）。 */
  async readTree(dir = "/"): Promise<Map<string, Uint8Array>> {
    const root = normalizeFsPath(dir);
    const files = new Map<string, Uint8Array>();
    for (const path of await this.listFiles(root)) {
      const rel = path.slice(root === "/" ? 1 : root.length + 1);
      if (rel === ".git" || rel.startsWith(".git/")) continue;
      files.set(rel, (await this.readFile(path)) as Uint8Array);
    }
    return files;
  }

  /** 清空（测试辅助）。 */
  clear(): void {
    this.entries.clear();
    this.entries.set("/", {
      type: "dir",
      mode: S_IFDIR,
      mtimeMs: this.tick(),
      ctimeMs: this.clock,
      ino: 0,
    });
  }
}

/** `MemoryFs` → isomorphic-git 的 PromiseFsClient。 */
function asGitFs(fs: MemoryFs): FsClient {
  return { promises: fs.promises };
}

// ---------------------------------------------------------------------------
// HTTP 传输
// ---------------------------------------------------------------------------

/**
 * isomorphic-git 的 `http/web` 适配器直接用全局 fetch，无法注入。
 * 需要 mock 时用这个等价实现；默认仍走官方 `http/web`。
 */
function createFetchHttpClient(fetchImpl: FetchLike): HttpClient {
  return {
    async request({
      url,
      method = "GET",
      headers = {},
      body,
      signal,
      fetchOptions = {},
    }) {
      let payload: Uint8Array | undefined;
      if (body) {
        const chunks: Uint8Array[] = [];
        let size = 0;
        for await (const chunk of body as AsyncIterable<Uint8Array>) {
          chunks.push(chunk);
          size += chunk.byteLength;
        }
        payload = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          payload.set(chunk, offset);
          offset += chunk.byteLength;
        }
      }
      const res = await fetchImpl(url, {
        ...fetchOptions,
        method,
        headers,
        body: payload,
        signal: signal ?? (fetchOptions.signal as AbortSignal | undefined),
      });
      const responseHeaders: Record<string, string> = {};
      res.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });
      const bodyIter = res.body
        ? (res.body as unknown as AsyncIterable<Uint8Array>)
        : [new Uint8Array(await res.arrayBuffer())];
      return {
        url: res.url || url,
        method,
        statusCode: res.status,
        statusMessage: res.statusText,
        headers: responseHeaders,
        body: bodyIterator(bodyIter),
      };
    },
  } as HttpClient;
}

function bodyIterator(
  iterable: AsyncIterable<Uint8Array> | Uint8Array[],
): AsyncIterableIterator<Uint8Array> {
  if (Array.isArray(iterable)) {
    let index = 0;
    return {
      next: async () =>
        index < iterable.length
          ? { done: false as const, value: iterable[index++] }
          : { done: true as const, value: undefined },
      return: async () => ({ done: true as const, value: undefined }),
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  }
  const iter = iterable[Symbol.asyncIterator]();
  return {
    next: () => iter.next(),
    return: (value?: unknown) =>
      iter.return
        ? iter.return(value)
        : Promise.resolve({ done: true as const, value: undefined }),
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}

function wikiRemoteUrl(owner: string, wikiRepo: string): string {
  const repo = wikiRepo.endsWith(".git") ? wikiRepo : `${wikiRepo}.git`;
  return `https://github.com/${owner}/${repo}`;
}

function wikiAuth(token: string): () => { username: string; password: string } {
  // GitHub 对 git 协议推荐 `x-access-token` 作为 username、token 作为 password。
  return () => ({ username: "x-access-token", password: token });
}

// ---------------------------------------------------------------------------
// clone
// ---------------------------------------------------------------------------

function isRepoMissing(err: unknown): boolean {
  if (err instanceof Errors.HttpError) {
    return err.data.statusCode === 404;
  }
  if ((err as { code?: unknown } | null)?.code === "HttpError") {
    const status = (err as { data?: { statusCode?: unknown } }).data
      ?.statusCode;
    return status === 404;
  }
  return false;
}

function isBranchMissing(err: unknown): boolean {
  if (err instanceof Errors.NotFoundError) return true;
  if (err instanceof Errors.NoCommitError) return true;
  const code = (err as { code?: unknown } | null)?.code;
  if (code === "NotFoundError" || code === "NoCommitError") return true;
  const message = (err as { message?: unknown } | null)?.message;
  if (typeof message === "string") {
    const lower = message.toLowerCase();
    if (lower.includes("could not find") || lower.includes("no commits"))
      return true;
  }
  return false;
}

async function cloneBranch(args: {
  fs: MemoryFs;
  dir: string;
  url: string;
  branch: string;
  http: HttpClient;
  token: string;
}): Promise<string> {
  const { fs, dir, url, branch, http, token } = args;
  await git.clone({
    fs: asGitFs(fs),
    http,
    dir,
    url,
    ref: branch,
    singleBranch: true,
    depth: 1,
    noTags: true,
    corsProxy: undefined,
    onAuth: wikiAuth(token),
  });
  return git.resolveRef({ fs: asGitFs(fs), dir, ref: "HEAD" });
}

/**
 * clone wiki 仓（depth 1、单分支），返回工作区文件 + 分支 + head。
 *
 * 分支探测：`defaultBranch ?? "master"` → `main`。仓库不存在（HTTP 404）或两个分支
 * 都取不到（空仓）→ `WikiNotFoundError`；其它错误原样抛出（含 401/403 凭据错误）。
 */
export async function cloneWiki(args: CloneWikiArgs): Promise<WikiSnapshot> {
  const { owner, wikiRepo, token, defaultBranch, fetchImpl } = args;
  const url = wikiRemoteUrl(owner, wikiRepo);
  const http = fetchImpl ? createFetchHttpClient(fetchImpl) : httpWeb;
  const dir = "/";
  const candidates = defaultBranch
    ? [
        defaultBranch,
        ...WIKI_BRANCH_CANDIDATES.filter((b) => b !== defaultBranch),
      ]
    : [...WIKI_BRANCH_CANDIDATES];

  let lastError: unknown;
  for (const branch of candidates) {
    const fs = new MemoryFs();
    try {
      const headSha = await cloneBranch({ fs, dir, url, branch, http, token });
      return await snapshotFromFs({ fs, dir, branch, headSha });
    } catch (err) {
      lastError = err;
      if (isRepoMissing(err)) {
        throw new WikiNotFoundError("http-404", {
          owner,
          wikiRepo,
          cause: err,
        });
      }
      if (isBranchMissing(err)) continue;
      throw err;
    }
  }

  throw new WikiNotFoundError("empty-repo", {
    owner,
    wikiRepo,
    cause: lastError,
  });
}

async function snapshotFromFs(args: {
  fs: MemoryFs;
  dir: string;
  branch: string;
  headSha: string;
}): Promise<WikiSnapshot> {
  return {
    files: await args.fs.readTree(args.dir),
    branch: args.branch,
    headSha: args.headSha,
    fs: args.fs,
    dir: args.dir,
  };
}

/** push 用：clone 一个**指定**分支（不探测），不存在 → WikiNotFoundError。 */
async function cloneExactBranch(args: {
  owner: string;
  wikiRepo: string;
  token: string;
  branch: string;
  fetchImpl?: FetchLike;
}): Promise<WikiSnapshot> {
  const { owner, wikiRepo, token, branch, fetchImpl } = args;
  const fs = new MemoryFs();
  const dir = "/";
  const http = fetchImpl ? createFetchHttpClient(fetchImpl) : httpWeb;
  try {
    const headSha = await cloneBranch({
      fs,
      dir,
      url: wikiRemoteUrl(owner, wikiRepo),
      branch,
      http,
      token,
    });
    return await snapshotFromFs({ fs, dir, branch, headSha });
  } catch (err) {
    if (isRepoMissing(err)) {
      throw new WikiNotFoundError("http-404", { owner, wikiRepo, cause: err });
    }
    if (isBranchMissing(err)) {
      throw new WikiNotFoundError("no-branch", { owner, wikiRepo, cause: err });
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 变更应用 + commit
// ---------------------------------------------------------------------------

/**
 * 校验并归一化 wiki 内相对路径。
 * 拒绝：绝对路径、`..`、空路径、`.git` 及其子路径（不能改写 git 元数据）。
 */
export function normalizeWikiPath(rawPath: string): string {
  if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
    throw new WikiPathError(rawPath);
  }
  const trimmed = rawPath.replace(/^\.\//, "").replace(/^\/+/, "");
  const parts: string[] = [];
  for (const part of trimmed.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") throw new WikiPathError(rawPath);
    parts.push(part);
  }
  if (parts.length === 0) throw new WikiPathError(rawPath);
  if (parts[0].toLowerCase() === ".git") throw new WikiPathError(rawPath);
  return parts.join("/");
}

function joinFsPath(dir: string, rel: string): string {
  return dir === "/" || dir === ""
    ? `/${rel}`
    : `${dir.replace(/\/+$/, "")}/${rel}`;
}

export interface ApplyWikiChangesResult {
  written: string[];
  deleted: string[];
}

/** 把 `changes` 落到内存工作区；纯文件操作，不碰 index。 */
export async function applyWikiChanges(args: {
  fs: MemoryFs;
  dir: string;
  changes: Map<string, Uint8Array | null>;
}): Promise<ApplyWikiChangesResult> {
  const { fs, dir, changes } = args;
  const written: string[] = [];
  const deleted: string[] = [];

  for (const [rawPath, content] of changes) {
    const rel = normalizeWikiPath(rawPath);
    const full = joinFsPath(dir, rel);
    if (content === null) {
      if (await fs.exists(full)) {
        await fs.unlink(full);
        deleted.push(rel);
      }
      continue;
    }
    await fs.writeFile(full, content);
    written.push(rel);
  }

  return { written, deleted };
}

/**
 * 把工作区变更 stage 并 commit（不 push）。
 *
 * 用 `statusMatrix` 对比 workdir 与 index，避免把未变更文件重新 stage；
 * 没有实际变更时返回 `{ changed: false }`，调用方据此跳过 push。
 */
export async function commitWikiChanges(args: {
  fs: MemoryFs;
  dir: string;
  message: string;
  author?: WikiAuthor;
  committer?: WikiAuthor;
}): Promise<{
  changed: boolean;
  commitSha: string | null;
  added: string[];
  removed: string[];
}> {
  const { fs, dir, message } = args;
  const identity = args.author ?? WIKI_BOT_IDENTITY;
  const gitFs = asGitFs(fs);

  const matrix = await git.statusMatrix({ fs: gitFs, dir });
  const added: string[] = [];
  const removed: string[] = [];

  for (const [filepath, _head, workdir, stage] of matrix) {
    if (workdir === 0) {
      if (stage !== 0) removed.push(filepath);
      continue;
    }
    if (workdir !== stage) added.push(filepath);
  }

  if (added.length === 0 && removed.length === 0) {
    return { changed: false, commitSha: null, added, removed };
  }

  if (added.length > 0) {
    await git.add({ fs: gitFs, dir, filepath: added });
  }
  if (removed.length > 0) {
    await git.remove({ fs: gitFs, dir, filepath: removed });
  }

  const commitSha = await git.commit({
    fs: gitFs,
    dir,
    message,
    author: identity,
    committer: args.committer ?? WIKI_BOT_IDENTITY,
  });

  return { changed: true, commitSha, added, removed };
}

// ---------------------------------------------------------------------------
// push
// ---------------------------------------------------------------------------

/**
 * 在已有快照上应用变更、commit、push（`force: false`）。
 *
 * - `baseSha` 与当前 head 不一致 → `WikiPushConflictError("stale-base")`（不落盘）。
 * - 远端拒绝 non-fast-forward → `WikiPushConflictError("non-fast-forward")`。
 * - 网络错误原样抛出，重试语义留给调用方。
 * - 没有实际变更 → 不 commit、不 push，返回当前 head。
 * - 注意：失败时内存 fs 可能已包含本地 commit；用同一 fs 重试会先撞 stale-base，
 *   调用方应重新 `cloneWiki`（或重新从 base 开始）。
 */
export async function pushWikiChanges(
  args: PushWikiChangesArgs,
): Promise<PushWikiResult> {
  const {
    owner,
    wikiRepo,
    token,
    branch,
    baseSha,
    changes,
    message,
    fetchImpl,
  } = args;
  const http = fetchImpl ? createFetchHttpClient(fetchImpl) : httpWeb;

  let fs = args.fs;
  let dir = args.dir;

  if (!fs) {
    const snapshot = await cloneExactBranch({
      owner,
      wikiRepo,
      token,
      branch,
      fetchImpl,
    });
    fs = snapshot.fs;
    dir = snapshot.dir;
    if (snapshot.headSha !== baseSha) {
      throw new WikiPushConflictError("stale-base", {
        owner,
        wikiRepo,
        branch,
        expectedSha: baseSha,
        actualSha: snapshot.headSha,
      });
    }
  }

  const gitFs = asGitFs(fs);
  dir = dir ?? "/";
  const url = wikiRemoteUrl(owner, wikiRepo);
  const onAuth = wikiAuth(token);

  const currentHead = await git.resolveRef({ fs: gitFs, dir, ref: "HEAD" });
  if (currentHead !== baseSha) {
    throw new WikiPushConflictError("stale-base", {
      owner,
      wikiRepo,
      branch,
      expectedSha: baseSha,
      actualSha: currentHead,
    });
  }

  await applyWikiChanges({ fs, dir, changes });

  const committed = await commitWikiChanges({
    fs,
    dir,
    message,
    author: args.author,
  });

  if (!committed.changed) {
    return { headSha: currentHead, branch, commitSha: null, committed: false };
  }

  try {
    await git.push({
      fs: gitFs,
      http,
      dir,
      url,
      ref: branch,
      remoteRef: `refs/heads/${branch}`,
      force: false,
      corsProxy: undefined,
      onAuth,
    });
  } catch (err) {
    if (
      err instanceof Errors.PushRejectedError ||
      (err as { code?: unknown } | null)?.code === "PushRejectedError"
    ) {
      throw new WikiPushConflictError("non-fast-forward", {
        owner,
        wikiRepo,
        branch,
        expectedSha: baseSha,
        cause: err,
      });
    }
    throw err;
  }

  const headSha = await git.resolveRef({
    fs: gitFs,
    dir,
    ref: `refs/heads/${branch}`,
  });
  return { headSha, branch, commitSha: committed.commitSha, committed: true };
}
