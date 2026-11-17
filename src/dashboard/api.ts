/**
 * P3 仪表盘 REST API（DESIGN.md §10）—— 原版 `Auth/InstallationFunction` 的后端面。
 *
 * 路由（统一 `/api` 前缀，除守卫外全部先 `requireUser`）：
 *
 *   GET  /api/me                              当前会话身份 + App 安装页（installUrl）
 *   GET  /api/repos                           用户可见仓库 + D1 聚合统计（含分支覆盖）
 *   POST /api/repos/{owner}/{name}/optimize   手动触发（trigger: "manual"）
 *   POST /api/repos/{owner}/{name}/settings   开关 / 默认分支覆盖
 *   GET  /api/repos/{owner}/{name}/stats      run / PR 明细
 *
 * 约定：
 * - 非本模块路由（含 `/api/hook`、`/api/auth/*`、非 `/api`）返回 `null` 交上游分流；
 * - 错误体统一 `{"error": "..."}`；未登录 401、不可见仓库 403、body 非法 400；
 * - **可见性**用用户 token 判（"这个人能否看到这个仓"）；**installation 归属**是
 *   App 视角查询（`GET /repos/{o}/{r}/installation` 只认 App 身份，用户 token 会被
 *   上游拒绝——2026-11-17 真仓实测 502 根因），用 App JWT；两者都过才放行（§4.1）；
 * - fetch 与 `requireUser` 均可注入，便于测试（`ApiDeps`）。
 */
import { GITHUB_API_BASE, GITHUB_API_VERSION } from "../github/gitdata";
import type { Env, RunDescriptor } from "../types";
import { generateAppJwt } from "../github/auth";
import {
  clearSession,
  requireUser,
  sessionIdFromRequest,
  type SessionUser,
} from "./auth";

/* -------------------------------------------------------------------------- */
/* 类型与常量                                                                  */
/* -------------------------------------------------------------------------- */

export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

/** 测试注入点：GitHub fetch 与会话守卫。生产不传 = 真实现。 */
export interface ApiDeps {
  fetch?: FetchLike;
  requireUser?: (env: Env, request: Request) => Promise<SessionUser | null>;
}

/** `GET /api/repos` 的单条记录。 */
export interface ReposApiEntry {
  fullName: string;
  isPrivate: boolean;
  enabled: boolean;
  installationId: number;
  lastRunAt: string | null;
  lastRunState: string | null;
  totalSavedBytes: number;
  prCount: number;
  defaultBranchOverride: string | null;
}

/** `POST /api/repos/{owner}/{name}/settings` 的返回体。 */
export interface RepoSettings {
  fullName: string;
  enabled: boolean;
  defaultBranchOverride: string | null;
}

/** `GET /api/repos/{owner}/{name}/stats` 的返回体。 */
export interface RepoStats {
  totals: {
    bytesBefore: number;
    bytesAfter: number;
    savedKb: number;
    runs: number;
  };
  recentRuns: Array<{
    runId: string;
    state: string;
    trigger: string;
    imagesOptimized: number | null;
    savedKb: number;
    createdAt: string;
    prNumber: number | null;
  }>;
  pulls: Array<{
    prNumber: number;
    state: string | null;
    openedAt: string | null;
    closedAt: string | null;
  }>;
}

const MAX_PAGES = 10;
const PER_PAGE = "100";
const REQUEST_TIMEOUT_MS = 20_000;
const RECENT_LIMIT = 20;

const SETTING_DEFAULT_BRANCH = "default_branch_override";

/* -------------------------------------------------------------------------- */
/* 路由分派                                                                    */
/* -------------------------------------------------------------------------- */

type Route =
  | { kind: "me" }
  | { kind: "repos" }
  | {
      kind: "repo";
      action: "optimize" | "settings" | "stats";
      owner: string;
      name: string;
    };

/** 只认本模块的 5 条路由；其余（含方法不符）返回 null。 */
function matchRoute(method: string, pathname: string): Route | null {
  const segments = pathname.split("/").filter((part) => part.length > 0);
  if (segments[0] !== "api") return null;

  if (method === "GET" && segments.length === 2 && segments[1] === "me") {
    return { kind: "me" };
  }
  if (method === "GET" && segments.length === 2 && segments[1] === "repos") {
    return { kind: "repos" };
  }
  if (segments.length === 5 && segments[1] === "repos") {
    const action = segments[4];
    if (
      (action === "optimize" && method === "POST") ||
      (action === "settings" && method === "POST") ||
      (action === "stats" && method === "GET")
    ) {
      const owner = decodeSegment(segments[2]);
      const name = decodeSegment(segments[3]);
      if (!owner || !name) return null;
      return { kind: "repo", action, owner, name };
    }
  }
  return null;
}

function decodeSegment(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
}

/** Worker 入口调用点：非本模块路由返回 null。 */
export async function handleApiRoute(
  env: Env,
  request: Request,
  url: URL,
  deps: ApiDeps = {},
): Promise<Response | null> {
  const route = matchRoute(request.method, url.pathname);
  if (!route) return null;

  // CSRF 纵深防御（P0）：状态变更的 POST 若带了 Origin，必须是同源。
  // 缺 Origin 放行（非浏览器客户端）；SameSite=Lax cookie 仍是主防线。
  if (
    route.kind === "repo" &&
    (route.action === "optimize" || route.action === "settings") &&
    isCrossOrigin(request, url)
  ) {
    return jsonResponse({ error: "forbidden" }, 403);
  }

  const resolveUser = deps.requireUser ?? requireUser;
  const user = await resolveUser(env, request);
  if (!user) return jsonResponse({ error: "unauthorized" }, 401);

  try {
    if (route.kind === "me") {
      return jsonResponse(
        {
          login: user.login,
          userId: user.userId,
          installUrl: appInstallUrl(env),
        },
        200,
      );
    }
    if (route.kind === "repos") {
      return jsonResponse(await listRepos(env, user, deps), 200);
    }

    const fullName = `${route.owner}/${route.name}`;
    if (route.action === "optimize") {
      return await optimizeRepo(
        env,
        user,
        route.owner,
        route.name,
        fullName,
        deps,
      );
    }
    if (route.action === "settings") {
      return await updateSettings(
        env,
        user,
        route.owner,
        route.name,
        fullName,
        request,
        deps,
      );
    }
    return await repoStats(env, user, route.owner, route.name, fullName, deps);
  } catch (error) {
    if (error instanceof GithubRequestError) {
      // GitHub App 的 OAuth user token 会过期/被撤销：401 说明会话里的 token
      // 已不可用 → 删行 + 401，让前端回到未登录态（否则每次请求都 502 且
      // 坏会话一直挂着）。所有 GitHub 调用（listRepos / resolveRepoAccess /
      // stats）都经 `ghRequest` 抛 `GithubRequestError`，这里统一收口。
      if (error.status === 401) {
        await dropSession(env, request);
        return jsonResponse({ error: "unauthorized" }, 401);
      }
      console.error(
        `dashboard api: GitHub ${error.detail} failed`,
        error.status,
      );
      return jsonResponse({ error: "github_error" }, 502);
    }
    console.error("dashboard api: unexpected failure", error);
    return jsonResponse({ error: "internal_error" }, 500);
  }
}

/** 上游 401 时清掉当前会话行（删失败只记日志，不把 401 变成 500）。 */
async function dropSession(env: Env, request: Request): Promise<void> {
  const sessionId = sessionIdFromRequest(request);
  if (!sessionId) return;
  try {
    await clearSession(env, sessionId);
  } catch (error) {
    console.error("dashboard api: failed to drop stale session", error);
  }
}

/**
 * 跨源判定（CSRF 纵深防御）：Origin 缺省 → 非浏览器客户端，放行；
 * 有 Origin 则 host 必须与请求 URL 一致。畸形 Origin（含 `null`）视为跨源。
 */
function isCrossOrigin(request: Request, url: URL): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).host !== url.host;
  } catch {
    return true;
  }
}

/** GitHub App 安装页直达链接；`GITHUB_APP_SLUG` 未配置 → null（前端自行兜底）。 */
function appInstallUrl(env: Env): string | null {
  const slug = (env.GITHUB_APP_SLUG ?? "").trim();
  return slug ? `https://github.com/apps/${slug}/installations/new` : null;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/* -------------------------------------------------------------------------- */
/* GitHub 访问                                                                 */
/* -------------------------------------------------------------------------- */

class GithubRequestError extends Error {
  readonly status: number;
  readonly detail: string;

  constructor(status: number, detail: string) {
    super(`GitHub request failed: ${status} ${detail}`);
    this.name = "GithubRequestError";
    this.status = status;
    this.detail = detail;
  }
}

interface GhResponse {
  status: number;
  ok: boolean;
  body: unknown;
  link: string | null;
}

function resolveFetch(deps: ApiDeps): FetchLike {
  if (deps.fetch) return deps.fetch;
  const impl = globalThis.fetch;
  if (typeof impl !== "function") {
    throw new Error("dashboard api requires a fetch implementation");
  }
  // 裸调用：workerd 下以成员调用原生 fetch 会触发 Illegal invocation。
  return (input, init) => impl(input, init);
}

async function ghRequest(
  deps: ApiDeps,
  token: string,
  pathOrUrl: string,
  init: RequestInit = {},
): Promise<GhResponse> {
  const url = pathOrUrl.startsWith("http")
    ? pathOrUrl
    : `${GITHUB_API_BASE}${pathOrUrl}`;

  let res: Response;
  try {
    res = await resolveFetch(deps)(url, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": GITHUB_API_VERSION,
        "user-agent": "image-bot-cf",
        ...(init.headers ?? {}),
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new GithubRequestError(
      0,
      `${init.method ?? "GET"} ${url}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  let body: unknown = null;
  const text = await res.text();
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
  };
}

/** RFC 5988 `Link: <…>; rel="next"` → next URL。 */
function nextLink(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(",")) {
    if (!/rel="?next"?/.test(part)) continue;
    const match = /<([^>]+)>/.exec(part);
    if (match?.[1]) return match[1];
  }
  return null;
}

function extractArray(body: unknown, field: string): unknown[] {
  if (Array.isArray(body)) return body;
  if (body !== null && typeof body === "object") {
    const value = (body as Record<string, unknown>)[field];
    if (Array.isArray(value)) return value;
  }
  return [];
}

/** 翻页拉列表；`field` 是响应对象里的数组键（数组响应也兼容）。 */
async function collectPages(
  deps: ApiDeps,
  token: string,
  firstUrl: string,
  field: string,
): Promise<unknown[]> {
  const items: unknown[] = [];
  let url: string | null = firstUrl;

  for (let page = 0; url && page < MAX_PAGES; page += 1) {
    const res = await ghRequest(deps, token, url);
    if (!res.ok) {
      throw new GithubRequestError(res.status, `GET ${url}`);
    }
    items.push(...extractArray(res.body, field));
    url = nextLink(res.link);
  }
  return items;
}

interface InstallationRef {
  id: number;
}

interface GithubRepoRef {
  fullName: string;
  isPrivate: boolean;
}

async function listUserInstallations(
  user: SessionUser,
  deps: ApiDeps,
): Promise<InstallationRef[]> {
  const raw = await collectPages(
    deps,
    user.token,
    `/user/installations?per_page=${PER_PAGE}`,
    "installations",
  );

  const installations: InstallationRef[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object") continue;
    const id = (item as Record<string, unknown>).id;
    if (typeof id === "number" && Number.isInteger(id)) {
      installations.push({ id });
    }
  }
  return installations;
}

async function listInstallationRepos(
  user: SessionUser,
  installationId: number,
  deps: ApiDeps,
): Promise<GithubRepoRef[]> {
  const raw = await collectPages(
    deps,
    user.token,
    `/user/installations/${installationId}/repositories?per_page=${PER_PAGE}`,
    "repositories",
  );

  const repos: GithubRepoRef[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (typeof record.full_name !== "string" || record.full_name === "") {
      continue;
    }
    repos.push({
      fullName: record.full_name,
      isPrivate: record.private === true,
    });
  }
  return repos;
}

/**
 * 仓库可见性 + installation 归属。
 * `GET /repos/{owner}/{name}` 404 → 对当前用户不可见（403，不泄露存在性）；
 * 其他 GitHub 故障上抛→502。
 */
interface RepoAccess {
  installationId: number;
  /** GitHub 规范名（响应体 full_name）——URL 段大小写不可信，锁键/D1 一律用它（P1）。 */
  fullName: string;
}

async function resolveRepoAccess(
  env: Env,
  user: SessionUser,
  owner: string,
  name: string,
  deps: ApiDeps,
): Promise<RepoAccess | { forbidden: true }> {
  const repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;

  // 可见性 = 用户视角（用户 token）
  const repoRes = await ghRequest(deps, user.token, repoPath);
  if (repoRes.status === 404) return { forbidden: true };
  if (!repoRes.ok) {
    throw new GithubRequestError(repoRes.status, `GET ${repoPath}`);
  }

  // installation 归属 = App 视角：该端点只认 App 身份（JWT/安装 token），
  // 用户 token 会被上游拒绝（2026-11-17 真仓实测）→ 用 App JWT。
  const appJwt = await generateAppJwt(
    env.GITHUB_APP_ID,
    env.GITHUB_PRIVATE_KEY,
  );
  const installRes = await ghRequest(deps, appJwt, `${repoPath}/installation`);
  if (installRes.status === 404 || installRes.status === 403) {
    // 仓库可见但 App 未安装 → 与不可操作同义。
    return { forbidden: true };
  }
  if (!installRes.ok) {
    throw new GithubRequestError(
      installRes.status,
      `GET ${repoPath}/installation`,
    );
  }

  const installationId = readNumber(
    (installRes.body as Record<string, unknown> | null)?.id,
  );
  if (installationId === null) {
    throw new GithubRequestError(502, `GET ${repoPath}/installation: bad body`);
  }
  const bodyFullName = (repoRes.body as Record<string, unknown> | null)
    ?.full_name;
  const canonicalName =
    typeof bodyFullName === "string" && bodyFullName.includes("/")
      ? bodyFullName
      : `${owner}/${name}`;
  return { installationId, fullName: canonicalName };
}

/* -------------------------------------------------------------------------- */
/* GET /api/repos                                                              */
/* -------------------------------------------------------------------------- */

interface RepoAggregate {
  lastRunAt: string | null;
  lastRunState: string | null;
  totalSavedBytes: number;
  prCount: number;
  enabled: boolean;
  defaultBranchOverride: string | null;
}

/** 一次 installation 的 D1 聚合（5 条查询，仓库数无关；均为 SQL 侧聚合）。 */
async function loadRepoAggregates(
  env: Env,
  installationId: number,
): Promise<Map<string, RepoAggregate>> {
  const aggregates = new Map<string, RepoAggregate>();

  // 每个 repo 的最近一条 run（窗口函数取 rn = 1），不在 JS 里扫全表。
  const lastRuns = await env.DB.prepare(
    "SELECT repo, created_at, state FROM (" +
      "SELECT repo, created_at, state, " +
      "ROW_NUMBER() OVER (PARTITION BY repo ORDER BY created_at DESC) AS rn " +
      "FROM runs WHERE installation_id = ?" +
      ") WHERE rn = 1",
  )
    .bind(installationId)
    .all<{ repo: string; created_at: string; state: string }>();

  for (const row of lastRuns.results ?? []) {
    const entry = ensureAggregate(aggregates, row.repo);
    entry.lastRunAt = row.created_at;
    entry.lastRunState = row.state;
  }

  // 节省量：SQL 侧求和，语义与 `savedBytes()` 一致（任一侧 NULL 记 0，不做 clamp）。
  const savings = await env.DB.prepare(
    "SELECT repo, " +
      "SUM(COALESCE(bytes_before, 0) - COALESCE(bytes_after, 0)) AS saved " +
      "FROM runs WHERE installation_id = ? GROUP BY repo",
  )
    .bind(installationId)
    .all<{ repo: string; saved: number | null }>();

  for (const row of savings.results ?? []) {
    ensureAggregate(aggregates, row.repo).totalSavedBytes =
      readNumber(row.saved) ?? 0;
  }

  const pulls = await env.DB.prepare(
    "SELECT repo, COUNT(*) AS pr_count FROM pulls " +
      "WHERE installation_id = ? GROUP BY repo",
  )
    .bind(installationId)
    .all<{ repo: string; pr_count: number }>();

  for (const row of pulls.results ?? []) {
    ensureAggregate(aggregates, row.repo).prCount =
      readNumber(row.pr_count) ?? 0;
  }

  const repos = await env.DB.prepare(
    "SELECT name, enabled FROM repos WHERE installation_id = ?",
  )
    .bind(installationId)
    .all<{ name: string; enabled: number | null }>();

  for (const row of repos.results ?? []) {
    ensureAggregate(aggregates, row.name).enabled = row.enabled !== 0;
  }

  // 分支覆盖（`settings.default_branch_override`，NULL/缺行 = 无覆盖）。
  const branchSettings = await env.DB.prepare(
    "SELECT repo, value FROM settings WHERE installation_id = ? AND key = ?",
  )
    .bind(installationId, SETTING_DEFAULT_BRANCH)
    .all<{ repo: string; value: string | null }>();

  for (const row of branchSettings.results ?? []) {
    ensureAggregate(aggregates, row.repo).defaultBranchOverride =
      typeof row.value === "string" && row.value.length > 0 ? row.value : null;
  }

  return aggregates;
}

function ensureAggregate(
  map: Map<string, RepoAggregate>,
  repo: string,
): RepoAggregate {
  let entry = map.get(repo);
  if (!entry) {
    // 缺省 = 启用（`repos` 行可能尚未写入）。
    entry = {
      lastRunAt: null,
      lastRunState: null,
      totalSavedBytes: 0,
      prCount: 0,
      enabled: true,
      defaultBranchOverride: null,
    };
    map.set(repo, entry);
  }
  return entry;
}

async function listRepos(
  env: Env,
  user: SessionUser,
  deps: ApiDeps,
): Promise<ReposApiEntry[]> {
  const installations = await listUserInstallations(user, deps);
  const entries: ReposApiEntry[] = [];

  for (const installation of installations) {
    const repos = await listInstallationRepos(user, installation.id, deps);
    const aggregates = await loadRepoAggregates(env, installation.id);

    for (const repo of repos) {
      const aggregate = aggregates.get(repo.fullName);
      entries.push({
        fullName: repo.fullName,
        isPrivate: repo.isPrivate,
        enabled: aggregate?.enabled ?? true,
        installationId: installation.id,
        lastRunAt: aggregate?.lastRunAt ?? null,
        lastRunState: aggregate?.lastRunState ?? null,
        totalSavedBytes: aggregate?.totalSavedBytes ?? 0,
        prCount: aggregate?.prCount ?? 0,
        defaultBranchOverride: aggregate?.defaultBranchOverride ?? null,
      });
    }
  }

  // 稳定输出（多 installation 之间也按全名排序），前端可少一次排序。
  entries.sort((a, b) => a.fullName.localeCompare(b.fullName));
  return entries;
}

/* -------------------------------------------------------------------------- */
/* POST /api/repos/{owner}/{name}/optimize                                     */
/* -------------------------------------------------------------------------- */

async function optimizeRepo(
  env: Env,
  user: SessionUser,
  owner: string,
  name: string,
  fullName: string,
  deps: ApiDeps,
): Promise<Response> {
  const access = await resolveRepoAccess(env, user, owner, name, deps);
  if ("forbidden" in access) {
    return jsonResponse({ error: "forbidden" }, 403);
  }
  // URL 段大小写可能与 GitHub 规范名不一致 → 后续锁键/D1/描述符一律用规范名（P1）。
  fullName = access.fullName;

  const desc: RunDescriptor = {
    run_id: crypto.randomUUID(),
    installation_id: access.installationId,
    repo: fullName,
    trigger: "manual",
    base_ref: "",
  };

  const stub = env.REPO_LOCK.getByName(
    `repo:${access.installationId}/${fullName}`,
  );
  const result = await stub.submit(desc);
  if (result.quotaExceeded) {
    return jsonResponse({ error: "quota_exceeded" }, 429);
  }

  return jsonResponse(
    {
      runId: desc.run_id,
      started: result.started,
      coalesced: result.coalesced,
    },
    202,
  );
}

/* -------------------------------------------------------------------------- */
/* POST /api/repos/{owner}/{name}/settings                                     */
/* -------------------------------------------------------------------------- */

interface SettingsPatch {
  enabled?: boolean;
  defaultBranchOverride?: string | null;
}

/** 只接受白名单键；类型不符 / 空对象 / 未知键 → null（400）。 */
function parseSettingsPatch(raw: unknown): SettingsPatch | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 0) return null;
  for (const key of keys) {
    if (key !== "enabled" && key !== "defaultBranchOverride") return null;
  }

  const patch: SettingsPatch = {};
  if ("enabled" in record) {
    if (typeof record.enabled !== "boolean") return null;
    patch.enabled = record.enabled;
  }
  if ("defaultBranchOverride" in record) {
    const value = record.defaultBranchOverride;
    if (value === null) {
      patch.defaultBranchOverride = null;
    } else if (typeof value === "string") {
      const trimmed = value.trim();
      // 空串 = 清除覆盖（与 null 同义）。
      patch.defaultBranchOverride = trimmed === "" ? null : trimmed;
    } else {
      return null;
    }
  }
  return patch;
}

async function updateSettings(
  env: Env,
  user: SessionUser,
  owner: string,
  name: string,
  fullName: string,
  request: Request,
  deps: ApiDeps,
): Promise<Response> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return jsonResponse({ error: "invalid_body" }, 400);
  }

  const patch = parseSettingsPatch(raw);
  if (!patch) return jsonResponse({ error: "invalid_body" }, 400);

  const access = await resolveRepoAccess(env, user, owner, name, deps);
  if ("forbidden" in access) {
    return jsonResponse({ error: "forbidden" }, 403);
  }
  // URL 段大小写可能与 GitHub 规范名不一致 → 后续锁键/D1/描述符一律用规范名（P1）。
  fullName = access.fullName;
  const installationId = access.installationId;

  if (patch.enabled !== undefined) {
    await env.DB.prepare(
      "INSERT INTO repos (installation_id, name, enabled) VALUES (?, ?, ?) " +
        "ON CONFLICT(installation_id, name) DO UPDATE SET enabled = excluded.enabled",
    )
      .bind(installationId, fullName, patch.enabled ? 1 : 0)
      .run();
  }

  if (patch.defaultBranchOverride !== undefined) {
    await env.DB.prepare(
      "INSERT INTO settings (installation_id, repo, key, value) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(installation_id, repo, key) DO UPDATE SET value = excluded.value",
    )
      .bind(
        installationId,
        fullName,
        SETTING_DEFAULT_BRANCH,
        patch.defaultBranchOverride,
      )
      .run();
  }

  const settings = await readRepoSettings(env, installationId, fullName);
  return jsonResponse(settings, 200);
}

async function readRepoSettings(
  env: Env,
  installationId: number,
  fullName: string,
): Promise<RepoSettings> {
  const enabledRow = await env.DB.prepare(
    "SELECT enabled FROM repos WHERE installation_id = ? AND name = ?",
  )
    .bind(installationId, fullName)
    .first<{ enabled: number | null }>();

  const settingRow = await env.DB.prepare(
    "SELECT value FROM settings WHERE installation_id = ? AND repo = ? AND key = ?",
  )
    .bind(installationId, fullName, SETTING_DEFAULT_BRANCH)
    .first<{ value: string | null }>();

  return {
    fullName,
    enabled: enabledRow ? enabledRow.enabled !== 0 : true,
    defaultBranchOverride: settingRow?.value ?? null,
  };
}

/* -------------------------------------------------------------------------- */
/* GET /api/repos/{owner}/{name}/stats                                         */
/* -------------------------------------------------------------------------- */

async function repoStats(
  env: Env,
  user: SessionUser,
  owner: string,
  name: string,
  fullName: string,
  deps: ApiDeps,
): Promise<Response> {
  const access = await resolveRepoAccess(env, user, owner, name, deps);
  if ("forbidden" in access) {
    return jsonResponse({ error: "forbidden" }, 403);
  }
  // URL 段大小写可能与 GitHub 规范名不一致 → 后续锁键/D1/描述符一律用规范名（P1）。
  fullName = access.fullName;
  const installationId = access.installationId;

  const totalsRow = await env.DB.prepare(
    "SELECT COUNT(*) AS run_count, " +
      "COALESCE(SUM(bytes_before), 0) AS bytes_before, " +
      "COALESCE(SUM(bytes_after), 0) AS bytes_after FROM runs " +
      "WHERE installation_id = ? AND repo = ?",
  )
    .bind(installationId, fullName)
    .first<{
      run_count: number | null;
      bytes_before: number | null;
      bytes_after: number | null;
    }>();

  const bytesBefore = readNumber(totalsRow?.bytes_before) ?? 0;
  const bytesAfter = readNumber(totalsRow?.bytes_after) ?? 0;

  const runRows = await env.DB.prepare(
    "SELECT run_id, state, trigger, images_optimized, bytes_before, bytes_after, " +
      "created_at, pr_number FROM runs WHERE installation_id = ? AND repo = ? " +
      "ORDER BY created_at DESC LIMIT ?",
  )
    .bind(installationId, fullName, RECENT_LIMIT)
    .all<{
      run_id: string;
      state: string;
      trigger: string;
      images_optimized: number | null;
      bytes_before: number | null;
      bytes_after: number | null;
      created_at: string;
      pr_number: number | null;
    }>();

  const pullRows = await env.DB.prepare(
    "SELECT pr_number, state, opened_at, closed_at FROM pulls " +
      "WHERE installation_id = ? AND repo = ? ORDER BY opened_at DESC LIMIT ?",
  )
    .bind(installationId, fullName, RECENT_LIMIT)
    .all<{
      pr_number: number;
      state: string | null;
      opened_at: string | null;
      closed_at: string | null;
    }>();

  const stats: RepoStats = {
    totals: {
      bytesBefore,
      bytesAfter,
      savedKb: toKb(bytesBefore - bytesAfter),
      runs: readNumber(totalsRow?.run_count) ?? 0,
    },
    recentRuns: (runRows.results ?? []).map((row) => ({
      runId: row.run_id,
      state: row.state,
      trigger: row.trigger,
      imagesOptimized: readNumber(row.images_optimized),
      savedKb: toKb(savedBytes(row.bytes_before, row.bytes_after)),
      createdAt: row.created_at,
      prNumber: readNumber(row.pr_number),
    })),
    pulls: (pullRows.results ?? []).map((row) => ({
      prNumber: row.pr_number,
      state: row.state ?? null,
      openedAt: row.opened_at ?? null,
      closedAt: row.closed_at ?? null,
    })),
  };

  return jsonResponse(stats, 200);
}

/* -------------------------------------------------------------------------- */
/* 小工具                                                                      */
/* -------------------------------------------------------------------------- */

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** 单条 run 的节省字节；任一侧缺失按 0（不把 NULL 当负数）。 */
function savedBytes(
  before: number | null | undefined,
  after: number | null | undefined,
): number {
  return (readNumber(before) ?? 0) - (readNumber(after) ?? 0);
}

/** KB 展示值（DESIGN.md §2.2：以 KB 为单位的 double，保留 1 位小数）。 */
function toKb(bytes: number): number {
  return Math.round((bytes / 1024) * 10) / 10;
}
