/**
 * §5.4 `RepoLock` —— 每个仓库的运行互斥 + push 防抖（复刻原版 `[Singleton("{InstallationId}")]`）。
 *
 * 这是**唯一入口漏斗**：Queue 消费者不直接建 Workflow 实例，一律调 `submit(desc)`。
 * - 锁空闲 → 记 current + 租约（60min alarm）→ 建 Workflow 实例 → `started`
 * - 锁占用 → 记 pending（后来者覆盖，最多 1 份 = 防抖）→ `coalesced`
 * - `finish(run_id)` 释放并把 pending 转正；`heartbeat(run_id)` 续租
 * - 租约到期（`alarm`）按 finish 处理：僵死 run 的兜底，不会永久占锁
 *
 * 实现约束（§5.4）：
 * - **RPC 方法**（DurableObject binding 直接调，勿用旧 `fetch` 路由）
 * - 全部状态落 `ctx.storage`（不用模块级变量，休眠/回收后仍一致）
 * - 建实例幂等：同 id 已存在按"已启动"处理
 *
 * DO id 约定（跨线契约）：`repo:${installation_id}/${repo}`。
 */

import { DurableObject } from "cloudflare:workers";

import { quotaAllowsNewRun } from "../quota";
import type { Env, RunDescriptor } from "../types";

/** §5.4 租约时长：60min（workflow 墙钟不限，靠 heartbeat 续）。 */
export const LEASE_MS = 60 * 60 * 1000;
/** pending 启动失败后的重试间隔（此时无 current，alarm 只做重试）。 */
export const PENDING_RETRY_MS = 60 * 1000;

const KEY_CURRENT = "current_run_id";
const KEY_PENDING = "pending_run";
const KEY_LEASE = "lease_until_ms";

/** `submit` 的返回值（入口线按此形状消费，见跨线契约）。 */
export interface RepoLockSubmitResult {
  /** true = 本次拿到锁并已创建 Workflow 实例。 */
  started: boolean;
  /** true = 锁被占用，描述符被记为 pending（后到者覆盖）。 */
  coalesced: boolean;
  /** true = 配额用尽（D10），未启动也未记 pending；缺省/undefined = 未触发。 */
  quotaExceeded?: boolean;
}

/** `finish` 的返回值：转正启动的 pending run id（没有则 null）。 */
export interface RepoLockFinishResult {
  startedRunId: string | null;
}

/**
 * `Workflow.create()` 在 id 已存在时抛错（workerd 文案为 "instance already exists"）。
 * 按"同 id 已存在 = 已启动"的幂等语义吞掉；其余错误照常上抛。
 */
function isInstanceAlreadyExists(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /already exists|already_exists|instance exists|duplicate/i.test(
    message,
  );
}

export class RepoLock extends DurableObject<Env> {
  /**
   * 串行化 RPC 变更的本地队列。
   *
   * DO 的 input gate 只保证"等待存储 I/O 时"不交错，而 `OPTIMIZE.create()` 是外部调用：
   * 若不串行，两个并发 `submit` 都可能读到空 current 并各建一个实例。
   * 这只是内存锁（非持久状态），实例被回收后自然失效 —— 持久状态全在 storage。
   */
  #tail: Promise<unknown> = Promise.resolve();

  #serialize<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(fn, fn);
    this.#tail = result.catch(() => undefined);
    return result;
  }

  /**
   * 入口漏斗：抢锁并启动 run，或把描述符记为 pending。
   * 幂等：`run_id` 已在运行（或实例已存在）→ 按已启动返回。
   */
  async submit(desc: RunDescriptor): Promise<RepoLockSubmitResult> {
    return this.#serialize(async () => {
      const current = await this.ctx.storage.get<string>(KEY_CURRENT);
      if (current) {
        // 锁占用：后来者覆盖（push 防抖，最多 1 份待跑）。
        await this.ctx.storage.put(KEY_PENDING, desc);
        return { started: false, coalesced: true };
      }

      // D10 配额：只拦"新启动"（coalesce/pending 转正属已接收的 run）。
      const quota = await quotaAllowsNewRun(this.env, desc.installation_id);
      if (!quota.allowed) {
        console.warn(
          `[RepoLock] quota exceeded for installation ${desc.installation_id}: ${quota.used}/${quota.limit} runs today`,
        );
        return { started: false, coalesced: false, quotaExceeded: true };
      }

      await this.startRun(desc);
      return { started: true, coalesced: false };
    });
  }

  /**
   * 释放锁（仅当 `run_id` 是当前持有者），若有 pending 则立即转正启动。
   * 陈旧调用（租约已被 alarm 兜底、或重复调用）不碰 pending，返回 `null`。
   */
  async finish(runId: string): Promise<RepoLockFinishResult> {
    return this.#serialize(async () => {
      const current = await this.ctx.storage.get<string>(KEY_CURRENT);
      if (current !== runId) return { startedRunId: null };
      return this.releaseAndStartPending();
    });
  }

  /** 续租（run 的每个 Workflow 步都会调一次，§5.3）。非持有者调用无效。 */
  async heartbeat(runId: string): Promise<void> {
    await this.#serialize(async () => {
      const current = await this.ctx.storage.get<string>(KEY_CURRENT);
      if (current !== runId) return;
      const leaseUntil = Date.now() + LEASE_MS;
      await this.ctx.storage.put(KEY_LEASE, leaseUntil);
      await this.ctx.storage.setAlarm(leaseUntil);
    });
  }

  /**
   * 租约 alarm（§5.4）。到期按 finish 处理（僵死 run 兜底）+ warn；
   * 无 current 但有 pending = pending 启动失败后的重试时机。
   */
  async alarm(): Promise<void> {
    await this.#serialize(async () => {
      const now = Date.now();
      const current = await this.ctx.storage.get<string>(KEY_CURRENT);
      if (current) {
        const leaseUntil = await this.ctx.storage.get<number>(KEY_LEASE);
        if (leaseUntil != null && leaseUntil > now) {
          // heartbeat 已续租、alarm 是旧值：按新租约重排。
          await this.ctx.storage.setAlarm(leaseUntil);
          return;
        }
        console.warn(
          `[RepoLock] run ${current} lease expired after ${LEASE_MS / 60000}min without heartbeat; ` +
            "treating as finished (hung run fallback)",
        );
        await this.releaseAndStartPending();
        return;
      }

      const pending = await this.ctx.storage.get<RunDescriptor>(KEY_PENDING);
      if (pending) {
        console.warn(
          `[RepoLock] retrying pending run ${pending.run_id} after a failed start`,
        );
        await this.startPending(pending);
      }
    });
  }

  /* ---------------------------------------------------------------------- */
  /* internals                                                              */
  /* ---------------------------------------------------------------------- */

  /**
   * 取得锁并创建 Workflow 实例（调用方已确认 current 为空）。
   * 建实例失败时回滚锁状态，避免白占 60min 租约。
   */
  private async startRun(desc: RunDescriptor): Promise<void> {
    const leaseUntil = Date.now() + LEASE_MS;
    await this.ctx.storage.put({
      [KEY_CURRENT]: desc.run_id,
      [KEY_LEASE]: leaseUntil,
    });
    await this.ctx.storage.setAlarm(leaseUntil);

    try {
      await this.env.OPTIMIZE.create({ id: desc.run_id, params: desc });
    } catch (err) {
      if (isInstanceAlreadyExists(err)) {
        // 幂等：同一 run_id 的实例已存在（重复投递 / 入口重试）→ 视为已启动。
        return;
      }
      await this.ctx.storage.delete([KEY_CURRENT, KEY_LEASE]);
      await this.ctx.storage.deleteAlarm();
      throw err;
    }
  }

  /** 清 current/租约，然后把 pending（若有）转正。 */
  private async releaseAndStartPending(): Promise<RepoLockFinishResult> {
    const pending = await this.ctx.storage.get<RunDescriptor>(KEY_PENDING);
    await this.ctx.storage.delete([KEY_CURRENT, KEY_LEASE]);

    if (!pending) {
      await this.ctx.storage.deleteAlarm();
      return { startedRunId: null };
    }

    const started = await this.startPending(pending);
    return { startedRunId: started ? pending.run_id : null };
  }

  /**
   * 启动 pending run；失败则放回 pending 并排一次重试 alarm（不抛给调用方：
   * 旧 run 的 finish 已经成功，不该因为下一个 run 起不来而失败）。
   */
  private async startPending(pending: RunDescriptor): Promise<boolean> {
    await this.ctx.storage.delete(KEY_PENDING);
    try {
      await this.startRun(pending);
      return true;
    } catch (err) {
      await this.ctx.storage.put(KEY_PENDING, pending);
      await this.ctx.storage.delete([KEY_CURRENT, KEY_LEASE]);
      await this.ctx.storage.setAlarm(Date.now() + PENDING_RETRY_MS);
      console.error(
        `[RepoLock] failed to start pending run ${pending.run_id}; retrying in ${PENDING_RETRY_MS / 1000}s`,
        err,
      );
      return false;
    }
  }
}
