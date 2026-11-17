/**
 * 保留策略 + DLQ 捕获测试（P0 加固）。
 *
 * 用极简 fake D1 记录 SQL 与绑定参数：断言的是**语义**
 * （哪张表、什么时间下界、几条语句），不是 D1 本身。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEAD_LETTER_ERROR,
  RETENTION_DAYS,
  handleDeadLetterBatch,
  pruneExpired,
  recordDeadLetter,
} from "../src/maintenance";
import type { DeadLetterMessage } from "../src/maintenance";
import type { Env } from "../src/types";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-11-18T03:00:00Z");

interface LogEntry {
  sql: string;
  args: unknown[];
}

class FakeD1 {
  logs: LogEntry[] = [];

  constructor(
    private readonly options: {
      /** 每条语句的 meta.changes（默认 0）。 */
      changes?: number;
      /** 命中该子串的语句抛错（模拟 DDL 滞后 / 表不存在）。 */
      failOn?: string;
    } = {},
  ) {}

  prepare(sql: string) {
    const self = this;
    const norm = sql.replace(/\s+/g, " ").trim();
    return {
      bind(...args: unknown[]) {
        return {
          async run() {
            self.logs.push({ sql: norm, args });
            if (self.options.failOn && norm.includes(self.options.failOn)) {
              throw new Error(`no such table: ${self.options.failOn}`);
            }
            return {
              success: true,
              meta: { changes: self.options.changes ?? 0 },
            };
          },
        };
      },
    };
  }
}

function envWith(db: FakeD1): Env {
  return { DB: db } as unknown as Env;
}

function iso(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString();
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

/* -------------------------------------------------------------------------- */
/* pruneExpired                                                                */
/* -------------------------------------------------------------------------- */

describe("pruneExpired", () => {
  it("五张表各一条 DELETE，时间下界按各自保留窗口（独立语句）", async () => {
    const db = new FakeD1({ changes: 7 });

    const counts = await pruneExpired(envWith(db), NOW);

    expect(db.logs.map((entry) => entry.sql)).toEqual([
      "DELETE FROM sessions WHERE expires_at < ?",
      "DELETE FROM deliveries WHERE received_at < ?",
      "DELETE FROM runs WHERE created_at < ?",
      "DELETE FROM dead_letters WHERE received_at < ?",
      "DELETE FROM image_cache WHERE optimized_at IS NOT NULL AND optimized_at < ?",
    ]);

    const bounds = db.logs.map((entry) => entry.args[0]);
    expect(bounds).toEqual([
      iso(0), // sessions：过期时刻 = now
      iso(-RETENTION_DAYS.deliveries * DAY_MS), // deliveries 30 天
      iso(-RETENTION_DAYS.runs * DAY_MS), // runs 365 天
      iso(-RETENTION_DAYS.deadLetters * DAY_MS), // dead_letters 90 天
      iso(-RETENTION_DAYS.imageCache * DAY_MS), // image_cache 180 天
    ]);
    expect(bounds[1]).toBe("2026-10-19T03:00:00.000Z");
    expect(bounds[2]).toBe("2025-11-18T03:00:00.000Z");
    expect(bounds[3]).toBe("2026-08-20T03:00:00.000Z");
    expect(bounds[4]).toBe("2026-05-22T03:00:00.000Z");

    // 每条语句只有一个绑定参数（时间界）。
    expect(db.logs.every((entry) => entry.args.length === 1)).toBe(true);

    expect(counts).toEqual({
      sessions: 7,
      deliveries: 7,
      runs: 7,
      deadLetters: 7,
      imageCache: 7,
    });
  });

  it("单表失败（DDL 滞后）不连坐：记 0 + 日志，其余照删", async () => {
    const db = new FakeD1({ changes: 2, failOn: "dead_letters" });

    const counts = await pruneExpired(envWith(db), NOW);

    expect(db.logs).toHaveLength(5);
    expect(counts).toEqual({
      sessions: 2,
      deliveries: 2,
      runs: 2,
      deadLetters: 0,
      imageCache: 2,
    });
    expect(console.error).toHaveBeenCalled();
  });

  it("缺 meta.changes → 计 0（不抛）", async () => {
    const db = {
      prepare: (sql: string) => ({
        bind: () => ({ run: async () => ({ success: true, sql }) }),
      }),
    } as unknown as FakeD1;

    const counts = await pruneExpired(envWith(db), NOW);
    expect(counts).toEqual({
      sessions: 0,
      deliveries: 0,
      runs: 0,
      deadLetters: 0,
      imageCache: 0,
    });
  });
});

/* -------------------------------------------------------------------------- */
/* DLQ                                                                         */
/* -------------------------------------------------------------------------- */

describe("recordDeadLetter", () => {
  it("INSERT 一行：queue / attempts / body / error / received_at", async () => {
    const db = new FakeD1();
    await recordDeadLetter(
      envWith(db),
      {
        queue: "router-dlq",
        attempts: 4,
        body: '{"run_id":"r1"}',
        error: DEAD_LETTER_ERROR,
      },
      NOW,
    );

    expect(db.logs).toHaveLength(1);
    expect(db.logs[0].sql).toContain("INSERT INTO dead_letters");
    expect(db.logs[0].args).toEqual([
      "router-dlq",
      4,
      '{"run_id":"r1"}',
      "no retryable",
      iso(0),
    ]);
  });
});

describe("handleDeadLetterBatch", () => {
  function message(body: unknown, attempts?: number) {
    let acked = 0;
    const msg: DeadLetterMessage = {
      body,
      attempts,
      ack: () => {
        acked += 1;
      },
    };
    return { msg, acked: () => acked };
  }

  it("逐条落库 + ack；对象 body 序列化，attempts 缺失归一为 null", async () => {
    const db = new FakeD1();
    const first = message({ run_id: "r1", repo: "o/r" }, 3);
    const second = message("plain-text-dlq", undefined);

    await handleDeadLetterBatch(
      { queue: "router-dlq", messages: [first.msg, second.msg] },
      envWith(db),
      NOW,
    );

    expect(db.logs).toHaveLength(2);
    expect(db.logs[0].args).toEqual([
      "router-dlq",
      3,
      '{"run_id":"r1","repo":"o/r"}',
      "no retryable",
      iso(0),
    ]);
    expect(db.logs[1].args).toEqual([
      "router-dlq",
      null,
      "plain-text-dlq",
      "no retryable",
      iso(0),
    ]);

    expect(first.acked()).toBe(1);
    expect(second.acked()).toBe(1);
    expect(console.error).toHaveBeenCalledTimes(2);
  });

  it("落库失败也必须 ack（DLQ 里没有「下次再来」）", async () => {
    const db = new FakeD1({ failOn: "INSERT INTO dead_letters" });
    const only = message({ run_id: "r1" }, 1);

    await handleDeadLetterBatch(
      { queue: "router-dlq", messages: [only.msg] },
      envWith(db),
      NOW,
    );

    expect(only.acked()).toBe(1);
    // 一次是「落库失败」，一次是「消息体摘要」。
    expect(console.error).toHaveBeenCalledTimes(2);
  });
});
