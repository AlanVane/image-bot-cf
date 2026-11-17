/**
 * 安全响应头（P0 加固）—— Worker 的**每一条**响应都要带。
 *
 * 入口在 `src/index.ts` 的 fetch handler 统一包一层：API、OAuth 回调、静态资产
 * 一视同仁（`env.ASSETS.fetch` 的响应同样经过这里）。
 *
 * CSP 取舍（务实版）：
 * - `script-src 'self'` 严格——XSS 的主战场，静态资产里没有内联脚本；
 * - `style-src 'self' 'unsafe-inline'` 放宽——前端有 CSSOM 写入（`el.style.x = …`）
 *   与后续内联样式微调，收紧成本大于收益；
 * - `img-src 'self' data:` 覆盖 data-URI 占位；`connect-src 'self'` 只允许同源
 *   API（仪表盘不调第三方接口，OAuth 跳转是导航不是 fetch）。
 *
 * 注意：**不要**把这里改成 `Object.entries` 之外的花样——纯常量表便于审计。
 */

/** 统一响应头表（值即最终值，不做拼接）。 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "content-security-policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "font-src 'self'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; "),
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
};

/** 这些状态码的响应体必须为 null（Fetch 规范），重建副本时要保持。 */
const NULL_BODY_STATUS: ReadonlySet<number> = new Set([101, 204, 205, 304]);

/**
 * 给响应挂上安全头，返回**可安全使用**的响应。
 *
 * 绝大多数响应（我们自建的 + assets 出来的）头是可写的，直接原地改；
 * 少数带 immutable headers 的响应（例如 `Response.redirect`）原地写会抛
 * TypeError → 退回重建副本。重建时逐个搬运头（含多条 `set-cookie`），
 * 且对 101/204/205/304 保持 null body。
 */
export function withSecurityHeaders(response: Response): Response {
  try {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      response.headers.set(name, value);
    }
    return response;
  } catch {
    return rebuildWithSecurityHeaders(response);
  }
}

function rebuildWithSecurityHeaders(response: Response): Response {
  const headers = new Headers();

  // `set-cookie` 可能有多条：优先用 getSetCookie() 逐条搬，避免被合并。
  const bag = response.headers as Headers & { getSetCookie?: () => string[] };
  const setCookies =
    typeof bag.getSetCookie === "function" ? bag.getSetCookie() : [];

  for (const [name, value] of response.headers) {
    if (name.toLowerCase() === "set-cookie" && setCookies.length > 0) continue;
    headers.append(name, value);
  }
  for (const cookie of setCookies) headers.append("set-cookie", cookie);

  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(name, value);
  }

  return new Response(
    NULL_BODY_STATUS.has(response.status) ? null : response.body,
    {
      status: response.status,
      statusText: response.statusText,
      headers,
    },
  );
}
