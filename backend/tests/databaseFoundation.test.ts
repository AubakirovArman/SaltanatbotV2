import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { isDatabaseConfigured, loadDatabaseConfig } from "../src/database/config.js";
import { migrateDatabase } from "../src/database/migrations.js";
import { DATABASE_MIGRATIONS, LATEST_DATABASE_SCHEMA_VERSION } from "../src/database/schema.js";

describe("PostgreSQL configuration", () => {
  it("defaults to the isolated self-host port without exposing a password", () => {
    const config = loadDatabaseConfig({ env: {} });

    expect(config.source).toBe("parameters");
    expect(config.description).toEqual({
      host: "127.0.0.1",
      port: 55_434,
      database: "saltanatbotv2",
      user: "saltanatbotv2",
      sslMode: "default",
      poolMax: 12
    });
    expect(JSON.stringify(config.description)).not.toContain("password");
  });

  it("reads a password file and removes only its final line ending", () => {
    const config = loadDatabaseConfig({
      env: { PGPASSWORD_FILE: "/run/secrets/postgres_password" },
      readSecret: () => "  pass phrase  \n"
    });

    expect(config.pool.password).toBe("  pass phrase  ");
  });

  it("parses DATABASE_URL only into a redacted description", () => {
    const config = loadDatabaseConfig({
      env: { DATABASE_URL: "postgresql://alice:do-not-log@db.example:6432/research?sslmode=require" }
    });

    expect(config.description).toEqual({
      host: "db.example",
      port: 6_432,
      database: "research",
      user: "alice",
      sslMode: "require",
      poolMax: 12
    });
    expect(JSON.stringify(config.description)).not.toContain("do-not-log");
  });

  it("rejects ambiguous password sources", () => {
    expect(() =>
      loadDatabaseConfig({
        env: { PGPASSWORD: "one", PGPASSWORD_FILE: "/run/secrets/postgres_password" },
        readSecret: () => "two"
      })
    ).toThrow(/only one/i);
  });

  it("detects whether an explicit database was configured", () => {
    expect(isDatabaseConfigured({})).toBe(false);
    expect(isDatabaseConfigured({ PGDATABASE: "saltanatbotv2" })).toBe(true);
  });
});

interface RecordedQuery {
  text: string;
  values?: readonly unknown[];
}

function createPoolDouble(
  appliedRows: Array<{ version: number; name: string; checksum: string }> = [],
  failWhen?: (text: string) => boolean
): { pool: Pool; queries: RecordedQuery[]; released: () => boolean } {
  const queries: RecordedQuery[] = [];
  let wasReleased = false;
  const client = {
    async query(text: string, values?: readonly unknown[]) {
      queries.push({ text, values });
      if (failWhen?.(text)) throw new Error("injected migration failure");
      if (text.startsWith("SELECT version")) return { rows: appliedRows };
      return { rows: [] };
    },
    release() {
      wasReleased = true;
    }
  };
  const pool = { connect: async () => client } as unknown as Pool;
  return { pool, queries, released: () => wasReleased };
}

describe("PostgreSQL schema migrations", () => {
  it("uses contiguous checksummed versions and no extensions", () => {
    expect(LATEST_DATABASE_SCHEMA_VERSION).toBe(8);
    expect(DATABASE_MIGRATIONS.map((migration) => migration.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(new Set(DATABASE_MIGRATIONS.map((migration) => migration.checksum)).size).toBe(8);
    expect(DATABASE_MIGRATIONS.every((migration) => /^[0-9a-f]{64}$/.test(migration.checksum))).toBe(true);
    expect(DATABASE_MIGRATIONS.map((migration) => migration.sql).join("\n")).not.toMatch(/CREATE\s+EXTENSION/i);
  });

  it("keeps the published v1-v3 checksums stable and adds client workspace IDs in v4", () => {
    expect(DATABASE_MIGRATIONS.slice(0, 3).map((migration) => migration.checksum)).toEqual([
      "9b538a4d07aad7251604f6f3b9a32e069cf9419efa993725762f00e4191cfd94",
      "4a164f3c2a96af3e7941cca8fd06e96147da4af10b2c9b1411713be32816192a",
      "6f37bfa7d8330ff1474525f95c81e85b21212986c53a8cd81b26568ce3f7ab05"
    ]);
    expect(DATABASE_MIGRATIONS[3].sql).toContain("ADD COLUMN client_id VARCHAR(160)");
    expect(DATABASE_MIGRATIONS[3].sql).toContain("ON workspaces (owner_user_id, client_id)");
    expect(DATABASE_MIGRATIONS[3].sql).toContain("WHERE deleted_at IS NULL");
    expect(DATABASE_MIGRATIONS[4].sql).toContain("authorization_revision BIGINT NOT NULL DEFAULT 1");
    expect(DATABASE_MIGRATIONS[5].sql).toContain("compute_jobs_terminal_completed_index");
    expect(DATABASE_MIGRATIONS[5].sql).toContain("compute_jobs_owner_terminal_completed_index");
    expect(DATABASE_MIGRATIONS[6].sql).toContain("CREATE TABLE execution_step_ledger");
    expect(DATABASE_MIGRATIONS[6].sql).toContain("CREATE TABLE execution_step_ledger_owner_usage");
    expect(DATABASE_MIGRATIONS[6].sql).toContain("CREATE TABLE execution_step_reservations");
    expect(DATABASE_MIGRATIONS[6].sql).toContain("PRIMARY KEY (owner_user_id, intent_id)");
    expect(DATABASE_MIGRATIONS[6].sql).toContain("UNIQUE (owner_user_id, binding_digest)");
    expect(DATABASE_MIGRATIONS[6].sql).toContain("authorization_epoch BIGINT NOT NULL CHECK (authorization_epoch >= 0)");
    expect(DATABASE_MIGRATIONS[6].sql).not.toContain("'telemetry'");
    expect(DATABASE_MIGRATIONS[6].sql).not.toMatch(/\b(payload|secret|signature|api_key|session|permit_token)\b/i);
    expect(DATABASE_MIGRATIONS[7].sql).toContain("ADD COLUMN artifact_size_bytes BIGINT");
    expect(DATABASE_MIGRATIONS[7].sql).toContain("CREATE TABLE compute_job_retention_usage");
    expect(DATABASE_MIGRATIONS[7].sql).toContain("maintain_compute_job_retention_usage");
    expect(DATABASE_MIGRATIONS[7].sql).toContain("compute_jobs_full_artifact_retention_index");
    expect(DATABASE_MIGRATIONS[7].sql).toContain("compute_jobs_tombstone_retention_index");
  });

  it("holds an advisory lock and applies every new migration atomically", async () => {
    const database = createPoolDouble();
    const result = await migrateDatabase(database.pool);

    expect(result).toMatchObject({ fromVersion: 0, toVersion: 8 });
    expect(result.applied).toHaveLength(8);
    expect(database.queries.some((query) => query.text.includes("pg_advisory_xact_lock"))).toBe(true);
    expect(database.queries.at(0)?.text).toBe("BEGIN");
    expect(database.queries.at(-1)?.text).toBe("COMMIT");
    expect(database.released()).toBe(true);
  });

  it("rolls back and releases the connection after a migration error", async () => {
    const database = createPoolDouble([], (text) => text.includes("CREATE TABLE workspaces"));

    await expect(migrateDatabase(database.pool)).rejects.toThrow("injected migration failure");
    expect(database.queries.at(-1)?.text).toBe("ROLLBACK");
    expect(database.released()).toBe(true);
  });

  it("refuses a migration history with a missing version", async () => {
    const database = createPoolDouble([
      { version: 2, name: DATABASE_MIGRATIONS[1].name, checksum: DATABASE_MIGRATIONS[1].checksum }
    ]);

    await expect(migrateDatabase(database.pool)).rejects.toThrow(/history has a gap/i);
    expect(database.queries.at(-1)?.text).toBe("ROLLBACK");
  });
});
