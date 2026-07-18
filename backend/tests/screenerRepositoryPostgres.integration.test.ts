import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ScreenerDefinitionV1 } from "@saltanatbotv2/contracts";
import { migrateDatabase } from "../src/database/migrations.js";
import { LATEST_DATABASE_SCHEMA_VERSION } from "../src/database/schema.js";
import {
  parseAndHashScreenerDefinition,
  ScreenerAuthorizationConflictError,
  ScreenerIdempotencyConflictError,
  ScreenerNotFoundError,
  ScreenerQuotaError,
  ScreenerRepository,
  ScreenerRevisionConflictError
} from "../src/screener/repository.js";
import { MAX_ACTIVE_SCREENER_PRESETS_PER_OWNER } from "../src/screener/repositoryTypes.js";
import { assertIsolatedTestDatabase } from "./support/postgresTestDatabase.js";

const connectionString = process.env.SCREENER_TEST_DATABASE_URL ?? process.env.ALERTS_TEST_DATABASE_URL;
const describePostgres = connectionString ? describe : describe.skip;
const OWNER_A = "00000000-0000-4000-8000-000000000101";
const OWNER_B = "00000000-0000-4000-8000-000000000102";
const ADMIN = "00000000-0000-4000-8000-000000000103";
const PASSWORD_HASH = "test-auth-hash-placeholder";
let pool: Pool;
let repository: ScreenerRepository;

describePostgres("ScreenerRepository against isolated PostgreSQL", () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString, max: 8 });
    await assertIsolatedTestDatabase(pool, "SCREENER_TEST_DATABASE_URL");
    await migrateDatabase(pool);
    await pool.query(
      `INSERT INTO users (
         id, login, login_normalized, password_hash, status, app_role
       ) VALUES
         ($1, 'screener-owner-a', 'screener-owner-a', $4, 'active', 'user'),
         ($2, 'screener-owner-b', 'screener-owner-b', $4, 'active', 'user'),
         ($3, 'screener-admin', 'screener-admin', $4, 'active', 'admin')
       ON CONFLICT (id) DO UPDATE SET
         status = 'active', must_change_password = FALSE,
         authorization_revision = 1, app_role = EXCLUDED.app_role`,
      [OWNER_A, OWNER_B, ADMIN, PASSWORD_HASH]
    );
    repository = new ScreenerRepository(pool);
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE screener_presets CASCADE");
    await pool.query(
      `UPDATE users SET status = 'active', must_change_password = FALSE,
         authorization_revision = 1
       WHERE id = ANY($1::uuid[])`,
      [[OWNER_A, OWNER_B, ADMIN]]
    );
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query("TRUNCATE screener_presets CASCADE").catch(() => undefined);
    await pool.end();
  });

  it("migrates to schema v15 with the screener preset table and indexes installed", async () => {
    const applied = await pool.query<{ version: number }>("SELECT max(version)::integer AS version FROM schema_migrations");
    expect(applied.rows[0]?.version).toBe(LATEST_DATABASE_SCHEMA_VERSION);
    expect(applied.rows[0]?.version).toBe(18);
    const objects = await pool.query<{ table_name: string | null; owner_index: string | null; retention_index: string | null }>(
      `SELECT to_regclass('public.screener_presets')::text AS table_name,
         to_regclass('public.screener_presets_owner_recent_index')::text AS owner_index,
         to_regclass('public.screener_presets_retention_index')::text AS retention_index`
    );
    expect(objects.rows[0]).toEqual({
      table_name: "screener_presets",
      owner_index: "screener_presets_owner_recent_index",
      retention_index: "screener_presets_retention_index"
    });
  });

  it("isolates presets by owner and rejects non-owner actors", async () => {
    const first = await createPreset(OWNER_A, "owner-a:first");
    const second = await createPreset(OWNER_B, "owner-b:first");

    expect((await repository.list(OWNER_A)).map(({ id }) => id)).toEqual([first.id]);
    expect((await repository.list(OWNER_B)).map(({ id }) => id)).toEqual([second.id]);
    expect(await repository.get(OWNER_A, second.id)).toBeUndefined();
    expect(await repository.get(ADMIN, first.id)).toBeUndefined();
    expect(await repository.get(OWNER_A, first.id)).toMatchObject({ id: first.id, revision: 1, definition: first.definition });

    await expect(
      repository.create({
        ownerUserId: OWNER_A,
        actorUserId: ADMIN,
        authorizationRevision: 1,
        clientId: "admin:create-bypass",
        definition: definition({ name: "Admin bypass" })
      })
    ).rejects.toBeInstanceOf(ScreenerNotFoundError);
    await expect(
      repository.update({
        ownerUserId: OWNER_A,
        actorUserId: ADMIN,
        presetId: first.id,
        expectedRevision: 1,
        authorizationRevision: 1,
        definition: definition({ name: "Admin update bypass" })
      })
    ).rejects.toBeInstanceOf(ScreenerNotFoundError);
    await expect(
      repository.update({
        ownerUserId: OWNER_B,
        actorUserId: OWNER_B,
        presetId: first.id,
        expectedRevision: 1,
        authorizationRevision: 1,
        definition: definition({ name: "Cross-owner update" })
      })
    ).rejects.toBeInstanceOf(ScreenerNotFoundError);
  });

  it("enforces the per-owner active quota while archived presets free capacity", async () => {
    await seedActivePresets(OWNER_A, MAX_ACTIVE_SCREENER_PRESETS_PER_OWNER);
    await expect(createPreset(OWNER_A, "quota:over-limit")).rejects.toBeInstanceOf(ScreenerQuotaError);
    // Another owner keeps an independent quota.
    await expect(createPreset(OWNER_B, "quota:other-owner")).resolves.toMatchObject({ revision: 1 });

    const seeded = (await repository.list(OWNER_A))[0]!;
    await repository.archive({
      ownerUserId: OWNER_A,
      actorUserId: OWNER_A,
      presetId: seeded.id,
      expectedRevision: seeded.revision,
      authorizationRevision: 1
    });
    await expect(createPreset(OWNER_A, "quota:after-archive")).resolves.toMatchObject({ revision: 1 });
  });

  it("returns the existing preset for a replayed client ID and conflicts on a different definition", async () => {
    const created = await createPreset(OWNER_A, "idempotent:client", { name: "Original definition" });
    const replayed = await createPreset(OWNER_A, "idempotent:client", { name: "Original definition" });
    expect(replayed).toMatchObject({ id: created.id, revision: 1, createdAt: created.createdAt });
    expect((await repository.list(OWNER_A)).length).toBe(1);

    await expect(createPreset(OWNER_A, "idempotent:client", { name: "Different definition" })).rejects.toBeInstanceOf(ScreenerIdempotencyConflictError);
    // The same client ID stays available to another owner.
    await expect(createPreset(OWNER_B, "idempotent:client", { name: "Original definition" })).resolves.toMatchObject({ revision: 1 });
  });

  it("applies optimistic revision control on update with hash-equal replay tolerance", async () => {
    const created = await createPreset(OWNER_A, "revision:update");

    await expect(
      updatePreset(created.id, 2, { name: "Stale revision" })
    ).rejects.toBeInstanceOf(ScreenerRevisionConflictError);

    const updated = await updatePreset(created.id, 1, { name: "Second revision" });
    expect(updated.revision).toBe(2);
    expect(updated.definition.name).toBe("Second revision");
    expect(updated.definitionHash).toBe(parseAndHashScreenerDefinition(definition({ name: "Second revision" })).hash);

    // A replayed update carrying the already-applied definition is tolerated.
    const replayed = await updatePreset(created.id, 1, { name: "Second revision" });
    expect(replayed).toMatchObject({ id: created.id, revision: 2 });
    // A stale revision with different content still conflicts.
    await expect(updatePreset(created.id, 1, { name: "Third revision" })).rejects.toBeInstanceOf(ScreenerRevisionConflictError);

    // Re-submitting the current definition at the current revision does not burn a revision.
    const unchanged = await updatePreset(created.id, 2, { name: "Second revision" });
    expect(unchanged.revision).toBe(2);
  });

  it("archives with revision fencing and blocks further mutation", async () => {
    const created = await createPreset(OWNER_A, "archive:lifecycle");

    await expect(
      repository.archive({
        ownerUserId: OWNER_A,
        actorUserId: OWNER_A,
        presetId: created.id,
        expectedRevision: 5,
        authorizationRevision: 1
      })
    ).rejects.toBeInstanceOf(ScreenerRevisionConflictError);

    const archived = await repository.archive({
      ownerUserId: OWNER_A,
      actorUserId: OWNER_A,
      presetId: created.id,
      expectedRevision: 1,
      authorizationRevision: 1
    });
    expect(archived.archivedAt).toBeDefined();
    expect(archived.revision).toBe(1);

    // Archiving is idempotent at the same revision fence.
    const replayed = await repository.archive({
      ownerUserId: OWNER_A,
      actorUserId: OWNER_A,
      presetId: created.id,
      expectedRevision: 1,
      authorizationRevision: 1
    });
    expect(replayed.archivedAt).toBe(archived.archivedAt);

    await expect(updatePreset(created.id, 1, { name: "After archive" })).rejects.toBeInstanceOf(ScreenerRevisionConflictError);

    // Archived presets stay visible after active ones in the management list.
    const active = await createPreset(OWNER_A, "archive:active");
    expect((await repository.list(OWNER_A)).map(({ id }) => id)).toEqual([active.id, created.id]);
  });

  it("fails closed when the owner authorization revision has moved on", async () => {
    const created = await createPreset(OWNER_A, "authorization:fence");
    await pool.query("UPDATE users SET authorization_revision = 2 WHERE id = $1", [OWNER_A]);

    await expect(createPreset(OWNER_A, "authorization:stale")).rejects.toBeInstanceOf(ScreenerAuthorizationConflictError);
    await expect(updatePreset(created.id, 1, { name: "Stale authorization" })).rejects.toBeInstanceOf(ScreenerAuthorizationConflictError);
    await expect(
      repository.update({
        ownerUserId: OWNER_A,
        actorUserId: OWNER_A,
        presetId: created.id,
        expectedRevision: 1,
        authorizationRevision: 2,
        definition: definition({ name: "Fresh authorization" })
      })
    ).resolves.toMatchObject({ revision: 2 });
  });
});

function definition(override: Partial<ScreenerDefinitionV1> = {}): ScreenerDefinitionV1 {
  return {
    schemaVersion: "screener-definition-v1",
    kind: "technical",
    name: "Repository screen",
    exchange: "binance",
    marketType: "spot",
    priceType: "last",
    timeframe: "1h",
    universeLimit: 50,
    sort: { key: "quoteVolume24h", direction: "desc" },
    filters: [
      { kind: "rsi", period: 14, condition: "above", value: "55" },
      { kind: "quote-volume-24h", min: "1000000" }
    ],
    researchOnly: true,
    executionPermission: false,
    ...override
  };
}

async function createPreset(ownerUserId: string, clientId: string, override: Partial<ScreenerDefinitionV1> = {}) {
  return repository.create({
    ownerUserId,
    actorUserId: ownerUserId,
    authorizationRevision: 1,
    clientId,
    definition: definition(override)
  });
}

async function updatePreset(presetId: string, expectedRevision: number, override: Partial<ScreenerDefinitionV1> = {}) {
  return repository.update({
    ownerUserId: OWNER_A,
    actorUserId: OWNER_A,
    presetId,
    expectedRevision,
    authorizationRevision: 1,
    definition: definition(override)
  });
}

async function seedActivePresets(ownerUserId: string, count: number): Promise<void> {
  const ids = Array.from({ length: count }, () => randomUUID());
  const clientIds = ids.map((_, index) => `quota.seed.${index}`);
  const parsed = parseAndHashScreenerDefinition(definition({ name: "Quota seed" }));
  await pool.query(
    `INSERT INTO screener_presets (
       id, owner_user_id, client_id, name, definition, definition_hash, authorization_revision
     ) SELECT seed.id, $1, seed.client_id, $4, $5::jsonb, $6, 1
       FROM unnest($2::uuid[], $3::text[]) AS seed(id, client_id)`,
    [ownerUserId, ids, clientIds, parsed.definition.name, parsed.serialized, parsed.hash]
  );
}
