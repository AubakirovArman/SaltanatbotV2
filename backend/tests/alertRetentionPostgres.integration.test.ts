import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AlertControlPlaneRetention } from "../src/alerts/retention.js";
import { migrateDatabase } from "../src/database/migrations.js";
import { assertIsolatedTestDatabase } from "./support/postgresTestDatabase.js";

const connectionString = process.env.ALERTS_TEST_DATABASE_URL ?? process.env.JOBS_TEST_DATABASE_URL;
const describePostgres = connectionString ? describe : describe.skip;
const OWNER = "00000000-0000-4000-8000-0000000000a1";
const OLD_RULE = "00000000-0000-4000-8000-0000000000a2";
const ARCHIVED_RULE = "00000000-0000-4000-8000-0000000000a3";
const FRESH_RULE = "00000000-0000-4000-8000-0000000000a4";
const PASSWORD_HASH = "test-auth-hash-placeholder";
const HASH = "a".repeat(64);
const OLD = "2026-05-01T00:00:00.000Z";
const DEFINITION = {
  schemaVersion: "alert-rule-v1",
  kind: "price-threshold",
  name: "Retention fixture",
  enabled: true,
  cooldownSeconds: 0,
  deliveryChannels: ["in-app"],
  researchOnly: true,
  executionPermission: false,
  exchange: "binance",
  marketType: "spot",
  priceType: "last",
  symbol: "BTCUSDT",
  timeframe: "1m",
  direction: "above",
  threshold: "100",
  crossing: "inclusive",
  repeat: "once-until-rearmed"
};

let pool: Pool;

describePostgres("alert retention against isolated PostgreSQL", () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString, max: 8 });
    await assertIsolatedTestDatabase(pool, process.env.ALERTS_TEST_DATABASE_URL ? "ALERTS_TEST_DATABASE_URL" : "JOBS_TEST_DATABASE_URL");
    await migrateDatabase(pool);
    await pool.query(
      `INSERT INTO users (id, login, login_normalized, password_hash, status)
       VALUES ($1, 'alert-retention-owner', 'alert-retention-owner', $2, 'active')
       ON CONFLICT (id) DO NOTHING`,
      [OWNER, PASSWORD_HASH]
    );
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE alert_event_sequences, alert_rules, notification_bindings, alert_evaluation_receipts CASCADE");
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("installs every lookup and candidate index used by bounded compaction", async () => {
    const indexes = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_catalog.pg_indexes
       WHERE schemaname = 'public' AND indexname = ANY($1::text[])
       ORDER BY indexname`,
      [
        [
          "alert_rules_archived_retention_index",
          "alert_rules_global_active_capacity_index",
          "alert_rule_revisions_retention_index",
          "alert_rule_states_compaction_index",
          "notification_outbox_event_lookup_index",
          "notification_deliveries_outbox_lookup_index",
          "alert_rule_import_receipts_target_lookup_index",
          "alert_evaluation_receipts_retention_index",
          "alert_evaluation_receipts_rule_revision_index"
        ]
      ]
    );
    expect(indexes.rows.map((row) => row.indexname)).toEqual([
      "alert_evaluation_receipts_retention_index",
      "alert_evaluation_receipts_rule_revision_index",
      "alert_rule_import_receipts_target_lookup_index",
      "alert_rule_revisions_retention_index",
      "alert_rule_states_compaction_index",
      "alert_rules_archived_retention_index",
      "alert_rules_global_active_capacity_index",
      "notification_deliveries_outbox_lookup_index",
      "notification_outbox_event_lookup_index"
    ]);
  });

  it("compacts old child history, obsolete revisions and archived rules in FK-safe order", async () => {
    await insertRule(OLD_RULE, { currentRevision: 2 });
    await insertOldHistory(OLD_RULE);
    await insertRule(ARCHIVED_RULE, { archived: true });
    await pool.query(
      `INSERT INTO alert_rule_import_receipts (
         owner_user_id, source_kind, source_key, source_hash, target_rule_id,
         disposition, semantic_payload, imported_at
       ) VALUES ($1, 'browser-price-v1', 'retention-import', $2, $3, 'imported', '{}'::jsonb, $4)`,
      [OWNER, HASH, ARCHIVED_RULE, OLD]
    );
    await insertRule(FRESH_RULE);

    const retention = new AlertControlPlaneRetention(pool, {
      batchSize: 100,
      maxRowsPerRun: 1_000,
      timeBudgetMs: 5_000,
      statementTimeoutMs: 2_000
    });
    await expect(retention.run()).resolves.toMatchObject({
      acquired: true,
      deliveries: 1,
      outbox: 1,
      events: 1,
      receipts: 1,
      states: 1,
      revisions: 1,
      archivedRules: 1,
      deletedRows: 7
    });

    const counts = await pool.query<{
      old_revisions: string;
      archived_rules: string;
      fresh_rules: string;
      receipts: string;
      event_sequences: string;
      events: string;
      outbox: string;
      deliveries: string;
      detached_imports: string;
    }>(
      `SELECT
        (SELECT count(*)::text FROM alert_rule_revisions WHERE alert_rule_id = $1) AS old_revisions,
        (SELECT count(*)::text FROM alert_rules WHERE id = $2) AS archived_rules,
        (SELECT count(*)::text FROM alert_rules WHERE id = $3) AS fresh_rules,
        (SELECT count(*)::text FROM alert_evaluation_receipts) AS receipts,
        (SELECT count(*)::text FROM alert_event_sequences) AS event_sequences,
        (SELECT count(*)::text FROM alert_rule_events) AS events,
        (SELECT count(*)::text FROM notification_outbox) AS outbox,
        (SELECT count(*)::text FROM notification_deliveries) AS deliveries,
        (SELECT count(*)::text FROM alert_rule_import_receipts WHERE source_key = 'retention-import' AND target_rule_id IS NULL) AS detached_imports`,
      [OLD_RULE, ARCHIVED_RULE, FRESH_RULE]
    );
    expect(counts.rows[0]).toEqual({
      old_revisions: "1",
      archived_rules: "0",
      fresh_rules: "1",
      receipts: "0",
      event_sequences: "1",
      events: "0",
      outbox: "0",
      deliveries: "0",
      detached_imports: "1"
    });
  });

  it("skips immediately when the singleton retention lock is held elsewhere", async () => {
    const lockClient = await pool.connect();
    try {
      await lockClient.query("BEGIN");
      await lockClient.query("SELECT pg_advisory_xact_lock(1895696369)");
      await expect(new AlertControlPlaneRetention(pool).run()).resolves.toMatchObject({
        acquired: false,
        deletedRows: 0
      });
    } finally {
      await lockClient.query("ROLLBACK");
      lockClient.release();
    }
  });
});

async function insertRule(ruleId: string, options: { currentRevision?: 1 | 2; archived?: boolean } = {}): Promise<void> {
  const currentRevision = options.currentRevision ?? 1;
  const archived = options.archived === true;
  const clientId = `retention.${ruleId.slice(-4)}`;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO alert_rules (
         id, owner_user_id, client_id, rule_kind, status, current_revision,
         authorization_revision, evaluation_interval_seconds, next_evaluation_at,
         created_by_user_id, updated_by_user_id, created_at, updated_at, archived_at
       ) VALUES (
         $1, $2, $3, 'price-threshold', $4::varchar, $5, 1, 60,
         CASE WHEN $4::varchar = 'active' THEN clock_timestamp() ELSE NULL END,
         $2, $2, $6, CASE WHEN $4::varchar = 'archived' THEN $6::timestamptz ELSE clock_timestamp() END,
         CASE WHEN $4::varchar = 'archived' THEN $6::timestamptz ELSE NULL END
       )`,
      [ruleId, OWNER, clientId, archived ? "archived" : "active", currentRevision, OLD]
    );
    await client.query(
      `INSERT INTO alert_rule_revisions (
         owner_user_id, alert_rule_id, revision, schema_version, rule_kind,
         definition, definition_hash, actor_user_id, created_at
       ) VALUES ($1, $2, 1, 'alert-rule-v1', 'price-threshold', $3::jsonb, $4, $1, $5)`,
      [OWNER, ruleId, JSON.stringify(DEFINITION), HASH, OLD]
    );
    if (currentRevision === 2) {
      await client.query(
        `INSERT INTO alert_rule_revisions (
           owner_user_id, alert_rule_id, revision, schema_version, rule_kind,
           definition, definition_hash, actor_user_id
         ) VALUES ($1, $2, 2, 'alert-rule-v1', 'price-threshold', $3::jsonb, $4, $1)`,
        [OWNER, ruleId, JSON.stringify({ ...DEFINITION, threshold: "101" }), "b".repeat(64)]
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function insertOldHistory(ruleId: string): Promise<void> {
  const stateKey = "market:binance:spot:last:BTCUSDT:1m";
  const observationId = `${stateKey}:bar:0`;
  const eventId = randomUUID();
  const outboxId = randomUUID();
  await pool.query(
    `INSERT INTO alert_rule_states (
       owner_user_id, alert_rule_id, state_key, rule_revision, state_revision,
       state_status, initialized, eligible, armed, state, last_evaluated_at, updated_at
     ) VALUES ($1, $2, $3, 1, 1, 'ineligible', TRUE, FALSE, TRUE, '{}'::jsonb, $4, $4)`,
    [OWNER, ruleId, stateKey, OLD]
  );
  await pool.query(
    `INSERT INTO alert_evaluation_receipts (
       owner_user_id, producer, alert_rule_id, rule_revision, state_key,
       observation_id, observation_hash, state_revision_before, state_revision_after,
       outcome, transition_key, prior_state_hash, committed_state_hash,
       evaluated_at, created_at
     ) VALUES ($1, 'price-alert-worker', $2, 1, $3, $4, $5, 0, 1,
       'armed', NULL, $5, $5, $6, $6)`,
    [OWNER, ruleId, stateKey, observationId, HASH, OLD]
  );
  await pool.query(
    `INSERT INTO alert_rule_events (
       id, owner_user_id, alert_rule_id, rule_revision, state_key,
       idempotency_key, event_type, from_state, to_state, observation_id,
       observation_hash, evidence, notification_requested, occurred_at, created_at
     ) VALUES ($1, $2, $3, 1, $4, $5, 'triggered', 'ineligible', 'eligible',
       $6, $7, '{}'::jsonb, TRUE, $8, $8)`,
    [eventId, OWNER, ruleId, stateKey, HASH.slice(0, 32), observationId, HASH, OLD]
  );
  await pool.query(
    `INSERT INTO notification_outbox (
       id, owner_user_id, alert_event_id, alert_rule_id, rule_revision,
       authorization_revision, deduplication_key, schema_version, payload,
       payload_hash, created_at
     ) VALUES ($1, $2, $3, $4, 1, 1, $5, 'notification-envelope-v1', '{}'::jsonb, $6, $7)`,
    [outboxId, OWNER, eventId, ruleId, HASH.slice(0, 32), HASH, OLD]
  );
  await pool.query(
    `INSERT INTO notification_deliveries (
       id, owner_user_id, outbox_id, channel, deduplication_key, status,
       attempt, max_attempts, run_after, lease_generation, created_at,
       updated_at, terminal_at, delivered_at
     ) VALUES ($1, $2, $3, 'in-app', $4, 'delivered', 1, 1, $5, 1, $5, $5, $5, $5)`,
    [randomUUID(), OWNER, outboxId, HASH.slice(0, 32), OLD]
  );
}
