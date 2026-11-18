/**
 * §5.3 `OptimizeRun` —— 单仓库一次运行的 Workflow 编排。
 *
 * 步骤（步名确定性，**勿用时间戳**，否则重放语义失效）：
 *   init-run → load-config → scan-tree → optimize-batch-{0..n} → commit → open-pr → cleanup
 *
 * 每步都会：① 更新 D1 `runs.state`（§5.1 状态机）② 调 DO `heartbeat` 续租（§5.4）。
 * 步返回值只传 R2 key + 统计（≤1MiB/步，§5.3 注记），图片字节永不进 step 结果。
 *
 * 失败语义：任一步耗尽重试 → `failed` + cleanup（删暂存 + 释锁）→ 原样抛出让 Workflow 记录。
 * `GithubApiError.retryable`（429 / 次级限速 / 5xx）原样抛，由步进重试退避消化（§4.2）。
 */

import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";

import {
  compileIgnorePatterns,
  filterIgnoredPaths,
  parseImgbotConfig,
  defaultConfig,
} from "../config/imgbotconfig";
import {
  type InstallationTokenCache,
  getInstallationToken,
} from "../github/auth";
import {
  GITHUB_API_BASE,
  GITHUB_API_VERSION,
  GitDataClient,
  GithubApiError,
  normalizeRef,
  toBase64,
  toGithubApiError,
  type CommitAuthor,
  type FetchLike,
} from "../github/gitdata";
import {
  WikiNotFoundError,
  cloneWiki,
  pushWikiChanges,
} from "../github/wiki-git";
import { optimizeViaContainer } from "../container/oversize-client";
import { MAX_CONTAINER_INPUT_BYTES } from "../container/limits";
import { optimizeImage } from "../optimize/dispatch";
import type {
  CompressionResult,
  Env,
  RepoConfig,
  RunDescriptor,
  RunState,
  SkipReason,
  TreeBlob,
} from "../types";
import {
  createCommitMessage,
  createPrBody,
  createPrTitle,
} from "../ux/templates";
import { getCodecSet } from "./codecs-boot";
import { checkPrivateQuota } from "./private-quota";
import {
  BATCH_SIZE,
  MAX_PR_IMAGES,
  MAX_PR_TOTAL_BYTES,
  sha256Hex,
  splitCommitMessage,
  buildImageStats,
  bytesToKb,
  chunk,
  shouldAbortForTruncatedReplays,
  shouldSkipDisabled,
  splitOwnerRepo,
  stagingRefForRun,
  sumSizes,
  thresholdGate,
  tipViolatesGuard,
  withinContainerInputCap,
  withinPrBudget,
  type OptimizedImage,
} from "./logic";

/* -------------------------------------------------------------------------- */
/* 常量                                                                        */
/* -------------------------------------------------------------------------- */

/** §2.1 / D5：唯一长驻分支名。 */
const IMGBOT_REF = "heads/imgbot";
/** bot 提交者身份（§2.1 人类改动守卫的比对基准；D6）。 */
const BOT_NAME = "image-bot-cf[bot]";
/** §2.2 D6：commit 作者用本 App 的 bot 身份（不是原版 ImgBotApp）。 */
const BOT_AUTHOR: CommitAuthor = {
  name: "image-bot-cf[bot]",
  email: "image-bot-cf[bot]@users.noreply.github.com",
};
/** §2.3 配置文件路径（仓库根）。 */
const CONFIG_PATH = ".imgbotconfig";
/** §1.1 P1 支持的图片扩展名（GIF 会在 dispatch 里归为 `unsupported`，P2 补 gifsicle）。 */
const IMAGE_PATH_PATTERN = /\.(png|jpe?g|gif|svg)$/i;
/** §5.3「步返回 ≤1MiB」：候选清单超此数量截断（分页多步属 P2）。 */
const MAX_SCAN_ENTRIES = 2000;
/** D1 `runs.error` 截断长度（避免把整页 HTML 写进库）。 */
const MAX_ERROR_LENGTH = 500;

const STEP_CONFIG = {
  initRun: {
    retries: { limit: 3, delay: "30 seconds", backoff: "exponential" },
    timeout: "30 seconds",
  },
  loadConfig: {
    retries: { limit: 3, delay: "30 seconds", backoff: "exponential" },
    timeout: "1 minute",
  },
  scanTree: {
    retries: { limit: 3, delay: "1 minute", backoff: "exponential" },
    timeout: "5 minutes",
  },
  // §5.3：`optimize-batch` 的 `limits.cpu_ms: 300000` 由 workflow 绑定侧配置，
  // WorkflowStepConfig 无此字段；这里只表达重试/墙钟超时。
  optimizeBatch: {
    retries: { limit: 2, delay: "1 minute", backoff: "exponential" },
    timeout: "10 minutes",
  },
  commit: {
    retries: { limit: 3, delay: "1 minute", backoff: "exponential" },
    timeout: "5 minutes",
  },
  openPr: {
    retries: { limit: 3, delay: "1 minute", backoff: "exponential" },
    timeout: "5 minutes",
  },
  cleanup: {
    retries: { limit: 3, delay: "10 seconds", backoff: "exponential" },
    timeout: "1 minute",
  },
} as const;

/* -------------------------------------------------------------------------- */
/* installation token 缓存（P1：isolate 内存）                                  */
/* -------------------------------------------------------------------------- */

/**
 * P1 用 isolate 内内存 Map 兜住同一 isolate 的多次取 token（同 run 的多个步大概率同 isolate）。
 * ⚠️ P2 换成 DO/KV 缓存（§4.1：「DO 内缓存并提前 5min 轮换」），跨 isolate 才真正省调用。
 */
const TOKEN_CACHE = new Map<string, { value: string; expiresAtMs: number }>();

const MEMORY_TOKEN_CACHE: InstallationTokenCache = {
  get(key: string): string | null {
    const hit = TOKEN_CACHE.get(key);
    if (!hit) return null;
    if (hit.expiresAtMs <= Date.now()) {
      TOKEN_CACHE.delete(key);
      return null;
    }
    return hit.value;
  },
  set(key: string, value: string, ttlSec: number): void {
    TOKEN_CACHE.set(key, { value, expiresAtMs: Date.now() + ttlSec * 1000 });
  },
};

/* -------------------------------------------------------------------------- */
/* step 结果形状（必须可结构化克隆）                                            */
/* -------------------------------------------------------------------------- */

interface LoadConfigResult {
  config: RepoConfig;
  baseRef: string;
  /** base 分支头 commit sha（commit 步的 `parentSha`）。 */
  baseSha: string;
  /** 根树 sha（`createTreeWithShas` 的 `base_tree`）。 */
  rootTreeSha: string;
  /** 仅图片扩展名条目（已按 §5.3 上限截断）。 */
  entries: TreeBlob[];
  /** §9-R10：GitHub 标记 tree 被截断（P2 退化为分目录递归）。 */
  treeTruncated: boolean;
}

/** 本轮不进入扫描的终态原因（load-config 判定，run() 映射成 `skipped_disabled`）。 */
type SkipSignalReason = "repo_disabled" | "private_quota_exceeded";

/**
 * load-config 结果用判别式返回：终态原因必须随 step 结果一起重放，
 * 不能放在闭包变量里（Workflow 恢复时 step 不会重跑）。
 */
type LoadConfigOutcome =
  | { kind: "loaded"; result: LoadConfigResult }
  | { kind: "skipped"; reason: SkipSignalReason };

/** §7.3 正向缓存的统计重放（PR body / commit message 的全量口径）。 */
interface ReplayStat {
  path: string;
  /** 源 blob sha（image_cache 主键的一部分）。 */
  sourceHash: string;
  /** 已提交产物的 blob sha（内容重放的查找键）。 */
  resultHash: string;
  beforeBytes: number;
  afterBytes: number;
  beforeKb: number;
  afterKb: number;
}

interface ScanResult {
  /** 每块 ≤`BATCH_SIZE` 图的候选清单；块序即 `optimize-batch-{i}` 的序号。 */
  batches: TreeBlob[][];
  /** 参与扫描的图片数（忽略规则过滤后）。 */
  imagesTotal: number;
  /** 命中 `image_cache` 而跳过的数量（§7.3，含正负向）。 */
  cachedSkipped: number;
  /** 正向缓存命中（已优化且已提交）的统计，进 commit/open-pr 的全量口径。 */
  replayed: ReplayStat[];
}

interface SkippedImage {
  path: string;
  reason: SkipReason;
  /** 兜底通道的诊断标签（如容器工具名/错误原因）。 */
  tool?: string;
}

interface BatchResult {
  optimized: OptimizedImage[];
  skipped: SkippedImage[];
}

/** wiki 通道（§2.3 compressWiki）的单步产出。 */
interface WikiPassOutcome {
  status: "committed" | "skipped_nochange" | "skipped_guard";
  imagesTotal: number;
  optimizedCount: number;
}

interface CommitResult {
  status:
    | "committed"
    | "skipped_nochange"
    | "skipped_threshold"
    | "aborted"
    /** 显式失败（负载超预算 / 截断树丢重放）：已 `patchRun` failed，不再抛错重试。 */
    | "failed";
  commitSha?: string;
}

/* -------------------------------------------------------------------------- */
/* D1 / R2 辅助                                                                */
/* -------------------------------------------------------------------------- */

type RunPatch = {
  state?: RunState;
  base_sha?: string | null;
  commit_sha?: string | null;
  pr_number?: number | null;
  images_total?: number | null;
  images_optimized?: number | null;
  bytes_before?: number | null;
  bytes_after?: number | null;
  min_kb_reduced?: number | null;
  error?: string | null;
  finished_at?: string | null;
};

/** 更新 `runs` 行（列名来自类型化白名单，无字符串拼接注入面）。 */
async function patchRun(
  env: Env,
  runId: string,
  patch: RunPatch,
): Promise<void> {
  const entries = Object.entries(patch).filter(
    ([, value]) => value !== undefined,
  ) as [string, string | number | null][];
  if (entries.length === 0) return;

  const assignments = entries.map(([column]) => `${column} = ?`).join(", ");
  await env.DB.prepare(`UPDATE runs SET ${assignments} WHERE run_id = ?`)
    .bind(...entries.map(([, value]) => value), runId)
    .run();
}

const IMAGE_CACHE_UPSERT =
  "INSERT INTO image_cache " +
  "(installation_id, repo, path, source_hash, result_hash, source_size, result_size, optimized_at) " +
  "VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
  "ON CONFLICT(installation_id, repo, path, source_hash) DO UPDATE SET " +
  "result_hash = excluded.result_hash, source_size = excluded.source_size, " +
  "result_size = excluded.result_size, optimized_at = excluded.optimized_at";

const PULL_UPSERT =
  "INSERT INTO pulls (installation_id, repo, pr_number, head_sha, state, opened_at) " +
  "VALUES (?, ?, ?, ?, 'open', ?) " +
  "ON CONFLICT(installation_id, repo, pr_number) DO UPDATE SET " +
  "head_sha = excluded.head_sha, state = 'open', closed_at = NULL";

/** `image_cache` 命中键：`(repo, path, source_hash)`（§7.3）。 */
function cacheKey(path: string, sourceHash: string): string {
  return `${path}\u0000${sourceHash}`;
}

/** §7.2 `staging/{run_id}/{path}`；原图/产物用后缀区分。 */
function stagingKey(runId: string, path: string, kind: "orig" | "opt"): string {
  return `staging/${runId}/${path}.${kind}`;
}

/** §7.2 / §5.3 cleanup：删掉 `staging/{run_id}/` 前缀下所有对象（分页）。 */
async function deleteStagingPrefix(env: Env, runId: string): Promise<void> {
  const prefix = `staging/${runId}/`;
  let cursor: string | undefined;
  for (;;) {
    const listed = await env.STAGING.list(
      cursor ? { prefix, cursor } : { prefix },
    );
    if (listed.objects.length > 0) {
      await env.STAGING.delete(listed.objects.map((object) => object.key));
    }
    if (!listed.truncated) return;
    cursor = listed.cursor;
    if (!cursor) return;
  }
}

function errorText(err: unknown): string {
  const message =
    err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return message.slice(0, MAX_ERROR_LENGTH);
}

/**
 * 本轮直接收尾的终态信号（停用仓库 / 私有配额超限）。
 *
 * 只在 step **外**抛出：步进重试只作用于 step 内部，这里不重试、不算失败；
 * `run()` 的 catch 会把它映射成 `skipped_disabled` 并照常走 cleanup（删暂存 + 释锁）。
 * `reason` 与 load-config 已写入 `runs.error` 的值一致（`repo_disabled` /
 * `private_quota_exceeded`），只用于日志与终态映射。
 */
class RepoDisabledSignal extends Error {
  constructor(readonly reason: SkipSignalReason = "repo_disabled") {
    super(reason);
    this.name = "RepoDisabledSignal";
  }
}

/* -------------------------------------------------------------------------- */
/* GitHub 辅助                                                                 */
/* -------------------------------------------------------------------------- */

interface GithubContext {
  client: GitDataClient;
  token: string;
}

async function githubContext(
  env: Env,
  installationId: number,
): Promise<GithubContext> {
  const { token } = await getInstallationToken({
    installationId,
    appId: env.GITHUB_APP_ID,
    privateKeyPem: env.GITHUB_PRIVATE_KEY,
    cache: MEMORY_TOKEN_CACHE,
  });
  return { client: new GitDataClient({ token }), token };
}

/**
 * 取某个 ref 指向的 **commit sha**。
 *
 * ⚠️ 跨模块缺口：`GitDataClient` 目前没有 ref 读取方法（`getTreeRootSha` 返回的是树 sha，
 * 不能当 commit 的 `parentSha`）。`RunDescriptor.base_sha` 有值时不走这里；
 * 只有 installation/schedule 这类没带 `base_sha` 的触发才需要补一次 `GET /git/ref`。
 * gitdata 侧补齐 `getRef` 后应删除本函数（错误映射复用其导出的 `toGithubApiError`）。
 */
async function fetchHeadCommitSha(
  token: string,
  owner: string,
  repo: string,
  ref: string,
): Promise<string> {
  // 注意：分支名里的 `/` 必须保持未编码（GitHub 的 `:ref` 语义）。
  const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
    repo,
  )}/git/ref/${normalizeRef(ref)}`;
  const fetchImpl = globalThis.fetch as FetchLike | undefined;
  if (typeof fetchImpl !== "function") {
    throw new Error("OptimizeRun requires a fetch implementation");
  }

  let res: Response;
  try {
    res = await fetchImpl(`${GITHUB_API_BASE}${path}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": GITHUB_API_VERSION,
        "user-agent": "image-bot-cf",
      },
    });
  } catch (err) {
    throw new GithubApiError({
      status: 0,
      message: `GitHub GET ${path} network error`,
      retryable: true,
      cause: err,
    });
  }
  if (!res.ok) throw await toGithubApiError(res, "GET", path);

  const body = (await res.json()) as { object?: { sha?: unknown } };
  const sha = body.object?.sha;
  if (typeof sha !== "string" || sha.length === 0) {
    throw new GithubApiError({
      status: 502,
      message: `GitHub GET ${path} response is missing \`object.sha\``,
      retryable: true,
    });
  }
  return sha;
}

/* -------------------------------------------------------------------------- */
/* Workflow                                                                    */
/* -------------------------------------------------------------------------- */

export class OptimizeRun extends WorkflowEntrypoint<Env, RunDescriptor> {
  /**
   * §2.3 compressWiki 的 wiki 通道：clone → 优化 → 直接 push wiki 默认分支。
   * 与主通道的差异：无 PR、无阈值门、无人类守卫（wiki 本来就是人编辑的）；
   * 读写全走 git 协议（isomorphic-git）——REST Git Data API 不服务 `.wiki` 仓（§11-2 判别实验）。
   * clone+优化+commit 合并为单步：wiki 极小，步进重试即整体重做（同内容 push 为 no-op）。
   */
  private async wikiPass(
    event: WorkflowEvent<RunDescriptor>,
    step: WorkflowStep,
  ): Promise<void> {
    const env = this.env;
    const params = event.payload;
    const runId = params.run_id;
    const installationId = params.installation_id;
    const slash = params.repo.indexOf("/");
    const owner = params.repo.slice(0, slash);
    const wikiRepo = params.repo.slice(slash + 1);

    let terminalState: RunState = "done";
    let failure: unknown = null;
    let imagesTotal = 0;
    let optimizedCount = 0;

    try {
      await step.do("wiki-init", STEP_CONFIG.initRun, async () => {
        await this.heartbeat(runId, installationId, params.repo);
        await env.DB.prepare(
          "INSERT OR IGNORE INTO runs " +
            "(run_id, installation_id, repo, trigger, state, created_at) " +
            "VALUES (?, ?, ?, ?, ?, ?)",
        )
          .bind(
            runId,
            installationId,
            params.repo,
            params.trigger,
            "scanning",
            new Date().toISOString(),
          )
          .run();
      });

      const outcome = await step.do<WikiPassOutcome>(
        "wiki-optimize-commit",
        STEP_CONFIG.optimizeBatch,
        async () => {
          await this.heartbeat(runId, installationId, params.repo);
          const { token } = await githubContext(env, installationId);

          let cloned: Awaited<ReturnType<typeof cloneWiki>>;
          try {
            cloned = await cloneWiki({ owner, wikiRepo, token });
          } catch (err) {
            if (err instanceof WikiNotFoundError) {
              return {
                status: "skipped_guard" as const,
                imagesTotal: 0,
                optimizedCount: 0,
              };
            }
            throw err;
          }

          // config 取 wiki 自己的 `.imgbotconfig`（wiki 与主仓独立配置，原版语义）
          const rawConfig = cloned.files.get(".imgbotconfig");
          const config = parseImgbotConfig(
            rawConfig ? new TextDecoder().decode(rawConfig) : null,
          );

          const patterns = compileIgnorePatterns(config.ignoredFiles);
          const allPaths = [...cloned.files.keys()].filter((p) =>
            /\.(png|jpe?g|gif|svg)$/i.test(p),
          );
          const candidates = filterIgnoredPaths(allPaths, patterns);

          const cacheRows = await env.DB.prepare(
            "SELECT path, source_hash FROM image_cache " +
              "WHERE installation_id = ? AND repo = ?",
          )
            .bind(installationId, params.repo)
            .all<{ path: string; source_hash: string }>();
          const seen = new Set(
            (cacheRows.results ?? []).map((row) =>
              cacheKey(row.path, row.source_hash),
            ),
          );

          const pending: Array<{
            path: string;
            bytes: Uint8Array;
            sourceHash: string;
          }> = [];
          for (const path of candidates) {
            const bytes = cloned.files.get(path)!;
            const sourceHash = await sha256Hex(bytes);
            if (!seen.has(cacheKey(path, sourceHash))) {
              pending.push({ path, bytes, sourceHash });
            }
          }

          const codecs = await getCodecSet();
          const changes = new Map<string, Uint8Array>();
          const results: OptimizedImage[] = [];
          for (const item of pending) {
            const outcome = await optimizeImage(item.path, item.bytes, {
              aggressive: config.aggressiveCompression,
              codecs,
            });
            if (outcome.optimized && outcome.optimizedSize !== null) {
              changes.set(item.path, outcome.optimized);
              results.push({
                path: item.path,
                sourceSha: item.sourceHash,
                resultHash: await sha256Hex(outcome.optimized),
                beforeBytes: outcome.originalSize,
                afterBytes: outcome.optimizedSize,
                beforeKb: bytesToKb(outcome.originalSize),
                afterKb: bytesToKb(outcome.optimizedSize),
              });
            } else if (
              outcome.skipped === "not_smaller" ||
              outcome.skipped === "decode_failed"
            ) {
              // 负向缓存（§7.3，wiki 同语义）
              await env.DB.prepare(IMAGE_CACHE_UPSERT)
                .bind(
                  installationId,
                  params.repo,
                  item.path,
                  item.sourceHash,
                  null,
                  item.bytes.length,
                  null,
                  new Date().toISOString(),
                )
                .run();
            }
          }

          if (results.length === 0) {
            return {
              status: "skipped_nochange" as const,
              imagesTotal: candidates.length,
              optimizedCount: 0,
            };
          }

          // wiki 无阈值门（§2.3）；commit message 同模板（原版语义）
          const message = createCommitMessage(
            results.map((r) => ({
              title: `*${r.path}`,
              sizeBeforeKb: r.beforeKb,
              sizeAfterKb: r.afterKb,
            })),
          );
          const pushed = await pushWikiChanges({
            owner,
            wikiRepo,
            token,
            branch: cloned.branch,
            baseSha: cloned.headSha,
            changes,
            message,
          });

          const nowIso = new Date().toISOString();
          for (const r of results) {
            await env.DB.prepare(IMAGE_CACHE_UPSERT)
              .bind(
                installationId,
                params.repo,
                r.path,
                r.sourceSha,
                r.resultHash,
                r.beforeBytes,
                r.afterBytes,
                nowIso,
              )
              .run();
          }
          await patchRun(env, runId, {
            state: "done",
            images_total: candidates.length,
            images_optimized: results.length,
            bytes_before: sumSizes(results).beforeBytes,
            bytes_after: sumSizes(results).afterBytes,
            commit_sha: pushed.commitSha,
          });
          return {
            status: "committed" as const,
            imagesTotal: candidates.length,
            optimizedCount: results.length,
          };
        },
      );

      imagesTotal = outcome.imagesTotal;
      optimizedCount = outcome.optimizedCount;
      terminalState = outcome.status === "committed" ? "done" : outcome.status;
    } catch (err) {
      failure = err;
      terminalState = "failed";
    }

    try {
      await step.do("cleanup", STEP_CONFIG.cleanup, async () => {
        await this.heartbeat(runId, installationId, params.repo);
        const patch: RunPatch = {
          state: terminalState,
          images_total: imagesTotal,
          images_optimized: optimizedCount,
          finished_at: new Date().toISOString(),
        };
        if (failure) patch.error = errorText(failure);
        await patchRun(env, runId, patch);
        await this.repoLock(installationId, params.repo).finish(runId);
      });
    } catch (cleanupErr) {
      if (!failure) throw cleanupErr;
      console.error(
        `[OptimizeRun] wiki cleanup failed for ${runId}`,
        cleanupErr,
      );
    }

    if (failure) throw failure;
  }

  async run(
    event: WorkflowEvent<RunDescriptor>,
    step: WorkflowStep,
  ): Promise<void> {
    const env = this.env;
    const params = event.payload;
    const runId = params.run_id;
    const installationId = params.installation_id;
    const { owner, repo } = splitOwnerRepo(params.repo);

    // §2.3 compressWiki：wiki 仓走独立通道（REST Git Data API 不服务 `.wiki` 仓——
    // 判别实验见 §11-2；走 git 协议 isomorphic-git，直接推 wiki 默认分支，无 PR 无阈值门）
    if (params.repo.endsWith(".wiki")) {
      return this.wikiPass(event, step);
    }

    let terminalState: RunState = "done";
    let failure: unknown = null;
    let imagesTotal = 0;
    let optimized: OptimizedImage[] = [];
    let commitSha: string | null = null;
    // 确定赋值：load-config 步成功后才有值；失败路径 cleanup 里用 `loaded?.` 安全访问
    let loaded!: LoadConfigResult;

    try {
      /* ---------------------------------------------------------------- */
      /* ① init-run：D1 记账（幂等：run_id 已存在则直接成功）               */
      /*                                                                    */
      /* §5.4：锁在入口漏斗 `RepoLock.submit()` 里已经抢到（Workflow 实例   */
      /* 由它创建），所以这一步只做记账 + 首次续租。                         */
      /* ---------------------------------------------------------------- */
      await step.do("init-run", STEP_CONFIG.initRun, async () => {
        await this.heartbeat(runId, installationId, params.repo);
        await env.DB.prepare(
          "INSERT OR IGNORE INTO runs " +
            "(run_id, installation_id, repo, trigger, state, base_sha, created_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
          .bind(
            runId,
            installationId,
            params.repo,
            params.trigger,
            "queued",
            params.base_sha ?? null,
            new Date().toISOString(),
          )
          .run();
        return { runId };
      });

      /* ---------------------------------------------------------------- */
      /* ② load-config：默认分支 + 根树 + `.imgbotconfig`                  */
      /* ---------------------------------------------------------------- */
      const loadedConfig = await step.do<LoadConfigOutcome>(
        "load-config",
        STEP_CONFIG.loadConfig,
        async () => {
          await this.heartbeat(runId, installationId, params.repo);

          // 仪表盘开关必须真正生效：`repos.enabled = 0` → 本轮不扫描、不开 PR。
          // 缺行 = 默认启用（与 dashboard 的 enabled 语义一致）；不扣配额、不算失败。
          const repoRow = await env.DB.prepare(
            "SELECT enabled FROM repos WHERE installation_id = ? AND name = ?",
          )
            .bind(installationId, params.repo)
            .first<{ enabled: number | null }>();
          if (shouldSkipDisabled(repoRow?.enabled ?? null)) {
            await patchRun(env, runId, {
              state: "skipped_disabled",
              error: "repo_disabled",
            });
            return {
              kind: "skipped" as const,
              reason: "repo_disabled" as const,
            };
          }

          // D16：把描述符里的可见性回填到 `repos.is_private`（未知 = 不写）。
          if (params.private !== undefined) {
            await env.DB.prepare(
              "INSERT INTO repos (installation_id, name, is_private) VALUES (?, ?, ?) " +
                "ON CONFLICT(installation_id, name) DO UPDATE SET " +
                "is_private = excluded.is_private",
            )
              .bind(installationId, params.repo, params.private ? 1 : 0)
              .run();
          }

          // D16 运行期强制执行：计费开启时，私有仓库数超过计划上限即收尾。
          // （self-host 的 env 上限只在仪表盘开关时刻生效，run 期不拦——旧行为。）
          const quota = await checkPrivateQuota(
            env,
            installationId,
            params.private,
          );
          if (quota.skip) {
            console.warn(
              `[OptimizeRun] ${params.repo}: private quota exceeded ` +
                `(${quota.count}/${quota.cap}), skipping run`,
            );
            await patchRun(env, runId, {
              state: "skipped_disabled",
              error: "private_quota_exceeded",
            });
            return {
              kind: "skipped" as const,
              reason: "private_quota_exceeded" as const,
            };
          }

          const { client, token } = await githubContext(env, installationId);

          // base_ref 缺失时用仓库默认分支（§5.2 描述符允许省略）
          const baseRef =
            params.base_ref || (await client.getDefaultBranch(owner, repo));

          // 固定快照：树扫描、base_tree、commit parent 全部指向同一个 commit，
          // 避免跑动期间 base 分支前移导致"旧 blob + 新树"混搭。
          const baseSha =
            params.base_sha ??
            (await fetchHeadCommitSha(token, owner, repo, baseRef));

          // 根树 sha 给 commit 步做 base_tree（commit sha 可当 tree-ish 解析）
          const rootTreeSha = await client.getTreeRootSha(owner, repo, baseSha);
          const { tree, truncated } = await client.getTreeRecursive(
            owner,
            repo,
            baseSha,
          );

          const configEntry = tree.find((entry) => entry.path === CONFIG_PATH);
          const config = configEntry
            ? parseImgbotConfig(
                new TextDecoder().decode(
                  await client.getBlobRaw(owner, repo, configEntry.sha),
                ),
              )
            : parseImgbotConfig(null);

          // §5.3 步返回 ≤1MiB：候选清单超 2000 张先截断（分页多步属 P2）
          const imageEntries = tree.filter((entry) =>
            IMAGE_PATH_PATTERN.test(entry.path),
          );
          // 截断必须在仪表盘可见（`runs.error` 是唯一展示位），但**不让 run 失败**：
          // 截断只缩小本轮覆盖范围，不是错误；下一轮（或配置缩窄后）自然补上。
          const scanNotes: string[] = [];
          if (imageEntries.length > MAX_SCAN_ENTRIES) {
            console.warn(
              `[OptimizeRun] ${params.repo}: ${imageEntries.length} images, ` +
                `truncating scan to ${MAX_SCAN_ENTRIES} (P2: paginate scan-tree)`,
            );
            scanNotes.push(
              `scan_truncated: ${MAX_SCAN_ENTRIES} entries; ` +
                `${imageEntries.length - MAX_SCAN_ENTRIES} images beyond the cap were skipped`,
            );
          }
          if (truncated) {
            console.warn(
              `[OptimizeRun] ${params.repo}: git tree is truncated by GitHub ` +
                "(§9-R10); P2 falls back to per-directory recursion",
            );
            scanNotes.push(
              "tree_truncated: GitHub tree listing was truncated; " +
                "files beyond the cap were not scanned",
            );
          }

          await patchRun(env, runId, {
            state: "scanning",
            base_sha: baseSha,
            min_kb_reduced: config.minKBReduced,
            ...(scanNotes.length > 0
              ? { error: scanNotes.join("; ").slice(0, MAX_ERROR_LENGTH) }
              : {}),
          });

          return {
            kind: "loaded" as const,
            result: {
              config,
              baseRef,
              baseSha,
              rootTreeSha,
              entries: imageEntries.slice(0, MAX_SCAN_ENTRIES),
              treeTruncated: truncated,
            },
          };
        },
      );

      // 停用/超配额仓库：在 step 外结束本轮（不进重试），由 catch 映射为 skipped_disabled。
      if (loadedConfig.kind === "skipped") {
        throw new RepoDisabledSignal(loadedConfig.reason);
      }
      loaded = loadedConfig.result;

      /* ---------------------------------------------------------------- */
      /* ③ scan-tree：忽略规则 + image_cache 比对 → 分块                   */
      /* ---------------------------------------------------------------- */
      const scan = await step.do<ScanResult>(
        "scan-tree",
        STEP_CONFIG.scanTree,
        async () => {
          await this.heartbeat(runId, installationId, params.repo);

          const patterns = compileIgnorePatterns(loaded.config.ignoredFiles);
          const allowed = new Set(
            filterIgnoredPaths(
              loaded.entries.map((entry) => entry.path),
              patterns,
            ),
          );
          const candidates = loaded.entries.filter((entry) =>
            allowed.has(entry.path),
          );

          // §7.3：`(repo, path, source_hash)` 命中即跳过——
          // 正向（result_hash 非空）= 已优化且已提交 → 统计进重放；负向 = 已判定 not_smaller → 直接跳过
          const cached = await env.DB.prepare(
            "SELECT path, source_hash, result_hash, source_size, result_size " +
              "FROM image_cache WHERE installation_id = ? AND repo = ?",
          )
            .bind(installationId, params.repo)
            .all<{
              path: string;
              source_hash: string;
              result_hash: string | null;
              source_size: number | null;
              result_size: number | null;
            }>();
          const seen = new Map(
            (cached.results ?? []).map((row) => [
              cacheKey(row.path, row.source_hash),
              row,
            ]),
          );

          const pending: TreeBlob[] = [];
          const replayed: ReplayStat[] = [];
          for (const entry of candidates) {
            const hit = seen.get(cacheKey(entry.path, entry.sha));
            if (!hit) {
              pending.push(entry);
              continue;
            }
            if (
              hit.result_hash !== null &&
              hit.source_size !== null &&
              hit.result_size !== null
            ) {
              replayed.push({
                path: entry.path,
                sourceHash: hit.source_hash,
                resultHash: hit.result_hash,
                beforeBytes: hit.source_size,
                afterBytes: hit.result_size,
                beforeKb: bytesToKb(hit.source_size),
                afterKb: bytesToKb(hit.result_size),
              });
            }
          }
          const batches = chunk(pending, BATCH_SIZE);

          await patchRun(env, runId, {
            state: "optimizing",
            images_total: candidates.length,
          });

          return {
            batches,
            imagesTotal: candidates.length,
            cachedSkipped: candidates.length - pending.length,
            replayed,
          };
        },
      );
      imagesTotal = scan.imagesTotal;

      /* ---------------------------------------------------------------- */
      /* ④ optimize-batch-{i}：逐图取 blob → 优化 → 建 blob → R2 暂存      */
      /* ---------------------------------------------------------------- */
      const batchResults: BatchResult[] = [];
      for (let index = 0; index < scan.batches.length; index++) {
        const batch = scan.batches[index];
        const result = await step.do<BatchResult>(
          `optimize-batch-${index}`,
          STEP_CONFIG.optimizeBatch,
          async () => {
            await this.heartbeat(runId, installationId, params.repo);
            const { client } = await githubContext(env, installationId);
            const codecs = await getCodecSet();
            const outcome: BatchResult = { optimized: [], skipped: [] };

            // §6.2：块内并发 = 1（128MB 内存墙）
            for (const entry of batch) {
              try {
                const original = await client.getBlobRaw(
                  owner,
                  repo,
                  entry.sha,
                );
                await env.STAGING.put(
                  stagingKey(runId, entry.path, "orig"),
                  original,
                );

                const optimizedImage = await optimizeImage(
                  entry.path,
                  original,
                  {
                    aggressive: loaded.config.aggressiveCompression,
                    codecs,
                  },
                );
                if (
                  !optimizedImage.optimized ||
                  optimizedImage.optimizedSize === null
                ) {
                  const reason = optimizedImage.skipped ?? "not_smaller";
                  // §6.3 超大图兜底：too_large 交给容器原生工具链（失败返回 null）。
                  // 硬上限 40MB：超过就不发请求（base64 膨胀 + 容器内存都不划算），按 too_large 跳过。
                  let rescued: Uint8Array | null = null;
                  let containerTool: string | undefined;
                  if (reason === "too_large") {
                    if (withinContainerInputCap(original.length)) {
                      const over = await optimizeViaContainer(
                        env,
                        entry.path,
                        original,
                        loaded.config.aggressiveCompression,
                      );
                      rescued = over.optimized;
                      containerTool = over.tool;
                    } else {
                      console.warn(
                        `[OptimizeRun] ${entry.path}: ${original.length} bytes exceeds ` +
                          `container input cap (${MAX_CONTAINER_INPUT_BYTES}); skipping (too_large)`,
                      );
                    }
                  }
                  if (rescued) {
                    await env.STAGING.put(
                      stagingKey(runId, entry.path, "opt"),
                      rescued,
                    );
                    outcome.optimized.push({
                      path: entry.path,
                      sourceSha: entry.sha,
                      resultHash: await sha256Hex(rescued),
                      beforeBytes: original.length,
                      afterBytes: rescued.length,
                      beforeKb: bytesToKb(original.length),
                      afterKb: bytesToKb(rescued.length),
                    });
                    continue;
                  }
                  outcome.skipped.push({
                    path: entry.path,
                    reason,
                    tool: containerTool,
                  });
                  // 负向缓存（§7.3）：确定性"不会更小"结论入库，免得每轮重试；
                  // unsupported 不缓存（格式支持会演进）；too_large 不缓存（环境相关）
                  if (reason === "not_smaller" || reason === "decode_failed") {
                    await env.DB.prepare(IMAGE_CACHE_UPSERT)
                      .bind(
                        installationId,
                        params.repo,
                        entry.path,
                        entry.sha,
                        null,
                        optimizedImage.originalSize,
                        null,
                        new Date().toISOString(),
                      )
                      .run();
                  }
                  continue;
                }

                // R1 后（§4.3 方案 A）：字节经 GraphQL FileAddition 一次性入库，
                // 不再逐图 POST /git/blobs（省 N 次内容写入配额，§4.2/§9-R2）
                await env.STAGING.put(
                  stagingKey(runId, entry.path, "opt"),
                  optimizedImage.optimized,
                );

                // 正向缓存改到 commit 成功后回填（阈值门可能整轮放弃提交，
                // 提前入缓存会让统计重放虚报"已在 PR 里"）
                outcome.optimized.push({
                  path: entry.path,
                  sourceSha: entry.sha,
                  resultHash: await sha256Hex(optimizedImage.optimized),
                  beforeBytes: optimizedImage.originalSize,
                  afterBytes: optimizedImage.optimizedSize,
                  beforeKb: bytesToKb(optimizedImage.originalSize),
                  afterKb: bytesToKb(optimizedImage.optimizedSize),
                });
              } catch (err) {
                // 429 / 次级限速 / 5xx：原样抛，步进重试退避消化（§4.2）
                if (err instanceof GithubApiError && err.retryable) throw err;
                // blob 在扫描后被删/被改（404/422）：只跳过这一张，不炸整个 run
                if (
                  err instanceof GithubApiError &&
                  (err.status === 404 || err.status === 422)
                ) {
                  console.warn(
                    `[OptimizeRun] ${entry.path}: GitHub ${err.status}, skipping`,
                  );
                  outcome.skipped.push({
                    path: entry.path,
                    reason: "decode_failed",
                  });
                  continue;
                }
                throw err;
              }
            }

            return outcome;
          },
        );
        batchResults.push(result);
      }

      optimized = batchResults.flatMap((result) => result.optimized);

      /* ---------------------------------------------------------------- */
      /* ⑤ commit：阈值门 → 树（sha 引用）→ commit → 重建 imgbot 分支      */
      /* ---------------------------------------------------------------- */
      const committed = await step.do<CommitResult>(
        "commit",
        STEP_CONFIG.commit,
        async () => {
          await this.heartbeat(runId, installationId, params.repo);
          const summary = sumSizes(optimized);

          await patchRun(env, runId, {
            state: "committing",
            images_optimized: optimized.length,
            bytes_before: summary.beforeBytes,
            bytes_after: summary.afterBytes,
          });

          // §5.1：无优化结果 → skipped_nochange（不开 PR，不建分支）
          if (optimized.length === 0) {
            return { status: "skipped_nochange" as const };
          }

          // §2.1 / §2.3：阈值门先于 commit（原版同样先判阈值）。
          // 累积式提交下口径 = 全量（重放 + 本批）：首轮等价于本批，后续轮避免小增量被误挡。
          const replayed = scan.replayed;
          const fullResults: CompressionResult[] = [
            ...replayed.map((r) => ({
              title: `*${r.path}`,
              sizeBeforeKb: r.beforeKb,
              sizeAfterKb: r.afterKb,
            })),
            ...optimized.map((image) => ({
              title: `*${image.path}`,
              sizeBeforeKb: image.beforeKb,
              sizeAfterKb: image.afterKb,
            })),
          ];
          const fullSummary = sumSizes([...replayed, ...optimized]);
          if (!thresholdGate(loaded.config.minKBReduced, fullSummary.savedKb)) {
            return { status: "skipped_threshold" as const };
          }

          // §2.2：commit message 逐字用模板（含 `*Total` 与 Signed-off-by 原样行，D6）
          const message = createCommitMessage(fullResults);

          const { client } = await githubContext(env, installationId);

          // §2.1 人类改动中止：imgbot 分支 tip 非 bot 所为 → 中止（对照原版守卫）。
          // 同时确定提交父节点与其树（差分基线）；分支缺失则首建于 base。
          const oldTipTree = new Map<string, string>();
          let parentTree: Map<string, string>;
          let expectedHeadOid: string;
          // P1(TOCTOU)：守卫时刻的 tip 快照，force 落地前复核用。
          let guardTipSha: string | null = null;
          try {
            const tipSha = await client.getRefCommitSha(
              owner,
              repo,
              IMGBOT_REF,
            );
            const tip = await client.getCommitAuthor(owner, repo, tipSha);
            if (tip.name !== BOT_NAME) {
              await patchRun(env, runId, { state: "aborted_by_human" });
              return { status: "aborted" as const };
            }
            for (const blob of (
              await client.getTreeRecursive(owner, repo, tipSha)
            ).tree) {
              oldTipTree.set(blob.path, blob.sha);
            }
            parentTree = oldTipTree;
            expectedHeadOid = tipSha;
            guardTipSha = tipSha;
          } catch (err) {
            if (!(err instanceof GithubApiError && err.status === 404)) {
              throw err;
            }
            await client.ensureRef(owner, repo, IMGBOT_REF, loaded.baseSha);
            parentTree = new Map(); // 父 = base，树差分基线即 base 本身
            expectedHeadOid = loaded.baseSha;
            guardTipSha = loaded.baseSha;
          }

          // R1（§4.3 方案 A）：GraphQL createCommitOnBranch —— GitHub 自动 PGP 签名。
          // D5（终稿·暂存分支重建）：历史 = base + 单 commit（可合并性同原版 rebase 效果）；
          // 但**不**把 imgbot 重置到 base——瞬时空 PR 会被 GitHub 自动关闭（实测
          // head_ref_force_pushed → closed 同秒发生）。改为：暂存分支上原子产出 commit，
          // 再把 imgbot 一次性 force 落到该 commit（目标非空，PR 正常跟进更新）。
          const baseTreeMap = new Map(
            loaded.entries.map((e) => [e.path, e.sha]),
          );

          // P1（静默回滚修复）：重放产物只能从旧 imgbot tip 的树里取 blob。
          // 旧 tip 树被 GitHub 截断（§9-R10）时，部分重放会找不到 oldSha 被丢弃，
          // 而 base 里是原图 → PR 里这些文件会**静默退回未优化版本**。
          // 截断对同一 base 快照是确定性的（重试无用），所以显式中止，不交出错误 PR。
          const replayCandidates = scan.replayed.filter(
            (r) => baseTreeMap.get(r.path) !== r.resultHash, // base 已含产物（合并后）→ 无需重放
          );
          const droppedReplays = replayCandidates.filter(
            (r) => !oldTipTree.has(r.path),
          ).length;
          if (
            shouldAbortForTruncatedReplays(loaded.treeTruncated, droppedReplays)
          ) {
            const note = `truncated_tree_lost_replays: ${droppedReplays} files`;
            console.warn(`[OptimizeRun] ${params.repo}: ${note}, aborting run`);
            await patchRun(env, runId, { state: "failed", error: note });
            return { status: "failed" as const };
          }
          // 非截断树下的缺失只是陈旧缓存行（产物不可达）：丢弃并由后续轮自愈。
          const plannedReplays = replayCandidates.filter((r) =>
            oldTipTree.has(r.path),
          );

          // PR 负载预算（§4.3）：在**读取任何 staged blob / 构造 base64 之前**预检。
          // 超限即显式失败——巨型 payload 一旦开始组装，OOM 在 step 内炸掉既看不到原因也不可重试。
          // 字节口径 = additions 的原始文件字节（含重放）；重放大小取 image_cache.result_size
          // （= 当初产物字节数），陈旧行的实际 blob 可能略有出入，这里只作预检屏障。
          const projectedCount = optimized.length + plannedReplays.length;
          const projectedBytes =
            optimized.reduce((sum, image) => sum + image.afterBytes, 0) +
            plannedReplays.reduce((sum, r) => sum + r.afterBytes, 0);
          if (!withinPrBudget(projectedCount, projectedBytes)) {
            const note =
              `pr_payload_too_large: ${projectedCount} images / ${projectedBytes} bytes ` +
              `exceeds cap (${MAX_PR_IMAGES} / ${MAX_PR_TOTAL_BYTES}); ` +
              "use ignoredFiles or minKBReduced";
            console.warn(`[OptimizeRun] ${params.repo}: ${note}`);
            await patchRun(env, runId, {
              state: "failed",
              error: note.slice(0, MAX_ERROR_LENGTH),
            });
            return { status: "failed" as const };
          }

          const additions: Array<{ path: string; contentsBase64: string }> = [];
          for (const image of optimized) {
            const staged = await env.STAGING.get(
              stagingKey(runId, image.path, "opt"),
            );
            if (!staged) {
              throw new Error(`missing staged result for ${image.path}`);
            }
            const bytes = new Uint8Array(await staged.arrayBuffer());
            additions.push({
              path: image.path,
              contentsBase64: toBase64(bytes),
            });
          }
          const includedReplay: ReplayStat[] = [];
          for (const r of plannedReplays) {
            additions.push({
              path: r.path,
              contentsBase64: toBase64(
                await client.getBlobRaw(owner, repo, oldTipTree.get(r.path)!),
              ),
            });
            includedReplay.push(r);
          }
          const { headline, body } = splitCommitMessage(message);

          // 暂存分支：**按 run 唯一**（P1：共享 ref 会被并发 run 互踩），
          // 每次重建到 base（无 PR 挂靠，force 无副作用），commit 落在它上面
          const stagingRef = stagingRefForRun(runId);
          await client.ensureRef(owner, repo, stagingRef, loaded.baseSha);
          await client.updateRef(owner, repo, stagingRef, loaded.baseSha, {
            force: true,
          });

          // 重试幂等性：expectedHeadOid 钉住 base（防并发）；成功后响应丢失的重放会撞
          // "head oid 不符"——此时 imgbot tip 若已是同一 message（bot 所为）则直接采用
          let newCommitSha: string;
          try {
            newCommitSha = await client.createCommitOnBranch(owner, repo, {
              branchName: stagingRef,
              headline,
              body,
              additions,
              expectedHeadOid: loaded.baseSha,
            });
          } catch (err) {
            if (
              err instanceof GithubApiError &&
              /head oid|head sha/i.test(err.message)
            ) {
              const tipSha = await client.getRefCommitSha(
                owner,
                repo,
                IMGBOT_REF,
              );
              const tip = await client.getCommitAuthor(owner, repo, tipSha);
              if (
                tip.name === BOT_NAME &&
                tip.message.trimEnd() === message.trimEnd()
              ) {
                newCommitSha = tipSha;
              } else {
                throw err;
              }
            } else {
              throw err;
            }
          }

          // P1（TOCTOU 复核）：守卫校验与 force 落地之间隔了全部 blob 写入，
          // 人类在窗口内推送/删除 imgbot 会被静默覆盖 → 落地前复核 tip 快照。
          // 已知残余：复核与 PATCH ref 之间无 CAS（REST refs 不支持），窗口极小。
          let tipNow: string | null = null;
          try {
            tipNow = await client.getRefCommitSha(owner, repo, IMGBOT_REF);
          } catch (err) {
            if (!(err instanceof GithubApiError && err.status === 404)) {
              throw err;
            }
          }
          if (tipViolatesGuard(guardTipSha, tipNow)) {
            await patchRun(env, runId, { state: "aborted_by_human" });
            return { status: "aborted" as const };
          }

          // 一次性把 imgbot 落到新 commit（等价原版 rebase 后的 force-push；
          // 目标非空 → PR 正常跟进更新，而非被自动关闭）
          await client.updateRef(owner, repo, IMGBOT_REF, newCommitSha, {
            force: true,
          });
          await client.deleteRef(owner, repo, stagingRef).catch(() => {});

          // 正向缓存回填（§7.3）：以新 commit 树里的真实 blob sha 记账
          //（产物可寻址——后续轮的重放与"base 已含"判断都靠它）
          const newTree = await client.getTreeRecursive(
            owner,
            repo,
            newCommitSha,
          );
          const shaByPath = new Map(
            newTree.tree.map((blob) => [blob.path, blob.sha]),
          );
          const nowIso = new Date().toISOString();
          for (const image of optimized) {
            await env.DB.prepare(IMAGE_CACHE_UPSERT)
              .bind(
                installationId,
                params.repo,
                image.path,
                image.sourceSha,
                shaByPath.get(image.path) ?? image.resultHash,
                image.beforeBytes,
                image.afterBytes,
                nowIso,
              )
              .run();
          }
          for (const r of includedReplay) {
            // 刷新 result_hash 为真实 blob sha（自愈历史行）
            await env.DB.prepare(IMAGE_CACHE_UPSERT)
              .bind(
                installationId,
                params.repo,
                r.path,
                r.sourceHash,
                shaByPath.get(r.path) ?? r.resultHash,
                r.beforeBytes,
                r.afterBytes,
                nowIso,
              )
              .run();
          }

          await patchRun(env, runId, { commit_sha: newCommitSha });
          return { status: "committed" as const, commitSha: newCommitSha };
        },
      );
      commitSha = committed.commitSha ?? null;

      /* ---------------------------------------------------------------- */
      /* ⑥ open-pr：建/更新 PR（模板逐字复刻）→ D1 pulls 记账              */
      /* ---------------------------------------------------------------- */
      if (committed.status === "committed") {
        await step.do("open-pr", STEP_CONFIG.openPr, async () => {
          await this.heartbeat(runId, installationId, params.repo);

          // 与 `Stats.ParseStats(commitMessage)` 等价：`[0]` = Total（§2.2）
          // 累积式提交下口径 = 全量（重放 + 本批），PR body 永远覆盖 PR 里的全部文件
          const stats = buildImageStats([...scan.replayed, ...optimized]);
          const settings = {
            prTitle: loaded.config.prTitle,
            prBody: loaded.config.prBody,
          };
          const body = createPrBody(stats, settings);
          const title = createPrTitle(settings);

          const { client } = await githubContext(env, installationId);
          const existing = await client.findOpenPullByHead(
            owner,
            repo,
            IMGBOT_REF,
          );

          let prNumber: number;
          if (existing) {
            // §2.1：已存在 open PR → 原地更新 body（不新开 PR）
            await client.updatePullBody(owner, repo, existing.number, body);
            prNumber = existing.number;
          } else {
            const created = await client.createPull(owner, repo, {
              title,
              body,
              head: IMGBOT_REF,
              base: loaded.baseRef,
            });
            prNumber = created.number;
          }

          await env.DB.prepare(PULL_UPSERT)
            .bind(
              installationId,
              params.repo,
              prNumber,
              commitSha,
              new Date().toISOString(),
            )
            .run();

          await patchRun(env, runId, { state: "pr_open", pr_number: prNumber });
          return { prNumber };
        });

        // §5.1：PR 开启后停在 pr_open；merged_cleanup → done 由合并 webhook / cron 推进。
        terminalState = "pr_open";
      } else {
        terminalState =
          committed.status === "aborted"
            ? "aborted_by_human"
            : committed.status;
      }
    } catch (err) {
      if (err instanceof RepoDisabledSignal) {
        // load-config 已把 runs.state 写成 skipped_disabled，error = 信号原因
        //（repo_disabled / private_quota_exceeded）；正常收尾，不记失败、不重试。
        terminalState = "skipped_disabled";
      } else {
        failure = err;
        terminalState = "failed";
      }
    }

    /* ------------------------------------------------------------------ */
    /* ⑦ cleanup：清暂存 + 终态 + 释放锁（成功/跳过/失败都执行）            */
    /* ------------------------------------------------------------------ */
    try {
      await step.do("cleanup", STEP_CONFIG.cleanup, async () => {
        await this.heartbeat(runId, installationId, params.repo);
        await deleteStagingPrefix(env, runId);

        const summary = sumSizes(optimized);
        const patch: RunPatch = {
          state: terminalState,
          images_total: imagesTotal,
          images_optimized: optimized.length,
          bytes_before: failure ? null : summary.beforeBytes,
          bytes_after: failure ? null : summary.afterBytes,
          finished_at: new Date().toISOString(),
        };
        if (failure) patch.error = errorText(failure);
        await patchRun(env, runId, patch);

        // §2.3 compressWiki：主仓 run 收尾后追加 wiki 通道（wiki run 不追加自己，防环）
        if (!params.repo.endsWith(".wiki") && loaded?.config.compressWiki) {
          await env.ROUTER.send(
            {
              run_id: crypto.randomUUID(),
              installation_id: installationId,
              repo: `${params.repo}.wiki`,
              trigger: params.trigger,
              base_ref: "",
              delivery_id: params.delivery_id,
            },
            { contentType: "json" },
          );
        }

        // 释锁并把 pending（若有）转正；陈旧调用是幂等的（§5.4）
        await this.repoLock(installationId, params.repo).finish(runId);
        return { state: terminalState };
      });
    } catch (cleanupErr) {
      if (!failure) throw cleanupErr;
      console.error(
        `[OptimizeRun] cleanup failed for ${runId} after: ${errorText(failure)}`,
        cleanupErr,
      );
    }

    if (failure) throw failure;
  }

  /* ---------------------------------------------------------------------- */
  /* internals                                                              */
  /* ---------------------------------------------------------------------- */

  private repoLock(installationId: number, repo: string) {
    return this.env.REPO_LOCK.getByName(`repo:${installationId}/${repo}`);
  }

  /** §5.4 续租。心跳失败不该让优化步失败（最坏情况是租约到期被 alarm 兜底）。 */
  private async heartbeat(
    runId: string,
    installationId: number,
    repo: string,
  ): Promise<void> {
    try {
      await this.repoLock(installationId, repo).heartbeat(runId);
    } catch (err) {
      console.warn(
        `[OptimizeRun] heartbeat failed for ${runId} (lease may expire)`,
        err,
      );
    }
  }
}
