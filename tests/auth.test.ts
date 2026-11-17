/**
 * 仪表盘 OAuth / 会话测试（DESIGN.md §10 P3，对应原版 `Auth/`）。
 *
 * 覆盖：login 的 state 生成与 authorize 跳转、callback 的 CSRF 校验与
 * token→user→session 全链路、cookie 属性、requireUser 命中/过期/缺 cookie、
 * logout 删行清 cookie、凭据缺失的可操作报错、非本前缀放行。
 *
 * 依赖全部手写：内存 D1（只实现 sessions 的三条语句）+ 可注入 fetch。
 */
import { describe, expect, it } from "vitest";

import {
  AUTH_CALLBACK_PATH,
  SESSION_COOKIE,
  SESSION_TTL_SEC,
  STATE_COOKIE,
  STATE_TTL_SEC,
  createAuthHandlers,
  handleAuthRoute,
  requireUser,
} from "../src/dashboard/auth";
import type { AuthDeps } from "../src/dashboard/auth";
import type { Env } from "../src/types";

const ORIGIN = "https://dash.example.com";
const CLIENT_ID = "Iv1.test-client-id";
const CLIENT_SECRET = "test-client-secret";
const FIXED_NOW = Date.UTC(2026, 0, 1, 12, 0, 0);

// ---------------------------------------------------------------------------
// 内存 D1（sessions 表）
// ---------------------------------------------------------------------------

interface SessionRecord {
  session_id: string;
  user_login: string;
  user_id: number | null;
  user_token: string;
  created_at: string;
  expires_at: string;
}

interface DbHarness {
  db: D1Database;
  rows: Map<string, SessionRecord>;
  statements: string[];
}

function createDb(): DbHarness {
  const rows = new Map<string, SessionRecord>();
  const statements: string[] = [];

  const db = {
    prepare(sql: string) {
      statements.push(sql);
      return {
        bind(...params: unknown[]) {
          return {
            async run() {
              if (sql.includes("INSERT INTO sessions")) {
                const [
                  session_id,
                  user_login,
                  user_id,
                  user_token,
                  created_at,
                  expires_at,
                ] = params as [
                  string,
                  string,
                  number | null,
                  string,
                  string,
                  string,
                ];
                if (rows.has(session_id)) {
                  return { success: true, meta: { changes: 0 } };
                }
                rows.set(session_id, {
                  session_id,
                  user_login,
                  user_id,
                  user_token,
                  created_at,
                  expires_at,
                });
                return { success: true, meta: { changes: 1 } };
              }
              if (sql.includes("DELETE FROM sessions")) {
                const removed = rows.delete(String(params[0]));
                return { success: true, meta: { changes: removed ? 1 : 0 } };
              }
              throw new Error(`unexpected run() SQL in test: ${sql}`);
            },
            async first<T>() {
              if (!sql.includes("FROM sessions")) {
                throw new Error(`unexpected first() SQL in test: ${sql}`);
              }
              const row = rows.get(String(params[0]));
              if (!row) return null;
              return {
                user_login: row.user_login,
                user_id: row.user_id,
                user_token: row.user_token,
                expires_at: row.expires_at,
              } as T;
            },
          };
        },
      };
    },
  };

  return { db: db as unknown as D1Database, rows, statements };
}

function createEnv(db: D1Database, overrides: Partial<Env> = {}): Env {
  return {
    DB: db,
    GITHUB_CLIENT_ID: CLIENT_ID,
    GITHUB_CLIENT_SECRET: CLIENT_SECRET,
    ...overrides,
  } as unknown as Env;
}

function seedSession(
  h: DbHarness,
  overrides: Partial<SessionRecord> = {},
): SessionRecord {
  // 默认相对墙钟取未来 7 天：requireUser 走真实 Date.now，固定时间会过期。
  const row: SessionRecord = {
    session_id: "session-1",
    user_login: "octocat",
    user_id: 583231,
    user_token: "gho_seeded",
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + SESSION_TTL_SEC * 1000).toISOString(),
    ...overrides,
  };
  h.rows.set(row.session_id, row);
  return row;
}

// ---------------------------------------------------------------------------
// fetch mock
// ---------------------------------------------------------------------------

interface FetchCall {
  url: string;
  init?: RequestInit;
}

interface FetchHarness {
  fetchImpl: AuthDeps["fetchImpl"];
  calls: FetchCall[];
}

function createFetch(
  handler: (call: FetchCall) => Response | Promise<Response>,
): FetchHarness {
  const calls: FetchCall[] = [];
  const fetchImpl = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const call = { url, init };
    calls.push(call);
    return handler(call);
  };
  return { fetchImpl, calls };
}

/** 成功链：token 交换 → /user。 */
function successFetch(
  body: {
    accessToken?: string;
    login?: string;
    userId?: number | null;
  } = {},
): FetchHarness {
  return createFetch((call) => {
    if (call.url.startsWith("https://github.com/login/oauth/access_token")) {
      return jsonResponse({
        access_token: body.accessToken ?? "gho_live_token",
        token_type: "bearer",
        scope: "",
      });
    }
    if (call.url === "https://api.github.com/user") {
      return jsonResponse({
        login: body.login ?? "octocat",
        id: body.userId === undefined ? 583231 : body.userId,
      });
    }
    throw new Error(`unexpected fetch: ${call.url}`);
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function setCookies(res: Response): string[] {
  const headers = res.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof headers.getSetCookie === "function") return headers.getSetCookie();
  const raw = res.headers.get("set-cookie");
  return raw ? [raw] : [];
}

function findCookie(res: Response, name: string): string | undefined {
  return setCookies(res).find((cookie) => cookie.startsWith(`${name}=`));
}

function cookieHeader(...cookies: Array<[string, string]>): string {
  return cookies.map(([name, value]) => `${name}=${value}`).join("; ");
}

function loginUrl(): string {
  return `${ORIGIN}/api/auth/login`;
}

function callbackUrl(params: Record<string, string>): string {
  const url = new URL(`${ORIGIN}${AUTH_CALLBACK_PATH}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

function authRoute(
  env: Env,
  request: Request,
  deps: AuthDeps,
): Promise<Response | null> {
  return createAuthHandlers(deps).handleAuthRoute(
    env,
    request,
    new URL(request.url),
  );
}

// ---------------------------------------------------------------------------
// /api/auth/login
// ---------------------------------------------------------------------------

describe("GET /api/auth/login", () => {
  it("302 到 GitHub authorize，state 同时进 query 与临时 cookie", async () => {
    const h = createDb();
    const env = createEnv(h.db);

    const res = await handleAuthRoute(
      env,
      new Request(loginUrl()),
      new URL(loginUrl()),
    );

    expect(res).not.toBeNull();
    expect(res!.status).toBe(302);

    const location = new URL(res!.headers.get("location")!);
    expect(location.origin + location.pathname).toBe(
      "https://github.com/login/oauth/authorize",
    );
    expect(location.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(location.searchParams.get("redirect_uri")).toBe(
      `${ORIGIN}${AUTH_CALLBACK_PATH}`,
    );

    const state = location.searchParams.get("state");
    expect(state).toBeTruthy();
    expect(state!.length).toBeGreaterThanOrEqual(32);

    const stateCookie = findCookie(res!, STATE_COOKIE);
    expect(stateCookie).toBeDefined();
    expect(stateCookie!.startsWith(`${STATE_COOKIE}=${state}`)).toBe(true);
    expect(stateCookie).toContain("HttpOnly");
    expect(stateCookie).toContain("Secure");
    expect(stateCookie).toContain("SameSite=Lax");
    expect(stateCookie).toContain(`Max-Age=${STATE_TTL_SEC}`);
    expect(stateCookie).toContain("Path=/api/auth");
  });

  it("每次登录生成不同 state", async () => {
    const h = createDb();
    const env = createEnv(h.db);

    const states = [] as string[];
    for (let i = 0; i < 2; i += 1) {
      const res = await handleAuthRoute(
        env,
        new Request(loginUrl()),
        new URL(loginUrl()),
      );
      states.push(
        new URL(res!.headers.get("location")!).searchParams.get("state")!,
      );
    }

    expect(states[0]).not.toBe(states[1]);
  });

  it("配置 PUBLIC_BASE_URL → redirect_uri 钉死到该基址（忽略请求 Host）", async () => {
    const h = createDb();
    const env = createEnv(h.db, {
      PUBLIC_BASE_URL: "https://imgbot.alanpally.com",
    });

    const res = await handleAuthRoute(
      env,
      new Request(loginUrl()),
      new URL(loginUrl()),
    );

    const location = new URL(res!.headers.get("location")!);
    expect(location.searchParams.get("redirect_uri")).toBe(
      `https://imgbot.alanpally.com${AUTH_CALLBACK_PATH}`,
    );

    // 尾斜杠容忍：钉死值不因配置写法多出 `//api`。
    const envSlash = createEnv(h.db, {
      PUBLIC_BASE_URL: "https://imgbot.alanpally.com/",
    });
    const resSlash = await handleAuthRoute(
      envSlash,
      new Request(loginUrl()),
      new URL(loginUrl()),
    );
    expect(
      new URL(resSlash!.headers.get("location")!).searchParams.get(
        "redirect_uri",
      ),
    ).toBe(`https://imgbot.alanpally.com${AUTH_CALLBACK_PATH}`);
  });

  it("凭据未配置 → 500，报错点名 GITHUB_CLIENT_ID/SECRET", async () => {
    const h = createDb();
    const env = createEnv(h.db, {
      GITHUB_CLIENT_ID: "",
      GITHUB_CLIENT_SECRET: "",
    });

    const res = await handleAuthRoute(
      env,
      new Request(loginUrl()),
      new URL(loginUrl()),
    );

    expect(res!.status).toBe(500);
    const body = await res!.text();
    expect(body).toContain("GITHUB_CLIENT_ID/SECRET");
    expect(body).toMatch(/missing or invalid/i);
  });

  it("非 GET → 405 + Allow", async () => {
    const h = createDb();
    const env = createEnv(h.db);

    const url = loginUrl();
    const res = await handleAuthRoute(
      env,
      new Request(url, { method: "POST" }),
      new URL(url),
    );

    expect(res!.status).toBe(405);
    expect(res!.headers.get("allow")).toBe("GET");
  });
});

// ---------------------------------------------------------------------------
// /api/auth/callback
// ---------------------------------------------------------------------------

describe("GET /api/auth/callback", () => {
  it("成功链：换 token → 查 user → 落 session 行 → 种 cookie → 302 /", async () => {
    const h = createDb();
    const env = createEnv(h.db);
    const fetchHarness = successFetch();
    const deps: AuthDeps = {
      fetchImpl: fetchHarness.fetchImpl,
      now: () => FIXED_NOW,
    };

    const url = callbackUrl({ code: "the-code", state: "state-ok" });
    const res = await authRoute(
      env,
      new Request(url, {
        headers: { cookie: cookieHeader([STATE_COOKIE, "state-ok"]) },
      }),
      deps,
    );

    expect(fetchHarness.calls).toHaveLength(2);

    // ① token 交换
    const [exchange, user] = fetchHarness.calls;
    expect(exchange.url).toBe("https://github.com/login/oauth/access_token");
    expect(exchange.init?.method).toBe("POST");
    expect(
      String((exchange.init?.headers as Record<string, string>).accept),
    ).toBe("application/json");
    const exchangeBody = JSON.parse(String(exchange.init?.body)) as Record<
      string,
      string
    >;
    expect(exchangeBody).toEqual({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code: "the-code",
      redirect_uri: `${ORIGIN}${AUTH_CALLBACK_PATH}`,
    });

    // ② 用户查询（用刚拿到的 token）
    expect(user.url).toBe("https://api.github.com/user");
    expect((user.init?.headers as Record<string, string>).authorization).toBe(
      "Bearer gho_live_token",
    );

    // ③ session 行
    expect(h.rows.size).toBe(1);
    const [session] = [...h.rows.values()];
    expect(session.user_login).toBe("octocat");
    expect(session.user_id).toBe(583231);
    expect(session.user_token).toBe("gho_live_token");
    expect(session.created_at).toBe(new Date(FIXED_NOW).toISOString());
    expect(
      Date.parse(session.expires_at) - Date.parse(session.created_at),
    ).toBe(SESSION_TTL_SEC * 1000);

    // ④ 响应：302 + 会话 cookie + 清 state
    expect(res!.status).toBe(302);
    expect(res!.headers.get("location")).toBe("/");

    const sessionCookie = findCookie(res!, SESSION_COOKIE);
    expect(sessionCookie).toBeDefined();
    expect(
      sessionCookie!.startsWith(`${SESSION_COOKIE}=${session.session_id}`),
    ).toBe(true);
    expect(sessionCookie).toContain("HttpOnly");
    expect(sessionCookie).toContain("Secure");
    expect(sessionCookie).toContain("SameSite=Lax");
    expect(sessionCookie).toContain("Path=/");
    expect(sessionCookie).toContain(`Max-Age=${SESSION_TTL_SEC}`);
    expect(sessionCookie).toContain("Max-Age=604800");

    const clearedState = findCookie(res!, STATE_COOKIE);
    expect(clearedState).toBeDefined();
    expect(clearedState).toContain("Max-Age=0");
  });

  it("fetchImpl 必须裸调用：严格 this 的 fetch（复刻 workerd WebIDL）不炸", async () => {
    const h = createDb();
    const env = createEnv(h.db);
    const fetchHarness = successFetch();
    // 复刻 workerd：原生 fetch 被成员调用（this ≠ undefined）→ Illegal invocation。
    // 2026-11-17 真仓 OAuth 实测踩坑：`args.fetchImpl(...)` 成员调用即触发。
    const strictFetch: typeof fetchHarness.fetchImpl = function (
      this: unknown,
      input,
      init,
    ) {
      if (this !== undefined) {
        throw new TypeError(
          "Illegal invocation: function called with incorrect `this` reference.",
        );
      }
      return fetchHarness.fetchImpl!(input, init);
    };
    const deps: AuthDeps = {
      fetchImpl: strictFetch,
      now: () => FIXED_NOW,
    };

    const url = callbackUrl({ code: "the-code", state: "state-ok" });
    const res = await authRoute(
      env,
      new Request(url, {
        headers: { cookie: cookieHeader([STATE_COOKIE, "state-ok"]) },
      }),
      deps,
    );

    expect(res!.status).toBe(302);
    expect(fetchHarness.calls).toHaveLength(2);
  });

  it("state 不符 → 400，不交换 token / 不落库", async () => {
    const h = createDb();
    const env = createEnv(h.db);
    const fetchHarness = successFetch();

    const url = callbackUrl({ code: "the-code", state: "attacker-state" });
    const res = await authRoute(
      env,
      new Request(url, {
        headers: { cookie: cookieHeader([STATE_COOKIE, "state-ok"]) },
      }),
      { fetchImpl: fetchHarness.fetchImpl },
    );

    expect(res!.status).toBe(400);
    expect(await res!.text()).toMatch(/state mismatch/i);
    expect(fetchHarness.calls).toHaveLength(0);
    expect(h.rows.size).toBe(0);
    expect(findCookie(res!, STATE_COOKIE)).toContain("Max-Age=0");
  });

  it("缺 state cookie → 400（CSRF 双提交缺失即失败）", async () => {
    const h = createDb();
    const env = createEnv(h.db);
    const fetchHarness = successFetch();

    const url = callbackUrl({ code: "the-code", state: "state-ok" });
    const res = await authRoute(env, new Request(url), {
      fetchImpl: fetchHarness.fetchImpl,
    });

    expect(res!.status).toBe(400);
    expect(fetchHarness.calls).toHaveLength(0);
    expect(h.rows.size).toBe(0);
  });

  it("缺 code → 400", async () => {
    const h = createDb();
    const env = createEnv(h.db);

    const url = callbackUrl({ state: "state-ok" });
    const res = await authRoute(
      env,
      new Request(url, {
        headers: { cookie: cookieHeader([STATE_COOKIE, "state-ok"]) },
      }),
      { fetchImpl: successFetch().fetchImpl },
    );

    expect(res!.status).toBe(400);
    expect(await res!.text()).toMatch(/missing `code`/);
    expect(h.rows.size).toBe(0);
  });

  it("token 交换返回 error 字段 → 400 且带 GitHub 原因", async () => {
    const h = createDb();
    const env = createEnv(h.db);
    const fetchHarness = createFetch(() =>
      jsonResponse({
        error: "bad_verification_code",
        error_description: "The code passed is incorrect or expired.",
      }),
    );

    const url = callbackUrl({ code: "expired", state: "state-ok" });
    const res = await authRoute(
      env,
      new Request(url, {
        headers: { cookie: cookieHeader([STATE_COOKIE, "state-ok"]) },
      }),
      { fetchImpl: fetchHarness.fetchImpl },
    );

    expect(res!.status).toBe(400);
    const body = await res!.text();
    expect(body).toContain("bad_verification_code");
    expect(body).toContain("incorrect or expired");
    expect(fetchHarness.calls).toHaveLength(1);
    expect(h.rows.size).toBe(0);
  });

  it("token 交换 HTTP 5xx → 400", async () => {
    const h = createDb();
    const env = createEnv(h.db);
    const fetchHarness = createFetch(() =>
      jsonResponse({ message: "server error" }, 500),
    );

    const url = callbackUrl({ code: "the-code", state: "state-ok" });
    const res = await authRoute(
      env,
      new Request(url, {
        headers: { cookie: cookieHeader([STATE_COOKIE, "state-ok"]) },
      }),
      { fetchImpl: fetchHarness.fetchImpl },
    );

    expect(res!.status).toBe(400);
    expect(await res!.text()).toContain("HTTP 500");
    expect(h.rows.size).toBe(0);
  });

  it("GET /user 失败 → 502，不落库", async () => {
    const h = createDb();
    const env = createEnv(h.db);
    const fetchHarness = createFetch((call) => {
      if (call.url.includes("access_token")) {
        return jsonResponse({ access_token: "gho_live_token" });
      }
      return jsonResponse({ message: "Bad credentials" }, 401);
    });

    const url = callbackUrl({ code: "the-code", state: "state-ok" });
    const res = await authRoute(
      env,
      new Request(url, {
        headers: { cookie: cookieHeader([STATE_COOKIE, "state-ok"]) },
      }),
      { fetchImpl: fetchHarness.fetchImpl },
    );

    expect(res!.status).toBe(502);
    expect(await res!.text()).toContain("HTTP 401");
    expect(h.rows.size).toBe(0);
  });

  it("回调时凭据未配置 → 500 + 可操作文案", async () => {
    const h = createDb();
    const env = createEnv(h.db, {
      GITHUB_CLIENT_ID: "",
      GITHUB_CLIENT_SECRET: "",
    });
    const fetchHarness = successFetch();

    const url = callbackUrl({ code: "the-code", state: "state-ok" });
    const res = await authRoute(
      env,
      new Request(url, {
        headers: { cookie: cookieHeader([STATE_COOKIE, "state-ok"]) },
      }),
      { fetchImpl: fetchHarness.fetchImpl },
    );

    expect(res!.status).toBe(500);
    expect(await res!.text()).toContain("GITHUB_CLIENT_ID/SECRET");
    expect(fetchHarness.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// requireUser
// ---------------------------------------------------------------------------

describe("requireUser", () => {
  it("命中：返回 login / userId / token", async () => {
    const h = createDb();
    const env = createEnv(h.db);
    seedSession(h);

    const request = new Request(`${ORIGIN}/api/repos`, {
      headers: { cookie: cookieHeader([SESSION_COOKIE, "session-1"]) },
    });
    const user = await requireUser(env, request);

    expect(user).toEqual({
      login: "octocat",
      userId: 583231,
      token: "gho_seeded",
    });
    expect(
      h.statements.some((sql) => sql.includes("DELETE FROM sessions")),
    ).toBe(false);
  });

  it("无 cookie → null，且不查库", async () => {
    const h = createDb();
    const env = createEnv(h.db);

    const user = await requireUser(env, new Request(`${ORIGIN}/api/repos`));

    expect(user).toBeNull();
    expect(h.statements).toHaveLength(0);
  });

  it("未知 session id → null", async () => {
    const h = createDb();
    const env = createEnv(h.db);

    const user = await requireUser(
      env,
      new Request(`${ORIGIN}/api/repos`, {
        headers: { cookie: cookieHeader([SESSION_COOKIE, "does-not-exist"]) },
      }),
    );

    expect(user).toBeNull();
  });

  it("过期行 → null 并顺手删除", async () => {
    const h = createDb();
    const env = createEnv(h.db);
    seedSession(h, {
      session_id: "expired-1",
      expires_at: new Date(Date.now() - 1000).toISOString(),
    });

    const user = await requireUser(
      env,
      new Request(`${ORIGIN}/api/repos`, {
        headers: { cookie: cookieHeader([SESSION_COOKIE, "expired-1"]) },
      }),
    );

    expect(user).toBeNull();
    expect(h.rows.has("expired-1")).toBe(false);
    expect(
      h.statements.some((sql) => sql.includes("DELETE FROM sessions")),
    ).toBe(true);
  });

  it("expires_at 不是合法时间 → 视为过期并删除", async () => {
    const h = createDb();
    const env = createEnv(h.db);
    seedSession(h, { session_id: "garbage-1", expires_at: "not-a-date" });

    const user = await requireUser(
      env,
      new Request(`${ORIGIN}/api/repos`, {
        headers: { cookie: cookieHeader([SESSION_COOKIE, "garbage-1"]) },
      }),
    );

    expect(user).toBeNull();
    expect(h.rows.has("garbage-1")).toBe(false);
  });

  it("cookie 头畸形（无等号/空段）不抛，按无会话处理", async () => {
    const h = createDb();
    const env = createEnv(h.db);

    const request = new Request(`${ORIGIN}/api/repos`, {
      headers: { cookie: ";;; ib_session; =; other=1" },
    });

    await expect(requireUser(env, request)).resolves.toBeNull();
  });

  it("user_id 缺失时归一为 null", async () => {
    const h = createDb();
    const env = createEnv(h.db);
    seedSession(h, { session_id: "no-id", user_id: null });

    const user = await requireUser(
      env,
      new Request(`${ORIGIN}/api/repos`, {
        headers: { cookie: cookieHeader([SESSION_COOKIE, "no-id"]) },
      }),
    );

    expect(user?.userId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// /api/auth/logout + 前缀分派
// ---------------------------------------------------------------------------

describe("POST /api/auth/logout", () => {
  it("删行 + 清 cookie → 202", async () => {
    const h = createDb();
    const env = createEnv(h.db);
    seedSession(h);

    const url = `${ORIGIN}/api/auth/logout`;
    const res = await handleAuthRoute(
      env,
      new Request(url, {
        method: "POST",
        headers: { cookie: cookieHeader([SESSION_COOKIE, "session-1"]) },
      }),
      new URL(url),
    );

    expect(res!.status).toBe(202);
    expect(h.rows.has("session-1")).toBe(false);

    const cleared = findCookie(res!, SESSION_COOKIE);
    expect(cleared).toBeDefined();
    expect(cleared).toContain("Max-Age=0");
    expect(cleared).toContain("HttpOnly");
  });

  it("无 cookie 也 202（幂等），仍然清 cookie", async () => {
    const h = createDb();
    const env = createEnv(h.db);

    const url = `${ORIGIN}/api/auth/logout`;
    const res = await handleAuthRoute(
      env,
      new Request(url, { method: "POST" }),
      new URL(url),
    );

    expect(res!.status).toBe(202);
    expect(findCookie(res!, SESSION_COOKIE)).toContain("Max-Age=0");
    expect(h.statements).toHaveLength(0);
  });

  it("GET → 405 + Allow: POST", async () => {
    const h = createDb();
    const env = createEnv(h.db);

    const url = `${ORIGIN}/api/auth/logout`;
    const res = await handleAuthRoute(env, new Request(url), new URL(url));

    expect(res!.status).toBe(405);
    expect(res!.headers.get("allow")).toBe("POST");
  });
});

describe("路由分派", () => {
  it("非 /api/auth 前缀 → null 交上游", async () => {
    const h = createDb();
    const env = createEnv(h.db);

    const url = `${ORIGIN}/api/repos`;
    const res = await handleAuthRoute(env, new Request(url), new URL(url));

    expect(res).toBeNull();
  });

  it("未知 /api/auth/* → 404", async () => {
    const h = createDb();
    const env = createEnv(h.db);

    const url = `${ORIGIN}/api/auth/whatever`;
    const res = await handleAuthRoute(env, new Request(url), new URL(url));

    expect(res!.status).toBe(404);
  });
});
