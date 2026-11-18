/**
 * ingress 层测试（DESIGN.md §2.4 / §4.1 / §5.2）。
 *
 * 覆盖：
 *  - `mapEventToRuns` 纯函数向量（installation/push/ping，含保守回退与大小写）；
 *  - `handleWebhook` 的验签、delivery 去重、入队次数与状态码。
 *
 * Env 全部手写 mock（D1 deliveries 用内存 Map 复刻 `INSERT OR IGNORE`），不引新依赖。
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  COMMITS_TRUNCATION_THRESHOLD,
  WEB_MERGE_MAX_COMMITS,
  getWebMergeTarget,
  isDefaultWebMerge,
  isImagePath,
  mapEventToRuns,
} from "../src/ingress/events";
import { handleWebhook } from "../src/ingress/webhook";
import type { Env, RunDescriptor } from "../src/types";

const SECRET = "test-webhook-secret";
const HOOK_URL = "https://example.com/api/hook";

/** 合并删分支测试需要真实 RSA 私钥（getInstallationToken → generateAppJwt）。 */
let privatePem = "";

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const der = new Uint8Array(
    (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer,
  );
  const b64 = Buffer.from(der).toString("base64");
  privatePem =
    "-----BEGIN PRIVATE KEY-----\n" +
    (b64.match(/.{1,64}/g) ?? []).join("\n") +
    "\n-----END PRIVATE KEY-----\n";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

interface Harness {
  env: Env;
  sent: RunDescriptor[];
  sendOptions: unknown[];
  deliveryRows: Map<string, string | null>;
  /** `marketplace_purchases` 的内存复刻（account_id 主键）。 */
  purchases: Map<number, Record<string, unknown>>;
  /** 写入计数（去重断言用；可变对象避免 getter 被解构时定型）。 */
  stats: { purchaseWrites: number };
  router: { fail: boolean };
}

function createHarness(): Harness {
  const sent: RunDescriptor[] = [];
  const sendOptions: unknown[] = [];
  const deliveryRows = new Map<string, string | null>();
  const purchases = new Map<number, Record<string, unknown>>();
  const counters = { purchaseWrites: 0 };
  const router = { fail: false };

  const db = {
    prepare(sql: string) {
      return {
        bind(...params: unknown[]) {
          return {
            async run() {
              if (sql.includes("INSERT INTO marketplace_purchases")) {
                const [
                  accountId,
                  accountLogin,
                  planId,
                  planName,
                  state,
                  updatedAt,
                ] = params as [
                  number,
                  string | null,
                  number,
                  string | null,
                  string,
                  string,
                ];
                purchases.set(accountId, {
                  account_login: accountLogin,
                  plan_id: planId,
                  plan_name: planName,
                  state,
                  updated_at: updatedAt,
                });
                counters.purchaseWrites += 1;
                return { success: true, meta: { changes: 1 } };
              }
              if (!sql.includes("INSERT OR IGNORE INTO deliveries")) {
                throw new Error(`unexpected SQL in test: ${sql}`);
              }
              const deliveryId = String(params[0]);
              if (deliveryRows.has(deliveryId)) {
                return { success: true, meta: { changes: 0 } };
              }
              deliveryRows.set(
                deliveryId,
                (params[1] as string | null) ?? null,
              );
              return { success: true, meta: { changes: 1 } };
            },
            async first() {
              if (!sql.includes("SELECT delivery_id FROM deliveries")) {
                throw new Error(`unexpected SQL in test: ${sql}`);
              }
              const deliveryId = String(params[0]);
              return deliveryRows.has(deliveryId)
                ? { delivery_id: deliveryId }
                : null;
            },
          };
        },
      };
    },
  };

  const env = {
    DB: db,
    ROUTER: {
      async send(body: RunDescriptor, options?: unknown) {
        if (router.fail) throw new Error("router down");
        sent.push(body);
        sendOptions.push(options);
      },
    },
    GITHUB_WEBHOOK_SECRET: SECRET,
  } as unknown as Env;

  return {
    env,
    sent,
    sendOptions,
    deliveryRows,
    purchases,
    stats: counters,
    router,
  } as Harness;
}

async function sign(body: string, secret = SECRET): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)),
  );
  const hex = [...signature]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `sha256=${hex}`;
}

interface HookOptions {
  event?: string;
  delivery?: string;
  secret?: string;
  method?: string;
  omitSignature?: boolean;
}

async function hookRequest(
  payload: unknown,
  options: HookOptions = {},
): Promise<Request> {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (options.event) headers["x-github-event"] = options.event;
  if (options.delivery) headers["x-github-delivery"] = options.delivery;
  if (!options.omitSignature) {
    headers["x-hub-signature-256"] = await sign(body, options.secret ?? SECRET);
  }
  return new Request(HOOK_URL, {
    method: options.method ?? "POST",
    headers,
    body: options.method === "GET" ? undefined : body,
  });
}

// push payload 构造器（只保留 ingress 需要的字段）
function pushPayload(
  branch: string,
  commits: Array<Record<string, string[]>>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ref: `refs/heads/${branch}`,
    before: "0".repeat(40),
    after: "a".repeat(40),
    created: false,
    deleted: false,
    forced: false,
    repository: { full_name: "acme/site", default_branch: "main" },
    installation: { id: 42 },
    commits,
    ...overrides,
  };
}

function installationPayload(
  action: string,
  repos: Array<{ full_name: string; default_branch?: string | null }>,
): Record<string, unknown> {
  return {
    action,
    installation: { id: 99 },
    repositories: repos.map((repo) => ({
      full_name: repo.full_name,
      default_branch: repo.default_branch ?? "main",
    })),
  };
}

// ---------------------------------------------------------------------------
// mapEventToRuns
// ---------------------------------------------------------------------------

describe("mapEventToRuns", () => {
  it("installation(created) 两个仓库 → 两条 installation run", () => {
    const runs = mapEventToRuns(
      "installation",
      installationPayload("created", [
        { full_name: "acme/site", default_branch: "main" },
        { full_name: "acme/docs", default_branch: "trunk" },
      ]),
    );

    expect(runs).toHaveLength(2);
    expect(runs.map((run) => run.repo)).toEqual(["acme/site", "acme/docs"]);
    expect(runs.every((run) => run.trigger === "installation")).toBe(true);
    expect(runs.every((run) => run.installation_id === 99)).toBe(true);
    expect(runs.map((run) => run.base_ref)).toEqual(["main", "trunk"]);
    expect(new Set(runs.map((run) => run.run_id)).size).toBe(2);
    expect(runs.every((run) => run.base_sha === undefined)).toBe(true);
  });

  it("installation_repositories(added) 只取新增仓库", () => {
    const runs = mapEventToRuns("installation_repositories", {
      action: "added",
      installation: { id: 7 },
      repositories_added: [
        { full_name: "acme/one", default_branch: "main" },
        { full_name: "acme/two", default_branch: "main" },
      ],
      repositories_removed: [{ full_name: "acme/old", default_branch: "main" }],
    });

    expect(runs.map((run) => run.repo)).toEqual(["acme/one", "acme/two"]);
  });

  it("installation 非 created/added action → 空", () => {
    expect(
      mapEventToRuns(
        "installation",
        installationPayload("deleted", [{ full_name: "acme/site" }]),
      ),
    ).toEqual([]);
  });

  it("push 改动图片 → 一条 push run 且 base_sha = after", () => {
    const payload = pushPayload("main", [
      { added: ["img/new.png"], modified: ["README.md"], removed: [] },
    ]);
    const runs = mapEventToRuns("push", payload);

    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      installation_id: 42,
      repo: "acme/site",
      trigger: "push",
      base_ref: "main",
      base_sha: "a".repeat(40),
    });
    expect(typeof runs[0]!.run_id).toBe("string");
    expect(runs[0]!.run_id).not.toBe("");
  });

  it("push 带 repository.private → 描述符携带 private（D16）", () => {
    const privateRuns = mapEventToRuns(
      "push",
      pushPayload(
        "main",
        [{ added: ["img/a.png"], modified: [], removed: [] }],
        {
          repository: {
            full_name: "acme/site",
            default_branch: "main",
            private: true,
          },
        },
      ),
    );
    expect(privateRuns[0]?.private).toBe(true);

    const publicRuns = mapEventToRuns(
      "push",
      pushPayload(
        "main",
        [{ added: ["img/a.png"], modified: [], removed: [] }],
        {
          repository: {
            full_name: "acme/site",
            default_branch: "main",
            private: false,
          },
        },
      ),
    );
    expect(publicRuns[0]?.private).toBe(false);
  });

  it("push 纯文档 → 空", () => {
    const payload = pushPayload("main", [
      { added: [], modified: ["docs/guide.md", "src/index.ts"], removed: [] },
    ]);
    expect(mapEventToRuns("push", payload)).toEqual([]);
  });

  it("push .imgbotconfig → 一条 run", () => {
    const payload = pushPayload("main", [
      { added: [], modified: [".imgbotconfig"], removed: [] },
    ]);
    expect(mapEventToRuns("push", payload)).toHaveLength(1);
  });

  it("push 非默认分支（含 imgbot）→ 空", () => {
    expect(
      mapEventToRuns(
        "push",
        pushPayload("feature/x", [
          { added: ["a.png"], modified: [], removed: [] },
        ]),
      ),
    ).toEqual([]);
    expect(
      mapEventToRuns(
        "push",
        pushPayload("imgbot", [
          { added: ["a.png"], modified: [], removed: [] },
        ]),
      ),
    ).toEqual([]);
  });

  it("push 大写扩展名 .PNG → 一条 run", () => {
    const payload = pushPayload("main", [
      { added: [], modified: ["Assets/LOGO.PNG"], removed: [] },
    ]);
    expect(mapEventToRuns("push", payload)).toHaveLength(1);
  });

  it("push 已删除图片 → 一条 run（removed 也计入）", () => {
    const payload = pushPayload("main", [
      { added: [], modified: [], removed: ["old/shot.JPEG"] },
    ]);
    expect(mapEventToRuns("push", payload)).toHaveLength(1);
  });

  it(`push 达到 ${COMMITS_TRUNCATION_THRESHOLD} 条 commit（文件集不可信）→ 保守入队`, () => {
    const commits = Array.from(
      { length: COMMITS_TRUNCATION_THRESHOLD },
      (_, i) => ({
        added: [`notes/${i}.md`],
        modified: [],
        removed: [],
      }),
    );
    const payload = pushPayload("main", commits);
    expect(mapEventToRuns("push", payload)).toHaveLength(1);
  });

  it("push commits 为空但存在 head_commit → 保守入队", () => {
    const payload = pushPayload("main", [], {
      head_commit: { id: "b".repeat(40), added: [], modified: [], removed: [] },
    });
    expect(mapEventToRuns("push", payload)).toHaveLength(1);
  });

  it("push 无 commits 无 head_commit → 空", () => {
    expect(mapEventToRuns("push", pushPayload("main", []))).toEqual([]);
  });

  it("push 删分支（deleted=true）→ 空", () => {
    const payload = pushPayload(
      "main",
      [{ added: [], modified: [], removed: ["a.png"] }],
      { deleted: true, after: "0".repeat(40) },
    );
    expect(mapEventToRuns("push", payload)).toEqual([]);
  });

  it("ping / marketplace_purchase / 未知事件 → 空", () => {
    expect(
      mapEventToRuns("ping", { zen: "Keep it logically awesome." }),
    ).toEqual([]);
    expect(
      mapEventToRuns("marketplace_purchase", { action: "purchased" }),
    ).toEqual([]);
    expect(mapEventToRuns("wat", {})).toEqual([]);
    expect(mapEventToRuns("push", null)).toEqual([]);
  });

  it("isImagePath 大小写不敏感且不含 gif 之外的非图片", () => {
    expect(isImagePath("a/b/c.JPG")).toBe(true);
    expect(isImagePath("a/b/c.jpeg")).toBe(true);
    expect(isImagePath("a/b/c.GiF")).toBe(true);
    expect(isImagePath("a/b/c.svg")).toBe(true);
    expect(isImagePath("a/b/c.webp")).toBe(false);
    expect(isImagePath("a/b/png")).toBe(false);
    expect(isImagePath(".png")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// handleWebhook
// ---------------------------------------------------------------------------

describe("handleWebhook", () => {
  const pushEvent = pushPayload("main", [
    { added: ["img/logo.png"], modified: [], removed: [] },
  ]);

  it("坏签名 → 401 且不入队", async () => {
    const { env, sent } = createHarness();
    const response = await handleWebhook(
      await hookRequest(pushEvent, {
        event: "push",
        delivery: "d-1",
        secret: "wrong-secret",
      }),
      env,
    );

    expect(response.status).toBe(401);
    expect(sent).toHaveLength(0);
  });

  it("缺签名头 → 401", async () => {
    const { env, sent } = createHarness();
    const response = await handleWebhook(
      await hookRequest(pushEvent, {
        event: "push",
        delivery: "d-missing",
        omitSignature: true,
      }),
      env,
    );
    expect(response.status).toBe(401);
    expect(sent).toHaveLength(0);
  });

  it("合法 push → 202 且恰好 send 1 次（json 内容类型）", async () => {
    const { env, sent, sendOptions } = createHarness();
    const response = await handleWebhook(
      await hookRequest(pushEvent, { event: "push", delivery: "d-2" }),
      env,
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ ok: true, queued: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      repo: "acme/site",
      trigger: "push",
      base_ref: "main",
      delivery_id: "d-2",
    });
    expect(sendOptions[0]).toEqual({ contentType: "json" });
  });

  it("入队失败 → 不落去重记录，重投不被视为重复（P1 事件丢失修复）", async () => {
    const { env, sent, deliveryRows, router } = createHarness();

    router.fail = true;
    const failed = await handleWebhook(
      await hookRequest(pushEvent, { event: "push", delivery: "d-3f" }),
      env,
    );
    expect(failed.status).toBe(500);
    expect(sent).toHaveLength(0);
    expect(deliveryRows.size).toBe(0);

    // GitHub 重投同一 delivery：必须还能入队（旧实现会撞去重表把事件永久丢掉）
    router.fail = false;
    const retried = await handleWebhook(
      await hookRequest(pushEvent, { event: "push", delivery: "d-3f" }),
      env,
    );
    expect(retried.status).toBe(202);
    await expect(retried.json()).resolves.toEqual({ ok: true, queued: 1 });
    expect(sent).toHaveLength(1);
    expect(deliveryRows.size).toBe(1);
  });

  it("重复 delivery → 202 duplicate，不再 send", async () => {
    const { env, sent, deliveryRows } = createHarness();

    const first = await handleWebhook(
      await hookRequest(pushEvent, { event: "push", delivery: "d-3" }),
      env,
    );
    expect(first.status).toBe(202);
    expect(sent).toHaveLength(1);

    const second = await handleWebhook(
      await hookRequest(pushEvent, { event: "push", delivery: "d-3" }),
      env,
    );
    expect(second.status).toBe(202);
    await expect(second.json()).resolves.toEqual({ ok: true, duplicate: true });
    expect(sent).toHaveLength(1);
    expect(deliveryRows.size).toBe(1);
  });

  it("ping → 202 queued 0", async () => {
    const { env, sent } = createHarness();
    const response = await handleWebhook(
      await hookRequest({ zen: "hi" }, { event: "ping", delivery: "d-4" }),
      env,
    );
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ ok: true, queued: 0 });
    expect(sent).toHaveLength(0);
  });

  it("非 POST → 404", async () => {
    const { env } = createHarness();
    const response = await handleWebhook(
      await hookRequest(null, { method: "GET", event: "push" }),
      env,
    );
    expect(response.status).toBe(404);
  });

  it("内部错误（D1 抛错）→ 500 且不泄露细节", async () => {
    const { env, sent } = createHarness();
    const brokenEnv = {
      ...env,
      DB: {
        prepare() {
          throw new Error("D1_ERROR: behind the curtain detail");
        },
      },
    } as unknown as Env;

    const response = await handleWebhook(
      await hookRequest(pushEvent, { event: "push", delivery: "d-5" }),
      brokenEnv,
    );

    expect(response.status).toBe(500);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({ ok: false, error: "internal_error" });
    expect(JSON.stringify(body)).not.toContain("curtain");
    expect(sent).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// handleWebhook：Marketplace 计费事件（D16）
// ---------------------------------------------------------------------------

/** `marketplace_purchase` 信封（GitHub Marketplace webhook 无 installation 字段）。 */
function marketplacePayload(
  action: string,
  plan: { id: number; name: string } = { id: 1001, name: "Agency" },
  account: { id: number; login: string } = { id: 583231, login: "octocat" },
): Record<string, unknown> {
  return {
    action,
    effective_date: "2026-11-18T00:00:00Z",
    marketplace_purchase: {
      account,
      plan,
      state: "active",
    },
  };
}

describe("handleWebhook marketplace_purchase", () => {
  it("purchased → upsert active 计划，202 queued 0 且不入队", async () => {
    const { env, sent, purchases } = createHarness();
    const response = await handleWebhook(
      await hookRequest(marketplacePayload("purchased"), {
        event: "marketplace_purchase",
        delivery: "mp-1",
      }),
      env,
    );

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ ok: true, queued: 0 });
    expect(sent).toHaveLength(0);
    expect(purchases.get(583231)).toMatchObject({
      account_login: "octocat",
      plan_id: 1001,
      plan_name: "Agency",
      state: "active",
    });
  });

  it("changed → 同一账户换成新计划并保持 active", async () => {
    const { env, purchases } = createHarness();
    await handleWebhook(
      await hookRequest(marketplacePayload("purchased"), {
        event: "marketplace_purchase",
        delivery: "mp-2a",
      }),
      env,
    );
    await handleWebhook(
      await hookRequest(
        marketplacePayload("changed", { id: 1002, name: "Enterprise" }),
        { event: "marketplace_purchase", delivery: "mp-2b" },
      ),
      env,
    );

    expect(purchases.size).toBe(1);
    expect(purchases.get(583231)).toMatchObject({
      plan_id: 1002,
      plan_name: "Enterprise",
      state: "active",
    });
  });

  it("cancelled → state 置 cancelled（保留 payload 里的 plan 行）", async () => {
    const { env, purchases } = createHarness();
    await handleWebhook(
      await hookRequest(marketplacePayload("purchased"), {
        event: "marketplace_purchase",
        delivery: "mp-3a",
      }),
      env,
    );
    const response = await handleWebhook(
      await hookRequest(marketplacePayload("cancelled"), {
        event: "marketplace_purchase",
        delivery: "mp-3b",
      }),
      env,
    );

    expect(response.status).toBe(202);
    expect(purchases.get(583231)).toMatchObject({
      plan_id: 1001,
      state: "cancelled",
    });
  });

  it("重复 delivery → duplicate，不再写 marketplace_purchases", async () => {
    const { env, purchases, stats } = createHarness();
    const first = await handleWebhook(
      await hookRequest(marketplacePayload("purchased"), {
        event: "marketplace_purchase",
        delivery: "mp-4",
      }),
      env,
    );
    expect(first.status).toBe(202);
    expect(stats.purchaseWrites).toBe(1);

    const second = await handleWebhook(
      await hookRequest(marketplacePayload("cancelled"), {
        event: "marketplace_purchase",
        delivery: "mp-4",
      }),
      env,
    );
    expect(second.status).toBe(202);
    await expect(second.json()).resolves.toEqual({
      ok: true,
      duplicate: true,
    });
    expect(stats.purchaseWrites).toBe(1);
    expect(purchases.get(583231)).toMatchObject({ state: "active" });
  });

  it("畸形 payload / 未知 action → 202 且不写库", async () => {
    const { env, purchases, stats } = createHarness();
    const malformed = await handleWebhook(
      await hookRequest(
        { action: "purchased" },
        {
          event: "marketplace_purchase",
          delivery: "mp-5",
        },
      ),
      env,
    );
    expect(malformed.status).toBe(202);

    const pending = await handleWebhook(
      await hookRequest(marketplacePayload("pending_change"), {
        event: "marketplace_purchase",
        delivery: "mp-6",
      }),
      env,
    );
    expect(pending.status).toBe(202);
    expect(stats.purchaseWrites).toBe(0);
    expect(purchases.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 合并删分支判定（§2.1，原版 `IsDefaultWebMerge`）
// ---------------------------------------------------------------------------

function webMergePush(
  commits: string[],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ref: "refs/heads/main",
    deleted: false,
    repository: { full_name: "acme/site", default_branch: "main" },
    installation: { id: 42 },
    commits: commits.map((message) => ({ message })),
    head_commit: { message: commits[commits.length - 1] ?? "" },
    ...overrides,
  };
}

const MERGE_COMMIT = "Merge pull request #12 from acme/imgbot";
const SQUASH_COMMIT =
  "[ImgBot] Optimize images\n\n*Total -- 300.00kb -> 240.00kb (20%)";

describe("isDefaultWebMerge", () => {
  it("merge commit（head_commit 匹配 Merge pull request …/imgbot）→ true", () => {
    expect(
      isDefaultWebMerge(
        webMergePush([], { head_commit: { message: MERGE_COMMIT } }),
      ),
    ).toBe(true);
  });

  it("commits 里带 Merge pull request …/imgbot → true", () => {
    expect(isDefaultWebMerge(webMergePush([MERGE_COMMIT]))).toBe(true);
  });

  it("squash 单 commit 标题即 [ImgBot] Optimize images → true", () => {
    expect(isDefaultWebMerge(webMergePush([SQUASH_COMMIT]))).toBe(true);
  });

  it(`恰好 ${WEB_MERGE_MAX_COMMITS} 个 commit 且其中一个含标题 → true`, () => {
    expect(
      isDefaultWebMerge(webMergePush(["chore: bump version", SQUASH_COMMIT])),
    ).toBe(true);
  });

  it("普通 push 3 个 commit（即使含标题）→ false", () => {
    expect(isDefaultWebMerge(webMergePush(["a", "b", SQUASH_COMMIT]))).toBe(
      false,
    );
  });

  it("合并自非 imgbot 分支（feature/x）→ false", () => {
    expect(
      isDefaultWebMerge(
        webMergePush([], {
          head_commit: { message: "Merge pull request #3 from acme/feature/x" },
        }),
      ),
    ).toBe(false);
  });

  it("非默认分支的 push → false", () => {
    expect(
      isDefaultWebMerge(
        webMergePush([SQUASH_COMMIT], { ref: "refs/heads/feature/x" }),
      ),
    ).toBe(false);
  });

  it("分支删除（deleted=true）→ false", () => {
    expect(
      isDefaultWebMerge(
        webMergePush([SQUASH_COMMIT], {
          deleted: true,
          ref: "refs/heads/imgbot",
        }),
      ),
    ).toBe(false);
  });

  it("人类普通提交 → false", () => {
    expect(isDefaultWebMerge(webMergePush(["fix: typo in readme"]))).toBe(
      false,
    );
  });

  it("getWebMergeTarget 提取 installation + repo；缺字段 → null", () => {
    expect(getWebMergeTarget(webMergePush([SQUASH_COMMIT]))).toEqual({
      installationId: 42,
      repo: "acme/site",
    });
    expect(getWebMergeTarget({ ref: "refs/heads/main" })).toBeNull();
    expect(getWebMergeTarget(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// handleWebhook：202 后 waitUntil 删 heads/imgbot
// ---------------------------------------------------------------------------

interface FetchCall {
  url: string;
  method: string;
}

function stubGithubFetch(deleteStatus = 204): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    "fetch",
    async (input: unknown, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ url, method });
      if (url.endsWith("/access_tokens")) {
        return Response.json({
          token: "tok",
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
      }
      if (method === "DELETE") {
        return new Response(null, { status: deleteStatus });
      }
      return new Response("unexpected", { status: 500 });
    },
  );
  return calls;
}

function createCtx(): {
  ctx: ExecutionContext;
  tasks: Promise<unknown>[];
} {
  const tasks: Promise<unknown>[] = [];
  const ctx = {
    waitUntil(promise: Promise<unknown>) {
      tasks.push(promise);
    },
  } as unknown as ExecutionContext;
  return { ctx, tasks };
}

function envWithAppKey(env: Env): Env {
  return {
    ...env,
    GITHUB_APP_ID: "123",
    GITHUB_PRIVATE_KEY: privatePem,
  } as Env;
}

describe("handleWebhook 合并删分支", () => {
  it("web 合并 → 202 且 waitUntil 删除 refs/heads/imgbot", async () => {
    const { env, sent } = createHarness();
    const calls = stubGithubFetch(204);
    const { ctx, tasks } = createCtx();

    const response = await handleWebhook(
      await hookRequest(webMergePush([MERGE_COMMIT]), {
        event: "push",
        delivery: "d-merge",
      }),
      envWithAppKey(env),
      ctx,
    );

    expect(response.status).toBe(202);
    // 合并 push 没有触碰图片 → 不入队，但删分支必须在后台发生。
    expect(sent).toHaveLength(0);
    expect(tasks).toHaveLength(1);
    await Promise.all(tasks);

    const deletes = calls.filter((call) => call.method === "DELETE");
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.url).toBe(
      "https://api.github.com/repos/acme/site/git/refs/heads/imgbot",
    );
  });

  it("删除返回 404（分支已不存在）→ 静默，不抛错", async () => {
    const { env } = createHarness();
    stubGithubFetch(404);
    const { ctx, tasks } = createCtx();

    const response = await handleWebhook(
      await hookRequest(webMergePush([SQUASH_COMMIT]), {
        event: "push",
        delivery: "d-merge-404",
      }),
      envWithAppKey(env),
      ctx,
    );

    expect(response.status).toBe(202);
    await expect(Promise.all(tasks)).resolves.toBeDefined();
  });

  it("删除失败（500）不影响主流程：仍 202", async () => {
    const { env } = createHarness();
    stubGithubFetch(500);
    const { ctx, tasks } = createCtx();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await handleWebhook(
      await hookRequest(webMergePush([SQUASH_COMMIT]), {
        event: "push",
        delivery: "d-merge-500",
      }),
      envWithAppKey(env),
      ctx,
    );

    expect(response.status).toBe(202);
    await expect(Promise.all(tasks)).resolves.toBeDefined();
    spy.mockRestore();
  });

  it("非合并 push → 不注册删分支任务，也不发 GitHub 请求", async () => {
    const { env } = createHarness();
    const calls = stubGithubFetch(204);
    const { ctx, tasks } = createCtx();

    const response = await handleWebhook(
      await hookRequest(
        webMergePush(["feat: normal push", "fix: another normal push"]),
        { event: "push", delivery: "d-normal" },
      ),
      envWithAppKey(env),
      ctx,
    );

    expect(response.status).toBe(202);
    expect(tasks).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });
});
