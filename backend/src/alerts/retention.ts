import { performance } from "node:perf_hooks";
import type { Pool, PoolClient } from "pg";

export const ALERT_HISTORY_RETENTION_DAYS = 30;
// The durable state cursor and revision/state hashes carry the long-lived fence.
// Receipts are a short replay/audit window: the 480-rule beta ceiling at a 1m
// cadence is eight sustained evaluations/second, or at most 1,382,400 rows over
// two days before compaction catches up (R11 must soak this bound).
export const ALERT_EVALUATION_RECEIPT_RETENTION_DAYS = 2;
export const ALERT_ARCHIVED_RULE_RETENTION_DAYS = 30;
// Telegram command bridge (R5.3b-2): tokens die at their 120s expiry, so a
// consumed/expired confirmation row is pure audit residue after two days.
// Replied reply rows keep a week of command history; unreplied rows are left
// to the replies lane, and executor_commands retention cascades the rest
// through the ON DELETE CASCADE foreign key.
export const TELEGRAM_CONFIRMATION_RETENTION_DAYS = 2;
export const TELEGRAM_COMMAND_REPLY_RETENTION_DAYS = 7;
export const ALERT_RETENTION_DEFAULT_BATCH_SIZE = 1_000;
export const ALERT_RETENTION_MAX_BATCH_SIZE = 5_000;
export const ALERT_RETENTION_DEFAULT_MAX_ROWS = 6_000;
export const ALERT_RETENTION_MAX_ROWS = 25_000;
export const ALERT_RETENTION_DEFAULT_TIME_BUDGET_MS = 2_000;
export const ALERT_RETENTION_MAX_TIME_BUDGET_MS = 10_000;

const ALERT_RETENTION_ADVISORY_LOCK = 1_895_696_369;

export interface AlertRetentionOptions {
  batchSize?: number;
  maxRowsPerRun?: number;
  timeBudgetMs?: number;
  statementTimeoutMs?: number;
  monotonicNow?: () => number;
}

export interface AlertRetentionResult {
  acquired: boolean;
  timeBudgetReached: boolean;
  deliveries: number;
  outbox: number;
  events: number;
  receipts: number;
  states: number;
  revisions: number;
  archivedRules: number;
  telegramConfirmations: number;
  telegramReplies: number;
  deletedRows: number;
  elapsedMs: number;
}

interface RetentionStage {
  key: Exclude<keyof AlertRetentionResult, "acquired" | "timeBudgetReached" | "deletedRows" | "elapsedMs">;
  sql: string;
  retentionDays: number;
}

/**
 * Incremental alert-history compaction. One transaction holds a non-blocking
 * advisory lock, every candidate scan uses SKIP LOCKED, and both statements and
 * the whole run are bounded. Child rows are removed before their immutable
 * parents; archived rules close the alert stages and rely on declared CASCADE
 * FKs. The Telegram command-bridge stages (consumed/expired confirmations,
 * replied reply rows) run last — they reference nothing downstream.
 */
export class AlertControlPlaneRetention {
  private readonly batchSize: number;
  private readonly maxRowsPerRun: number;
  private readonly timeBudgetMs: number;
  private readonly statementTimeoutMs: number;
  private readonly monotonicNow: () => number;

  constructor(
    private readonly pool: Pool,
    options: AlertRetentionOptions = {}
  ) {
    this.batchSize = boundedInteger(options.batchSize, ALERT_RETENTION_DEFAULT_BATCH_SIZE, 1, ALERT_RETENTION_MAX_BATCH_SIZE);
    this.maxRowsPerRun = boundedInteger(options.maxRowsPerRun, ALERT_RETENTION_DEFAULT_MAX_ROWS, 1, ALERT_RETENTION_MAX_ROWS);
    this.timeBudgetMs = boundedInteger(options.timeBudgetMs, ALERT_RETENTION_DEFAULT_TIME_BUDGET_MS, 50, ALERT_RETENTION_MAX_TIME_BUDGET_MS);
    this.statementTimeoutMs = boundedInteger(options.statementTimeoutMs, Math.min(1_000, this.timeBudgetMs), 25, Math.min(5_000, this.timeBudgetMs));
    this.monotonicNow = options.monotonicNow ?? performance.now.bind(performance);
  }

  async run(): Promise<AlertRetentionResult> {
    const startedAt = this.monotonicNow();
    const result = emptyResult();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('statement_timeout', $1, true), set_config('lock_timeout', $1, true)", [`${this.statementTimeoutMs}ms`]);
      const lock = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_xact_lock($1::integer) AS locked", [ALERT_RETENTION_ADVISORY_LOCK]);
      if (lock.rows[0]?.locked !== true) {
        await client.query("COMMIT");
        return finishResult(result, startedAt, this.monotonicNow());
      }
      result.acquired = true;

      let madeProgress = true;
      while (madeProgress && result.deletedRows < this.maxRowsPerRun) {
        madeProgress = false;
        for (const stage of RETENTION_STAGES) {
          if (result.deletedRows >= this.maxRowsPerRun || this.monotonicNow() - startedAt >= this.timeBudgetMs) {
            result.timeBudgetReached = this.monotonicNow() - startedAt >= this.timeBudgetMs;
            break;
          }
          const limit = Math.min(this.batchSize, this.maxRowsPerRun - result.deletedRows);
          const deleted = await deleteBatch(client, stage.sql, limit, stage.retentionDays);
          result[stage.key] += deleted;
          result.deletedRows += deleted;
          madeProgress ||= deleted > 0;
        }
      }
      await client.query("COMMIT");
      return finishResult(result, startedAt, this.monotonicNow());
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

const RETENTION_STAGES: readonly RetentionStage[] = [
  {
    key: "deliveries",
    retentionDays: ALERT_HISTORY_RETENTION_DAYS,
    sql: `WITH candidates AS MATERIALIZED (
      SELECT d.id
      FROM notification_deliveries d
      WHERE d.status IN ('delivered', 'dead_letter', 'cancelled')
        AND d.terminal_at < clock_timestamp() - ($2::integer * interval '1 day')
      ORDER BY d.terminal_at, d.owner_user_id, d.id
      FOR UPDATE OF d SKIP LOCKED
      LIMIT $1
    )
    DELETE FROM notification_deliveries d
    USING candidates c
    WHERE d.id = c.id
    RETURNING d.id`
  },
  {
    key: "outbox",
    retentionDays: ALERT_HISTORY_RETENTION_DAYS,
    sql: `WITH candidates AS MATERIALIZED (
      SELECT o.id
      FROM notification_outbox o
      WHERE o.created_at < clock_timestamp() - ($2::integer * interval '1 day')
        AND NOT EXISTS (
          SELECT 1 FROM notification_deliveries d
          WHERE d.owner_user_id = o.owner_user_id AND d.outbox_id = o.id
        )
      ORDER BY o.created_at, o.owner_user_id, o.id
      FOR UPDATE OF o SKIP LOCKED
      LIMIT $1
    )
    DELETE FROM notification_outbox o
    USING candidates c
    WHERE o.id = c.id
    RETURNING o.id`
  },
  {
    key: "events",
    retentionDays: ALERT_HISTORY_RETENTION_DAYS,
    sql: `WITH candidates AS MATERIALIZED (
      SELECT e.id
      FROM alert_rule_events e
      WHERE e.created_at < clock_timestamp() - ($2::integer * interval '1 day')
        AND NOT EXISTS (
          SELECT 1 FROM notification_outbox o
          WHERE o.owner_user_id = e.owner_user_id AND o.alert_event_id = e.id
        )
      ORDER BY e.created_at, e.owner_user_id, e.id
      FOR UPDATE OF e SKIP LOCKED
      LIMIT $1
    )
    DELETE FROM alert_rule_events e
    USING candidates c
    WHERE e.id = c.id
    RETURNING e.id`
  },
  {
    key: "receipts",
    retentionDays: ALERT_EVALUATION_RECEIPT_RETENTION_DAYS,
    sql: `WITH candidates AS MATERIALIZED (
      SELECT r.owner_user_id, r.producer, r.alert_rule_id, r.rule_revision,
        r.observation_id
      FROM alert_evaluation_receipts r
      WHERE r.created_at < clock_timestamp() - ($2::integer * interval '1 day')
      ORDER BY r.created_at, r.owner_user_id, r.producer, r.observation_id
      FOR UPDATE OF r SKIP LOCKED
      LIMIT $1
    )
    DELETE FROM alert_evaluation_receipts r
    USING candidates c
    WHERE r.owner_user_id = c.owner_user_id
      AND r.producer = c.producer
      AND r.alert_rule_id = c.alert_rule_id
      AND r.rule_revision = c.rule_revision
      AND r.observation_id = c.observation_id
    RETURNING r.observation_id`
  },
  {
    key: "states",
    retentionDays: ALERT_HISTORY_RETENTION_DAYS,
    sql: `WITH candidates AS MATERIALIZED (
      SELECT s.owner_user_id, s.alert_rule_id, s.state_key
      FROM alert_rule_states s
      INNER JOIN alert_rules r
        ON r.owner_user_id = s.owner_user_id AND r.id = s.alert_rule_id
      WHERE (s.rule_revision <> r.current_revision OR r.status = 'archived')
        AND s.updated_at < clock_timestamp() - ($2::integer * interval '1 day')
      ORDER BY s.updated_at, s.owner_user_id, s.alert_rule_id, s.state_key
      FOR UPDATE OF s SKIP LOCKED
      LIMIT $1
    )
    DELETE FROM alert_rule_states s
    USING candidates c
    WHERE s.owner_user_id = c.owner_user_id
      AND s.alert_rule_id = c.alert_rule_id
      AND s.state_key = c.state_key
    RETURNING s.state_key`
  },
  {
    key: "revisions",
    retentionDays: ALERT_HISTORY_RETENTION_DAYS,
    sql: `WITH candidates AS MATERIALIZED (
      SELECT v.owner_user_id, v.alert_rule_id, v.revision
      FROM alert_rule_revisions v
      INNER JOIN alert_rules r
        ON r.owner_user_id = v.owner_user_id AND r.id = v.alert_rule_id
      WHERE v.revision <> r.current_revision
        AND v.created_at < clock_timestamp() - ($2::integer * interval '1 day')
        AND NOT EXISTS (
          SELECT 1 FROM alert_rule_states s
          WHERE s.owner_user_id = v.owner_user_id
            AND s.alert_rule_id = v.alert_rule_id
            AND s.rule_revision = v.revision
        )
        AND NOT EXISTS (
          SELECT 1 FROM alert_evaluation_receipts x
          WHERE x.owner_user_id = v.owner_user_id
            AND x.alert_rule_id = v.alert_rule_id
            AND x.rule_revision = v.revision
        )
        AND NOT EXISTS (
          SELECT 1 FROM alert_rule_events e
          WHERE e.owner_user_id = v.owner_user_id
            AND e.alert_rule_id = v.alert_rule_id
            AND e.rule_revision = v.revision
        )
        AND NOT EXISTS (
          SELECT 1 FROM notification_outbox o
          WHERE o.owner_user_id = v.owner_user_id
            AND o.alert_rule_id = v.alert_rule_id
            AND o.rule_revision = v.revision
        )
      ORDER BY v.created_at, v.owner_user_id, v.alert_rule_id, v.revision
      FOR UPDATE OF v SKIP LOCKED
      LIMIT $1
    )
    DELETE FROM alert_rule_revisions v
    USING candidates c
    WHERE v.owner_user_id = c.owner_user_id
      AND v.alert_rule_id = c.alert_rule_id
      AND v.revision = c.revision
    RETURNING v.revision`
  },
  {
    key: "archivedRules",
    retentionDays: ALERT_ARCHIVED_RULE_RETENTION_DAYS,
    sql: `WITH candidates AS MATERIALIZED (
      SELECT r.owner_user_id, r.id
      FROM alert_rules r
      WHERE r.status = 'archived'
        AND r.archived_at < clock_timestamp() - ($2::integer * interval '1 day')
        AND r.lease_owner IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM alert_rule_states s
          WHERE s.owner_user_id = r.owner_user_id AND s.alert_rule_id = r.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM alert_evaluation_receipts x
          WHERE x.owner_user_id = r.owner_user_id AND x.alert_rule_id = r.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM alert_rule_events e
          WHERE e.owner_user_id = r.owner_user_id AND e.alert_rule_id = r.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM notification_outbox o
          WHERE o.owner_user_id = r.owner_user_id AND o.alert_rule_id = r.id
        )
      ORDER BY r.archived_at, r.owner_user_id, r.id
      FOR UPDATE OF r SKIP LOCKED
      LIMIT $1
    ), detached_imports AS (
      UPDATE alert_rule_import_receipts i
      SET target_rule_id = NULL
      FROM candidates c
      WHERE i.owner_user_id = c.owner_user_id AND i.target_rule_id = c.id
      RETURNING i.source_key
    )
    DELETE FROM alert_rules r
    USING candidates c
    WHERE r.owner_user_id = c.owner_user_id AND r.id = c.id
    RETURNING r.id`
  },
  {
    key: "telegramConfirmations",
    retentionDays: TELEGRAM_CONFIRMATION_RETENTION_DAYS,
    sql: `WITH candidates AS MATERIALIZED (
      SELECT t.id
      FROM telegram_confirmations t
      WHERE (t.consumed_at IS NOT NULL OR t.expires_at < clock_timestamp())
        AND t.created_at < clock_timestamp() - ($2::integer * interval '1 day')
      ORDER BY t.created_at, t.owner_user_id, t.id
      FOR UPDATE OF t SKIP LOCKED
      LIMIT $1
    )
    DELETE FROM telegram_confirmations t
    USING candidates c
    WHERE t.id = c.id
    RETURNING t.id`
  },
  {
    key: "telegramReplies",
    retentionDays: TELEGRAM_COMMAND_REPLY_RETENTION_DAYS,
    sql: `WITH candidates AS MATERIALIZED (
      SELECT r.command_id
      FROM telegram_command_replies r
      WHERE r.replied_at IS NOT NULL
        AND r.created_at < clock_timestamp() - ($2::integer * interval '1 day')
      ORDER BY r.created_at, r.owner_user_id, r.command_id
      FOR UPDATE OF r SKIP LOCKED
      LIMIT $1
    )
    DELETE FROM telegram_command_replies r
    USING candidates c
    WHERE r.command_id = c.command_id
    RETURNING r.command_id`
  }
];

async function deleteBatch(client: PoolClient, sql: string, limit: number, retentionDays: number): Promise<number> {
  const result = await client.query(sql, [limit, retentionDays]);
  return result.rowCount ?? result.rows.length;
}

function emptyResult(): AlertRetentionResult {
  return {
    acquired: false,
    timeBudgetReached: false,
    deliveries: 0,
    outbox: 0,
    events: 0,
    receipts: 0,
    states: 0,
    revisions: 0,
    archivedRules: 0,
    telegramConfirmations: 0,
    telegramReplies: 0,
    deletedRows: 0,
    elapsedMs: 0
  };
}

function finishResult(result: AlertRetentionResult, startedAt: number, finishedAt: number): AlertRetentionResult {
  result.elapsedMs = Math.max(0, Math.round(finishedAt - startedAt));
  return result;
}

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(value!)));
}
