/**
 * 仪表盘 REST API 测试（DESIGN.md §10 / §5.2 / §5.4 / §7.1）。
 *
 * 全部外部依赖注入：GitHub fetch、`requireUser`、内存 D1、内存 RepoLock。
 * 覆盖路由分派（含未命中返回 null）、401 守卫、D1 聚合拼装、手动触发的
 * 可见性校验与 RunDescriptor 形状、settings UPSERT 参数、stats 数字。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  handleApiRoute,
  type ApiDeps,
  type RepoStats,
  type ReposApiEntry,
  type RepoSettings,
} from "../src/dashboard/api";
import type { SessionUser } from "../src/dashboard/auth";
import type { Env, RunDescriptor } from "../src/types";

/* -------------------------------------------------------------------------- */
/* 夹具：内存 D1                                                               */
/* -------------------------------------------------------------------------- */

interface RunsSeed {
  run_id: string;
  installation_id: number;
  repo: string;
  trigger: string;
  state: string;
  images_optimized?: number | null;
  bytes_before?: number | null;
  bytes_after?: number | null;
  pr_number?: number | null;
  created_at: string;
}

interface PullsSeed {
  installation_id: number;
  repo: string;
  pr_number: number;
  state?: string | null;
  opened_at?: string | null;
  closed_at?: string | null;
}

interface ReposSeed {
  installation_id: number;
  name: string;
  enabled?: number;
}

interface SettingsSeed {
  installation_id: number;
  repo: string;
  key: string;
  value: string | null;
}

interface Seed {
  runs?: RunsSeed[];
  pulls?: PullsSeed[];
  repos?: ReposSeed[];
  settings?: SettingsSeed[];
}

type Row = Record<string, unknown>;

class FakeStatement {
  #args: unknown[] = [];

  constructor(
    readonly db: FakeD1,
    readonly sql: string,
  ) {}

  bind(...args: unknown[]): FakeStatement {
    this.#args = args;
    return this;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.db.query(this.sql, this.#args) as unknown as T[] };
  }

  async first<T>(): Promise<T | null> {
    const rows = this.db.query(this.sql, this.#args);
    return (rows[0] ?? null) as T | null;
  }

  async run(): Promise<{ success: true }> {
    this.db.execute(this.sql, this.#args);
    return { success: true };
  }
}

const byCreatedDesc = (a: { created_at: string }, b: { created_at: string }) =>
  b.created_at.localeCompare(a.created_at);

class FakeD1 {
  runs: RunsSeed[];
  pulls: PullsSeed[];
  repos: ReposSeed[];
  settings: SettingsSeed[];
  /** 记录全部写语句，供 UPSERT 参数断言。 */
  executed: Array<{ sql: string; args: unknown[] }> = [];

  constructor(seed: Seed = {}) {
    this.runs = [...(seed.runs ?? [])];
    this.pulls = [...(seed.pulls ?? [])];
    this.repos = [...(seed.repos ?? [])];
    this.settings = [...(seed.settings ?? [])];
  }

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this, sql);
  }

  query(sql: string, args: unknown[]): Row[] {
    const norm = sql.replace(/\s+/g, " ").trim();

    if (norm.startsWith("SELECT COUNT(*) AS run_count")) {
      const [installationId, repo] = args as [number, string];
      const rows = this.runs.filter(
        (row) => row.installation_id === installationId && row.repo === repo,
      );
      return [
        {
          run_count: rows.length,
          bytes_before: rows.reduce(
            (sum, row) => sum + (row.bytes_before ?? 0),
            0,
          ),
          bytes_after: rows.reduce(
            (sum, row) => sum + (row.bytes_after ?? 0),
            0,
          ),
        },
      ];
    }

    if (norm.startsWith("SELECT run_id, state, trigger")) {
      const [installationId, repo, limit] = args as [number, string, number];
      return this.runs
        .filter(
          (row) => row.installation_id === installationId && row.repo === repo,
        )
        .sort(byCreatedDesc)
        .slice(0, Number(limit))
        .map((row) => ({
          run_id: row.run_id,
          state: row.state,
          trigger: row.trigger,
          images_optimized: row.images_optimized ?? null,
          bytes_before: row.bytes_before ?? null,
          bytes_after: row.bytes_after ?? null,
          created_at: row.created_at,
          pr_number: row.pr_number ?? null,
        }));
    }

    if (norm.startsWith("SELECT repo, state, created_at")) {
      const [installationId] = args as [number];
      return this.runs
        .filter((row) => row.installation_id === installationId)
        .sort(byCreatedDesc)
        .map((row) => ({
          repo: row.repo,
          state: row.state,
          created_at: row.created_at,
          bytes_before: row.bytes_before ?? null,
          bytes_after: row.bytes_after ?? null,
        }));
    }

    if (norm.startsWith("SELECT repo, COUNT(*) AS pr_count")) {
      const [installationId] = args as [number];
      const counts = new Map<string, number>();
      for (const row of this.pulls) {
        if (row.installation_id !== installationId) continue;
        counts.set(row.repo, (counts.get(row.repo) ?? 0) + 1);
      }
      return [...counts].map(([repo, pr_count]) => ({ repo, pr_count }));
    }

    if (norm.startsWith("SELECT name, enabled FROM repos")) {
      const [installationId] = args as [number];
      return this.repos
        .filter((row) => row.installation_id === installationId)
        .map((row) => ({ name: row.name, enabled: row.enabled ?? 1 }));
    }

    if (norm.startsWith("SELECT enabled FROM repos")) {
      const [installationId, name] = args as [number, string];
      const row = this.repos.find(
        (entry) =>
          entry.installation_id === installationId && entry.name === name,
      );
      return row ? [{ enabled: row.enabled ?? 1 }] : [];
    }

    if (norm.startsWith("SELECT repo, value FROM settings")) {
      const [installationId, key] = args as [number, string];
      return this.settings
        .filter(
          (entry) =>
            entry.installation_id === installationId && entry.key === key,
        )
        .map((entry) => ({ repo: entry.repo, value: entry.value }));
    }

    if (norm.startsWith("SELECT value FROM settings")) {
      const [installationId, repo, key] = args as [number, string, string];
      const row = this.settings.find(
        (entry) =>
          entry.installation_id === installationId &&
          entry.repo === repo &&
          entry.key === key,
      );
      return row ? [{ value: row.value }] : [];
    }

    if (norm.startsWith("SELECT pr_number, state, opened_at, closed_at")) {
      const [installationId, repo, limit] = args as [number, string, number];
      return this.pulls
        .filter(
          (row) => row.installation_id === installationId && row.repo === repo,
        )
        .sort((a, b) => (b.opened_at ?? "").localeCompare(a.opened_at ?? ""))
        .slice(0, Number(limit))
        .map((row) => ({
          pr_number: row.pr_number,
          state: row.state ?? null,
          opened_at: row.opened_at ?? null,
          closed_at: row.closed_at ?? null,
        }));
    }

    throw new Error(`FakeD1: unexpected query: ${norm}`);
  }

  execute(sql: string, args: unknown[]): void {
    this.executed.push({ sql: sql.replace(/\s+/g, " ").trim(), args });
    const norm = sql.replace(/\s+/g, " ").trim();

    if (norm.startsWith("INSERT INTO repos")) {
      const [installationId, name, enabled] = args as [number, string, number];
      const row = this.repos.find(
        (entry) =>
          entry.installation_id === installationId && entry.name === name,
      );
      if (row) row.enabled = enabled;
      else this.repos.push({ installation_id: installationId, name, enabled });
      return;
    }

    if (norm.startsWith("INSERT INTO settings")) {
      const [installationId, repo, key, value] = args as [
        number,
        string,
        string,
        string | null,
      ];
      const row = this.settings.find(
        (entry) =>
          entry.installation_id === installationId &&
          entry.repo === repo &&
          entry.key === key,
      );
      if (row) row.value = value;
      else
        this.settings.push({
          installation_id: installationId,
          repo,
          key,
          value,
        });
      return;
    }

    throw new Error(`FakeD1: unexpected statement: ${norm}`);
  }
}

/* -------------------------------------------------------------------------- */
/* 夹具：RepoLock / fetch / env                                                */
/* -------------------------------------------------------------------------- */

interface LockCall {
  name: string;
  desc: RunDescriptor;
}

class FakeRepoLock {
  calls: LockCall[] = [];
  result: { started: boolean; coalesced: boolean; quotaExceeded?: boolean } = {
    started: true,
    coalesced: false,
  };

  getByName(name: string) {
    return {
      submit: async (desc: RunDescriptor) => {
        this.calls.push({ name, desc });
        return this.result;
      },
    };
  }
}

interface FetchCall {
  url: string;
  method: string;
  authorization: string | null;
}

type FetchHandler = (
  url: URL,
  init?: RequestInit,
) => Response | Promise<Response>;

function makeFetch(handlers: Record<string, FetchHandler>): {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  return {
    calls,
    fetch: async (input, init) => {
      const url = new URL(input);
      const headers = new Headers(init?.headers);
      calls.push({
        url: url.toString(),
        method: init?.method ?? "GET",
        authorization: headers.get("authorization"),
      });
      const handler = handlers[url.pathname];
      if (!handler) {
        return jsonResponse({ message: "Not Found" }, 404);
      }
      return handler(url, init);
    },
  };
}

function jsonResponse(body: unknown, status = 200, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const USER: SessionUser = {
  login: "octocat",
  userId: 583231,
  token: "user-token",
};

interface Harness {
  env: Env;
  db: FakeD1;
  lock: FakeRepoLock;
  deps: ApiDeps;
  fetchCalls: FetchCall[];
}

function makeHarness(options: {
  seed?: Seed;
  handlers: Record<string, FetchHandler>;
  user?: SessionUser | null;
  appSlug?: string;
}): Harness {
  const db = new FakeD1(options.seed);
  const lock = new FakeRepoLock();
  const gh = makeFetch(options.handlers);
  const user = options.user === undefined ? USER : options.user;

  const env = {
    DB: db,
    REPO_LOCK: lock,
    GITHUB_APP_SLUG: options.appSlug,
  } as unknown as Env;

  return {
    env,
    db,
    lock,
    fetchCalls: gh.calls,
    deps: {
      fetch: gh.fetch,
      requireUser: async () => user,
    },
  };
}

function callApi(
  harness: Harness,
  path: string,
  init: RequestInit = {},
): Promise<Response | null> {
  const request = new Request(`https://dash.test${path}`, init);
  return handleApiRoute(
    harness.env,
    request,
    new URL(request.url),
    harness.deps,
  );
}

function postJson(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

/** GitHub 侧对某仓库的标准响应（可见 + installation 42）。 */
function repoHandlers(
  fullName = "o/r",
  extra: Record<string, FetchHandler> = {},
): Record<string, FetchHandler> {
  return {
    [`/repos/${fullName}`]: () =>
      jsonResponse({
        full_name: fullName,
        private: false,
        default_branch: "main",
      }),
    [`/repos/${fullName}/installation`]: () => jsonResponse({ id: 42 }),
    ...extra,
  };
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

/* -------------------------------------------------------------------------- */
/* 路由分派                                                                    */
/* -------------------------------------------------------------------------- */

describe("路由分派", () => {
  it("非 /api 前缀返回 null（交上游）", async () => {
    const harness = makeHarness({ handlers: {} });
    await expect(callApi(harness, "/healthz")).resolves.toBeNull();
    await expect(callApi(harness, "/")).resolves.toBeNull();
    expect(harness.fetchCalls).toHaveLength(0);
  });

  it("/api/hook 与 /api/auth/* 不归本模块，返回 null", async () => {
    const harness = makeHarness({ handlers: {} });
    await expect(
      callApi(harness, "/api/hook", postJson({})),
    ).resolves.toBeNull();
    await expect(callApi(harness, "/api/auth/login")).resolves.toBeNull();
    await expect(callApi(harness, "/api/nope")).resolves.toBeNull();
  });

  it("方法不符 / 未知 action 返回 null，且不触发 requireUser", async () => {
    const harness = makeHarness({ handlers: {} });
    const requireUser = vi.fn(async () => USER);
    harness.deps.requireUser = requireUser;

    await expect(
      callApi(harness, "/api/me", { method: "POST" }),
    ).resolves.toBeNull();
    await expect(callApi(harness, "/api/repos/o/r/nope")).resolves.toBeNull();
    expect(requireUser).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/* 401 守卫                                                                    */
/* -------------------------------------------------------------------------- */

describe("会话守卫", () => {
  it("未登录 → 401 {error:'unauthorized'}（含 /api/me、/api/repos）", async () => {
    const harness = makeHarness({ handlers: {}, user: null });

    const me = await callApi(harness, "/api/me");
    expect(me?.status).toBe(401);
    expect(await me?.json()).toEqual({ error: "unauthorized" });

    const repos = await callApi(harness, "/api/repos");
    expect(repos?.status).toBe(401);
    expect(harness.fetchCalls).toHaveLength(0);
  });

  it("未登录 → optimize/settings/stats 一律 401", async () => {
    const harness = makeHarness({ handlers: {}, user: null });
    for (const [path, init] of [
      ["/api/repos/o/r/optimize", { method: "POST" }],
      ["/api/repos/o/r/settings", postJson({ enabled: false })],
      ["/api/repos/o/r/stats", {}],
    ] as const) {
      const res = await callApi(harness, path, init);
      expect(res?.status).toBe(401);
      expect(await res?.json()).toEqual({ error: "unauthorized" });
    }
  });

  it("GET /api/me → login / userId / installUrl（缺省 null）", async () => {
    const harness = makeHarness({ handlers: {} });
    const res = await callApi(harness, "/api/me");
    expect(res?.status).toBe(200);
    expect(await res?.json()).toEqual({
      login: "octocat",
      userId: 583231,
      installUrl: null,
    });
  });

  it("GET /api/me → 配置 GITHUB_APP_SLUG 时返回安装页直达链接", async () => {
    const harness = makeHarness({ handlers: {}, appSlug: "my-imgbot" });
    const res = await callApi(harness, "/api/me");
    expect(await res?.json()).toEqual({
      login: "octocat",
      userId: 583231,
      installUrl: "https://github.com/apps/my-imgbot/installations/new",
    });
  });
});

/* -------------------------------------------------------------------------- */
/* GET /api/repos                                                              */
/* -------------------------------------------------------------------------- */

describe("GET /api/repos", () => {
  it("拼装 GitHub 仓库列表与 D1 聚合（最近 run / 节省量 / PR 数 / enabled）", async () => {
    const harness = makeHarness({
      handlers: {
        "/user/installations": () =>
          jsonResponse({ installations: [{ id: 42 }] }),
        "/user/installations/42/repositories": () =>
          jsonResponse({
            repositories: [
              { full_name: "o/r", private: true },
              { full_name: "o/other", private: false },
            ],
          }),
      },
      seed: {
        runs: [
          {
            run_id: "run-new",
            installation_id: 42,
            repo: "o/r",
            trigger: "push",
            state: "done",
            bytes_before: 10_000,
            bytes_after: 8_000,
            created_at: "2026-11-17T10:00:00Z",
          },
          {
            run_id: "run-old",
            installation_id: 42,
            repo: "o/r",
            trigger: "schedule",
            state: "skipped_nochange",
            bytes_before: 5_000,
            bytes_after: 5_000,
            created_at: "2026-11-16T10:00:00Z",
          },
        ],
        pulls: [
          { installation_id: 42, repo: "o/r", pr_number: 1 },
          { installation_id: 42, repo: "o/r", pr_number: 2 },
          { installation_id: 42, repo: "o/other", pr_number: 3 },
        ],
        repos: [{ installation_id: 42, name: "o/r", enabled: 0 }],
        settings: [
          {
            installation_id: 42,
            repo: "o/r",
            key: "default_branch_override",
            value: "develop",
          },
        ],
      },
    });

    const res = await callApi(harness, "/api/repos");
    expect(res?.status).toBe(200);
    const body = (await res?.json()) as ReposApiEntry[];

    expect(body).toEqual([
      {
        fullName: "o/other",
        isPrivate: false,
        enabled: true,
        installationId: 42,
        lastRunAt: null,
        lastRunState: null,
        totalSavedBytes: 0,
        prCount: 1,
        defaultBranchOverride: null,
      },
      {
        fullName: "o/r",
        isPrivate: true,
        enabled: false,
        installationId: 42,
        lastRunAt: "2026-11-17T10:00:00Z",
        lastRunState: "done",
        totalSavedBytes: 2_000,
        prCount: 2,
        defaultBranchOverride: "develop",
      },
    ]);

    // 用用户 token（不是 installation token）访问 /user/* 系端点。
    expect(harness.fetchCalls[0]?.authorization).toBe("Bearer user-token");
    expect(harness.fetchCalls[0]?.url).toContain("per_page=100");
  });

  it("无安装 → 空数组，且不查 D1 聚合", async () => {
    const harness = makeHarness({
      handlers: {
        "/user/installations": () => jsonResponse({ installations: [] }),
      },
    });
    const res = await callApi(harness, "/api/repos");
    expect(res?.status).toBe(200);
    expect(await res?.json()).toEqual([]);
    expect(harness.fetchCalls).toHaveLength(1);
  });

  it("按 Link rel=next 翻页拉取 installations", async () => {
    let page = 0;
    const harness = makeHarness({
      handlers: {
        "/user/installations": () => {
          page += 1;
          if (page === 1) {
            return jsonResponse({ installations: [{ id: 1 }] }, 200, {
              link: '<https://api.github.com/user/installations?page=2>; rel="next"',
            });
          }
          return jsonResponse({ installations: [{ id: 2 }] });
        },
        "/user/installations/1/repositories": () =>
          jsonResponse({
            repositories: [{ full_name: "a/one", private: false }],
          }),
        "/user/installations/2/repositories": () =>
          jsonResponse({
            repositories: [{ full_name: "b/two", private: false }],
          }),
      },
    });

    const res = await callApi(harness, "/api/repos");
    const body = (await res?.json()) as ReposApiEntry[];
    expect(body.map((entry) => entry.fullName)).toEqual(["a/one", "b/two"]);
    expect(body.map((entry) => entry.installationId)).toEqual([1, 2]);
    expect(body.every((entry) => entry.enabled)).toBe(true);
  });

  it("GitHub 5xx → 502 {error:'github_error'}", async () => {
    const harness = makeHarness({
      handlers: {
        "/user/installations": () => jsonResponse({ message: "boom" }, 500),
      },
    });
    const res = await callApi(harness, "/api/repos");
    expect(res?.status).toBe(502);
    expect(await res?.json()).toEqual({ error: "github_error" });
  });
});

/* -------------------------------------------------------------------------- */
/* POST /api/repos/{owner}/{name}/optimize                                     */
/* -------------------------------------------------------------------------- */

describe("POST /api/repos/{owner}/{name}/optimize", () => {
  it("仓库不可见（GitHub 404）→ 403，且不调 RepoLock", async () => {
    const harness = makeHarness({
      handlers: {
        "/repos/o/r": () => jsonResponse({ message: "Not Found" }, 404),
      },
    });

    const res = await callApi(harness, "/api/repos/o/r/optimize", {
      method: "POST",
    });
    expect(res?.status).toBe(403);
    expect(await res?.json()).toEqual({ error: "forbidden" });
    expect(harness.lock.calls).toHaveLength(0);
  });

  it("URL 段大小写 ≠ GitHub 规范名 → 锁键与描述符用规范名（P1）", async () => {
    const harness = makeHarness({
      handlers: {
        "/repos/Foo/Bar": () =>
          jsonResponse({
            full_name: "foo/bar",
            private: false,
            default_branch: "main",
          }),
        "/repos/Foo/Bar/installation": () => jsonResponse({ id: 42 }),
      },
    });

    const res = await callApi(harness, "/api/repos/Foo/Bar/optimize", {
      method: "POST",
    });
    expect(res?.status).toBe(202);
    expect(harness.lock.calls[0]?.name).toBe("repo:42/foo/bar");
    expect(harness.lock.calls[0]?.desc.repo).toBe("foo/bar");
  });

  it("成功 → 202，submit 参数为 trigger:'manual' / base_ref:'' / run_id=UUID", async () => {
    const harness = makeHarness({ handlers: repoHandlers("o/r") });

    const res = await callApi(harness, "/api/repos/o/r/optimize", {
      method: "POST",
    });
    expect(res?.status).toBe(202);
    const body = (await res?.json()) as {
      runId: string;
      started: boolean;
      coalesced: boolean;
    };
    expect(body.started).toBe(true);
    expect(body.coalesced).toBe(false);
    expect(body.runId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    expect(harness.lock.calls).toHaveLength(1);
    expect(harness.lock.calls[0].name).toBe("repo:42/o/r");
    expect(harness.lock.calls[0].desc).toEqual({
      run_id: body.runId,
      installation_id: 42,
      repo: "o/r",
      trigger: "manual",
      base_ref: "",
    });

    // 可见性与 installation 都用用户 token 查。
    expect(
      harness.fetchCalls.every(
        (call) => call.authorization === "Bearer user-token",
      ),
    ).toBe(true);
  });

  it("配额用尽（D10）→ 429 {error:'quota_exceeded'}", async () => {
    const harness = makeHarness({ handlers: repoHandlers("o/r") });
    harness.lock.result = {
      started: false,
      coalesced: false,
      quotaExceeded: true,
    };

    const res = await callApi(harness, "/api/repos/o/r/optimize", {
      method: "POST",
    });
    expect(res?.status).toBe(429);
    expect(await res?.json()).toEqual({ error: "quota_exceeded" });
  });

  it("锁被占用 → 202 透传 coalesced", async () => {
    const harness = makeHarness({ handlers: repoHandlers("o/r") });
    harness.lock.result = { started: false, coalesced: true };

    const res = await callApi(harness, "/api/repos/o/r/optimize", {
      method: "POST",
    });
    expect(res?.status).toBe(202);
    expect(await res?.json()).toMatchObject({
      started: false,
      coalesced: true,
    });
  });

  it("App 未安装（installation 404）→ 403", async () => {
    const harness = makeHarness({
      handlers: {
        "/repos/o/r": () => jsonResponse({ full_name: "o/r", private: false }),
        "/repos/o/r/installation": () =>
          jsonResponse({ message: "Not Found" }, 404),
      },
    });
    const res = await callApi(harness, "/api/repos/o/r/optimize", {
      method: "POST",
    });
    expect(res?.status).toBe(403);
    expect(harness.lock.calls).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* POST /api/repos/{owner}/{name}/settings                                     */
/* -------------------------------------------------------------------------- */

describe("POST /api/repos/{owner}/{name}/settings", () => {
  it("enabled + defaultBranchOverride 各写一条 UPSERT，返回更新后对象", async () => {
    const harness = makeHarness({
      handlers: repoHandlers("o/r"),
      seed: {
        repos: [{ installation_id: 42, name: "o/r", enabled: 1 }],
        settings: [
          {
            installation_id: 42,
            repo: "o/r",
            key: "default_branch_override",
            value: "main",
          },
        ],
      },
    });

    const res = await callApi(
      harness,
      "/api/repos/o/r/settings",
      postJson({ enabled: false, defaultBranchOverride: "release" }),
    );

    expect(res?.status).toBe(200);
    const body = (await res?.json()) as RepoSettings;
    expect(body).toEqual({
      fullName: "o/r",
      enabled: false,
      defaultBranchOverride: "release",
    });

    expect(harness.db.executed).toHaveLength(2);
    const [reposWrite, settingsWrite] = harness.db.executed;

    expect(reposWrite.sql).toContain("INSERT INTO repos");
    expect(reposWrite.sql).toContain("ON CONFLICT(installation_id, name)");
    expect(reposWrite.args).toEqual([42, "o/r", 0]);

    expect(settingsWrite.sql).toContain("INSERT INTO settings");
    expect(settingsWrite.sql).toContain(
      "ON CONFLICT(installation_id, repo, key)",
    );
    expect(settingsWrite.args).toEqual([
      42,
      "o/r",
      "default_branch_override",
      "release",
    ]);
  });

  it("只传 enabled → 不写 settings，override 保持原值", async () => {
    const harness = makeHarness({
      handlers: repoHandlers("o/r"),
      seed: {
        settings: [
          {
            installation_id: 42,
            repo: "o/r",
            key: "default_branch_override",
            value: "develop",
          },
        ],
      },
    });

    const res = await callApi(
      harness,
      "/api/repos/o/r/settings",
      postJson({ enabled: false }),
    );

    expect(await res?.json()).toEqual({
      fullName: "o/r",
      enabled: false,
      defaultBranchOverride: "develop",
    });
    expect(harness.db.executed).toHaveLength(1);
    expect(harness.db.executed[0].sql).toContain("INSERT INTO repos");
  });

  it("defaultBranchOverride:null（或空串）→ 清除覆盖", async () => {
    const harness = makeHarness({
      handlers: repoHandlers("o/r"),
      seed: {
        settings: [
          {
            installation_id: 42,
            repo: "o/r",
            key: "default_branch_override",
            value: "develop",
          },
        ],
      },
    });

    const res = await callApi(
      harness,
      "/api/repos/o/r/settings",
      postJson({ defaultBranchOverride: null }),
    );

    expect(res?.status).toBe(200);
    expect(await res?.json()).toEqual({
      fullName: "o/r",
      enabled: true,
      defaultBranchOverride: null,
    });
    expect(harness.db.executed[0].args).toEqual([
      42,
      "o/r",
      "default_branch_override",
      null,
    ]);
  });

  it("非法 body → 400（空对象 / 类型错误 / 未知键 / 非 JSON）", async () => {
    const harness = makeHarness({ handlers: repoHandlers("o/r") });

    for (const body of [
      {},
      { enabled: "yes" },
      { defaultBranchOverride: 5 },
      { nope: 1 },
    ]) {
      const res = await callApi(
        harness,
        "/api/repos/o/r/settings",
        postJson(body),
      );
      expect(res?.status).toBe(400);
      expect(await res?.json()).toEqual({ error: "invalid_body" });
    }

    const badJson = await callApi(harness, "/api/repos/o/r/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(badJson?.status).toBe(400);

    // 校验失败不应触碰 GitHub 或 D1。
    expect(harness.fetchCalls).toHaveLength(0);
    expect(harness.db.executed).toHaveLength(0);
  });

  it("仓库不可见 → 403", async () => {
    const harness = makeHarness({
      handlers: {
        "/repos/o/r": () => jsonResponse({ message: "Not Found" }, 404),
      },
    });
    const res = await callApi(
      harness,
      "/api/repos/o/r/settings",
      postJson({ enabled: true }),
    );
    expect(res?.status).toBe(403);
    expect(harness.db.executed).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* GET /api/repos/{owner}/{name}/stats                                         */
/* -------------------------------------------------------------------------- */

describe("GET /api/repos/{owner}/{name}/stats", () => {
  it("totals 聚合 + 最近 20 条 run / pull 映射", async () => {
    const harness = makeHarness({
      handlers: repoHandlers("o/r"),
      seed: {
        runs: [
          {
            run_id: "run-1",
            installation_id: 42,
            repo: "o/r",
            trigger: "push",
            state: "done",
            images_optimized: 3,
            bytes_before: 10_240,
            bytes_after: 5_120,
            pr_number: 7,
            created_at: "2026-11-17T10:00:00Z",
          },
          {
            run_id: "run-2",
            installation_id: 42,
            repo: "o/r",
            trigger: "schedule",
            state: "skipped_nochange",
            images_optimized: 0,
            bytes_before: 2_048,
            bytes_after: 2_048,
            pr_number: null,
            created_at: "2026-11-16T10:00:00Z",
          },
          {
            // 其他仓库的行必须被过滤掉。
            run_id: "run-other",
            installation_id: 42,
            repo: "o/other",
            trigger: "push",
            state: "done",
            bytes_before: 99_999,
            bytes_after: 1,
            created_at: "2026-11-17T11:00:00Z",
          },
        ],
        pulls: [
          {
            installation_id: 42,
            repo: "o/r",
            pr_number: 7,
            state: "open",
            opened_at: "2026-11-17T10:01:00Z",
            closed_at: null,
          },
          {
            installation_id: 42,
            repo: "o/r",
            pr_number: 6,
            state: "merged",
            opened_at: "2026-11-10T10:01:00Z",
            closed_at: "2026-11-11T10:01:00Z",
          },
        ],
      },
    });

    const res = await callApi(harness, "/api/repos/o/r/stats");
    expect(res?.status).toBe(200);

    const body = (await res?.json()) as RepoStats;
    expect(body.totals).toEqual({
      bytesBefore: 12_288,
      bytesAfter: 7_168,
      savedKb: 5,
      runs: 2,
    });

    expect(body.recentRuns).toEqual([
      {
        runId: "run-1",
        state: "done",
        trigger: "push",
        imagesOptimized: 3,
        savedKb: 5,
        createdAt: "2026-11-17T10:00:00Z",
        prNumber: 7,
      },
      {
        runId: "run-2",
        state: "skipped_nochange",
        trigger: "schedule",
        imagesOptimized: 0,
        savedKb: 0,
        createdAt: "2026-11-16T10:00:00Z",
        prNumber: null,
      },
    ]);

    expect(body.pulls).toEqual([
      {
        prNumber: 7,
        state: "open",
        openedAt: "2026-11-17T10:01:00Z",
        closedAt: null,
      },
      {
        prNumber: 6,
        state: "merged",
        openedAt: "2026-11-10T10:01:00Z",
        closedAt: "2026-11-11T10:01:00Z",
      },
    ]);
  });

  it("无历史 → 零值统计", async () => {
    const harness = makeHarness({ handlers: repoHandlers("o/r") });

    const res = await callApi(harness, "/api/repos/o/r/stats");
    expect(res?.status).toBe(200);
    expect(await res?.json()).toEqual({
      totals: { bytesBefore: 0, bytesAfter: 0, savedKb: 0, runs: 0 },
      recentRuns: [],
      pulls: [],
    });
  });

  it("仓库不可见 → 403", async () => {
    const harness = makeHarness({
      handlers: {
        "/repos/o/r": () => jsonResponse({ message: "Not Found" }, 404),
      },
    });
    const res = await callApi(harness, "/api/repos/o/r/stats");
    expect(res?.status).toBe(403);
  });
});

/* -------------------------------------------------------------------------- */
/* 路径编码                                                                    */
/* -------------------------------------------------------------------------- */

describe("路径编码", () => {
  it("owner/name 走 decodeURIComponent 后再打 GitHub", async () => {
    const harness = makeHarness({
      handlers: {
        "/repos/my%20org/my%20repo": () =>
          jsonResponse({ full_name: "my org/my repo", private: false }),
        "/repos/my%20org/my%20repo/installation": () => jsonResponse({ id: 7 }),
      },
    });

    const res = await callApi(
      harness,
      "/api/repos/my%20org/my%20repo/optimize",
      { method: "POST" },
    );

    expect(res?.status).toBe(202);
    expect(harness.lock.calls[0].name).toBe("repo:7/my org/my repo");
    expect(harness.lock.calls[0].desc.repo).toBe("my org/my repo");
  });
});
