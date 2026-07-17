import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AlertCapacityError, AlertQuotaError, AlertRepository } from "../src/alerts/repository.js";
import { parseAndHashAlertDefinition } from "../src/alerts/repositoryRows.js";
import { migrateDatabase } from "../src/database/migrations.js";
import { assertIsolatedTestDatabase } from "./support/postgresTestDatabase.js";

const connectionString = process.env.ALERTS_TEST_DATABASE_URL ?? process.env.JOBS_TEST_DATABASE_URL;
const describePostgres = connectionString ? describe : describe.skip;
const OWNERS = Array.from({ length: 7 }, (_, index) => `00000000-0000-4000-8000-${String(index + 201).padStart(12, "0")}`);
const PASSWORD_HASH = "test-auth-hash-placeholder";
const ACTIVE_DEFINITION = definition(true);
const DISABLED_DEFINITION = definition(false);
let pool: Pool;

describePostgres("alert management and beta capacity against isolated PostgreSQL", () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString, max: 8 });
    await assertIsolatedTestDatabase(pool, process.env.ALERTS_TEST_DATABASE_URL ? "ALERTS_TEST_DATABASE_URL" : "JOBS_TEST_DATABASE_URL");
    await migrateDatabase(pool);
    for (const [index, owner] of OWNERS.entries()) {
      await pool.query(
        `INSERT INTO users (id, login, login_normalized, password_hash, status)
         VALUES ($1, $2, $2, $3, 'active') ON CONFLICT (id) DO NOTHING`,
        [owner, `alert-capacity-${index + 1}`, PASSWORD_HASH]
      );
    }
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE alert_event_sequences, alert_rules, notification_bindings, alert_evaluation_receipts CASCADE");
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("lists every non-archived rule before newer archived history and archive frees quota immediately", async () => {
    const rows: FixtureRule[] = [];
    for (let index = 0; index < 100; index += 1) rows.push(fixture(OWNERS[0]!, "active", index, "2026-05-01T00:00:00.000Z"));
    for (let index = 100; index < 200; index += 1) rows.push(fixture(OWNERS[0]!, "disabled", index, "2026-05-01T00:00:00.000Z"));
    for (let index = 200; index < 350; index += 1) rows.push(fixture(OWNERS[0]!, "archived", index, "2026-07-17T00:00:00.000Z"));
    await insertFixtureRules(rows);
    const repository = new AlertRepository(pool);

    const managed = await repository.list(OWNERS[0]!);
    expect(managed).toHaveLength(200);
    expect(managed.every((rule) => rule.status !== "archived")).toBe(true);
    expect(managed.filter((rule) => rule.status === "active")).toHaveLength(100);
    expect(managed.filter((rule) => rule.status === "disabled")).toHaveLength(100);

    await expect(
      repository.create({
        ownerUserId: OWNERS[0]!,
        actorUserId: OWNERS[0]!,
        authorizationRevision: 1,
        clientId: "capacity.before-archive",
        definition: DISABLED_DEFINITION
      })
    ).rejects.toBeInstanceOf(AlertQuotaError);

    const disabled = managed.find((rule) => rule.status === "disabled")!;
    await repository.archive({
      ownerUserId: OWNERS[0]!,
      actorUserId: OWNERS[0]!,
      authorizationRevision: 1,
      ruleId: disabled.id,
      expectedRevision: 1
    });
    await expect(
      repository.create({
        ownerUserId: OWNERS[0]!,
        actorUserId: OWNERS[0]!,
        authorizationRevision: 1,
        clientId: "capacity.after-archive",
        definition: DISABLED_DEFINITION
      })
    ).resolves.toMatchObject({ clientId: "capacity.after-archive", status: "disabled" });
  });

  it("always allows archive at history pressure and caps only subsequent creation at 400 total records", async () => {
    const archived = Array.from({ length: 200 }, (_, index) => fixture(OWNERS[0]!, "archived", 1_000 + index, "2026-07-17T00:00:00.000Z"));
    const active = fixture(OWNERS[0]!, "active", 1_200, "2026-07-17T00:00:00.000Z");
    await insertFixtureRules([...archived, active]);
    const repository = new AlertRepository(pool);

    await expect(
      repository.archive({
        ownerUserId: OWNERS[0]!,
        actorUserId: OWNERS[0]!,
        authorizationRevision: 1,
        ruleId: active.id,
        expectedRevision: 1
      })
    ).resolves.toMatchObject({ id: active.id, status: "archived" });

    const remainingHistory = Array.from({ length: 199 }, (_, index) => fixture(OWNERS[0]!, "archived", 1_201 + index, "2026-07-17T00:00:00.000Z"));
    await insertFixtureRules(remainingHistory);
    await expect(
      repository.create({
        ownerUserId: OWNERS[0]!,
        actorUserId: OWNERS[0]!,
        authorizationRevision: 1,
        clientId: "capacity.total-history",
        definition: DISABLED_DEFINITION
      })
    ).rejects.toBeInstanceOf(AlertQuotaError);

    const counts = await pool.query<{ total: string; active: string }>(
      "SELECT count(*)::text AS total, count(*) FILTER (WHERE status = 'active')::text AS active FROM alert_rules WHERE owner_user_id = $1",
      [OWNERS[0]!]
    );
    expect(counts.rows[0]).toEqual({ total: "400", active: "0" });
  });

  it("serializes cross-owner activation so only one rule crosses 479 to the global ceiling", async () => {
    const rows = Array.from({ length: 479 }, (_, index) => fixture(OWNERS[index % 5]!, "active", index, "2026-07-17T00:00:00.000Z"));
    await insertFixtureRules(rows);
    const repository = new AlertRepository(pool);
    const attempts = await Promise.allSettled(
      [OWNERS[5]!, OWNERS[6]!].map((owner, index) =>
        repository.create({
          ownerUserId: owner,
          actorUserId: owner,
          authorizationRevision: 1,
          clientId: `global-capacity-${index}`,
          definition: ACTIVE_DEFINITION
        })
      )
    );

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((attempt): attempt is PromiseRejectedResult => attempt.status === "rejected");
    expect(rejected?.reason).toBeInstanceOf(AlertCapacityError);
    const active = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM alert_rules WHERE status = 'active'");
    expect(active.rows[0]?.count).toBe("480");
  });
});

interface FixtureRule {
  id: string;
  ownerUserId: string;
  clientId: string;
  status: "active" | "disabled" | "archived";
  definition: Record<string, unknown>;
  definitionHash: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

function fixture(ownerUserId: string, status: FixtureRule["status"], index: number, updatedAt: string): FixtureRule {
  const source = status === "active" ? ACTIVE_DEFINITION : DISABLED_DEFINITION;
  const parsed = parseAndHashAlertDefinition(source);
  return {
    id: randomUUID(),
    ownerUserId,
    clientId: `fixture.${index}.${randomUUID().slice(0, 8)}`,
    status,
    definition: parsed.definition,
    definitionHash: parsed.hash,
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt,
    archivedAt: status === "archived" ? updatedAt : null
  };
}

async function insertFixtureRules(rows: FixtureRule[]): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO alert_rules (
         id, owner_user_id, client_id, rule_kind, status, current_revision,
         authorization_revision, evaluation_interval_seconds, next_evaluation_at,
         created_by_user_id, updated_by_user_id, created_at, updated_at, archived_at
       )
       SELECT x.id, x.owner_user_id, x.client_id, 'price-threshold', x.status, 1,
         1, 60, CASE WHEN x.status = 'active' THEN clock_timestamp() ELSE NULL END,
         x.owner_user_id, x.owner_user_id, x.created_at, x.updated_at, x.archived_at
       FROM jsonb_to_recordset($1::jsonb) AS x(
         id uuid, owner_user_id uuid, client_id text, status text,
         created_at timestamptz, updated_at timestamptz, archived_at timestamptz
       )`,
      [JSON.stringify(rows.map((row) => ({ id: row.id, owner_user_id: row.ownerUserId, client_id: row.clientId, status: row.status, created_at: row.createdAt, updated_at: row.updatedAt, archived_at: row.archivedAt })))]
    );
    await client.query(
      `INSERT INTO alert_rule_revisions (
         owner_user_id, alert_rule_id, revision, schema_version, rule_kind,
         definition, definition_hash, actor_user_id, created_at
       )
       SELECT x.owner_user_id, x.id, 1, 'alert-rule-v1', 'price-threshold',
         x.definition, x.definition_hash, x.owner_user_id, x.created_at
       FROM jsonb_to_recordset($1::jsonb) AS x(
         id uuid, owner_user_id uuid, definition jsonb, definition_hash text,
         created_at timestamptz
       )`,
      [JSON.stringify(rows.map((row) => ({ id: row.id, owner_user_id: row.ownerUserId, definition: row.definition, definition_hash: row.definitionHash, created_at: row.createdAt })))]
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function definition(enabled: boolean) {
  return {
    schemaVersion: "alert-rule-v1",
    kind: "price-threshold",
    name: enabled ? "Active capacity fixture" : "Disabled capacity fixture",
    enabled,
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
  } as const;
}
