/**
 * 仪表盘 GitHub OAuth（DESIGN.md §10 P3，对应原版 `Auth/`）。
 *
 * 两条职责，互相独立：
 * 1. `handleAuthRoute` —— OAuth 三端点：`/api/auth/{login,callback,logout}`。
 * 2. `requireUser`     —— 从 `ib_session` cookie 还原会话（api.ts 的守卫）。
 *
 * 契约（被 `api.ts` 消费，签名不可变）：
 * ```ts
 * requireUser(env, request): Promise<SessionUser | null>
 * handleAuthRoute(env, request, url): Promise<Response | null>
 * ```
 * 网络调用与时钟通过 `createAuthHandlers({ fetchImpl, now })` 注入（测试用）；
 * 直接调用上面的两个函数走 `globalThis.fetch` / `Date.now`，行为一致。
 *
 * 安全要点：
 * - cookie 只带 `session_id`，GitHub access token 仅存服务端 `sessions` 表；
 * - CSRF：随机 `state` 双提交（cookie + query），一次一用，回调即清；
 * - cookie 一律 `HttpOnly; Secure; SameSite=Lax`；会话 7 天，state 30 分钟；
 * - 过期行在 `requireUser` 命中时顺手删除，避免表无限增长。
 */

import type { FetchLike } from "../github/gitdata";
import { GITHUB_API_BASE, GITHUB_API_VERSION } from "../github/gitdata";
import type { Env } from "../types";

/** 会话 cookie 名（固定，前端与 api.ts 都按它取）。 */
export const SESSION_COOKIE = "ib_session";
/** OAuth state 临时 cookie 名。 */
export const STATE_COOKIE = "ib_oauth_state";
/** 会话有效期：7 天。 */
export const SESSION_TTL_SEC = 60 * 60 * 24 * 7;
/** state 有效期：30 分钟（够走完 GitHub 登录页）。 */
export const STATE_TTL_SEC = 60 * 30;

export const GITHUB_OAUTH_AUTHORIZE_URL =
  "https://github.com/login/oauth/authorize";
export const GITHUB_OAUTH_TOKEN_URL =
  "https://github.com/login/oauth/access_token";
export const AUTH_CALLBACK_PATH = "/api/auth/callback";
export const AUTH_PREFIX = "/api/auth";

/** 校验通过的会话用户；`token` 是 GitHub 用户 access token。 */
export interface SessionUser {
  login: string;
  userId: number | null;
  token: string;
}

/** 可注入依赖（仅测试使用；生产走全局 fetch / Date.now）。 */
export interface AuthDeps {
  fetchImpl?: FetchLike;
  now?: () => number;
}

/** 两个公共入口的工厂形态：同一份实现，带上注入依赖。 */ export interface AuthHandlers {
  requireUser(env: Env, request: Request): Promise<SessionUser | null>;
  handleAuthRoute(
    env: Env,
    request: Request,
    url: URL,
  ): Promise<Response | null>;
}

const SESSION_COLUMNS = "user_login, user_id, user_token, expires_at";
const SELECT_SESSION_SQL = `SELECT ${SESSION_COLUMNS} FROM sessions WHERE session_id = ?`;
const DELETE_SESSION_SQL = "DELETE FROM sessions WHERE session_id = ?";
const INSERT_SESSION_SQL =
  "INSERT INTO sessions (session_id, user_login, user_id, user_token, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)";

interface SessionRow {
  user_login?: unknown;
  user_id?: unknown;
  user_token?: unknown;
  expires_at?: unknown;
}

const MISSING_CREDENTIALS_MESSAGE =
  "GitHub OAuth credentials are missing or invalid: configure GITHUB_CLIENT_ID/SECRET " +
  "from the GitHub App's OAuth credentials (Settings → Developer settings → GitHub Apps).";

// ---------------------------------------------------------------------------
// 公共入口（签名钉死）
// ---------------------------------------------------------------------------

/** 从 Cookie 取会话并校验（过期/不存在 → null，并顺手清过期行）。 */
export function requireUser(
  env: Env,
  request: Request,
): Promise<SessionUser | null> {
  return requireUserWith(env, request, {});
}

/** auth 路由分派：/api/auth/{login,callback,logout}，非本前缀返回 null 交上游。 */
export function handleAuthRoute(
  env: Env,
  request: Request,
  url: URL,
): Promise<Response | null> {
  return handleAuthRouteWith(env, request, url, {});
}

/** 从请求 Cookie 头取会话 id（无 cookie → null）；api.ts 处理上游 401 时用。 */
export function sessionIdFromRequest(request: Request): string | null {
  return parseCookies(request.headers.get("cookie"))[SESSION_COOKIE] ?? null;
}

/** 删除一条会话（上游 401 = token 过期/被撤销，会话不再可用）。 */
export async function clearSession(env: Env, sessionId: string): Promise<void> {
  await deleteSessionRow(env, sessionId);
}

/** 注入版工厂（测试用；等价于直接调用上面两个函数 + 替换 fetch/时钟）。 */
export function createAuthHandlers(deps: AuthDeps = {}): AuthHandlers {
  return {
    requireUser: (env, request) => requireUserWith(env, request, deps),
    handleAuthRoute: (env, request, url) =>
      handleAuthRouteWith(env, request, url, deps),
  };
}

// ---------------------------------------------------------------------------
// requireUser
// ---------------------------------------------------------------------------

async function requireUserWith(
  env: Env,
  request: Request,
  deps: AuthDeps,
): Promise<SessionUser | null> {
  const cookies = parseCookies(request.headers.get("cookie"));
  const sessionId = cookies[SESSION_COOKIE];
  if (!sessionId) return null;

  const row = await env.DB.prepare(SELECT_SESSION_SQL)
    .bind(sessionId)
    .first<SessionRow>();
  if (!row) return null;

  const login = typeof row.user_login === "string" ? row.user_login : "";
  const token = typeof row.user_token === "string" ? row.user_token : "";
  const expiresAt =
    typeof row.expires_at === "string" ? Date.parse(row.expires_at) : NaN;

  // 过期 / 脏数据：顺手删掉这一行，避免每次请求都命中。
  const expired = !Number.isFinite(expiresAt) || expiresAt <= nowMs(deps);
  if (expired || !login || !token) {
    await deleteSessionRow(env, sessionId);
    return null;
  }

  return {
    login,
    userId:
      typeof row.user_id === "number" && Number.isFinite(row.user_id)
        ? row.user_id
        : null,
    token,
  };
}

async function deleteSessionRow(env: Env, sessionId: string): Promise<void> {
  await env.DB.prepare(DELETE_SESSION_SQL).bind(sessionId).run();
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

async function handleAuthRouteWith(
  env: Env,
  request: Request,
  url: URL,
  deps: AuthDeps,
): Promise<Response | null> {
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (path === `${AUTH_PREFIX}/login`) {
    if (request.method !== "GET") return methodNotAllowed("GET");
    return handleLogin(env, url);
  }
  if (path === AUTH_CALLBACK_PATH) {
    if (request.method !== "GET") return methodNotAllowed("GET");
    return handleCallback(env, request, url, deps);
  }
  if (path === `${AUTH_PREFIX}/logout`) {
    if (request.method !== "POST") return methodNotAllowed("POST");
    return handleLogout(env, request);
  }

  // `/api/auth`、`/api/auth/` 归本模块（404），其余前缀交上游。
  if (path === AUTH_PREFIX) return text("not found", 404);
  if (path.startsWith(`${AUTH_PREFIX}/`)) return text("not found", 404);
  return null;
}

function handleLogin(env: Env, url: URL): Response {
  const clientId = (env.GITHUB_CLIENT_ID ?? "").trim();
  if (!clientId || !(env.GITHUB_CLIENT_SECRET ?? "").trim()) {
    return text(MISSING_CREDENTIALS_MESSAGE, 500);
  }

  const state = randomState();
  const authorize = new URL(GITHUB_OAUTH_AUTHORIZE_URL);
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("redirect_uri", callbackUri(env, url));
  authorize.searchParams.set("state", state);

  const headers = new Headers({
    location: authorize.toString(),
    "cache-control": "no-store",
  });
  headers.append(
    "set-cookie",
    buildCookie(STATE_COOKIE, state, {
      maxAge: STATE_TTL_SEC,
      path: AUTH_PREFIX,
    }),
  );

  return new Response(null, { status: 302, headers });
}

async function handleCallback(
  env: Env,
  request: Request,
  url: URL,
  deps: AuthDeps,
): Promise<Response> {
  const cookies = parseCookies(request.headers.get("cookie"));
  const expectedState = cookies[STATE_COOKIE];
  const state = url.searchParams.get("state");

  // 失败路径统一清掉 state，避免脏 cookie 反复触发。
  const clearState = buildCookie(STATE_COOKIE, "", {
    maxAge: 0,
    path: AUTH_PREFIX,
  });

  if (!state || !expectedState || state !== expectedState) {
    return text(
      "OAuth state mismatch (possible CSRF); restart the sign-in flow.",
      400,
      {
        "set-cookie": clearState,
      },
    );
  }

  const code = url.searchParams.get("code");
  if (!code) {
    return text("OAuth callback is missing `code`.", 400, {
      "set-cookie": clearState,
    });
  }

  const clientId = (env.GITHUB_CLIENT_ID ?? "").trim();
  const clientSecret = (env.GITHUB_CLIENT_SECRET ?? "").trim();
  if (!clientId || !clientSecret) {
    return text(MISSING_CREDENTIALS_MESSAGE, 500, {
      "set-cookie": clearState,
    });
  }

  const fetchImpl =
    deps.fetchImpl ?? (globalThis.fetch as FetchLike | undefined);
  if (typeof fetchImpl !== "function") {
    return text("OAuth callback requires a fetch implementation.", 500, {
      "set-cookie": clearState,
    });
  }

  const now = nowMs(deps);
  const redirectUri = callbackUri(env, url);

  let token: string;
  try {
    token = await exchangeCode({
      fetchImpl,
      clientId,
      clientSecret,
      code,
      redirectUri,
    });
  } catch (error) {
    return text(describeError("GitHub token exchange failed", error), 400, {
      "set-cookie": clearState,
    });
  }

  let profile: { login: string; userId: number | null };
  try {
    profile = await fetchUserProfile(fetchImpl, token);
  } catch (error) {
    return text(describeError("GitHub user lookup failed", error), 502, {
      "set-cookie": clearState,
    });
  }

  const sessionId = crypto.randomUUID();
  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(now + SESSION_TTL_SEC * 1000).toISOString();

  await env.DB.prepare(INSERT_SESSION_SQL)
    .bind(sessionId, profile.login, profile.userId, token, createdAt, expiresAt)
    .run();

  const headers = new Headers({ location: "/", "cache-control": "no-store" });
  headers.append(
    "set-cookie",
    buildCookie(SESSION_COOKIE, sessionId, {
      maxAge: SESSION_TTL_SEC,
      path: "/",
    }),
  );
  headers.append("set-cookie", clearState);

  return new Response(null, { status: 302, headers });
}

async function handleLogout(env: Env, request: Request): Promise<Response> {
  const cookies = parseCookies(request.headers.get("cookie"));
  const sessionId = cookies[SESSION_COOKIE];
  if (sessionId) await deleteSessionRow(env, sessionId);

  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  headers.append(
    "set-cookie",
    buildCookie(SESSION_COOKIE, "", { maxAge: 0, path: "/" }),
  );

  return new Response(JSON.stringify({ ok: true }), { status: 202, headers });
}

// ---------------------------------------------------------------------------
// GitHub OAuth 调用
// ---------------------------------------------------------------------------

interface ExchangeArgs {
  fetchImpl: FetchLike;
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}

async function exchangeCode(args: ExchangeArgs): Promise<string> {
  // ⚠️ workerd 陷阱（同 gitdata.ts）：必须裸调用——`args.fetchImpl(...)` 是成员调用，
  // 原生 fetch 的 WebIDL `this` 检查会抛 Illegal invocation（测试 mock 是普通
  // 函数所以测不出来；2026-11-17 真仓 OAuth 实测踩坑）。
  const fetchImpl = args.fetchImpl;
  const res = await fetchImpl(GITHUB_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": "image-bot-cf",
    },
    body: JSON.stringify({
      client_id: args.clientId,
      client_secret: args.clientSecret,
      code: args.code,
      redirect_uri: args.redirectUri,
    }),
  });

  const raw = await res.text();
  let body: Record<string, unknown> = {};
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object") {
        body = parsed as Record<string, unknown>;
      }
    } catch {
      // GitHub 在 `Accept: application/json` 下必返 JSON；非 JSON 视为失败。
      throw new Error(`HTTP ${res.status}: ${raw.slice(0, 200)}`);
    }
  }

  if (!res.ok) {
    const detail =
      typeof body.error_description === "string"
        ? body.error_description
        : typeof body.error === "string"
          ? body.error
          : raw.slice(0, 200);
    throw new Error(`HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
  }
  if (typeof body.error === "string" && body.error) {
    const detail =
      typeof body.error_description === "string" && body.error_description
        ? `: ${body.error_description}`
        : "";
    throw new Error(`${body.error}${detail}`);
  }

  const accessToken = body.access_token;
  if (typeof accessToken !== "string" || !accessToken) {
    throw new Error("response is missing `access_token`");
  }
  return accessToken;
}

async function fetchUserProfile(
  fetchImpl: FetchLike,
  token: string,
): Promise<{ login: string; userId: number | null }> {
  const res = await fetchImpl(`${GITHUB_API_BASE}/user`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": GITHUB_API_VERSION,
      "user-agent": "image-bot-cf",
    },
  });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }

  const body = (await res.json()) as { login?: unknown; id?: unknown };
  if (typeof body.login !== "string" || !body.login) {
    throw new Error("response is missing `login`");
  }

  return {
    login: body.login,
    userId:
      typeof body.id === "number" && Number.isFinite(body.id) ? body.id : null,
  };
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function nowMs(deps: AuthDeps): number {
  return deps.now ? deps.now() : Date.now();
}

/**
 * OAuth `redirect_uri`：配了 `PUBLIC_BASE_URL` 就钉死到它（防 Host 头注入 /
 * 多域名漂移——GitHub 只认 App 里登记的回调），否则沿用请求 origin。
 */
function callbackUri(env: Env, url: URL): string {
  const base = (env.PUBLIC_BASE_URL ?? "").trim().replace(/\/+$/, "");
  return base
    ? `${base}${AUTH_CALLBACK_PATH}`
    : `${url.origin}${AUTH_CALLBACK_PATH}`;
}

function randomState(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

interface CookieOptions {
  maxAge: number;
  path: string;
}

/** 统一的 cookie 属性；`Secure` 在 http://localhost 上也照发（CF 生产恒 HTTPS）。 */
function buildCookie(name: string, value: string, opts: CookieOptions): string {
  return [
    `${name}=${value}`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Path=${opts.path}`,
    `Max-Age=${opts.maxAge}`,
  ].join("; ");
}

/** 容错解析 Cookie 头：缺头/畸形片段一律跳过，绝不抛。 */
function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;

  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name || name in out) continue;

    let value = part.slice(eq + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1);
    }
    try {
      value = decodeURIComponent(value);
    } catch {
      // 非法百分号转义：保留原文（session id 是 UUID，不依赖解码）。
    }
    out[name] = value;
  }
  return out;
}

function methodNotAllowed(allow: string): Response {
  return text("method not allowed", 405, { allow });
}

function text(
  body: string,
  status: number,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

function describeError(prefix: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `${prefix}: ${detail}`;
}
