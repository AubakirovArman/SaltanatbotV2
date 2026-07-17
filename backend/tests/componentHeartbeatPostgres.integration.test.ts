import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it
} from "vitest";
import { migrateDatabase } from "../src/database/migrations.js";
import { RuntimeComponentHeartbeatRepository } from "../src/operations/componentHeartbeat.js";
import { assertIsolatedTestDatabase } from "./support/postgresTestDatabase.js";

const configuredConnection =
  process.env.COMPONENT_HEARTBEAT_TEST_DATABASE_URL ??
  process.env.WORKSPACES_TEST_DATABASE_URL;
const configuredVariable = process.env.COMPONENT_HEARTBEAT_TEST_DATABASE_URL
  ? "COMPONENT_HEARTBEAT_TEST_DATABASE_URL"
  : "WORKSPACES_TEST_DATABASE_URL";
const describePostgres = configuredConnection ? describe : describe.skip;
let pool: Pool;
let repository: RuntimeComponentHeartbeatRepository;
let initialized = false;

describePostgres("runtime component heartbeat against isolated PostgreSQL", () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: configuredConnection, max: 4 });
    await assertIsolatedTestDatabase(pool, configuredVariable);
    await migrateDatabase(pool);
    repository = new RuntimeComponentHeartbeatRepository(pool);
    initialized = true;
  });

  beforeEach(async () => {
    await pool.query("DELETE FROM runtime_component_heartbeats");
  });

  afterAll(async () => {
    if (pool) {
      if (initialized) {
        await pool.query("DELETE FROM runtime_component_heartbeats");
      }
      await pool.end();
    }
  });

  it("upserts one generation and fences stale generation pulses and terminal marks", async () => {
    const firstGeneration = randomUUID();
    const secondGeneration = randomUUID();

    await expect(
      repository.start({
        component: "research-worker",
        generationId: firstGeneration,
        status: "starting",
        releaseCommit: "abcdef0",
        databaseSchemaVersion: 11
      })
    ).resolves.toMatchObject({
      component: "research-worker",
      generationId: firstGeneration,
      status: "starting",
      releaseCommit: "abcdef0",
      databaseSchemaVersion: 11
    });
    await expect(
      repository.pulse("research-worker", firstGeneration, "ready")
    ).resolves.toBe(true);
    await expect(
      repository.mark("research-worker", randomUUID(), "draining")
    ).resolves.toBe(false);

    await expect(
      repository.start({
        component: "research-worker",
        generationId: secondGeneration,
        status: "ready",
        databaseSchemaVersion: 11
      })
    ).resolves.toMatchObject({
      generationId: secondGeneration,
      status: "ready",
      releaseCommit: undefined
    });
    await expect(
      repository.pulse("research-worker", firstGeneration)
    ).resolves.toBe(false);
    await expect(
      repository.mark("research-worker", secondGeneration, "draining")
    ).resolves.toBe(true);
    await expect(
      repository.mark("research-worker", secondGeneration, "stopped")
    ).resolves.toBe(true);
    await expect(repository.get("research-worker")).resolves.toMatchObject({
      generationId: secondGeneration,
      status: "stopped",
      databaseSchemaVersion: 11
    });

    const count = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM runtime_component_heartbeats"
    );
    expect(count.rows[0]?.count).toBe("1");
  });

  it("retains database constraints beneath repository validation", async () => {
    await expect(
      pool.query(
        `INSERT INTO runtime_component_heartbeats (
           component,
           generation_id,
           status,
           started_at,
           heartbeat_at,
           database_schema_version
         ) VALUES (
           'api',
           $1,
           'ready',
           statement_timestamp(),
           statement_timestamp(),
           11
         )`,
        [randomUUID()]
      )
    ).rejects.toMatchObject({ code: "23514" });

    await expect(
      pool.query(
        `INSERT INTO runtime_component_heartbeats (
           component,
           generation_id,
           status,
           started_at,
           heartbeat_at,
           release_commit,
           database_schema_version
         ) VALUES (
           'research-worker',
           $1,
           'ready',
           statement_timestamp(),
           statement_timestamp(),
           'ABCDEF0',
           11
         )`,
        [randomUUID()]
      )
    ).rejects.toMatchObject({ code: "23514" });
  });
});
