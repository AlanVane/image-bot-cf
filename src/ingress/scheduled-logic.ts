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

/** `GET /installation/repositories` → `{ repo, defaultBranch }`。 */
export function parseInstallationRepos(
  body: unknown,
): Array<{ repo: string; defaultBranch: string | null }> {
  const list = asArray(asRecord(body)?.repositories);
  const repos: Array<{ repo: string; defaultBranch: string | null }> = [];
  for (const item of list) {
    const record = asRecord(item);
    const repo = asString(record?.full_name);
    if (!repo) continue;
    repos.push({ repo, defaultBranch: asString(record?.default_branch) });
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
