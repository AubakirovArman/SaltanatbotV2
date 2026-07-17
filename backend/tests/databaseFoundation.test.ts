import type { Pool } from "pg";
import { createHash } from "node:crypto";
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

  it("keeps at least one PostgreSQL connection beside a bounded readiness probe", () => {
    expect(() =>
      loadDatabaseConfig({
        env: { PGPOOL_MAX: "1" }
      })
    ).toThrow(/PGPOOL_MAX must be between 2 and 100/);
    expect(loadDatabaseConfig({ env: { PGPOOL_MAX: "2" } }).description.poolMax).toBe(2);
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
    expect(LATEST_DATABASE_SCHEMA_VERSION).toBe(14);
    expect(DATABASE_MIGRATIONS.map((migration) => migration.version)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14
    ]);
    expect(new Set(DATABASE_MIGRATIONS.map((migration) => migration.checksum)).size).toBe(14);
    expect(DATABASE_MIGRATIONS.every((migration) => /^[0-9a-f]{64}$/.test(migration.checksum))).toBe(true);
    expect(DATABASE_MIGRATIONS.map((migration) => migration.sql).join("\n")).not.toMatch(/CREATE\s+EXTENSION/i);
  });

  it("keeps every published migration stable and adds only the alert control plane in v13", () => {
    expect(DATABASE_MIGRATIONS.slice(0, 10).map((migration) => migration.checksum)).toEqual([
      "9b538a4d07aad7251604f6f3b9a32e069cf9419efa993725762f00e4191cfd94",
      "4a164f3c2a96af3e7941cca8fd06e96147da4af10b2c9b1411713be32816192a",
      "6f37bfa7d8330ff1474525f95c81e85b21212986c53a8cd81b26568ce3f7ab05",
      "645cf8965961a0bb817b9918074330764d270e0768a4a337307ab653223848c7",
      "cec8a2438dea7afa2bb9751a9e37181b400ca411fe79613bd647aa94b79ed0b7",
      "f341253187e03b73f60981f35d11ce558c43d6301ed6ef7da9ddb68be467b34b",
      "19144479136344c3f09e4fd78ac6f57b1cb9813e4148af756457ad7842c0503e",
      "3d62620312b302e48475629898a318bfb7fd31fea79f9b0cc47ecb19a9a13d22",
      "f4976a3bf7016daa0ee6238f41aa92264437422715754fb459ea45eb5a53eb08",
      "d6a3496e6ee1e9f1769abb3483de5b876411e0e786e07ff5b280d8a3f42d2622"
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
    expect(DATABASE_MIGRATIONS[8].sql).toContain("ADD COLUMN public_id UUID");
    expect(DATABASE_MIGRATIONS[8].sql).toContain("pre_https_live_role_downgrade");
    expect(DATABASE_MIGRATIONS[8].sql).toContain("users_non_admin_live_trading_forbidden");
    expect(DATABASE_MIGRATIONS[8].sql).toContain("saltanatbotv2-auth-session-public-id:v1:");
    expect(DATABASE_MIGRATIONS[8].sql).not.toMatch(/substr\(id_hash/i);
    expect(DATABASE_MIGRATIONS[9].sql).toContain("ADD COLUMN archived_at TIMESTAMPTZ");
    expect(DATABASE_MIGRATIONS[9].sql).toContain("ADD COLUMN payload_bytes BIGINT");
    expect(DATABASE_MIGRATIONS[9].sql).toContain("maintain_workspace_payload_bytes");
    expect(DATABASE_MIGRATIONS[9].sql).toContain("workspaces_owner_archive_updated_index");
    expect(DATABASE_MIGRATIONS[10].sql).toContain("CREATE TABLE user_onboarding");
    expect(DATABASE_MIGRATIONS[10].sql).toContain("INSERT INTO user_onboarding");
    expect(DATABASE_MIGRATIONS[10].sql).toContain("CREATE TABLE runtime_component_heartbeats");
    expect(DATABASE_MIGRATIONS[10].sql).toContain("'research-worker'");
    expect(DATABASE_MIGRATIONS[10].sql).toContain(
      "created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp()"
    );
    expect(DATABASE_MIGRATIONS[10].sql).not.toContain(
      "DEFAULT clock_timestamp()"
    );
    expect(DATABASE_MIGRATIONS[10].sql).not.toMatch(
      /\b(api_key|credential|password_hash|private_key|live_order)\b/i
    );
    expect(DATABASE_MIGRATIONS[10].checksum).toBe(
      "8e9906f5aa4e98cbf15cf31dd68c5fb5f8462889d7ba995ca4edbc5e456681f3"
    );
    expect(DATABASE_MIGRATIONS[11].name).toBe("durable_executor_command_queue");
    expect(DATABASE_MIGRATIONS[11].checksum).toBe(
      "72beb8455a9e96de97d28129b34a1a6a2c8a103090e1aa5455a9c9a0aa56d8d6"
    );
    expect(DATABASE_MIGRATIONS[11].sql).toContain("CREATE TABLE executor_commands");
    expect(DATABASE_MIGRATIONS[11].sql).toContain("UNIQUE (owner_user_id, idempotency_key)");
    expect(DATABASE_MIGRATIONS[11].sql).toContain("authorization_epoch >= 0");
    expect(DATABASE_MIGRATIONS[11].sql).toContain("lease_generation = attempt");
    expect(DATABASE_MIGRATIONS[11].sql).toContain(
      "CREATE UNIQUE INDEX executor_commands_one_applying_per_owner"
    );
    expect(DATABASE_MIGRATIONS[11].sql).toContain("sqlite_receipt_hash");
    expect(DATABASE_MIGRATIONS[11].sql).toContain(
      "executor_commands_owner_terminal_retention_index"
    );
    expect(DATABASE_MIGRATIONS[11].sql).not.toMatch(
      /\b(api_key|password_hash|private_key|exchange_secret|signed_request)\b/i
    );
    expect(DATABASE_MIGRATIONS[12].name).toBe(
      "durable_owner_alerts_and_notification_outbox"
    );
    expect(DATABASE_MIGRATIONS[12].checksum).toBe(
      "1419c56fb6d0ccd5ff3c4feee3aa310f71f767bec00ff13a7078bc051e235f02"
    );
    for (const table of [
      "alert_rules",
      "alert_rule_revisions",
      "alert_rule_states",
      "alert_evaluation_receipts",
      "alert_event_sequences",
      "alert_rule_events",
      "notification_bindings",
      "notification_outbox",
      "notification_deliveries",
      "alert_rule_import_receipts"
    ]) {
      expect(DATABASE_MIGRATIONS[12].sql).toContain(`CREATE TABLE ${table}`);
    }
    expect(DATABASE_MIGRATIONS[12].sql).toContain(
      "alert_rules_one_leased_per_owner"
    );
    expect(DATABASE_MIGRATIONS[12].sql).toContain(
      "notification_deliveries_one_sending_per_owner"
    );
    expect(DATABASE_MIGRATIONS[12].sql).toContain(
      "alert_rule_events_owner_sequence_unique"
    );
    expect(DATABASE_MIGRATIONS[12].sql).toContain(
      "CREATE TRIGGER alert_rule_events_assign_owner_sequence"
    );
    expect(DATABASE_MIGRATIONS[12].sql).toContain(
      "run_after TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp()"
    );
    expect(DATABASE_MIGRATIONS[12].sql).toContain(
      "state_revision_before"
    );
    expect(DATABASE_MIGRATIONS[12].sql).toContain(
      "committed_state_hash"
    );
    expect(DATABASE_MIGRATIONS[12].sql).toContain(
      "CHECK (research_only)"
    );
    expect(DATABASE_MIGRATIONS[12].sql).toContain(
      "CHECK (NOT execution_permission)"
    );
    expect(DATABASE_MIGRATIONS[12].sql).toContain(
      "CHECK (component IN ('research-worker', 'notification-worker'))"
    );
    expect(DATABASE_MIGRATIONS[12].sql).not.toMatch(
      /\b(api_key|bot_token|telegram_token|chat_id|password_hash|private_key|exchange_secret|signed_request)\b/i
    );
  });

  it("derives legacy public session IDs opaquely from the full secret hash", () => {
    const idHash = "0123456789abcdef".repeat(4);
    const digest = createHash("md5")
      .update(`saltanatbotv2-auth-session-public-id:v1:${idHash}`)
      .digest("hex");
    const publicId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20)}`;
    const compact = publicId.replaceAll("-", "");

    expect(publicId).toMatch(/^[0-9a-f-]{36}$/);
    expect(idHash).not.toContain(compact);
    expect(compact).not.toBe(idHash.slice(0, 32));
  });

  it("holds an advisory lock and applies every new migration atomically", async () => {
    const database = createPoolDouble();
    const result = await migrateDatabase(database.pool);

    expect(result).toMatchObject({ fromVersion: 0, toVersion: 14 });
    expect(result.applied).toHaveLength(14);
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
