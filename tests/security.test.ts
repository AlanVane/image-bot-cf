/**
 * 安全响应头（P0 加固）测试。
 *
 * `withSecurityHeaders` 是 Worker 每条响应的统一出口：这里钉死头名/头值，
 * 并验证「普通响应」「重定向」「204 无体」三类形态都不丢原有语义。
 */
import { describe, expect, it } from "vitest";

import { SECURITY_HEADERS, withSecurityHeaders } from "../src/security";

const EXPECTED_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; " +
  "form-action 'self'; frame-ancestors 'none'";

function expectSecurityHeaders(res: Response): void {
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("x-frame-options")).toBe("DENY");
  expect(res.headers.get("content-security-policy")).toBe(EXPECTED_CSP);
  expect(res.headers.get("referrer-policy")).toBe(
    "strict-origin-when-cross-origin",
  );
  expect(res.headers.get("permissions-policy")).toBe(
    "camera=(), microphone=(), geolocation=()",
  );
}

describe("withSecurityHeaders", () => {
  it("头表常量与契约一致（5 条，含严格 script-src）", () => {
    expect(Object.keys(SECURITY_HEADERS)).toEqual([
      "x-content-type-options",
      "x-frame-options",
      "content-security-policy",
      "referrer-policy",
      "permissions-policy",
    ]);
    expect(SECURITY_HEADERS["content-security-policy"]).toBe(EXPECTED_CSP);
  });

  it("普通响应：加头 + 保留 status/content-type/body", async () => {
    const source = new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    });

    const res = withSecurityHeaders(source);

    expectSecurityHeaders(res);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    await expect(res.json()).resolves.toEqual({ ok: true });
  });

  it("重定向：302 + location 保留，头照挂", () => {
    const source = new Response(null, {
      status: 302,
      headers: { location: "/", "cache-control": "no-store" },
    });

    const res = withSecurityHeaders(source);

    expectSecurityHeaders(res);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("多条 set-cookie 不被合并（OAuth 回调同时种 session + 清 state）", () => {
    const headers = new Headers({ location: "/" });
    headers.append("set-cookie", "ib_session=abc; Path=/; HttpOnly");
    headers.append("set-cookie", "ib_oauth_state=; Path=/api/auth; Max-Age=0");
    const source = new Response(null, { status: 302, headers });

    const res = withSecurityHeaders(source);

    expectSecurityHeaders(res);
    const bag = res.headers as Headers & { getSetCookie?: () => string[] };
    const cookies =
      typeof bag.getSetCookie === "function"
        ? bag.getSetCookie()
        : [res.headers.get("set-cookie") ?? ""];
    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toContain("ib_session=abc");
    expect(cookies[1]).toContain("ib_oauth_state=");
  });

  it("204 无体响应保持 null body（重建副本时不许塞 body）", async () => {
    const res = withSecurityHeaders(new Response(null, { status: 204 }));

    expectSecurityHeaders(res);
    expect(res.status).toBe(204);
    await expect(res.text()).resolves.toBe("");
  });

  it("immutable headers 的响应（Response.redirect）→ 退回重建副本也带头", () => {
    const source = Response.redirect("https://example.com/next", 302);
    const res = withSecurityHeaders(source);

    expectSecurityHeaders(res);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://example.com/next");
    // 原响应不受影响（说明确实走的是副本路径或至少未被破坏）。
    expect(source.headers.get("x-frame-options")).toBeNull();
  });

  it("已带同名头 → 以安全头值为准（不被上游覆盖）", () => {
    const source = new Response("x", {
      headers: { "x-frame-options": "SAMEORIGIN" },
    });

    const res = withSecurityHeaders(source);
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });
});
