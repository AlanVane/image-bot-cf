/**
 * webhook 事件 → RunDescriptor 映射（DESIGN.md §2.4 事件响应矩阵 / §5.2 消息契约）。
 *
 * 纯函数、零 IO：只读 payload，产出描述符；绝不携带图片字节（128KB 消息上限）。
 * `delivery_id` 由 ingress 层补充（本函数签名不含投递信封，保持可单测）。
 *
 * 同时提供「web 合并 imgbot → 删分支」的纯判定（§2.1，原版
 * `WebHookFunction.IsDefaultWebMerge`）；副作用在 `./webhook.ts`。
 */
import { COMMIT_MESSAGE_TITLE } from "../ux/templates";
import type { RunDescriptor } from "../types";

/** §1.1 支持的图片扩展名（大小写不敏感）。 */
const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "svg",
]);

/** §2.4：配置文件本身变更也要重跑（忽略规则/阈值可能变了）。 */
export const IMBOT_CONFIG_PATH = ".imgbotconfig";

/** §2.4 注：GitHub push payload 在 20 条 commit 处截断，超过即不可信。 */
export const COMMITS_TRUNCATION_THRESHOLD = 20;

/** §2.1：唯一长驻分支名；push 到这里不是"人类改默认分支"，P2 处理。 */
export const IMBOT_BRANCH = "imgbot";

const REFS_HEADS = "refs/heads/";

/** installation / installation_repositories 中会新建仓库关联的 action。 */
const INSTALL_ACTIONS: ReadonlySet<string> = new Set(["created", "added"]);

/**
 * 是否图片路径。刻意不复用 `optimize/dispatch.detectFormat`：那里 .gif 归为
 * unsupported（P2 编码器），但 GIF 变更仍需触发重跑（状态机/缓存一致）。
 */
export function isImagePath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot <= 0 || dot === path.length - 1) return false;
  return IMAGE_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
}

function isRelevantPath(path: string): boolean {
  return path === IMBOT_CONFIG_PATH || isImagePath(path);
}

/**
 * §2.4 事件响应矩阵 → 0..n 个 run。
 * 未识别/延后事件返回空数组（ingress 依然 202，避免 GitHub 重投）。
 */
export function mapEventToRuns(
  event: string,
  payload: unknown,
): RunDescriptor[] {
  const body = asRecord(payload);
  if (!body) return [];

  switch (event) {
    case "installation":
    case "installation_repositories":
      return mapInstallationEvent(event, body);
    case "push":
      return mapPushEvent(body);
    default:
      // ping / marketplace_purchase / pull_request / *_deleted …：P2
      return [];
  }
}

/** installation(created) / installation_repositories(added)：每个受影响仓库一条全量 run。 */
function mapInstallationEvent(
  event: string,
  body: Record<string, unknown>,
): RunDescriptor[] {
  const action = asString(body.action);
  if (!action || !INSTALL_ACTIONS.has(action)) return [];

  const installationId = asNumber(asRecord(body.installation)?.id);
  if (installationId === null) return [];

  const lists: unknown[][] = [];
  if (event === "installation_repositories") {
    lists.push(asArray(body.repositories_added));
  }
  // installation 的仓库集在 `repositories`；installation_repositories 里它是全量快照，
  // 只作 `repositories_added` 缺失时的兜底。
  lists.push(asArray(body.repositories));

  const seen = new Set<string>();
  const runs: RunDescriptor[] = [];
  for (const list of lists) {
    for (const item of list) {
      const repo = asRecord(item);
      const name = asString(repo?.full_name);
      if (!name || seen.has(name)) continue;
      seen.add(name);
      runs.push({
        run_id: newRunId(),
        installation_id: installationId,
        repo: name,
        trigger: "installation",
        base_ref: asString(repo?.default_branch) ?? "",
      });
    }
  }
  return runs;
}

/** push：仅默认分支；改动触碰图片/配置才入队（带保守回退）。 */
function mapPushEvent(body: Record<string, unknown>): RunDescriptor[] {
  // 分支删除（含合并后删 imgbot）：P2
  if (body.deleted === true) return [];

  const repository = asRecord(body.repository);
  const installationId = asNumber(asRecord(body.installation)?.id);
  const repoName = asString(repository?.full_name);
  const defaultBranch = asString(repository?.default_branch);
  if (installationId === null || !repoName || !defaultBranch) return [];
  if (defaultBranch === IMBOT_BRANCH) return [];

  // 默认分支之外（imgbot 分支、feature 分支）：P2 / 不关心
  if (asString(body.ref) !== `${REFS_HEADS}${defaultBranch}`) return [];

  const commits = asArray(body.commits);
  const hasHeadCommit = asRecord(body.head_commit) !== null;

  const touched = new Set<string>();
  for (const item of commits) {
    const commit = asRecord(item);
    if (!commit) continue;
    for (const key of ["added", "modified", "removed"]) {
      for (const entry of asArray(commit[key])) {
        const path = asString(entry);
        if (path) touched.add(path);
      }
    }
  }

  const relevant = [...touched].some(isRelevantPath);
  // 保守回退（宁可多跑一次；scan-tree 的 blob sha 缓存会快速短路）：
  // ① commit 列表被截断（≥20）→ 文件集不可信；
  // ② commits 缺失/为空但存在 head_commit（GitHub 对某些 push 只给 head_commit）。
  const truncated = commits.length >= COMMITS_TRUNCATION_THRESHOLD;
  const commitsMissing = commits.length === 0 && hasHeadCommit;

  if (!relevant && !truncated && !commitsMissing) return [];

  const desc: RunDescriptor = {
    run_id: newRunId(),
    installation_id: installationId,
    repo: repoName,
    trigger: "push",
    base_ref: defaultBranch,
  };
  const after = asString(body.after);
  if (after) desc.base_sha = after;
  return [desc];
}

// ---------------------------------------------------------------------------
// 合并删分支判定（§2.1，原版 `IsDefaultWebMerge`）
// ---------------------------------------------------------------------------

/** commit 列表里是否出现 ImgBot 的标题行（squash 后剩下的那个 commit）。 */
export function isImgbotCommitMessage(message: string): boolean {
  return message.includes(COMMIT_MESSAGE_TITLE);
}

/** §2.1：web 合并只认 ≤2 个 commit（merge commit 或 squash 单 commit）。 */
export const WEB_MERGE_MAX_COMMITS = 2;

/** GitHub web 合并 commit 的标题格式；`\S+` 是 head owner。 */
const WEB_MERGE_PATTERN = new RegExp(
  `Merge pull request #\\d+ from \\S+/${IMBOT_BRANCH}`,
);

/**
 * 合并判定核心：`commits.length <= 2` 且满足任一：
 * - 任一 commit message 含 `[ImgBot] Optimize images`（merge / squash 都覆盖）；
 * - `head_commit.message` 匹配 `Merge pull request #<n> from <owner>/imgbot`。
 *
 * 参数放宽到 `string | {message}`：测试向量可读，调用方也不必先窄化。
 */
export function isImgbotWebMerge(
  commits: readonly (string | { message?: string | null })[],
  headCommitMessage: string | null = null,
): boolean {
  if (commits.length > WEB_MERGE_MAX_COMMITS) return false;

  const messages: string[] = [];
  for (const commit of commits) {
    const message =
      typeof commit === "string" ? commit : (commit?.message ?? "");
    if (message) messages.push(message);
  }

  if (messages.some(isImgbotCommitMessage)) return true;
  return (
    headCommitMessage !== null && WEB_MERGE_PATTERN.test(headCommitMessage)
  );
}

/**
 * 从原始 push payload 判定「默认分支上的 imgbot web 合并」。
 * 只认 `refs/heads/{repository.default_branch}`；删分支/非默认分支一律 false。
 */
export function isDefaultWebMerge(payload: unknown): boolean {
  const body = asRecord(payload);
  if (!body) return false;
  if (body.deleted === true) return false;

  const repository = asRecord(body.repository);
  const defaultBranch = asString(repository?.default_branch);
  if (!defaultBranch) return false;
  if (asString(body.ref) !== `${REFS_HEADS}${defaultBranch}`) return false;

  const commits = asArray(body.commits)
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => item !== null)
    .map((item) => asString(item.message) ?? "");

  const headMessage = asString(asRecord(body.head_commit)?.message);
  return isImgbotWebMerge(commits, headMessage);
}

/** 合并删分支的副作用目标（`owner/name` + installation）。 */
export interface WebMergeTarget {
  installationId: number;
  repo: string;
}

/** 从 push payload 提取删 ref 的目标；字段不全时返回 null。 */
export function getWebMergeTarget(payload: unknown): WebMergeTarget | null {
  const body = asRecord(payload);
  if (!body) return null;
  const installationId = asNumber(asRecord(body.installation)?.id);
  const repo = asString(asRecord(body.repository)?.full_name);
  if (installationId === null || !repo) return null;
  return { installationId, repo };
}

// ---------------------------------------------------------------------------
// payload 窄化helpers（payload 是完全不可信的外部 JSON）
// ---------------------------------------------------------------------------

function newRunId(): string {
  return crypto.randomUUID();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}
