/**
 * cron 编排（DESIGN.md §2.1 / §2.3 / §2.4）—— 两个 sweep 的 I/O 部分。
 *
 *   每 30 分钟  → `runPrPoisonSweep`：卡死 PR 巡检（原版 `PrPoisonHandler`）
 *                 目标集只来自 D1（我们碰过的仓库），不枚举 installation
 *   每日 03:00 → `runScheduleSweep`：`.imgbotconfig` 的 schedule 重优化
 *
 * 判定/解析逻辑全部在 `./scheduled-logic.ts`（纯函数）；本文件只做
 * GitHub API / D1 / Queue 访问。单个仓库失败只记日志，不中断整轮。
 */
import { generateAppJwt, getInstallationToken } from "../github/auth";
import {
  GITHUB_API_BASE,
  MAX_PAGES,
  PER_PAGE,
  REQUEST_TIMEOUT_MS,
  githubRequest,
  nextLink,
  type GithubHttpResult,
} from "../github/http";
import { toGithubApiError } from "../github/gitdata";
import { parseImgbotConfig } from "../config/imgbotconfig";
import type { Env } from "../types";
import {
  IMBOT_BRANCH,
  buildRecoveredPr,
  parseInstallationIds,
  parseInstallationRepos,
  prOverridesFromConfig,
  scheduleGate,
  selectSweepTargets,
  shouldRebuildPr,
  type CommitAuthorLike,
  type SweepRepoRow,
  type SweepRunRow,
  type SweepTarget,
} from "./scheduled-logic";

/** wrangler.jsonc `triggers.crons` 的两条表达式。 */
export const CRON_PR_POISON = "*/30 * * * *";
export const CRON_SCHEDULE = "0 3 * * *";

const CONFIG_PATH = ".imgbotconfig";

/* -------------------------------------------------------------------------- */
/* HTTP helpers                                                                */
/* -------------------------------------------------------------------------- */

/** GET/POST 统一入口；非 2xx 抛 `GithubApiError`（404 由 `requestOrNull` 吞掉）。 */
async function request(
  token: string,
  pathOrUrl: string,
  init: RequestInit = {},
  accept?: string,
): Promise<GithubHttpResult> {
  const result = await githubRequest({
    token,
    path: pathOrUrl,
    init,
    accept,
    timeoutMs: REQUEST_TIMEOUT_MS,
  });
  if (!result.ok) {
    throw await toGithubApiError(
      result.response,
      init.method ?? "GET",
      pathOrUrl,
      result.text ?? undefined,
    );
  }
  return result;
}

/** 404 → null（分支/文件不存在是正常状态，不是错误）。 */
async function requestOrNull(
  token: string,
  pathOrUrl: string,
  accept?: string,
): Promise<GithubHttpResult | null> {
  try {
    return await request(token, pathOrUrl, {}, accept);
  } catch (err) {
    if ((err as { status?: unknown }).status === 404) return null;
    throw err;
  }
}

function encodeSegment(value: string): string {
  return encodeURIComponent(value);
}

function repoPath(owner: string, repo: string, suffix = ""): string {
  return `/repos/${encodeSegment(owner)}/${encodeSegment(repo)}${suffix}`;
}

function splitRepo(fullName: string): { owner: string; repo: string } | null {
  const slash = fullName.indexOf("/");
  if (slash <= 0 || slash === fullName.length - 1) return null;
  return {
    owner: fullName.slice(0, slash),
    repo: fullName.slice(slash + 1),
  };
}

/* -------------------------------------------------------------------------- */
/* 枚举 installations / repositories                                           */
/* -------------------------------------------------------------------------- */

async function listInstallationIds(env: Env): Promise<number[]> {
  const jwt = await generateAppJwt(env.GITHUB_APP_ID, env.GITHUB_PRIVATE_KEY);
  const ids: number[] = [];
  let url: string | null =
    `${GITHUB_API_BASE}/app/installations?per_page=${PER_PAGE}`;

  for (let page = 0; url && page < MAX_PAGES; page += 1) {
    const res = await request(jwt, url);
    ids.push(...parseInstallationIds(res.body));
    url = nextLink(res.link);
  }
  if (url) {
    console.warn(
      `cron: installation listing truncated at MAX_PAGES=${MAX_PAGES} ` +
        `(${ids.length} installations seen); remaining installations skipped`,
    );
  }
  return ids;
}

async function installationToken(
  env: Env,
  installationId: number,
): Promise<string> {
  const { token } = await getInstallationToken({
    installationId,
    appId: env.GITHUB_APP_ID,
    privateKeyPem: env.GITHUB_PRIVATE_KEY,
  });
  return token;
}

async function listInstallationRepos(
  token: string,
  installationId: number,
): Promise<
  Array<{ repo: string; defaultBranch: string | null; isPrivate: boolean }>
> {
  const repos: Array<{
    repo: string;
    defaultBranch: string | null;
    isPrivate: boolean;
  }> = [];
  let url: string | null =
    `${GITHUB_API_BASE}/installation/repositories?per_page=${PER_PAGE}`;

  for (let page = 0; url && page < MAX_PAGES; page += 1) {
    const res = await request(token, url);
    repos.push(...parseInstallationRepos(res.body));
    url = nextLink(res.link);
  }
  if (url) {
    // 分页见底还有 next：明确记录被截断的 installation，别静默少扫。
    console.warn(
      `cron: installation ${installationId} repository listing truncated at ` +
        `MAX_PAGES=${MAX_PAGES} (${repos.length} repos seen); remaining repos skipped`,
    );
  }
  return repos;
}

async function resolveDefaultBranch(
  token: string,
  owner: string,
  repo: string,
  known: string | null,
): Promise<string | null> {
  if (known) return known;
  const res = await requestOrNull(token, repoPath(owner, repo));
  if (!res) return null;
  const body = res.body as { default_branch?: unknown };
  return typeof body.default_branch === "string" && body.default_branch
    ? body.default_branch
    : null;
}

/**
 * 取默认分支根目录下的文本文件（`.imgbotconfig`）。
 * 先列根树拿 blob sha，再按 raw 取内容：缺文件/空仓库 → null。
 */
async function fetchRootFileText(
  token: string,
  owner: string,
  repo: string,
  ref: string,
): Promise<string | null> {
  const treeRes = await requestOrNull(
    token,
    repoPath(owner, repo, `/git/trees/${ref}`),
  );
  if (!treeRes) return null;

  const body = treeRes.body as {
    tree?: Array<{ path?: unknown; type?: unknown; sha?: unknown }>;
  };
  const entry = (body.tree ?? []).find(
    (item) => item.path === CONFIG_PATH && item.type === "blob",
  );
  if (!entry || typeof entry.sha !== "string" || !entry.sha) return null;

  // accept=raw 必须单独传：默认 header 是 JSON，会返回 base64 包装体。
  const blobRes = await requestOrNull(
    token,
    repoPath(owner, repo, `/git/blobs/${encodeSegment(entry.sha)}`),
    "application/vnd.github.raw",
  );
  if (!blobRes) return null;
  return blobRes.text ?? "";
}

/* -------------------------------------------------------------------------- */
/* ② schedule 重优化 sweep                                                     */
/* -------------------------------------------------------------------------- */

/**
 * 每日 sweep：对每个已安装仓库读 `.imgbotconfig`，`schedule` 开启且门限通过
 * 则投递一条 `trigger: "schedule"` 的描述符。
 */
export async function runScheduleSweep(
  env: Env,
  now: Date = new Date(),
): Promise<void> {
  let installationIds: number[];
  try {
    installationIds = await listInstallationIds(env);
  } catch (error) {
    console.error("schedule sweep: list installations failed", error);
    return;
  }

  for (const installationId of installationIds) {
    let token: string;
    let repos: Array<{
      repo: string;
      defaultBranch: string | null;
      isPrivate: boolean;
    }>;
    try {
      token = await installationToken(env, installationId);
      repos = await listInstallationRepos(token, installationId);
    } catch (error) {
      console.error(
        `schedule sweep: installation ${installationId} failed`,
        error,
      );
      continue;
    }

    for (const entry of repos) {
      try {
        await maybeScheduleRepo(env, token, installationId, entry, now);
      } catch (error) {
        console.error(`schedule sweep: repo ${entry.repo} failed`, error);
      }
    }
  }
}

async function maybeScheduleRepo(
  env: Env,
  token: string,
  installationId: number,
  entry: { repo: string; defaultBranch: string | null; isPrivate: boolean },
  now: Date,
): Promise<void> {
  const split = splitRepo(entry.repo);
  if (!split) return;

  const baseRef = await resolveDefaultBranch(
    token,
    split.owner,
    split.repo,
    entry.defaultBranch,
  );
  if (!baseRef) return;

  const configText = await fetchRootFileText(
    token,
    split.owner,
    split.repo,
    baseRef,
  );
  const config = parseImgbotConfig(configText);
  if (!config.schedule) return;

  const lastRunAt = await lastRunAtFor(env, installationId, entry.repo);
  if (!scheduleGate(config.schedule, lastRunAt, now)) return;

  // D8：门限只看运行史；base_sha 留给 Workflow 自己解析，避免这里多烧一次调用。
  await env.ROUTER.send(
    {
      run_id: crypto.randomUUID(),
      installation_id: installationId,
      repo: entry.repo,
      trigger: "schedule",
      base_ref: baseRef,
      private: entry.isPrivate,
    },
    { contentType: "json" },
  );
}

/** 该仓库最近一次任意 run 的创建时间（D8 门限输入）。 */
async function lastRunAtFor(
  env: Env,
  installationId: number,
  repo: string,
): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT created_at FROM runs WHERE installation_id = ? AND repo = ? " +
      "ORDER BY created_at DESC LIMIT 1",
  )
    .bind(installationId, repo)
    .first<{ created_at: string }>();
  return row?.created_at ?? null;
}

/* -------------------------------------------------------------------------- */
/* ③ 卡死 PR 巡检 sweep                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 每 30 分钟：有 `imgbot` 分支、无 open PR、tip 是 bot → 从 commit message 重建 PR。
 *
 * **目标集只来自 D1**（P1 加固 #5）：不再枚举 installation / repository，只巡
 * 「我们碰过」的仓库（`selectSweepTargets` 的 runs/repos/pulls 并集）。
 *
 * GitHub 调用预算对比（一个装了 N 个仓库、其中 M 个有历史的 installation）：
 *
 *   旧：每轮 1×列 installations + 每 installation 1×token + ⌈N/100⌉×仓库分页
 *       + N×≥1（每仓库至少查一次 `heads/imgbot`）；30 分钟一轮 ≈ 48 轮/天，
 *       即 ≥48×N 次调用/天（N 大时仓库分页还会静默截断）。
 *   新：每轮 0×列 installations + 每 installation 1×token + M×1..4（有 PR 重建
 *       才走后面几步）。仓库每 30 分钟不再无条件被查 → O(有历史的仓库)，
 *       而非 O(全部已安装仓库)。
 *
 * 代价（有意接受）：D1 里已卸载/改名的仓库仍会被巡——卸载的 installation
 * 在取 token 时 403，只留一条日志（每轮 1 次失败调用），不再扩散到全仓扫描。
 */
export async function runPrPoisonSweep(
  env: Env,
  now: Date = new Date(),
): Promise<void> {
  let targets: SweepTarget[];
  try {
    targets = selectSweepTargets(await loadSweepSources(env), now);
  } catch (error) {
    console.error("pr poison sweep: load D1 targets failed", error);
    return;
  }

  if (targets.length === 0) {
    console.log("pr poison sweep: no D1 history, nothing to sweep");
    return;
  }
  console.log(`pr poison sweep: ${targets.length} target repo(s)`);

  // 按 installation 分组：每个 installation 只换一次 token，一个目标失败不连坐。
  const grouped = new Map<number, SweepTarget[]>();
  for (const target of targets) {
    const group = grouped.get(target.installationId);
    if (group) group.push(target);
    else grouped.set(target.installationId, [target]);
  }

  for (const [installationId, group] of grouped) {
    let token: string;
    try {
      token = await installationToken(env, installationId);
    } catch (error) {
      console.error(
        `pr poison sweep: installation ${installationId} token failed`,
        error,
      );
      continue;
    }

    for (const target of group) {
      try {
        await recoverRepoPr(token, {
          repo: target.repo,
          defaultBranch: target.defaultBranch,
        });
      } catch (error) {
        console.error(`pr poison sweep: repo ${target.repo} failed`, error);
      }
    }
  }
}

/**
 * D1 侧的三路候选（薄查询，判定全部在 `selectSweepTargets`）。
 * `runs` 取每仓库最近一次 run 的时间（90 天窗口由纯函数判定）；
 * `repos` / `pulls` 是小表，整表读即可（仓库数无关）。
 */
async function loadSweepSources(env: Env): Promise<{
  runs: SweepRunRow[];
  repos: SweepRepoRow[];
  pulls: SweepRepoRow[];
}> {
  const [runs, repos, pulls] = await Promise.all([
    env.DB.prepare(
      "SELECT installation_id, repo, MAX(created_at) AS last_run_at " +
        "FROM runs GROUP BY installation_id, repo",
    ).all<SweepRunRow>(),
    env.DB.prepare(
      "SELECT installation_id, name AS repo, default_branch FROM repos",
    ).all<SweepRepoRow>(),
    env.DB.prepare(
      "SELECT DISTINCT installation_id, repo FROM pulls",
    ).all<SweepRepoRow>(),
  ]);

  return {
    runs: runs.results ?? [],
    repos: repos.results ?? [],
    pulls: pulls.results ?? [],
  };
}

interface PullSummary {
  number: number;
  closedAt: string | null;
  updatedAt: string | null;
}

async function listPulls(
  token: string,
  owner: string,
  repo: string,
  params: Record<string, string>,
): Promise<PullSummary[]> {
  const query = new URLSearchParams({ per_page: PER_PAGE, ...params });
  const res = await request(
    token,
    `${repoPath(owner, repo, "/pulls")}?${query.toString()}`,
  );
  const body = res.body as unknown;
  if (!Array.isArray(body)) return [];

  const pulls: PullSummary[] = [];
  for (const item of body) {
    if (item === null || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (typeof record.number !== "number") continue;
    pulls.push({
      number: record.number,
      closedAt: typeof record.closed_at === "string" ? record.closed_at : null,
      updatedAt:
        typeof record.updated_at === "string" ? record.updated_at : null,
    });
  }
  return pulls;
}

interface TipCommit {
  message: string | null;
  author: CommitAuthorLike;
  committedAt: string | null;
}

async function fetchTipCommit(
  token: string,
  owner: string,
  repo: string,
  ref: string,
): Promise<TipCommit | null> {
  const res = await requestOrNull(
    token,
    repoPath(owner, repo, `/commits/${encodeSegment(ref)}`),
  );
  if (!res) return null;

  const body = res.body as {
    commit?: {
      message?: unknown;
      author?: { name?: unknown; email?: unknown; date?: unknown };
      committer?: { date?: unknown };
    };
    author?: { login?: unknown; type?: unknown } | null;
  };

  const commitAuthor = body.commit?.author;
  const message =
    typeof body.commit?.message === "string" ? body.commit.message : null;
  return {
    message,
    author: {
      name: typeof commitAuthor?.name === "string" ? commitAuthor.name : null,
      email:
        typeof commitAuthor?.email === "string" ? commitAuthor.email : null,
      login: typeof body.author?.login === "string" ? body.author.login : null,
      type: typeof body.author?.type === "string" ? body.author.type : null,
    },
    committedAt:
      typeof commitAuthor?.date === "string"
        ? commitAuthor.date
        : typeof body.commit?.committer?.date === "string"
          ? body.commit.committer.date
          : null,
  };
}

async function recoverRepoPr(
  token: string,
  entry: { repo: string; defaultBranch: string | null },
): Promise<void> {
  const split = splitRepo(entry.repo);
  if (!split) return;
  const { owner, repo } = split;

  // ① `heads/imgbot` 必须存在；404 即无事可做。
  const refRes = await requestOrNull(
    token,
    repoPath(owner, repo, `/git/ref/heads/${IMBOT_BRANCH}`),
  );
  if (!refRes) return;

  // ② 已有 head=imgbot 的 open PR → 不重复开。
  const openPulls = await listPulls(token, owner, repo, {
    state: "open",
    head: `${owner}:${IMBOT_BRANCH}`,
    per_page: "1",
  });
  if (openPulls.length > 0) return;

  // ③ tip 作者必须是 bot（人类动过的分支不碰，§2.1）。
  const tip = await fetchTipCommit(token, owner, repo, IMBOT_BRANCH);
  if (!tip) return;

  // ④ 分支比最近一次 closed PR 旧 → 不重建（原版语义）。
  const closedPulls = await listPulls(token, owner, repo, {
    state: "closed",
    head: `${owner}:${IMBOT_BRANCH}`,
    sort: "updated",
    direction: "desc",
    per_page: "1",
  });
  const lastClosed = closedPulls[0] ?? null;

  if (
    !shouldRebuildPr({
      branchExists: true,
      hasOpenPull: false,
      tipAuthor: tip.author,
      tipCommittedAt: tip.committedAt,
      lastClosedPrAt: lastClosed?.closedAt ?? lastClosed?.updatedAt ?? null,
    })
  ) {
    return;
  }

  // ⑤ 重建 PR 内容：`.imgbotconfig` 的 prTitle/prBody 覆盖 + commit message 统计。
  const baseRef = await resolveDefaultBranch(
    token,
    owner,
    repo,
    entry.defaultBranch,
  );
  if (!baseRef) return;

  const configText = await fetchRootFileText(token, owner, repo, baseRef);
  const content = buildRecoveredPr(
    tip.message,
    prOverridesFromConfig(configText),
  );
  if (!content) return;

  const res = await request(token, repoPath(owner, repo, "/pulls"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: content.title,
      body: content.body,
      head: IMBOT_BRANCH,
      base: baseRef,
    }),
  });
  const created = res.body as { number?: unknown };
  console.log(
    `pr poison sweep: recreated PR #${String(created.number)} for ${entry.repo}`,
  );
}
