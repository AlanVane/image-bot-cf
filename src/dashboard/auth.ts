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
 *
 * Access token 生命周期（GitHub App 的 user token 8 小时过期）：
 * - 登录时把 `refresh_token` / `expires_in` 一并落库（`token_expires_at`）；
 * - `requireUser` 是唯一收口点：距到期 ≤ 5 分钟（或已过期）且有 refresh token
 *   就换新（refresh token 轮换后写回）；换不到就删行 → 前端回登录页。
 * - `SESSION_ENCRYPTION_KEY` 配置后，两个 token 均以 AES-GCM 密文落库
 *   （格式 `v1:<iv-b64>:<ct-b64>`）；未配置 = 明文开发模式。
 */

import type { FetchLike } from "../github/http";
import { githubRequest } from "../github/http";
import type { Env } from "../types";

/** 会话 cookie 名（固定，前端与 api.ts 都按它取）。 */
export const SESSION_COOKIE = "ib_session";
/** OAuth state 临时 cookie 名。 */
export const STATE_COOKIE = "ib_oauth_state";
/** 会话有效期：7 天。 */
export const SESSION_TTL_SEC = 60 * 60 * 24 * 7;
/** state 有效期：30 分钟（够走完 GitHub 登录页）。 */
export const STATE_TTL_SEC = 60 * 30;
/**
 * Access token 刷新窗口：剩余寿命 ≤ 5 分钟即换新。
 * 窗口放长于单次请求耗时，避免请求中途过期（GitHub 的 user token 仅 8 小时）。
 */
export const TOKEN_REFRESH_WINDOW_MS = 5 * 60 * 1000;

export const GITHUB_OAUTH_AUTHORIZE_URL =
  "https://github.com/login/oauth/authorize";
/** OAuth 端点与 api.github.com 是两个 host：传输层用 `base` 区分。 */
const GITHUB_OAUTH_BASE = "https://github.com";
const GITHUB_OAUTH_TOKEN_PATH = "/login/oauth/access_token";
export const GITHUB_OAUTH_TOKEN_URL = `${GITHUB_OAUTH_BASE}${GITHUB_OAUTH_TOKEN_PATH}`;
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

const SESSION_COLUMNS =
  "user_login, user_id, user_token, refresh_token, token_expires_at, expires_at";
const SELECT_SESSION_SQL = `SELECT ${SESSION_COLUMNS} FROM sessions WHERE session_id = ?`;
const DELETE_SESSION_SQL = "DELETE FROM sessions WHERE session_id = ?";
const INSERT_SESSION_SQL =
  "INSERT INTO sessions (session_id, user_login, user_id, user_token, refresh_token, token_expires_at, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)";
const UPDATE_SESSION_SQL =
  "UPDATE sessions SET user_token = ?, refresh_token = ?, token_expires_at = ? WHERE session_id = ?";

interface SessionRow {
  user_login?: unknown;
  user_id?: unknown;
  user_token?: unknown;
  refresh_token?: unknown;
  token_expires_at?: unknown;
  expires_at?: unknown;
}

/** 刷新网络失败的重试次数（含首次）；HTTP 4xx/5xx 不做重试。 */
const REFRESH_MAX_ATTEMPTS = 2;

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

  const now = nowMs(deps);
  const login = typeof row.user_login === "string" ? row.user_login : "";
  const expiresAt =
    typeof row.expires_at === "string" ? Date.parse(row.expires_at) : NaN;

  // 过期 / 脏数据：顺手删掉这一行，避免每次请求都命中。
  const expired = !Number.isFinite(expiresAt) || expiresAt <= now;
  if (expired || !login) {
    await deleteSessionRow(env, sessionId);
    return null;
  }

  // 落库值可能是 AES-GCM 密文（v1:）；解不开 = 行不可用（含"配了 key 却读到
  // 无 key 时写入的密文"这种不可恢复状态）→ 删行让前端重新登录。
  const key = await sessionKey(env);
  const token = await openSecret(
    key,
    typeof row.user_token === "string" ? row.user_token : "",
  );
  if (!token) {
    await deleteSessionRow(env, sessionId);
    return null;
  }

  const userId =
    typeof row.user_id === "number" && Number.isFinite(row.user_id)
      ? row.user_id
      : null;
  const storedRefreshToken =
    typeof row.refresh_token === "string" ? row.refresh_token : "";
  const tokenExpiresAt =
    typeof row.token_expires_at === "string"
      ? Date.parse(row.token_expires_at)
      : NaN;

  // 无 token_expires_at / refresh_token 的旧行照旧可用（不刷新，靠上游 401 收口）。
  const refreshDue =
    storedRefreshToken !== "" &&
    Number.isFinite(tokenExpiresAt) &&
    tokenExpiresAt - now <= TOKEN_REFRESH_WINDOW_MS;
  if (!refreshDue) return { login, userId, token };

  const refreshToken = await openSecret(key, storedRefreshToken);
  if (!refreshToken) {
    await deleteSessionRow(env, sessionId);
    return null;
  }

  const fetchImpl =
    deps.fetchImpl ?? (globalThis.fetch as FetchLike | undefined);
  const clientId = (env.GITHUB_CLIENT_ID ?? "").trim();
  const clientSecret = (env.GITHUB_CLIENT_SECRET ?? "").trim();
  const refreshed =
    typeof fetchImpl === "function" && clientId && clientSecret
      ? await refreshAccessToken({
          fetchImpl,
          clientId,
          clientSecret,
          refreshToken,
          now,
        })
      : null;
  if (!refreshed) {
    // 刷新失败（400/401/网络）= 会话已不可用：删行，前端翻回登录页。
    await deleteSessionRow(env, sessionId);
    return null;
  }

  // GitHub 会轮换 refresh token：响应里给了就用新的，没给就沿用旧的。
  // 顺带把明文旧行升级为密文（key 配了就会加密写回）。
  const nextRefreshToken = refreshed.refreshToken ?? refreshToken;
  await env.DB.prepare(UPDATE_SESSION_SQL)
    .bind(
      await sealSecret(key, refreshed.accessToken),
      await sealSecret(key, nextRefreshToken),
      refreshed.tokenExpiresAt,
      sessionId,
    )
    .run();

  return { login, userId, token: refreshed.accessToken };
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

  let exchanged: ExchangedToken;
  try {
    exchanged = await exchangeCode({
      fetchImpl,
      clientId,
      clientSecret,
      code,
      redirectUri,
      now,
    });
  } catch (error) {
    return text(describeError("GitHub token exchange failed", error), 400, {
      "set-cookie": clearState,
    });
  }

  let profile: { login: string; userId: number | null };
  try {
    profile = await fetchUserProfile(fetchImpl, exchanged.accessToken);
  } catch (error) {
    return text(describeError("GitHub user lookup failed", error), 502, {
      "set-cookie": clearState,
    });
  }

  const sessionId = crypto.randomUUID();
  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(now + SESSION_TTL_SEC * 1000).toISOString();

  try {
    const key = await sessionKey(env);
    await env.DB.prepare(INSERT_SESSION_SQL)
      .bind(
        sessionId,
        profile.login,
        profile.userId,
        await sealSecret(key, exchanged.accessToken),
        exchanged.refreshToken
          ? await sealSecret(key, exchanged.refreshToken)
          : null,
        exchanged.tokenExpiresAt,
        createdAt,
        expiresAt,
      )
      .run();
  } catch (error) {
    return text(describeError("session storage failed", error), 500, {
      "set-cookie": clearState,
    });
  }

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
  /** 计算 `token_expires_at` 用（注入时钟，测试可固定）。 */
  now: number;
}

/** `/login/oauth/access_token` 的解析结果（GitHub 可能不发 refresh/expires_in）。 */
export interface ExchangedToken {
  accessToken: string;
  /** 轮换用 refresh token；GitHub 未启用过期 token 时缺省。 */
  refreshToken: string | null;
  /** access token 到期时间（ISO）；缺 `expires_in` 时 null = 不主动刷新。 */
  tokenExpiresAt: string | null;
}

async function exchangeCode(args: ExchangeArgs): Promise<ExchangedToken> {
  // 裸调用由传输层保证（绝不 `args.fetchImpl(...)` 成员调用——2026-11-17 真仓
  // OAuth 实测：workerd 原生 fetch 的 WebIDL `this` 检查会抛 Illegal invocation）。
  const fetchImpl = args.fetchImpl;
  const res = await githubRequest({
    path: GITHUB_OAUTH_TOKEN_PATH,
    base: GITHUB_OAUTH_BASE,
    accept: "application/json",
    fetchImpl,
    init: {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_id: args.clientId,
        client_secret: args.clientSecret,
        code: args.code,
        redirect_uri: args.redirectUri,
      }),
    },
  });

  const raw = res.text ?? "";
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
  return {
    accessToken,
    refreshToken: readString(body.refresh_token),
    tokenExpiresAt: tokenExpiresAtFromBody(body, args.now),
  };
}

/**
 * 用 refresh token 换新的 access token（GitHub Apps user token 轮换）。
 *
 * 失败语义 = `null`（调用方删会话）：HTTP 4xx/5xx 不重试，网络异常最多尝试
 * `REFRESH_MAX_ATTEMPTS` 次（"network twice"）。
 */
async function refreshAccessToken(args: {
  fetchImpl: FetchLike;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  now: number;
}): Promise<ExchangedToken | null> {
  // 同上：裸调用由传输层保证，绝不 `args.fetchImpl(...)`。
  const fetchImpl = args.fetchImpl;

  for (let attempt = 0; attempt < REFRESH_MAX_ATTEMPTS; attempt += 1) {
    let res: Awaited<ReturnType<typeof githubRequest>>;
    try {
      res = await githubRequest({
        path: GITHUB_OAUTH_TOKEN_PATH,
        base: GITHUB_OAUTH_BASE,
        accept: "application/json",
        fetchImpl,
        init: {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            client_id: args.clientId,
            client_secret: args.clientSecret,
            grant_type: "refresh_token",
            refresh_token: args.refreshToken,
          }),
        },
      });
    } catch (error) {
      console.error(
        `dashboard auth: token refresh network failure (attempt ${attempt + 1})`,
        error,
      );
      continue;
    }

    const raw = res.text ?? "";
    if (!res.ok) {
      // 400/401 = refresh token 失效/被撤销；5xx 也不值得重试（换下次请求再说
      // 也没意义——会话已经没有可用 token）。
      console.error(
        `dashboard auth: token refresh rejected`,
        res.status,
        raw.slice(0, 200),
      );
      return null;
    }

    let body: Record<string, unknown> = {};
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === "object") {
          body = parsed as Record<string, unknown>;
        }
      } catch {
        return null;
      }
    }
    if (typeof body.error === "string" && body.error) return null;

    const accessToken = readString(body.access_token);
    if (!accessToken) return null;
    return {
      accessToken,
      refreshToken: readString(body.refresh_token),
      tokenExpiresAt: tokenExpiresAtFromBody(body, args.now),
    };
  }

  return null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** `expires_in`（秒，GitHub 偶尔给字符串）→ 绝对 ISO 时间；缺省 null。 */
function tokenExpiresAtFromBody(
  body: Record<string, unknown>,
  now: number,
): string | null {
  const raw = body.expires_in;
  const seconds =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && raw.trim() !== ""
        ? Number(raw)
        : NaN;
  return Number.isFinite(seconds) && seconds > 0
    ? new Date(now + seconds * 1000).toISOString()
    : null;
}

async function fetchUserProfile(
  fetchImpl: FetchLike,
  token: string,
): Promise<{ login: string; userId: number | null }> {
  const res = await githubRequest({ token, path: "/user", fetchImpl });

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }

  const body = (res.body ?? {}) as { login?: unknown; id?: unknown };
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
// 静态加密（AES-256-GCM）
// ---------------------------------------------------------------------------

/** 密文格式版本前缀；解不开/无 key 一律视为不可用。 */
const SECRET_PREFIX = "v1:";
const AES_GCM_IV_BYTES = 12;
const AES_KEY_BYTES = 32;

/** CryptoKey 导入缓存（key 字符串 → 已导入句柄；同进程内避免每次请求重导）。 */
const importedKeys = new Map<string, Promise<CryptoKey | null>>();

/**
 * `SESSION_ENCRYPTION_KEY` → CryptoKey；未配置 → null（明文开发模式）。
 * 配了但格式不对 → 抛错（写路径必须响，绝不"以为加密了其实明文"）。
 */
async function sessionKey(env: Env): Promise<CryptoKey | null> {
  const raw = (env.SESSION_ENCRYPTION_KEY ?? "").trim();
  if (!raw) return null;
  const key = await importSecretKey(raw);
  if (!key) {
    throw new Error(
      "SESSION_ENCRYPTION_KEY is invalid: expected base64 of 32 random bytes",
    );
  }
  return key;
}

/** base64(32 bytes) → AES-GCM CryptoKey；非法 base64 / 长度不符 → null。 */
export function importSecretKey(base64Key: string): Promise<CryptoKey | null> {
  let pending = importedKeys.get(base64Key);
  if (!pending) {
    pending = importSecretKeyUncached(base64Key);
    importedKeys.set(base64Key, pending);
  }
  return pending;
}

async function importSecretKeyUncached(
  base64Key: string,
): Promise<CryptoKey | null> {
  const bytes = base64ToBytes(base64Key.trim());
  if (!bytes || bytes.byteLength !== AES_KEY_BYTES) return null;
  try {
    return await crypto.subtle.importKey(
      "raw",
      bytes,
      { name: "AES-GCM" },
      false,
      ["encrypt", "decrypt"],
    );
  } catch {
    return null;
  }
}

/**
 * 加密单个 secret：`v1:<iv-b64>:<ct-b64>`（每次调用随机 12 字节 IV）。
 * key 非法时抛错（见 `sessionKey`）。
 */
export async function encryptSecret(
  base64Key: string,
  plaintext: string,
): Promise<string> {
  const key = await importSecretKey(base64Key);
  if (!key) {
    throw new Error(
      "SESSION_ENCRYPTION_KEY is invalid: expected base64 of 32 random bytes",
    );
  }
  return encryptSecretWithKey(key, plaintext);
}

/** 解密 `v1:` 密文；格式不符 / key 不可用 / 校验失败 → null（绝不抛）。 */
export async function decryptSecret(
  base64Key: string,
  value: string,
): Promise<string | null> {
  try {
    const key = await importSecretKey(base64Key);
    if (!key) return null;
    return await decryptSecretWithKey(key, value);
  } catch {
    return null;
  }
}

function isEncryptedSecret(value: string): boolean {
  return value.startsWith(SECRET_PREFIX);
}

/** 读出可用的明文 token：明文照旧，密文解密；不可用 → null。 */
async function openSecret(
  key: CryptoKey | null,
  value: string,
): Promise<string | null> {
  if (!value) return null;
  if (!isEncryptedSecret(value)) return value; // 旧明文行 / 无 key 开发模式
  if (!key) return null; // 配了 key 才能读密文（缺 key = 行不可用）
  return decryptSecretWithKey(key, value);
}

/** 落库前的加密包装：无 key → 原样存（开发模式），有 key → 密文。 */
async function sealSecret(
  key: CryptoKey | null,
  value: string,
): Promise<string> {
  if (!key) return value;
  return encryptSecretWithKey(key, value);
}

async function encryptSecretWithKey(
  key: CryptoKey,
  plaintext: string,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plaintext),
  );
  return `${SECRET_PREFIX}${bytesToBase64(iv)}:${bytesToBase64(
    new Uint8Array(ciphertext),
  )}`;
}

async function decryptSecretWithKey(
  key: CryptoKey,
  value: string,
): Promise<string | null> {
  const parts = value.split(":");
  if (parts.length !== 3 || `${parts[0]}:` !== SECRET_PREFIX) return null;
  const iv = base64ToBytes(parts[1]);
  const ciphertext = base64ToBytes(parts[2]);
  if (!iv || !ciphertext || iv.byteLength !== AES_GCM_IV_BYTES) return null;
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      ciphertext,
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    return null;
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array | null {
  try {
    const binary = atob(value);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      out[i] = binary.charCodeAt(i);
    }
    return out;
  } catch {
    return null;
  }
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
