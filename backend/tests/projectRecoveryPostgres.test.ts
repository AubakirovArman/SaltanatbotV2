import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPostgresRecoveryOperations, resolveRecoveryConnections } from "../../scripts/lib/project-recovery-postgres.mjs";

const temporaryDirectories: string[] = [];

function temporaryDirectory() {
  const directory = mkdtempSync(path.join(tmpdir(), "saltanat-recovery-postgres-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("project recovery PostgreSQL boundary", () => {
  it("resolves separate source/operator connections and owner-only password files", () => {
    const directory = temporaryDirectory();
    const passwordFile = path.resolve(directory, "operator-password");
    writeFileSync(passwordFile, "operator-secret\n", { mode: 0o600 });
    chmodSync(passwordFile, 0o600);
    const connections = resolveRecoveryConnections({
      DATABASE_URL: "postgresql://app:source-secret@127.0.0.1:55434/saltanatbotv2_test?sslmode=disable",
      RECOVERY_OPERATOR_PGHOST: "127.0.0.1",
      RECOVERY_OPERATOR_PGPORT: "55434",
      RECOVERY_OPERATOR_PGUSER: "recovery_operator",
      RECOVERY_OPERATOR_PGPASSWORD_FILE: passwordFile,
      RECOVERY_MAINTENANCE_DATABASE: "postgres",
      PGPASSFILE: "/tmp/foreign-passfile",
      PGSERVICE: "foreign-service",
      PGOPTIONS: "-c search_path=foreign",
      UNRELATED_SECRET: "must-not-reach-child"
    });

    expect(connections.source).toMatchObject({
      database: "saltanatbotv2_test",
      user: "app"
    });
    expect(connections.operator).toMatchObject({
      database: "postgres",
      user: "recovery_operator"
    });
    expect(connections.source.nodeConfig()).toMatchObject({
      connectionTimeoutMillis: 10_000,
      statement_timeout: 300_000,
      query_timeout: 310_000
    });
    const operatorEnvironment = connections.operator.toolEnvironment("replacement");
    expect(operatorEnvironment).toMatchObject({
      PGDATABASE: "replacement",
      PGUSER: "recovery_operator",
      PGPASSWORD: "operator-secret"
    });
    expect(JSON.stringify(connections)).not.toMatch(/source-secret|operator-secret/);
    expect(operatorEnvironment).not.toHaveProperty("DATABASE_URL");
    expect(operatorEnvironment).not.toHaveProperty("RECOVERY_OPERATOR_DATABASE_URL");
    expect(operatorEnvironment).not.toHaveProperty("PGPASSFILE");
    expect(operatorEnvironment).not.toHaveProperty("PGSERVICE");
    expect(operatorEnvironment).not.toHaveProperty("PGOPTIONS");
    expect(operatorEnvironment).not.toHaveProperty("UNRELATED_SECRET");
    expect(operatorEnvironment.PGCONNECT_TIMEOUT).toBe("10");
  });

  it("rejects a password file below an intermediate symbolic link", () => {
    const directory = temporaryDirectory();
    const realDirectory = path.resolve(directory, "real");
    const linkedDirectory = path.resolve(directory, "linked");
    const passwordFile = path.resolve(realDirectory, "password");
    mkdirSync(realDirectory, { mode: 0o700 });
    writeFileSync(passwordFile, "operator-secret\n", { mode: 0o600 });
    symlinkSync(realDirectory, linkedDirectory, "dir");

    expect(() =>
      resolveRecoveryConnections({
        RECOVERY_OPERATOR_PGHOST: "127.0.0.1",
        RECOVERY_OPERATOR_PGUSER: "recovery_operator",
        RECOVERY_OPERATOR_PGPASSWORD_FILE: path.resolve(linkedDirectory, "password")
      })
    ).toThrow(/symbolic-link components/i);
  });

  it("rejects split, remote or transport-ambiguous recovery endpoints", () => {
    expect(() =>
      resolveRecoveryConnections({
        PGHOST: "127.0.0.1",
        PGPORT: "55434",
        PGDATABASE: "saltanatbotv2",
        PGUSER: "saltanatbotv2",
        PGSSLMODE: "prefer"
      })
    ).toThrow(/sslmode.*must be disable/i);

    expect(() =>
      resolveRecoveryConnections({
        PGHOST: "database.internal",
        PGPORT: "55434",
        PGDATABASE: "saltanatbotv2",
        PGUSER: "saltanatbotv2",
        PGSSLMODE: "disable"
      })
    ).toThrow(/numeric loopback endpoint/i);

    expect(() =>
      resolveRecoveryConnections({
        PGHOST: "127.0.0.1",
        PGPORT: "55434",
        PGDATABASE: "saltanatbotv2",
        PGUSER: "saltanatbotv2",
        PGSSLMODE: "disable",
        RECOVERY_OPERATOR_PGHOST: "127.0.0.1",
        RECOVERY_OPERATOR_PGPORT: "55435",
        RECOVERY_OPERATOR_PGUSER: "operator",
        RECOVERY_OPERATOR_PGSSLMODE: "disable"
      })
    ).toThrow(/one exact numeric loopback endpoint/i);
  });

  it("keeps one exported snapshot and drops only an exact marker-owned database", async () => {
    const state = new Map<string, { marker?: string; databaseOid: string }>();
    let nextDatabaseOid = 20_000;
    let schemaVersion = 11;
    let onboardingTable = true;
    let persistDatabaseMarker = true;
    const queries: string[] = [];
    class FakeClient {
      readonly database: string;

      constructor(config: { database: string }) {
        this.database = config.database;
      }

      async connect() {}
      async end() {
        throw new Error("injected client shutdown failure");
      }

      async query(sql: string, params: unknown[] = []) {
        const normalized = sql.replace(/\s+/g, " ").trim();
        queries.push(`${this.database}:${normalized}`);
        if (normalized.startsWith("BEGIN") || normalized === "COMMIT" || normalized === "ROLLBACK") {
          return { rows: [], rowCount: 0 };
        }
        if (normalized.includes("pg_advisory_lock")) {
          return { rows: [{ pg_advisory_lock: null }], rowCount: 1 };
        }
        if (normalized.includes("pg_export_snapshot")) {
          return { rows: [{ snapshot: "00000003-0000001B-1" }], rowCount: 1 };
        }
        if (normalized.includes("current_database()")) {
          return { rows: [{ database: this.database, owner: "saltanatbotv2" }], rowCount: 1 };
        }
        if (normalized.includes("FROM public.schema_migrations")) {
          return {
            rows: Array.from({ length: schemaVersion }, (_, index) => ({
              version: index + 1,
              name: `migration_${index + 1}`,
              checksum: ((index + 1) % 16).toString(16).repeat(64)
            })),
            rowCount: schemaVersion
          };
        }
        if (normalized.includes("workspace_revisions")) {
          return {
            rows: [
              {
                users: "2",
                workspaces: "3",
                workspace_revisions: "4",
                compute_jobs: "5",
                has_user_onboarding: onboardingTable
              }
            ],
            rowCount: 1
          };
        }
        if (normalized.includes("FROM public.user_onboarding")) {
          return {
            rows: [{ user_onboarding: "1" }],
            rowCount: 1
          };
        }
        if (normalized.startsWith("SELECT id::text AS id FROM public.users")) {
          return {
            rows: [{ id: "owner-a" }, { id: "owner-b" }],
            rowCount: 2
          };
        }
        if (normalized.startsWith("SELECT 1 FROM pg_database")) {
          const database = String(params[0]);
          return { rows: state.has(database) ? [{ "?column?": 1 }] : [], rowCount: state.has(database) ? 1 : 0 };
        }
        if (normalized.startsWith("CREATE DATABASE")) {
          const database = normalized.match(/^CREATE DATABASE "([^"]+)"/)?.[1];
          if (!database || state.has(database)) throw new Error("database exists");
          state.set(database, { databaseOid: String(nextDatabaseOid++) });
          return { rows: [], rowCount: 0 };
        }
        if (normalized.startsWith("COMMENT ON DATABASE")) {
          const match = normalized.match(/^COMMENT ON DATABASE "([^"]+)" IS '([^']+)'$/);
          if (!match) throw new Error("invalid comment");
          if (persistDatabaseMarker) state.get(match[1]!)!.marker = match[2];
          return { rows: [], rowCount: 0 };
        }
        if (normalized.includes("shobj_description")) {
          const database = String(params[0]);
          const current = state.get(database);
          return {
            rows: current ? [{ marker: current.marker, database_oid: current.databaseOid }] : [],
            rowCount: current ? 1 : 0
          };
        }
        if (normalized.startsWith("DROP DATABASE")) {
          const database = normalized.match(/^DROP DATABASE "([^"]+)"$/)?.[1];
          if (!database) throw new Error("invalid drop");
          state.delete(database);
          return { rows: [], rowCount: 0 };
        }
        throw new Error(`Unexpected SQL: ${normalized}`);
      }
    }
    const descriptor = (database: string, user: string) => ({
      database,
      user,
      nodeConfig: (selected = database) => ({ database: selected, user }),
      toolEnvironment: (selected = database) => ({ PGDATABASE: selected })
    });
    const operations = createPostgresRecoveryOperations(
      {
        source: descriptor("saltanatbotv2_test", "recovery_reader"),
        operator: descriptor("postgres", "recovery_operator"),
        maintenanceDatabase: "postgres"
      },
      FakeClient as never
    );

    const snapshotResult = await operations.withExportedSnapshot(async (value) => value);
    expect(snapshotResult).toMatchObject({
      snapshot: "00000003-0000001B-1",
      inventory: {
        database: "saltanatbotv2_test",
        owner: "saltanatbotv2",
        counts: {
          users: 2,
          workspaces: 3,
          workspaceRevisions: 4,
          computeJobs: 5,
          userOnboarding: 1
        }
      }
    });
    expect(queries.indexOf("saltanatbotv2_test:COMMIT")).toBeGreaterThan(queries.findIndex((query) => query.includes("FROM schema_migrations")));

    schemaVersion = 10;
    onboardingTable = false;
    const legacyInventory = await operations.withExportedSnapshot(async (value) => value.inventory);
    expect(legacyInventory.migrations).toHaveLength(10);
    expect(legacyInventory.migrations.at(-1)?.version).toBe(10);
    expect(legacyInventory.counts.userOnboarding).toBe(0);

    schemaVersion = 11;
    onboardingTable = false;
    await expect(operations.withExportedSnapshot(async (value) => value.inventory)).rejects.toThrow(/schema 11.*user_onboarding/i);

    onboardingTable = true;
    await expect(
      operations.withExportedSnapshot(async () => {
        throw new Error("pg_dump timed out after 50ms and was killed");
      })
    ).rejects.toThrow(/timed out/i);
    expect(queries.at(-1)).toBe("saltanatbotv2_test:ROLLBACK");

    const database = "saltanatbotv2_test_restore_unit";
    const marker = "saltanatbotv2-project-recovery:v1:generation:operation";
    const created = await operations.createDatabase(database, "saltanatbotv2", marker);
    expect(created).toEqual({ databaseOid: "20000" });
    await expect(operations.readDatabaseIdentity(database)).resolves.toEqual({
      marker,
      databaseOid: "20000"
    });
    await expect(operations.readVerifiedInventory(database, marker, created.databaseOid)).resolves.toMatchObject({
      identity: { marker, databaseOid: "20000" },
      inventory: {
        database,
        counts: {
          users: 2,
          workspaces: 3,
          workspaceRevisions: 4,
          computeJobs: 5,
          userOnboarding: 1
        }
      }
    });
    await expect(operations.dropDatabase(database, "wrong-marker", created.databaseOid)).rejects.toThrow(/identity mismatch/i);
    expect(state.has(database)).toBe(true);
    state.get(database)!.databaseOid = "20001";
    await expect(operations.dropDatabase(database, marker, created.databaseOid)).rejects.toThrow(/identity mismatch/i);
    expect(state.has(database)).toBe(true);
    state.get(database)!.databaseOid = created.databaseOid;
    await expect(operations.dropDatabase(database, marker, created.databaseOid)).resolves.toBe(true);
    expect(state.has(database)).toBe(false);

    persistDatabaseMarker = false;
    const markerLossDatabase = "saltanatbotv2_test_restore_marker_loss";
    await expect(operations.createDatabase(markerLossDatabase, "saltanatbotv2", marker)).rejects.toThrow(/could not initialize or remove/i);
    expect(state.has(markerLossDatabase)).toBe(true);
  });
});
