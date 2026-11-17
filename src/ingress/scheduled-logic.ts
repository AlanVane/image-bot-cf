/**
 * ingress 侧的定时判定纯函数（DESIGN.md §2.3 / §2.4 / D8）。
 *
 * 这里只放**零 IO、可单测**的判定与组装逻辑；所有 GitHub/D1/Queue 访问都在
 * `./scheduled.ts`（cron 编排）。合并删分支的判定在 `./events.ts`（事件语义）。
 */

import { parseImgbotConfig } from "../config/imgbotconfig";
import type { ImageStat, RepoConfig } from "../types";
import { createPrBody, createPrTitle, parseStats } from "../ux/templates";

/** §2.1：唯一长驻分支名。 */
export const IMBOT_BRANCH = "imgbot";

/* -------------------------------------------------------------------------- */
/* ② schedule 门限（§2.3 / D8）                                               */
/* -------------------------------------------------------------------------- */

export type ScheduleValue = "daily" | "weekly" | "monthly";

/**
 * D8：用 D1 运行史代替扫 git 历史。周期按固定毫秒近似
 * （monthly = 30 天；原版也是「多久以前」的粗粒度判断）。
 */
export const SCHEDULE_PERIOD_MS: Readonly<Record<ScheduleValue, number>> = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
};

/**
 * 是否允许本次 schedule 重跑。
 *
 * - `schedule` 非 daily/weekly/monthly → false（未开启）
 * - 从未跑过（`lastRunAt` 为空）→ true
 * - 距上次 run 已满一个周期 → true；周期内已有任何 run → false
 * - `lastRunAt` 无法解析 → 视为从未跑过（宁可跑一次也不饿死调度）
 */
export function scheduleGate(
  schedule: ScheduleValue | null | undefined,
  lastRunAt: string | number | Date | null | undefined,
  now: Date | number = Date.now(),
): boolean {
  if (!schedule || !(schedule in SCHEDULE_PERIOD_MS)) return false;

  const nowMs = toEpochMs(now);
  if (nowMs === null) return false;

  const lastMs = toEpochMs(lastRunAt);
  if (lastMs === null) return true;

  return nowMs - lastMs >= SCHEDULE_PERIOD_MS[schedule];
}

/* -------------------------------------------------------------------------- */
/* ③ 30min 卡死 PR 巡检（原版 `PrPoisonHandler`）                             */
/* -------------------------------------------------------------------------- */

/** commit 作者的最小形状（Git Data commit.author + REST `author` 用户对象）。 */
export interface CommitAuthorLike {
  name?: string | null;
  email?: string | null;
  login?: string | null;
  /** GitHub 用户类型：`Bot` / `User` / `Organization`。 */
  type?: string | null;
}

/** §2.1 / D6：bot 身份判定（新 `{slug}[bot]` 与旧 `ImgBotApp` 都认）。 */
export function isBotAuthor(
  author: CommitAuthorLike | null | undefined,
): boolean {
  if (!author) return false;
  if (author.type === "Bot") return true;
  if (author.login && /\[bot\]$/i.test(author.login)) return true;
  if (author.name && /\[bot\]$/i.test(author.name)) return true;
  if (author.name === "ImgBotApp") return true;
  if (author.email === "ImgBotHelp@gmail.com") return true;
  return false;
}

/** 巡检判定输入（全部来自 GitHub API；时间用 ISO 字符串）。 */
export interface PrPoisonInput {
  /** `heads/imgbot` 是否存在。 */
  branchExists: boolean;
  /** 是否已有 head=imgbot 的 open PR。 */
  hasOpenPull: boolean;
  /** 分支 tip commit 的作者。 */
  tipAuthor: CommitAuthorLike | null | undefined;
  /** 分支 tip commit 时间（committer/author date）。 */
  tipCommittedAt: string | null | undefined;
  /** 最近一次 closed PR 的时间；没有则为 null。 */
  lastClosedPrAt: string | null | undefined;
}

/**
 * 是否重建卡死 PR：
 * 有分支、无 open PR、tip 作者是 bot（防人类分支误开 PR），
 * 且分支不比最近一次 closed PR 旧（原版「分支比上次 PR 新才重建」）。
 */
export function shouldRebuildPr(input: PrPoisonInput): boolean {
  if (!input.branchExists) return false;
  if (input.hasOpenPull) return false;
  if (!isBotAuthor(input.tipAuthor)) return false;

  const tipMs = toEpochMs(input.tipCommittedAt);
  const closedMs = toEpochMs(input.lastClosedPrAt);
  if (tipMs !== null && closedMs !== null && tipMs <= closedMs) return false;

  return true;
}

/** 巡检重建的 PR 内容。 */
export interface RecoveredPrContent {
  title: string;
  body: string;
  /** `parseStats` 的原始结果（第 0 条是 Total，单图除外）。 */
  stats: ImageStat[];
}

/** `createPrTitle` / `createPrBody` 需要的覆盖项子集。 */
export type PrOverrideSettings = Pick<RepoConfig, "prTitle" | "prBody">;

/**
 * 从 tip commit message 重建 PR 内容（§2.2：`parseStats` → `createPrBody`）。
 * 解析不出任何统计（或 message 不是 ImgBot 格式）→ null，调用方跳过。
 */
export function buildRecoveredPr(
  commitMessage: string | null | undefined,
  settings?: PrOverrideSettings | null,
): RecoveredPrContent | null {
  const stats = parseStats(commitMessage);
  if (!stats || stats.length === 0) return null;
  return {
    title: createPrTitle(settings),
    body: createPrBody(stats, settings),
    stats,
  };
}

/** 从 `.imgbotconfig` 文本提取 PR 覆盖项（缺文件 = 全默认）。 */
export function prOverridesFromConfig(raw: string | null): PrOverrideSettings {
  const config = parseImgbotConfig(raw);
  return { prTitle: config.prTitle, prBody: config.prBody };
}

/* -------------------------------------------------------------------------- */
/* ③′ 巡检目标选择（P1 加固 #5：巡检只巡 D1 里有历史的仓库）                   */
/* -------------------------------------------------------------------------- */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * `runs` 源的「最近活动」窗口（天）。只有陈旧 run 的仓库不再算「我们还在管」；
 * `repos` / `pulls` 两张小表是「碰过就永久记得」，不受此窗口限制。
 */
export const SWEEP_RUN_WINDOW_DAYS = 90;

/** `runs` 源一行：该仓库最近一次 run（SQL 用 `MAX(created_at) AS last_run_at`）。 */
export interface SweepRunRow {
  installation_id: number;
  repo: string;
  last_run_at?: string | null;
}

/** `repos` / `pulls` 源一行（`name AS repo`）；`default_branch` 只有 `repos` 表有。 */
export interface SweepRepoRow {
  installation_id: number;
  repo: string;
  default_branch?: string | null;
}

/** 巡检的三路候选来源（全部来自 D1；缺省 = 空集）。 */
export interface SweepTargetSources {
  runs?: ReadonlyArray<SweepRunRow> | null;
  repos?: ReadonlyArray<SweepRepoRow> | null;
  pulls?: ReadonlyArray<SweepRepoRow> | null;
}

/** 巡检目标：一个具体的 `installation_id` + `owner/repo`。 */
export interface SweepTarget {
  installationId: number;
  repo: string;
  /** `repos.default_branch`；只在 runs/pulls 有记录的仓库为 null（调用方回源查）。 */
  defaultBranch: string | null;
}

/**
 * 三源去重成巡检目标集合（P1 加固 #5）。
 *
 * 旧实现每次 cron 枚举全部 installation 的全部仓库，每仓库至少 1 次 GitHub
 * 调用（30 分钟一轮 ≈ 48 次/仓库/天）。未安装到的仓库不可能有我们的卡死 PR，
 * 所以目标集 = D1 里「我们碰过」的仓库：`runs`（近 {@link SWEEP_RUN_WINDOW_DAYS}
 * 天）、`repos`、`pulls` 的并集。调用预算随之从 O(全部仓库) 变成 O(有历史的仓库)。
 *
 * 纯函数：窗口过滤也在这里（不在 SQL 里），便于单测；行形状非法则跳过。
 * `defaultBranch` 优先取 `repos` 源的非空值。
 */
export function selectSweepTargets(
  sources: SweepTargetSources,
  now: Date | number = Date.now(),
): SweepTarget[] {
  const nowMs = toEpochMs(now);
  if (nowMs === null) {
    // 宁可让本轮 cron 失败并留日志，也不要静默按错误窗口（或空集）跑。
    throw new Error("selectSweepTargets: invalid `now`");
  }
  const cutoffMs = nowMs - SWEEP_RUN_WINDOW_DAYS * DAY_MS;

  const targets = new Map<string, SweepTarget>();

  const remember = (
    installationId: number,
    repo: string,
    defaultBranch: string | null,
  ): void => {
    const key = `${installationId}\u0000${repo}`;
    const existing = targets.get(key);
    if (!existing) {
      targets.set(key, { installationId, repo, defaultBranch });
      return;
    }
    if (!existing.defaultBranch && defaultBranch) {
      existing.defaultBranch = defaultBranch;
    }
  };

  for (const row of sources.runs ?? []) {
    const target = readTargetRow(row);
    if (!target) continue;
    const lastMs = toEpochMs(row?.last_run_at);
    // 窗口外的 run 不是「还在管」的证据；时间不可解析同样不算。
    if (lastMs === null || lastMs < cutoffMs) continue;
    remember(target.installationId, target.repo, null);
  }

  for (const row of sources.repos ?? []) {
    const target = readTargetRow(row);
    if (!target) continue;
    remember(target.installationId, target.repo, asString(row?.default_branch));
  }

  for (const row of sources.pulls ?? []) {
    const target = readTargetRow(row);
    if (!target) continue;
    remember(target.installationId, target.repo, null);
  }

  // 稳定顺序：日志/测试可复现（按 installation，再按仓库名）。
  return [...targets.values()].sort((a, b) => {
    if (a.installationId !== b.installationId) {
      return a.installationId - b.installationId;
    }
    return a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0;
  });
}

function readTargetRow(
  row: { installation_id?: unknown; repo?: unknown } | null | undefined,
): { installationId: number; repo: string } | null {
  if (row === null || typeof row !== "object") return null;
  const installationId = asNumber(row.installation_id);
  const repo = asString(row.repo);
  if (installationId === null || repo === null) return null;
  return { installationId, repo };
}

/* -------------------------------------------------------------------------- */
/* GitHub 列表响应窄化（纯解析，便于单测）                                    */
/* -------------------------------------------------------------------------- */

/** `GET /app/installations` → installation id 列表。 */
export function parseInstallationIds(body: unknown): number[] {
  const list = Array.isArray(body) ? body : [];
  const ids: number[] = [];
  for (const item of list) {
    const id = asNumber(asRecord(item)?.id);
    if (id !== null) ids.push(id);
  }
  return ids;
}

/** `GET /installation/repositories` → `{ repo, defaultBranch, isPrivate }`。 */
export function parseInstallationRepos(
  body: unknown,
): Array<{ repo: string; defaultBranch: string | null; isPrivate: boolean }> {
  const list = asArray(asRecord(body)?.repositories);
  const repos: Array<{
    repo: string;
    defaultBranch: string | null;
    isPrivate: boolean;
  }> = [];
  for (const item of list) {
    const record = asRecord(item);
    const repo = asString(record?.full_name);
    if (!repo) continue;
    repos.push({
      repo,
      defaultBranch: asString(record?.default_branch),
      isPrivate: record?.private === true,
    });
  }
  return repos;
}

/* -------------------------------------------------------------------------- */
/* helpers                                                                     */
/* -------------------------------------------------------------------------- */

function toEpochMs(
  value: string | number | Date | null | undefined,
): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value !== "string" || value === "") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
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
