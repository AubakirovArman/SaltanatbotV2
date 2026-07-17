import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateDatabase } from "../src/database/migrations.js";
import { DATABASE_MIGRATIONS } from "../src/database/schema.js";
import { assertIsolatedTestDatabase } from "./support/postgresTestDatabase.js";

const connectionString =
  process.env.ALERTS_TEST_DATABASE_URL ?? process.env.JOBS_TEST_DATABASE_URL;
const describePostgres = connectionString ? describe : describe.skip;
const OWNER_A = "00000000-0000-4000-8000-000000000081";
const OWNER_B = "00000000-0000-4000-8000-000000000082";
const ACTOR = "00000000-0000-4000-8000-000000000083";
const PASSWORD_HASH = "test-auth-hash-placeholder";
let pool: Pool;

describePostgres("owner alert control plane against isolated PostgreSQL", () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString, max: 8 });
    await assertIsolatedTestDatabase(
      pool,
      process.env.ALERTS_TEST_DATABASE_URL
        ? "ALERTS_TEST_DATABASE_URL"
        : "JOBS_TEST_DATABASE_URL",
    );
    await migrateDatabase(pool);
    await pool.query(
      `INSERT INTO users (
         id, login, login_normalized, password_hash, status
       ) VALUES
         ($1, 'alerts-owner-a', 'alerts-owner-a', $4, 'active'),
         ($2, 'alerts-owner-b', 'alerts-owner-b', $4, 'active'),
         ($3, 'alerts-actor', 'alerts-actor', $4, 'active')
       ON CONFLICT (id) DO NOTHING`,
      [OWNER_A, OWNER_B, ACTOR, PASSWORD_HASH],
    );
  });

  beforeEach(async () => {
    await pool.query(
      "TRUNCATE alert_event_sequences, alert_rules, notification_bindings, alert_evaluation_receipts CASCADE",
    );
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("installs every v13 owner, lease, outbox and retention boundary", async () => {
    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])
       ORDER BY table_name`,
      [[
        "alert_rules",
        "alert_rule_revisions",
        "alert_rule_states",
        "alert_evaluation_receipts",
        "alert_event_sequences",
        "alert_rule_events",
        "notification_bindings",
        "notification_outbox",
        "notification_deliveries",
        "alert_rule_import_receipts",
      ]],
    );
    expect(tables.rows.map(({ table_name }) => table_name)).toEqual([
      "alert_evaluation_receipts",
      "alert_event_sequences",
      "alert_rule_events",
      "alert_rule_import_receipts",
      "alert_rule_revisions",
      "alert_rule_states",
      "alert_rules",
      "notification_bindings",
      "notification_deliveries",
      "notification_outbox",
    ]);

    const indexes = await pool.query<{ indexname: string }>(
      `SELECT indexname
       FROM pg_catalog.pg_indexes
       WHERE schemaname = 'public'
         AND tablename = ANY($1::text[])
       ORDER BY indexname`,
      [[
        "alert_rules",
        "alert_rule_states",
        "alert_rule_events",
        "notification_outbox",
        "notification_deliveries",
      ]],
    );
    expect(indexes.rows.map(({ indexname }) => indexname)).toEqual(
      expect.arrayContaining([
        "alert_rules_due_evaluation_index",
        "alert_rules_expired_lease_index",
        "alert_rules_one_leased_per_owner",
        "alert_rule_states_retention_index",
        "alert_rule_events_retention_index",
        "alert_rule_events_owner_sequence_unique",
        "notification_outbox_retention_index",
        "notification_deliveries_due_index",
        "notification_deliveries_expired_lease_index",
        "notification_deliveries_one_sending_per_owner",
        "notification_deliveries_terminal_retention_index",
      ]),
    );

    const columns = await pool.query<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])`,
      [[
        "alert_rules",
        "notification_bindings",
        "notification_outbox",
        "notification_deliveries",
      ]],
    );
    expect(columns.rows.map(({ column_name }) => column_name).join(" ")).not.toMatch(
      /api_key|bot_token|telegram_token|chat_id|password_hash|private_key|exchange_secret|signed_request/i,
    );
  });

  it("upgrades schema v12 to v13 atomically without assigning tenant data", async () => {
    const schemaName = `alerts_v13_${randomUUID().replaceAll("-", "")}`;
    await pool.query(`CREATE SCHEMA "${schemaName}" AUTHORIZATION CURRENT_USER`);
    const migrationPool = new Pool({
      connectionString,
      max: 1,
      options: `-c search_path="${schemaName}"`,
    });
    const owner = "00000000-0000-4000-8000-000000000089";
    try {
      await migrateDatabase(migrationPool, {
        migrations: DATABASE_MIGRATIONS.slice(0, 12),
      });
      await migrationPool.query(
        `INSERT INTO users (
           id, login, login_normalized, password_hash, status
         ) VALUES ($1, 'alerts-v12-owner', 'alerts-v12-owner', $2, 'active')`,
        [owner, PASSWORD_HASH],
      );

      await expect(
        migrateDatabase(migrationPool, { migrations: DATABASE_MIGRATIONS.slice(0, 13) }),
      ).resolves.toMatchObject({
        fromVersion: 12,
        toVersion: 13,
        applied: [
          {
            version: 13,
            name: "durable_owner_alerts_and_notification_outbox",
          },
        ],
      });
      const proof = await migrationPool.query<{
        users: string;
        rules: string;
        outbox: string;
      }>(
        `SELECT
           (SELECT count(*)::text FROM users WHERE id = $1) AS users,
           (SELECT count(*)::text FROM alert_rules) AS rules,
           (SELECT count(*)::text FROM notification_outbox) AS outbox`,
        [owner],
      );
      expect(proof.rows[0]).toEqual({
        users: "1",
        rules: "0",
        outbox: "0",
      });
      await expect(
        migrationPool.query(
          `INSERT INTO runtime_component_heartbeats (
             component,
             generation_id,
             status,
             started_at,
             heartbeat_at,
             database_schema_version
           ) VALUES (
             'notification-worker',
             $1,
             'ready',
             clock_timestamp(),
             clock_timestamp(),
             13
           )`,
          [randomUUID()],
        ),
      ).resolves.toMatchObject({ rowCount: 1 });
    } finally {
      await migrationPool.end();
      await pool.query(`DROP SCHEMA "${schemaName}" CASCADE`);
    }
  });

  it("enforces cross-owner graph isolation, immutable revisions and fair leases", async () => {
    const first = await insertRule(OWNER_A, "price:first");
    const second = await insertRule(OWNER_A, "price:second");

    await expect(
      pool.query(
        `INSERT INTO alert_rule_states (
           owner_user_id,
           alert_rule_id,
           state_key,
           rule_revision,
           state_status,
           initialized,
           eligible,
           armed,
           last_evaluated_at
         ) VALUES (
           $1,
           $2,
           'binance:spot:last:BTCUSDT:1m',
           1,
           'ineligible',
           true,
           false,
           true,
           clock_timestamp()
         )`,
        [OWNER_B, first],
      ),
    ).rejects.toMatchObject({ code: "23503" });

    await expect(
      pool.query(
        `UPDATE alert_rule_revisions
         SET definition_hash = $4
         WHERE owner_user_id = $1
           AND alert_rule_id = $2
           AND revision = $3`,
        [OWNER_A, first, 1, "f".repeat(64)],
      ),
    ).rejects.toThrow(/immutable/);

    await pool.query(
      `INSERT INTO alert_evaluation_receipts (
         owner_user_id, producer, alert_rule_id, rule_revision, state_key,
         observation_id, observation_hash, state_revision_before, state_revision_after,
         outcome, transition_key, prior_state_hash, committed_state_hash, evaluated_at
       ) VALUES ($1,'price-alert-worker',$2,1,$3,$4,$5,0,1,'armed',NULL,$6,$7,statement_timestamp())`,
      [OWNER_A, first, "market:binance:spot:last:BTCUSDT:1m", "market:binance:spot:last:BTCUSDT:1m:bar:1", "a".repeat(64), "b".repeat(64), "c".repeat(64)],
    );
    await expect(
      pool.query(
        `UPDATE alert_evaluation_receipts SET outcome = 'triggered'
         WHERE owner_user_id = $1 AND alert_rule_id = $2`,
        [OWNER_A, first],
      ),
    ).rejects.toThrow(/immutable/);
    await expect(
      pool.query(
        `DELETE FROM alert_evaluation_receipts
         WHERE owner_user_id = $1 AND alert_rule_id = $2`,
        [OWNER_A, first],
      ),
    ).resolves.toMatchObject({ rowCount: 1 });

    await pool.query(
      `UPDATE alert_rules
       SET lease_generation = 1,
           lease_owner = 'alert-worker:test',
           lease_token = $3,
           lease_acquired_at = clock_timestamp(),
           lease_expires_at = clock_timestamp() + interval '30 seconds'
       WHERE owner_user_id = $1 AND id = $2`,
      [OWNER_A, first, randomUUID()],
    );
    await expect(
      pool.query(
        `UPDATE alert_rules
         SET lease_generation = 1,
             lease_owner = 'alert-worker:test',
             lease_token = $3,
             lease_acquired_at = clock_timestamp(),
             lease_expires_at = clock_timestamp() + interval '30 seconds'
         WHERE owner_user_id = $1 AND id = $2`,
        [OWNER_A, second, randomUUID()],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("serializes same-owner event sequence assignment through commit order", async () => {
    const rule = await insertRule(OWNER_A, "event-sequence:commit-order");
    const first = await pool.connect();
    const second = await pool.connect();
    let firstOpen = false;
    let secondOpen = false;
    const insertEvent = (
      client: typeof first,
      key: string,
      ownerUserId = OWNER_A,
      alertRuleId = rule,
    ) =>
      client.query<{ owner_sequence: string }>(
        `INSERT INTO alert_rule_events (
           id, owner_user_id, alert_rule_id, rule_revision, state_key,
           idempotency_key, event_type, to_state, evidence,
           notification_requested, occurred_at
         ) VALUES ($1,$2,$3,1,$4,$5,'state_changed','ineligible','{}'::jsonb,FALSE,statement_timestamp())
         RETURNING owner_sequence::text AS owner_sequence`,
        [randomUUID(), ownerUserId, alertRuleId, "market:binance:spot:last:BTCUSDT:1m", key],
      );
    try {
      await first.query("BEGIN");
      firstOpen = true;
      await second.query("BEGIN");
      secondOpen = true;
      const firstInsert = await insertEvent(first, "sequence:first");
      expect(firstInsert.rows[0]?.owner_sequence).toBe("1");

      let secondSettled = false;
      const secondInsert = insertEvent(second, "sequence:second").then((result) => {
        secondSettled = true;
        return result;
      });
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      expect(secondSettled).toBe(false);

      await first.query("COMMIT");
      firstOpen = false;
      expect((await secondInsert).rows[0]?.owner_sequence).toBe("2");
      await second.query("COMMIT");
      secondOpen = false;

      const proof = await pool.query<{ owner_sequence: string; idempotency_key: string }>(
        `SELECT owner_sequence::text AS owner_sequence, idempotency_key
         FROM alert_rule_events WHERE owner_user_id = $1 AND alert_rule_id = $2
         ORDER BY owner_sequence ASC`,
        [OWNER_A, rule],
      );
      expect(proof.rows).toEqual([
        { owner_sequence: "1", idempotency_key: "sequence:first" },
        { owner_sequence: "2", idempotency_key: "sequence:second" },
      ]);

      await first.query("BEGIN");
      firstOpen = true;
      expect((await insertEvent(first, "sequence:rolled-back")).rows[0]?.owner_sequence).toBe("3");
      await first.query("ROLLBACK");
      firstOpen = false;
      expect((await insertEvent(second, "sequence:after-rollback")).rows[0]?.owner_sequence).toBe("3");

      const otherOwnerRule = await insertRule(OWNER_B, "event-sequence:other-owner");
      expect(
        (await insertEvent(second, "sequence:other-owner", OWNER_B, otherOwnerRule)).rows[0]
          ?.owner_sequence,
      ).toBe("1");
    } finally {
      if (firstOpen) await first.query("ROLLBACK").catch(() => undefined);
      if (secondOpen) await second.query("ROLLBACK").catch(() => undefined);
      first.release();
      second.release();
    }
  });

  it("fails closed on unsafe outbox flags and cross-owner bindings", async () => {
    const ruleId = await insertRule(OWNER_A, "price:outbox");
    const eventId = randomUUID();
    await pool.query(
      `INSERT INTO alert_rule_events (
         id,
         owner_user_id,
         alert_rule_id,
         rule_revision,
         state_key,
         idempotency_key,
         event_type,
         to_state,
         observation_id,
         observation_hash,
         evidence,
         notification_requested,
         occurred_at
       ) VALUES (
         $1,
         $2,
         $3,
         1,
         'binance:spot:last:BTCUSDT:1m',
         'price-level-v1:event:1',
         'triggered',
         'eligible',
         'binance:BTCUSDT:1m:1',
         $4,
         '{}'::jsonb,
         true,
         clock_timestamp()
       )`,
      [eventId, OWNER_A, ruleId, "a".repeat(64)],
    );
    const outboxValues = [
      randomUUID(),
      OWNER_A,
      eventId,
      ruleId,
      "price-level-v1:delivery:1",
      JSON.stringify({
        schemaVersion: "notification-envelope-v1",
        researchOnly: true,
        executionPermission: false,
      }),
      "b".repeat(64),
    ];
    await expect(
      pool.query(
        `${outboxInsertSql()}
         VALUES ($1,$2,$3,$4,1,1,$5,'notification-envelope-v1',$6::jsonb,$7,false,false)`,
        outboxValues,
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await pool.query(
      `${outboxInsertSql()}
       VALUES ($1,$2,$3,$4,1,1,$5,'notification-envelope-v1',$6::jsonb,$7,true,false)`,
      outboxValues,
    );

    const bindingId = randomUUID();
    await pool.query(
      `INSERT INTO notification_bindings (
         id,
         owner_user_id,
         channel,
         recipient_fingerprint
       ) VALUES ($1,$2,'telegram',$3)`,
      [bindingId, OWNER_B, "c".repeat(64)],
    );
    await expect(
      pool.query(
        `INSERT INTO notification_deliveries (
           id,
           owner_user_id,
           outbox_id,
           channel,
           binding_id,
           binding_revision,
           deduplication_key
         ) VALUES ($1,$2,$3,'telegram',$4,1,'price-level-v1:telegram:1')`,
        [randomUUID(), OWNER_A, outboxValues[0], bindingId],
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });
});

async function insertRule(ownerUserId: string, clientId: string): Promise<string> {
  const id = randomUUID();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO alert_rules (
         id,
         owner_user_id,
         client_id,
         rule_kind,
         authorization_revision,
         next_evaluation_at,
         created_by_user_id,
         updated_by_user_id
       ) VALUES ($1,$2,$3,'price-threshold',1,clock_timestamp(),$4,$4)`,
      [id, ownerUserId, clientId, ACTOR],
    );
    await client.query(
      `INSERT INTO alert_rule_revisions (
         owner_user_id,
         alert_rule_id,
         revision,
         schema_version,
         rule_kind,
         definition,
         definition_hash,
         actor_user_id
       ) VALUES (
         $1,
         $2,
         1,
         'alert-rule-v1',
         'price-threshold',
         $3::jsonb,
         $4,
         $5
       )`,
      [
        ownerUserId,
        id,
        JSON.stringify({
          schemaVersion: "alert-rule-v1",
          kind: "price-threshold",
          name: clientId,
          enabled: true,
          cooldownSeconds: 60,
          deliveryChannels: ["in-app"],
          exchange: "binance",
          marketType: "spot",
          priceType: "last",
          symbol: "BTCUSDT",
          timeframe: "1m",
          direction: "above",
          threshold: "65000",
          crossing: "inclusive",
          repeat: "once-until-rearmed",
          researchOnly: true,
          executionPermission: false,
        }),
        "d".repeat(64),
        ACTOR,
      ],
    );
    await client.query("COMMIT");
    return id;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function outboxInsertSql(): string {
  return `INSERT INTO notification_outbox (
    id,
    owner_user_id,
    alert_event_id,
    alert_rule_id,
    rule_revision,
    authorization_revision,
    deduplication_key,
    schema_version,
    payload,
    payload_hash,
    research_only,
    execution_permission
  )`;
}
