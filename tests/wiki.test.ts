/**
 * wiki git 协议层单测（DESIGN.md §2.3 compressWiki / §9-R5）。
 *
 * 覆盖范围（远程 push 不在单测内，真仓 e2e 由编排方执行）：
 * 1. 自备内存文件系统的读写 / 目录 / stat 语义（isomorphic-git 的 fs 契约）。
 * 2. `normalizeWikiPath` / `applyWikiChanges` / `commitWikiChanges`：变更应用、
 *    commit message/author 组装（本地内存仓 init → commit → readCommit 往返自洽）。
 * 3. `WikiNotFoundError` / `WikiPushConflictError` / `WikiPathError` 的构造契约，
 *    以及 fetch 注入（404 → WikiNotFoundError）。
 */

import { describe, expect, it } from "vitest";
import git, { Errors } from "isomorphic-git";

import {
  MemoryFs,
  WIKI_BOT_IDENTITY,
  WikiGitError,
  WikiNotFoundError,
  WikiPathError,
  WikiPushConflictError,
  applyWikiChanges,
  commitWikiChanges,
  normalizeFsPath,
  normalizeWikiPath,
  pushWikiChanges,
  type FetchLike,
} from "../src/github/wiki-git";

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

function gitFs(fs: MemoryFs) {
  return { promises: fs.promises };
}

async function initRepo(fs: MemoryFs): Promise<void> {
  await git.init({ fs: gitFs(fs), dir: "/" });
}

async function readHeadSha(fs: MemoryFs, ref = "HEAD"): Promise<string> {
  return git.resolveRef({ fs: gitFs(fs), dir: "/", ref });
}

// ---------------------------------------------------------------------------
// 内存 fs
// ---------------------------------------------------------------------------

describe("MemoryFs", () => {
  it("读写 UTF-8 文本与二进制内容", async () => {
    const fs = new MemoryFs();
    await fs.writeFile("/Home.md", "# Hello\n");
    expect(await fs.readFile("/Home.md", "utf8")).toBe("# Hello\n");
    expect(await fs.readFile("/Home.md", { encoding: "utf8" })).toBe(
      "# Hello\n",
    );

    const bytes = new Uint8Array([0, 255, 13, 10, 42]);
    await fs.writeFile("/assets/logo.bin", bytes);
    const raw = (await fs.readFile("/assets/logo.bin")) as Uint8Array;
    expect([...raw]).toEqual([0, 255, 13, 10, 42]);
    expect(await fs.readFile("/assets/logo.bin", "utf8")).toBeDefined();
  });

  it("读出的字节是副本（改写返回值不影响存储）", async () => {
    const fs = new MemoryFs();
    await fs.writeFile("/a.md", new Uint8Array([1, 2, 3]));
    const first = (await fs.readFile("/a.md")) as Uint8Array;
    first[0] = 99;
    const second = (await fs.readFile("/a.md")) as Uint8Array;
    expect([...second]).toEqual([1, 2, 3]);
  });

  it("writeFile 自动创建父目录，路径归一化支持 . 与 ..", async () => {
    const fs = new MemoryFs();
    await fs.writeFile("/deep/nested/dir/file.md", "x");
    expect(await fs.readFile("/deep/nested/dir/file.md", "utf8")).toBe("x");
    expect(await fs.readdir("/deep/nested")).toEqual(["dir"]);
    expect(
      await fs.readFile("/deep/./nested/../nested/dir/file.md", "utf8"),
    ).toBe("x");
    expect(normalizeFsPath("a//b/./c/../d")).toBe("/a/b/d");
  });

  it("readdir 返回排序后的直接子项（文件与目录）", async () => {
    const fs = new MemoryFs();
    await fs.writeFile("/b.md", "b");
    await fs.writeFile("/a.md", "a");
    await fs.mkdir("/docs");
    expect(await fs.readdir("/")).toEqual(["a.md", "b.md", "docs"]);
    // 再次写入同一目录下的深层文件不改变直接子项集合
    await fs.writeFile("/docs/x/y.md", "y");
    expect(await fs.readdir("/docs")).toEqual(["x"]);
  });

  it("stat / lstat 提供 isomorphic-git 需要的字段", async () => {
    const fs = new MemoryFs();
    await fs.writeFile("/Home.md", "hello");
    await fs.mkdir("/docs");
    const file = await fs.stat("/Home.md");
    expect(file.isFile()).toBe(true);
    expect(file.isDirectory()).toBe(false);
    expect(file.isSymbolicLink()).toBe(false);
    expect(file.mode & 0o170000).toBe(0o100000);
    expect(file.mode & 0o777).toBe(0o644);
    expect(file.size).toBe(5);
    expect(typeof file.mtimeMs).toBe("number");
    expect(typeof file.mtimeSeconds).toBe("number");
    expect(typeof file.mtimeNanoseconds).toBe("number");
    expect(file.uid).toBe(0);
    expect(file.gid).toBe(0);
    const dir = await fs.stat("/docs");
    expect(dir.isDirectory()).toBe(true);
    expect(dir.mode & 0o170000).toBe(0o040000);
  });

  it("mtime 单调递增（避免 index 的 racy-git 误判为未变更）", async () => {
    const fs = new MemoryFs();
    await fs.writeFile("/a.md", "1");
    const first = await fs.stat("/a.md");
    await fs.writeFile("/a.md", "2");
    const second = await fs.stat("/a.md");
    expect(second.mtimeMs).toBeGreaterThan(first.mtimeMs);
  });

  it("ENOENT / EISDIR / ENOTDIR / ENOTEMPTY 错误码与 isomorphic-git 约定一致", async () => {
    const fs = new MemoryFs();
    await fs.writeFile("/Home.md", "x");
    await fs.mkdir("/docs");
    await fs.writeFile("/docs/a.md", "a");

    await expect(fs.readFile("/missing.md")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.readFile("/docs")).rejects.toMatchObject({
      code: "EISDIR",
    });
    await expect(fs.readdir("/Home.md")).rejects.toMatchObject({
      code: "ENOTDIR",
    });
    await expect(fs.unlink("/missing.md")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.mkdir("/docs")).rejects.toMatchObject({ code: "EEXIST" });
    await expect(fs.rmdir("/docs")).rejects.toMatchObject({
      code: "ENOTEMPTY",
    });
    await expect(fs.writeFile("/Home.md/child.md", "x")).rejects.toMatchObject({
      code: "ENOTDIR",
    });
  });

  it("rmdir recursive 删除整棵子树", async () => {
    const fs = new MemoryFs();
    await fs.writeFile("/a/b/c.md", "c");
    await fs.writeFile("/a/d.md", "d");
    await fs.rmdir("/a", { recursive: true });
    expect(await fs.readdir("/")).toEqual([]);
    await expect(fs.readFile("/a/b/c.md")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("promises 形态：readFile() 无参调用返回 rejected promise（isomorphic-git 的探测方式）", async () => {
    const fs = new MemoryFs();
    const probe = (fs.promises.readFile as () => Promise<unknown>)();
    expect(typeof (probe as Promise<unknown>).then).toBe("function");
    await expect(probe).rejects.toMatchObject({ code: "EINVAL" });
  });

  it("symlink / readlink 支持（git 的 120000 模式）", async () => {
    const fs = new MemoryFs();
    await fs.writeFile("/target.md", "t");
    await fs.symlink("target.md", "/link.md");
    expect((await fs.lstat("/link.md")).isSymbolicLink()).toBe(true);
    expect(await fs.readlink("/link.md")).toBe("target.md");
    expect((await fs.stat("/link.md")).isFile()).toBe(true);
  });

  it("listFiles / readTree 跳过 .git", async () => {
    const fs = new MemoryFs();
    await fs.writeFile("/.git/config", "x");
    await fs.writeFile("/Home.md", "home");
    await fs.writeFile("/sub/Page.md", "page");
    expect(await fs.listFiles("/")).toEqual([
      "/.git/config",
      "/Home.md",
      "/sub/Page.md",
    ]);
    const tree = await fs.readTree("/");
    expect([...tree.keys()].sort()).toEqual(["Home.md", "sub/Page.md"]);
    expect(new TextDecoder().decode(tree.get("Home.md"))).toBe("home");
  });
});

// ---------------------------------------------------------------------------
// 路径校验
// ---------------------------------------------------------------------------

describe("normalizeWikiPath", () => {
  it("归一化合法的相对路径", () => {
    expect(normalizeWikiPath("Home.md")).toBe("Home.md");
    expect(normalizeWikiPath("./Home.md")).toBe("Home.md");
    expect(normalizeWikiPath("/Home.md")).toBe("Home.md");
    expect(normalizeWikiPath("docs/./Setup.md")).toBe("docs/Setup.md");
  });

  it("拒绝绝对越界与 .git 写入", () => {
    expect(() => normalizeWikiPath("../etc/passwd")).toThrow(WikiPathError);
    expect(() => normalizeWikiPath("docs/../../x")).toThrow(WikiPathError);
    expect(() => normalizeWikiPath(".git/config")).toThrow(WikiPathError);
    expect(() => normalizeWikiPath(".GIT/hooks/pre-commit")).toThrow(
      WikiPathError,
    );
    expect(() => normalizeWikiPath("")).toThrow(WikiPathError);
    expect(() => normalizeWikiPath("/")).toThrow(WikiPathError);
    expect(() => normalizeWikiPath("   ")).toThrow(WikiPathError);
  });
});

// ---------------------------------------------------------------------------
// 变更应用 + commit
// ---------------------------------------------------------------------------

describe("applyWikiChanges", () => {
  it("写入 / 覆盖 / 删除文件，删除不存在的路径是 no-op", async () => {
    const fs = new MemoryFs();
    await fs.writeFile("/Home.md", "old");
    await fs.writeFile("/Keep.md", "keep");

    const changes = new Map<string, Uint8Array | null>([
      ["Home.md", new TextEncoder().encode("new")],
      ["docs/New.md", new TextEncoder().encode("new page")],
      ["Keep.md", null],
      ["Ghost.md", null],
    ]);

    const result = await applyWikiChanges({ fs, dir: "/", changes });
    expect(result.written.sort()).toEqual(["Home.md", "docs/New.md"]);
    expect(result.deleted).toEqual(["Keep.md"]);

    expect(await fs.readFile("/Home.md", "utf8")).toBe("new");
    expect(await fs.readFile("/docs/New.md", "utf8")).toBe("new page");
    await expect(fs.readFile("/Keep.md")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("拒绝非法路径且不落盘", async () => {
    const fs = new MemoryFs();
    await expect(
      applyWikiChanges({
        fs,
        dir: "/",
        changes: new Map([["../escape.md", new Uint8Array([1])]]),
      }),
    ).rejects.toBeInstanceOf(WikiPathError);
    expect(await fs.readdir("/")).toEqual([]);
  });
});

describe("commitWikiChanges（内存仓自洽验证）", () => {
  it("首次 commit 的 message / author / committer / tree 与 bot 身份一致", async () => {
    const fs = new MemoryFs();
    await initRepo(fs);
    await fs.writeFile("/Home.md", "# Hello\n");
    await fs.writeFile("/docs/Guide.md", "guide\n");

    const result = await commitWikiChanges({
      fs,
      dir: "/",
      message: "Initial wiki commit",
    });
    expect(result.changed).toBe(true);
    expect(result.added.sort()).toEqual(["Home.md", "docs/Guide.md"]);
    expect(result.removed).toEqual([]);
    expect(result.commitSha).toMatch(/^[0-9a-f]{40}$/);

    const { commit, oid } = await git.readCommit({
      fs: gitFs(fs),
      dir: "/",
      oid: result.commitSha!,
    });
    expect(oid).toBe(result.commitSha);
    expect(commit.message.trim()).toBe("Initial wiki commit");
    expect(commit.author.name).toBe(WIKI_BOT_IDENTITY.name);
    expect(commit.author.email).toBe(WIKI_BOT_IDENTITY.email);
    expect(commit.committer.name).toBe(WIKI_BOT_IDENTITY.name);
    expect(commit.parent).toEqual([]);
    expect(await readHeadSha(fs)).toBe(result.commitSha);

    expect((await git.listFiles({ fs: gitFs(fs), dir: "/" })).sort()).toEqual([
      "Home.md",
      "docs/Guide.md",
    ]);
  });

  it("第二次 commit 只包含变更：修改 + 新增 + 删除，parent 指向前一次", async () => {
    const fs = new MemoryFs();
    await initRepo(fs);
    await fs.writeFile("/Home.md", "v1");
    await fs.writeFile("/Old.md", "old");
    const first = await commitWikiChanges({ fs, dir: "/", message: "first" });

    await applyWikiChanges({
      fs,
      dir: "/",
      changes: new Map<string, Uint8Array | null>([
        ["Home.md", new TextEncoder().encode("v2")],
        ["New.md", new TextEncoder().encode("new")],
        ["Old.md", null],
      ]),
    });
    const second = await commitWikiChanges({ fs, dir: "/", message: "second" });

    expect(second.changed).toBe(true);
    expect(second.added.sort()).toEqual(["Home.md", "New.md"]);
    expect(second.removed).toEqual(["Old.md"]);

    const { commit } = await git.readCommit({
      fs: gitFs(fs),
      dir: "/",
      oid: second.commitSha!,
    });
    expect(commit.parent).toEqual([first.commitSha]);
    expect(commit.message.trim()).toBe("second");

    expect((await git.listFiles({ fs: gitFs(fs), dir: "/" })).sort()).toEqual([
      "Home.md",
      "New.md",
    ]);
    expect(
      new TextDecoder().decode((await fs.readFile("/Home.md")) as Uint8Array),
    ).toBe("v2");
  });

  it("没有实际变更时不产生 commit", async () => {
    const fs = new MemoryFs();
    await initRepo(fs);
    await fs.writeFile("/Home.md", "same");
    const first = await commitWikiChanges({ fs, dir: "/", message: "first" });
    const headAfterFirst = await readHeadSha(fs);

    const second = await commitWikiChanges({
      fs,
      dir: "/",
      message: "should be skipped",
    });
    expect(second.changed).toBe(false);
    expect(second.commitSha).toBeNull();
    expect(await readHeadSha(fs)).toBe(headAfterFirst);
    expect(first.commitSha).toBe(headAfterFirst);
  });

  it("自定义 author 覆盖 bot 身份", async () => {
    const fs = new MemoryFs();
    await initRepo(fs);
    await fs.writeFile("/Home.md", "x");
    const result = await commitWikiChanges({
      fs,
      dir: "/",
      message: "custom",
      author: { name: "Someone", email: "someone@example.com" },
    });
    const { commit } = await git.readCommit({
      fs: gitFs(fs),
      dir: "/",
      oid: result.commitSha!,
    });
    expect(commit.author.name).toBe("Someone");
    expect(commit.author.email).toBe("someone@example.com");
    expect(commit.committer.name).toBe(WIKI_BOT_IDENTITY.name);
  });
});

// ---------------------------------------------------------------------------
// 错误契约
// ---------------------------------------------------------------------------

describe("错误类型契约", () => {
  it("WikiGitError 是共同基类", () => {
    const notFound = new WikiNotFoundError("http-404", {
      owner: "acme",
      wikiRepo: "notes.wiki",
    });
    const conflict = new WikiPushConflictError("non-fast-forward", {
      owner: "acme",
      wikiRepo: "notes.wiki",
      branch: "master",
    });
    expect(notFound).toBeInstanceOf(WikiGitError);
    expect(notFound).toBeInstanceOf(Error);
    expect(conflict).toBeInstanceOf(WikiGitError);
    expect(notFound.code).toBe("WikiNotFoundError");
    expect(conflict.code).toBe("WikiPushConflictError");
    expect(notFound.name).toBe("WikiNotFoundError");
  });

  it("WikiNotFoundError 保留 reason / owner / repo 与 cause", () => {
    const cause = new Error("boom");
    const err = new WikiNotFoundError("empty-repo", {
      owner: "acme",
      wikiRepo: "notes.wiki",
      cause,
    });
    expect(err.reason).toBe("empty-repo");
    expect(err.owner).toBe("acme");
    expect(err.wikiRepo).toBe("notes.wiki");
    expect(err.message).toContain("acme/notes.wiki");
    expect((err as { cause?: unknown }).cause).toBe(cause);
  });

  it("WikiPushConflictError 区分 stale-base / non-fast-forward", () => {
    const stale = new WikiPushConflictError("stale-base", {
      owner: "acme",
      wikiRepo: "notes.wiki",
      branch: "master",
      expectedSha: "a".repeat(40),
      actualSha: "b".repeat(40),
    });
    expect(stale.reason).toBe("stale-base");
    expect(stale.message).toContain("expected base");

    const rejected = new WikiPushConflictError("non-fast-forward", {
      owner: "acme",
      wikiRepo: "notes.wiki",
      branch: "master",
    });
    expect(rejected.reason).toBe("non-fast-forward");
    expect(rejected.message).toContain("master");
  });

  it("WikiPathError 保留非法路径", () => {
    const err = new WikiPathError("../x");
    expect(err.filepath).toBe("../x");
    expect(err).toBeInstanceOf(WikiGitError);
    expect(err.message).toContain("../x");
  });
});

// ---------------------------------------------------------------------------
// 网络注入 / push 早退路径
// ---------------------------------------------------------------------------

describe("pushWikiChanges", () => {
  const base = {
    owner: "acme",
    wikiRepo: "notes.wiki",
    token: "ghs_test",
    branch: "master",
  };

  it("wiki 不存在（HTTP 404）→ WikiNotFoundError", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response("Not Found", { status: 404, statusText: "Not Found" });

    await expect(
      pushWikiChanges({
        ...base,
        baseSha: "0".repeat(40),
        changes: new Map([["Home.md", new TextEncoder().encode("x")]]),
        message: "m",
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(WikiNotFoundError);
  });

  it("401 不是 WikiNotFoundError（凭据错误必须冒泡）", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response("Bad credentials", {
        status: 401,
        statusText: "Unauthorized",
      });

    await expect(
      pushWikiChanges({
        ...base,
        baseSha: "0".repeat(40),
        changes: new Map([["Home.md", new TextEncoder().encode("x")]]),
        message: "m",
        fetchImpl,
      }),
    ).rejects.not.toBeInstanceOf(WikiNotFoundError);
  });

  it("baseSha 与当前 head 不一致 → stale-base，且不改动工作区", async () => {
    const fs = new MemoryFs();
    await initRepo(fs);
    await fs.writeFile("/Home.md", "v1");
    const first = await commitWikiChanges({ fs, dir: "/", message: "first" });

    await expect(
      pushWikiChanges({
        ...base,
        baseSha: "0".repeat(40),
        changes: new Map([["Home.md", new TextEncoder().encode("v2")]]),
        message: "second",
        fs,
        dir: "/",
      }),
    ).rejects.toMatchObject({ reason: "stale-base" });

    // 冲突发生在 applyChanges 之前
    expect(await fs.readFile("/Home.md", "utf8")).toBe("v1");
    expect(await readHeadSha(fs)).toBe(first.commitSha);
  });

  it("变更内容与 head 相同 → 不 commit、不 push（无需网络）", async () => {
    const fs = new MemoryFs();
    await initRepo(fs);
    await fs.writeFile("/Home.md", "same");
    const first = await commitWikiChanges({ fs, dir: "/", message: "first" });

    const result = await pushWikiChanges({
      ...base,
      baseSha: first.commitSha!,
      changes: new Map([["Home.md", new TextEncoder().encode("same")]]),
      message: "no-op",
      fs,
      dir: "/",
    });

    expect(result).toEqual({
      headSha: first.commitSha,
      branch: "master",
      commitSha: null,
      committed: false,
    });
  });
});

describe("isomorphic-git 错误类可用性", () => {
  it("通过 Errors 命名空间可判别 404 / push rejected", () => {
    expect(typeof Errors.HttpError).toBe("function");
    expect(typeof Errors.PushRejectedError).toBe("function");
    const err = new Errors.HttpError(404, "Not Found", "body");
    expect(err).toBeInstanceOf(Errors.HttpError);
    expect(err.data.statusCode).toBe(404);
  });
});
