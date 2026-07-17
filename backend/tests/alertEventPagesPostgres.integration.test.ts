import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  AlertEventCursorAheadError,
  listAlertEventPage,
} from "../src/alerts/eventPages.js";
import { parseAndHashAlertDefinition } from "../src/alerts/repositoryRows.js";
import { migrateDatabase } from "../src/database/migrations.js";
import { assertIsolatedTestDatabase } from "./support/postgresTestDatabase.js";

const connectionString =
  process.env.ALERTS_TEST_DATABASE_URL ?? process.env.JOBS_TEST_DATABASE_URL;
const describePostgres = connectionString ? describe : describe.skip;
const OWNER = "00000000-0000-4000-8000-000000000091";
const RULE = "00000000-0000-4000-8000-000000000092";
const PASSWORD_HASH = "test-auth-hash-placeholder";
const EVENT_SINCE = "2026-07-16T09:00:00.000Z";
let pool: Pool;

describePostgres("alert event forward pages against isolated PostgreSQL", () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString, max: 4 });
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
       ) VALUES ($1, 'alert-event-page-owner', 'alert-event-page-owner', $2, 'active')
       ON CONFLICT (id) DO NOTHING`,
      [OWNER, PASSWORD_HASH],
    );
  });

  beforeEach(async () => {
    await pool.query(
      "TRUNCATE alert_event_sequences, alert_rules, notification_bindings, alert_evaluation_receipts CASCADE",
    );
    await seedRule();
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("drains 51 committed owner events without a rolling-window loss", async () => {
    const empty = await listAlertEventPage(pool, {
      ownerUserId: OWNER,
      limit: 10,
    });
    expect(empty).toMatchObject({
      events: [],
      nextOwnerSequence: "0",
      hasMore: false,
    });

    const ids = Array.from({ length: 51 }, () => randomUUID());
    await pool.query(
      `INSERT INTO alert_rule_events (
         id, owner_user_id, alert_rule_id, rule_revision, state_key,
         idempotency_key, event_type, to_state, evidence,
         notification_requested, occurred_at
       )
       SELECT input.id, $1, $2, 1,
         'market:binance:spot:last:BTCUSDT:1m',
         input.idempotency_key, 'evaluation_error', 'unavailable',
         jsonb_build_object('summary', input.summary), FALSE,
         input.occurred_at
       FROM unnest(
         $3::uuid[],
         $4::text[],
         $5::text[],
         $6::timestamptz[]
       ) AS input(id, idempotency_key, summary, occurred_at)`,
      [
        OWNER,
        RULE,
        ids,
        ids.map((_, index) => `event-page:${index + 1}`),
        ids.map((_, index) => `Event ${index + 1}`),
        ids.map((_, index) =>
          new Date(
            Date.parse("2026-07-16T09:00:00.000Z") +
              (index % 2 === 0 ? 1_000 - index : index),
          ).toISOString(),
        ),
      ],
    );

    const first = await listAlertEventPage(pool, {
      ownerUserId: OWNER,
      afterOwnerSequence: empty.nextOwnerSequence,
      limit: 50,
    });
    expect(first.events).toHaveLength(50);
    expect(first).toMatchObject({
      nextOwnerSequence: "50",
      hasMore: true,
    });

    const second = await listAlertEventPage(pool, {
      ownerUserId: OWNER,
      afterOwnerSequence: first.nextOwnerSequence,
      limit: 50,
    });
    expect(second.events).toHaveLength(1);
    expect(second).toMatchObject({
      nextOwnerSequence: "51",
      hasMore: false,
    });
    expect(
      new Set([...first.events, ...second.events].map(({ id }) => id)),
    ).toEqual(new Set(ids));

    const retainedOrigin = await listAlertEventPage(pool, {
      ownerUserId: OWNER,
      ruleId: RULE,
      limit: 10,
    });
    expect(retainedOrigin.events).toHaveLength(10);
    expect(retainedOrigin).toMatchObject({
      nextOwnerSequence: "10",
      hasMore: true,
    });
  });

  it("selects a non-monotonic event-time window while paging by owner sequence", async () => {
    const fixtures = [
      { id: randomUUID(), occurredAt: EVENT_SINCE },
      { id: randomUUID(), occurredAt: "2026-07-16T08:59:00.000Z" },
      { id: randomUUID(), occurredAt: "2026-07-16T09:10:00.000Z" },
      { id: randomUUID(), occurredAt: "2026-07-16T08:00:00.000Z" },
      { id: randomUUID(), occurredAt: "2026-07-16T09:01:00.000Z" },
    ];
    for (const [index, fixture] of fixtures.entries()) {
      await pool.query(
        `INSERT INTO alert_rule_events (
           id, owner_user_id, alert_rule_id, rule_revision, state_key,
           idempotency_key, event_type, to_state, evidence,
           notification_requested, occurred_at
         ) VALUES (
           $1,$2,$3,1,'market:binance:spot:last:BTCUSDT:1m',
           $4,'evaluation_error','unavailable',$5::jsonb,FALSE,$6::timestamptz
         )`,
        [
          fixture.id,
          OWNER,
          RULE,
          `event-time-window:${index + 1}`,
          JSON.stringify({ summary: `Event-time fixture ${index + 1}` }),
          fixture.occurredAt,
        ],
      );
    }

    const first = await listAlertEventPage(pool, {
      ownerUserId: OWNER,
      notBefore: EVENT_SINCE,
      limit: 2,
    });
    expect(first.events.map(({ id }) => id)).toEqual([
      fixtures[0]?.id,
      fixtures[2]?.id,
    ]);
    expect(first).toMatchObject({
      nextOwnerSequence: "3",
      hasMore: true,
    });

    const second = await listAlertEventPage(pool, {
      ownerUserId: OWNER,
      afterOwnerSequence: first.nextOwnerSequence,
      notBefore: EVENT_SINCE,
      limit: 2,
    });
    expect(second.events.map(({ id }) => id)).toEqual([fixtures[4]?.id]);
    expect(second).toMatchObject({
      nextOwnerSequence: "5",
      hasMore: false,
    });
  });

  it("rejects a durable cursor ahead of a restored stream", async () => {
    await expect(
      listAlertEventPage(pool, {
        ownerUserId: OWNER,
        afterOwnerSequence: "1",
        limit: 10,
      }),
    ).rejects.toBeInstanceOf(AlertEventCursorAheadError);
  });
});

async function seedRule(): Promise<void> {
  const parsed = parseAndHashAlertDefinition({
    schemaVersion: "alert-rule-v1",
    kind: "price-threshold",
    name: "Event page fixture",
    enabled: false,
    cooldownSeconds: 0,
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
  });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO alert_rules (
         id, owner_user_id, client_id, rule_kind, status, current_revision,
         authorization_revision, evaluation_interval_seconds,
         created_by_user_id, updated_by_user_id
       ) VALUES ($1,$2,'event-page-fixture','price-threshold','disabled',1,1,60,$2,$2)`,
      [RULE, OWNER],
    );
    await client.query(
      `INSERT INTO alert_rule_revisions (
         owner_user_id, alert_rule_id, revision, schema_version, rule_kind,
         definition, definition_hash, actor_user_id
       ) VALUES ($1,$2,1,'alert-rule-v1','price-threshold',$3::jsonb,$4,$1)`,
      [OWNER, RULE, parsed.serialized, parsed.hash],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
