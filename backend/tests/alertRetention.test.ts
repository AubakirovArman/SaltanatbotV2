import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { ALERT_EVALUATION_RECEIPT_RETENTION_DAYS, ALERT_RETENTION_MAX_BATCH_SIZE, ALERT_RETENTION_MAX_ROWS, AlertControlPlaneRetention } from "../src/alerts/retention.js";

describe("alert control-plane retention", () => {
  it("uses one non-blocking lock, FK-safe stage order and hard row bounds", async () => {
    const database = poolDouble((sql, values) => {
      if (sql.includes("pg_try_advisory_xact_lock")) {
        return rows([{ locked: true }]);
      }
      if (sql.includes("DELETE FROM notification_deliveries")) {
        return count(Number(values[0]));
      }
      if (sql.includes("DELETE FROM notification_outbox")) {
        return count(Number(values[0]));
      }
      if (sql.includes("DELETE FROM alert_rule_events")) {
        return count(Number(values[0]));
      }
      if (sql.includes("DELETE FROM")) return count(0);
      return rows([]);
    });
    const retention = new AlertControlPlaneRetention(database.pool, {
      batchSize: 2,
      maxRowsPerRun: 5,
      timeBudgetMs: 1_000,
      statementTimeoutMs: 250
    });

    await expect(retention.run()).resolves.toMatchObject({
      acquired: true,
      deliveries: 2,
      outbox: 2,
      events: 1,
      receipts: 0,
      deletedRows: 5
    });
    expect(database.calls.at(0)?.sql).toBe("BEGIN");
    expect(database.calls.at(-1)?.sql).toBe("COMMIT");
    expect(database.calls[1]?.values).toEqual(["250ms"]);

    const deletes = database.calls.filter((call) => call.sql.includes("DELETE FROM"));
    expect(deletes.map((call) => deletedTable(call.sql))).toEqual(["notification_deliveries", "notification_outbox", "alert_rule_events"]);
    expect(deletes.every((call) => call.sql.includes("SKIP LOCKED"))).toBe(true);
    expect(deletes.every((call) => Number(call.values[0]) <= 2)).toBe(true);
  });

  it("does no deletion when another worker owns the advisory lock", async () => {
    const database = poolDouble((sql) => (sql.includes("pg_try_advisory_xact_lock") ? rows([{ locked: false }]) : rows([])));

    await expect(new AlertControlPlaneRetention(database.pool).run()).resolves.toMatchObject({ acquired: false, deletedRows: 0 });
    expect(database.calls.some((call) => call.sql.includes("DELETE FROM"))).toBe(false);
    expect(database.calls.at(-1)?.sql).toBe("COMMIT");
  });

  it("stops between batches at its time budget and rolls back failures", async () => {
    let clock = 0;
    const timed = poolDouble((sql) => {
      if (sql.includes("pg_try_advisory_xact_lock")) {
        clock = 60;
        return rows([{ locked: true }]);
      }
      return rows([]);
    });
    await expect(
      new AlertControlPlaneRetention(timed.pool, {
        timeBudgetMs: 50,
        monotonicNow: () => clock
      }).run()
    ).resolves.toMatchObject({
      acquired: true,
      timeBudgetReached: true,
      deletedRows: 0,
      elapsedMs: 60
    });

    const failed = poolDouble((sql) => {
      if (sql.includes("pg_try_advisory_xact_lock")) {
        return rows([{ locked: true }]);
      }
      if (sql.includes("DELETE FROM notification_deliveries")) {
        throw new Error("retention statement failed");
      }
      return rows([]);
    });
    await expect(new AlertControlPlaneRetention(failed.pool).run()).rejects.toThrow("retention statement failed");
    expect(failed.calls.at(-1)?.sql).toBe("ROLLBACK");
    expect(failed.release).toHaveBeenCalledOnce();
  });

  it("clamps hostile batch and run limits to explicit capacity ceilings", async () => {
    const database = poolDouble((sql, values) => {
      if (sql.includes("pg_try_advisory_xact_lock")) {
        return rows([{ locked: true }]);
      }
      if (sql.includes("DELETE FROM notification_deliveries")) {
        expect(values[0]).toBe(ALERT_RETENTION_MAX_BATCH_SIZE);
        return count(Number(values[0]));
      }
      if (sql.includes("DELETE FROM notification_outbox")) {
        return count(Number(values[0]));
      }
      if (sql.includes("DELETE FROM alert_rule_events")) {
        return count(Number(values[0]));
      }
      if (sql.includes("DELETE FROM alert_evaluation_receipts")) {
        return count(Number(values[0]));
      }
      if (sql.includes("DELETE FROM alert_rule_states")) {
        return count(Number(values[0]));
      }
      return count(0);
    });
    const result = await new AlertControlPlaneRetention(database.pool, {
      batchSize: Number.MAX_SAFE_INTEGER,
      maxRowsPerRun: Number.MAX_SAFE_INTEGER
    }).run();
    expect(result.deletedRows).toBe(ALERT_RETENTION_MAX_ROWS);
    expect(database.calls.find((call) => call.sql.includes("DELETE FROM alert_evaluation_receipts"))?.values[1]).toBe(ALERT_EVALUATION_RECEIPT_RETENTION_DAYS);
  });
});

interface QueryCall {
  sql: string;
  values: readonly unknown[];
}

interface QueryResult {
  rows: unknown[];
  rowCount: number;
}

function poolDouble(handler: (sql: string, values: readonly unknown[]) => QueryResult): {
  pool: Pool;
  calls: QueryCall[];
  release: ReturnType<typeof vi.fn>;
} {
  const calls: QueryCall[] = [];
  const release = vi.fn();
  const client = {
    query: vi.fn(async (sql: string, values: readonly unknown[] = []) => {
      calls.push({ sql, values });
      return handler(sql, values);
    }),
    release
  } as unknown as PoolClient;
  return {
    pool: { connect: vi.fn(async () => client) } as unknown as Pool,
    calls,
    release
  };
}

function rows(value: unknown[]): QueryResult {
  return { rows: value, rowCount: value.length };
}

function count(value: number): QueryResult {
  return rows(Array.from({ length: value }, () => ({})));
}

function deletedTable(sql: string): string {
  return /DELETE FROM ([a-z_]+)/.exec(sql)?.[1] ?? "unknown";
}
