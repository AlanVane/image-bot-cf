/**
 * 共享契约 —— 各模块唯一事实来源。
 * 语义以 DESIGN.md 为准；本文件只做类型固化，禁止在此加业务逻辑。
 */

/** §5.2 / §2.4 触发来源 */
export type Trigger =
  "installation" | "push" | "schedule" | "manual" | "recovery";

/** §5.2 Queue 消息（描述符模式：禁止携带图片字节，128KB 限制） */
export interface RunDescriptor {
  run_id: string;
  installation_id: number;
  repo: string;
  trigger: Trigger;
  base_ref: string;
  base_sha?: string;
  delivery_id?: string;
}

/** §2.3 .imgbotconfig 解析结果 */
export interface RepoConfig {
  schedule: "daily" | "weekly" | "monthly" | null;
  ignoredFiles: string[];
  aggressiveCompression: boolean;
  compressWiki: boolean;
  minKBReduced: number;
  prTitle: string | null;
  prBody: string | null;
}

/** §2.2 commit 行统计；大小单位 KB（double，= bytes/1024） */
export interface CompressionResult {
  /** `*${path}` 或 `*Total` */
  title: string;
  sizeBeforeKb: number;
  sizeAfterKb: number;
}

/** §2.2 PR 明细行；before/after 为 Stats.ParseStats 保留的原文（含 `kb` 后缀，如 `163.11kb`） */
export interface ImageStat {
  name: string;
  before: string;
  after: string;
  percent: number;
}

/** §5.1 run 状态机 */
export type RunState =
  | "queued"
  | "scanning"
  | "optimizing"
  | "committing"
  | "pr_open"
  | "merged_cleanup"
  | "done"
  | "skipped_threshold"
  | "skipped_nochange"
  | "skipped_guard"
  | "aborted_by_human"
  | "failed";

/** §6 优化契约的跳过原因 */
export type SkipReason =
  "not_smaller" | "too_large" | "decode_failed" | "unsupported" | "ignored";

/**
 * §6 优化契约：optimized 非空当且仅当 严格变小 且 再解码校验通过。
 * 任何异常路径都必须回到 skipped，绝不产出损坏或变大的文件。
 */
export interface OptimizeOutcome {
  path: string;
  originalSize: number;
  optimizedSize: number | null;
  optimized: Uint8Array | null;
  skipped: SkipReason | null;
}

/** Git Data API 扫描结果条目 */
export interface TreeBlob {
  path: string;
  sha: string;
  size: number;
}

/**
 * 解码中间产物。刻意不依赖 DOM 的 ImageData 全局：
 * jsquash 解码返回 { data, width, height } 形状；workerd 是否提供全局 ImageData
 * 待 §11-3 实测，如缺则在 codec init 处补一个 ~5 行 shim。
 */
export interface ImageDataLike {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}

/** §6.1 按扩展名分派的编解码器集合（wasm Module 注入，见 §6.2） */
export interface CodecSet {
  png?: {
    decode: (bytes: Uint8Array) => Promise<ImageDataLike>;
    encode: (img: ImageDataLike) => Promise<Uint8Array>;
  };
  jpeg?: {
    /** P1 无损 = 元数据/段剥离（字节级），见 lane 实现 */
    stripMetadata: (bytes: Uint8Array) => Uint8Array;
    /** P2 有损重编码（jsquash） */
    decode?: (bytes: Uint8Array) => Promise<ImageDataLike>;
    encode?: (
      img: ImageDataLike,
      opts: { quality: number },
    ) => Promise<Uint8Array>;
  };
  svg?: {
    optimize: (svg: string) => string;
  };
  gif?: {
    /**
     * GIF 重编码（omggif 解码 + gifenc 编码；默认保色调色板 → 像素无损）。
     * P2 落地，替代原版 gifsicle（GPL-2 传染性见 LICENSES.md）。
     */
    optimize: (
      bytes: Uint8Array,
      opts: { aggressive: boolean },
    ) => Uint8Array | Promise<Uint8Array>;
  };
}

/** Worker 绑定环境（wrangler.jsonc 对应） */
export interface Env {
  DB: D1Database;
  STAGING: R2Bucket;
  ROUTER: Queue<RunDescriptor>;
  OPTIMIZE: Workflow;
  REPO_LOCK: DurableObjectNamespace<import("./do/repo-lock").RepoLock>;
  GITHUB_APP_ID: string;
  GITHUB_PRIVATE_KEY: string;
  GITHUB_WEBHOOK_SECRET: string;
}
