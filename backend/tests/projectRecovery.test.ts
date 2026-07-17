import { createHash, randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createProjectRecoveryBackup, drillProjectRecovery, inspectSqliteInventory, PROJECT_RECOVERY_MANIFEST, restoreProjectRecovery, runRecoveryTool, verifyProjectRecovery } from "../../scripts/lib/project-recovery.mjs";
import { restoreRuntimeBackup } from "../../scripts/runtime-data.mjs";

const TEST_SECRET = "11".repeat(32);
const RELEASE_COMMIT = "a".repeat(40);
const temporaryDirectories: string[] = [];

interface PostgresInventory {
  database: string;
  owner: string;
  migrations: Array<{ version: number; name: string; checksum: string }>;
  counts: {
    users: number;
    workspaces: number;
    workspaceRevisions: number;
    computeJobs: number;
    userOnboarding: number;
    executorCommands?: number;
    alertRules?: number;
    alertRuleRevisions?: number;
    alertRuleStates?: number;
    alertEvaluationReceipts?: number;
    alertEventSequences?: number;
    alertRuleEvents?: number;
    notificationBindings?: number;
    notificationOutbox?: number;
    notificationDeliveries?: number;
    alertRuleImportReceipts?: number;
  };
  userIds?: string[];
}

function alertControlPlaneCounts() {
  return {
    alertRules: 7,
    alertRuleRevisions: 9,
    alertRuleStates: 11,
    alertEvaluationReceipts: 13,
    alertEventSequences: 2,
    alertRuleEvents: 15,
    notificationBindings: 2,
    notificationOutbox: 4,
    notificationDeliveries: 6,
    alertRuleImportReceipts: 1
  };
}

interface FakeDatabase {
  marker: string;
  databaseOid: string;
  inventory?: PostgresInventory;
}

function temporaryDirectory() {
  const directory = mkdtempSync(path.join(tmpdir(), "saltanat-project-recovery-"));
  temporaryDirectories.push(directory);
  return directory;
}

function sourceInventory(): PostgresInventory {
  return {
    database: "saltanatbotv2_test",
    owner: "saltanatbotv2",
    migrations: [
      { version: 1, name: "identity_foundation", checksum: "1".repeat(64) },
      { version: 2, name: "workspace_foundation", checksum: "2".repeat(64) }
    ],
    counts: {
      users: 3,
      workspaces: 4,
      workspaceRevisions: 7,
      computeJobs: 2,
      userOnboarding: 2
    },
    userIds: ["owner-a", "owner-b", "owner-c"]
  };
}

function migrationsThrough(version: number): PostgresInventory["migrations"] {
  return Array.from({ length: version }, (_, index) => ({
    version: index + 1,
    name: `test_migration_${index + 1}`,
    checksum: (index + 1).toString(16).padStart(2, "0").repeat(32)
  }));
}

function seedRuntimeData(dataDirectory: string) {
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  const trading = new DatabaseSync(path.resolve(dataDirectory, "trading.db"));
  trading.exec(`
    PRAGMA user_version = 9;
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, encrypted INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE bots (id TEXT PRIMARY KEY, ownerUserId TEXT NOT NULL);
    CREATE TABLE trading_accounts (id TEXT PRIMARY KEY, ownerUserId TEXT NOT NULL);
    CREATE TABLE trading_account_credentials (id TEXT PRIMARY KEY);
    CREATE TABLE orders (id TEXT PRIMARY KEY, ownerUserId TEXT NOT NULL);
    CREATE TABLE fills (id TEXT PRIMARY KEY, ownerUserId TEXT NOT NULL);
    CREATE TABLE paper_events (id TEXT PRIMARY KEY, ownerUserId TEXT NOT NULL, ledgerEpoch INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE paper_portfolios (id TEXT PRIMARY KEY, ownerUserId TEXT NOT NULL);
    CREATE TABLE paper_portfolio_epochs (id TEXT PRIMARY KEY, ownerUserId TEXT NOT NULL);
    CREATE TABLE paper_bot_allocations (id TEXT PRIMARY KEY, ownerUserId TEXT NOT NULL);
    CREATE TABLE paper_valuation_marks (id TEXT PRIMARY KEY, ownerUserId TEXT NOT NULL);
    CREATE TABLE paper_portfolio_mutations (id TEXT PRIMARY KEY, ownerUserId TEXT NOT NULL);
    CREATE TABLE paper_bot_revision_evidence (id TEXT PRIMARY KEY, ownerUserId TEXT NOT NULL);
    CREATE TABLE paper_bot_tombstones (id TEXT PRIMARY KEY, ownerUserId TEXT NOT NULL);
    CREATE TABLE paper_portfolio_events (id TEXT PRIMARY KEY, ownerUserId TEXT NOT NULL);
    CREATE TABLE paper_portfolio_projections (id TEXT PRIMARY KEY, ownerUserId TEXT NOT NULL);
    INSERT INTO settings (key, value, encrypted) VALUES ('marker', 'source', 0);
    INSERT INTO bots (id, ownerUserId) VALUES ('bot-1', 'owner-a'), ('bot-2', 'owner-b');
    INSERT INTO trading_accounts (id, ownerUserId) VALUES ('account-1', 'owner-a');
    INSERT INTO orders (id, ownerUserId) VALUES ('order-1', 'owner-a');
    INSERT INTO fills (id, ownerUserId) VALUES ('fill-1', 'owner-b');
    INSERT INTO paper_events (id, ownerUserId) VALUES ('event-1', 'owner-a');
    INSERT INTO paper_portfolios (id, ownerUserId) VALUES ('portfolio-1', 'owner-a');
    INSERT INTO paper_portfolio_epochs (id, ownerUserId) VALUES ('epoch-1', 'owner-a');
    INSERT INTO paper_bot_allocations (id, ownerUserId) VALUES ('allocation-1', 'owner-a');
    INSERT INTO paper_valuation_marks (id, ownerUserId) VALUES ('mark-1', 'owner-a');
    INSERT INTO paper_portfolio_mutations (id, ownerUserId) VALUES ('mutation-1', 'owner-a');
    INSERT INTO paper_bot_revision_evidence (id, ownerUserId) VALUES ('revision-1', 'owner-a');
    INSERT INTO paper_bot_tombstones (id, ownerUserId) VALUES ('tombstone-1', 'owner-a');
    INSERT INTO paper_portfolio_events (id, ownerUserId) VALUES ('journal-1', 'owner-a');
    INSERT INTO paper_portfolio_projections (id, ownerUserId) VALUES ('projection-1', 'owner-a');
  `);
  trading.close();
  const candles = new DatabaseSync(path.resolve(dataDirectory, "candles.db"));
  candles.exec("CREATE TABLE candles (id TEXT PRIMARY KEY); INSERT INTO candles (id) VALUES ('candle-1'), ('candle-2')");
  candles.close();
  const multiLeg = new DatabaseSync(path.resolve(dataDirectory, "arbitrage-paper-multi-leg.sqlite"));
  multiLeg.exec("CREATE TABLE runs (runId TEXT PRIMARY KEY); INSERT INTO runs (runId) VALUES ('run-1')");
  multiLeg.close();
  writeFileSync(path.resolve(dataDirectory, ".secret"), TEST_SECRET, { mode: 0o600 });
}

function fakeRecoveryRuntime(
  options: {
    failRestore?: boolean;
    failDumpWithForeignEntry?: boolean;
    restoredInventory?: PostgresInventory;
    postgresUserIds?: string[];
    beforeRestore?: () => void;
    afterSecondArchiveVerification?: (dumpPath: string) => void;
  } = {}
) {
  const inventory = sourceInventory();
  if (options.postgresUserIds) {
    inventory.userIds = [...options.postgresUserIds];
  }
  const databases = new Map<string, FakeDatabase>();
  let nextDatabaseOid = 10_000;
  let archiveVerificationCount = 0;
  const toolCalls: Array<{
    command: string;
    args: string[];
    env?: Record<string, string>;
    timeout?: number;
  }> = [];
  const postgres = {
    source: {
      database: inventory.database,
      toolEnvironment: () => ({ FAKE_CONNECTION: "source" })
    },
    operator: {
      database: "postgres",
      toolEnvironment: (database = "postgres") => ({ FAKE_CONNECTION: database })
    },
    async withExportedSnapshot<T>(operation: (value: { snapshot: string; inventory: PostgresInventory }) => Promise<T>) {
      return operation({ snapshot: "00000003-0000001B-1", inventory: structuredClone(inventory) });
    },
    async databaseExists(database: string) {
      return databases.has(database);
    },
    async createDatabase(database: string, _owner: string, marker: string) {
      if (databases.has(database)) throw new Error("database already exists");
      const databaseOid = String(nextDatabaseOid++);
      databases.set(database, { marker, databaseOid });
      return { databaseOid };
    },
    async readInventory(database: string) {
      const restored = databases.get(database)?.inventory;
      if (!restored) throw new Error("database was not restored");
      return structuredClone(restored);
    },
    async readVerifiedInventory(database: string, marker: string, databaseOid: string) {
      const current = databases.get(database);
      if (!current || current.marker !== marker || current.databaseOid !== databaseOid || !current.inventory) {
        throw new Error("database ownership identity mismatch");
      }
      return {
        identity: { marker: current.marker, databaseOid: current.databaseOid },
        inventory: structuredClone(current.inventory)
      };
    },
    async readDatabaseIdentity(database: string) {
      const current = databases.get(database);
      return current ? { marker: current.marker, databaseOid: current.databaseOid } : undefined;
    },
    async dropDatabase(database: string, marker: string, databaseOid: string) {
      const current = databases.get(database);
      if (!current) return false;
      if (current.marker !== marker || current.databaseOid !== databaseOid) {
        throw new Error("ownership identity mismatch");
      }
      databases.delete(database);
      return true;
    }
  };
  const runTool = (command: string, args: string[], toolOptions: { env?: Record<string, string>; timeout?: number } = {}) => {
    toolCalls.push({
      command,
      args: [...args],
      env: toolOptions.env,
      timeout: toolOptions.timeout
    });
    if (command === "pg_dump") {
      const file = optionValue(args, "--file=");
      if (!file) throw new Error("fake pg_dump did not receive a file");
      expect(optionValue(args, "--snapshot=")).toBe("00000003-0000001B-1");
      writeFileSync(file, "fake-postgresql-custom-dump", { mode: 0o600 });
      if (options.failDumpWithForeignEntry) {
        writeFileSync(path.resolve(path.dirname(file), "foreign-staging.txt"), "must survive");
        throw new Error("injected pg_dump failure");
      }
      return "";
    }
    if (command === "pg_restore" && args[0] === "--list") {
      if (readFileSync(args[1]!, "utf8") !== "fake-postgresql-custom-dump") {
        throw new Error("fake pg_restore rejected the dump");
      }
      archiveVerificationCount += 1;
      if (archiveVerificationCount === 2) {
        options.afterSecondArchiveVerification?.(args[1]!);
      }
      return "fake archive list";
    }
    if (command === "pg_restore") {
      if (options.failRestore) throw new Error("injected pg_restore failure");
      expect(args).toContain("--single-transaction");
      options.beforeRestore?.();
      const database = optionValue(args, "--dbname=");
      const current = database ? databases.get(database) : undefined;
      if (!database || !current) throw new Error("fake restore target is missing");
      const restoredInventory = structuredClone(options.restoredInventory ?? inventory);
      restoredInventory.database = database;
      restoredInventory.owner = optionValue(args, "--role=") ?? restoredInventory.owner;
      current.inventory = restoredInventory;
      return "";
    }
    if (command === "git") return RELEASE_COMMIT;
    throw new Error(`unexpected tool: ${command}`);
  };
  return { postgres, runTool, databases, toolCalls, inventory };
}

async function createGeneration(workspace: string, runtime = fakeRecoveryRuntime()) {
  const dataDirectory = path.resolve(workspace, "source-data");
  const generationDirectory = path.resolve(workspace, "generation");
  seedRuntimeData(dataDirectory);
  const result = await createProjectRecoveryBackup({
    outputDirectory: generationDirectory,
    dataDirectory,
    releaseCommit: RELEASE_COMMIT,
    env: {
      ...process.env,
      RUNTIME_PROFILE: "public-http-paper",
      UNRELATED_SECRET: "must-not-reach-pg-restore-list",
      PGPASSFILE: "/tmp/foreign-passfile",
      PGSERVICE: "foreign-service",
      PGOPTIONS: "-c search_path=foreign"
    },
    postgres: runtime.postgres,
    runTool: runtime.runTool,
    pgDump: "pg_dump",
    pgRestore: "pg_restore"
  });
  return { ...result, dataDirectory, generationDirectory, runtime };
}

function readManifest(generationDirectory: string) {
  return JSON.parse(readFileSync(path.resolve(generationDirectory, PROJECT_RECOVERY_MANIFEST), "utf8"));
}

function writeManifest(generationDirectory: string, manifest: unknown) {
  const file = path.resolve(generationDirectory, PROJECT_RECOVERY_MANIFEST);
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}

function fileSha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function readRuntimeMarker(dataDirectory: string) {
  const database = new DatabaseSync(path.resolve(dataDirectory, "trading.db"), { readOnly: true });
  try {
    return database.prepare("SELECT value FROM settings WHERE key = 'marker'").get();
  } finally {
    database.close();
  }
}

function optionValue(args: string[], prefix: string) {
  return args.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("paired project recovery", () => {
  it("keeps pre-v9 recovery count manifests backward-compatible", () => {
    const directory = path.resolve(temporaryDirectory(), "legacy-runtime");
    mkdirSync(directory, { mode: 0o700 });
    const trading = new DatabaseSync(path.resolve(directory, "trading.db"));
    trading.exec(`
      PRAGMA user_version = 8;
      CREATE TABLE bots (id TEXT PRIMARY KEY);
      INSERT INTO bots (id) VALUES ('legacy-bot');
    `);
    trading.close();

    expect(inspectSqliteInventory(directory).counts).toEqual({
      tradingBots: 1,
      tradingAccounts: 0,
      tradingCredentials: 0,
      orders: 0,
      fills: 0,
      paperEvents: 0,
      candles: 0,
      multiLegRuns: 0
    });
  });

  it("fails closed when a v9 paper recovery table or owner scope is missing", () => {
    const directory = path.resolve(temporaryDirectory(), "incomplete-v9-runtime");
    seedRuntimeData(directory);
    const database = new DatabaseSync(path.resolve(directory, "trading.db"));
    database.exec("DROP TABLE paper_bot_tombstones");
    database.close();

    expect(() => inspectSqliteInventory(directory)).toThrow(/schema 9.*paper_bot_tombstones/i);

    const malformed = new DatabaseSync(path.resolve(directory, "trading.db"));
    malformed.exec("CREATE TABLE paper_bot_tombstones (id TEXT PRIMARY KEY)");
    malformed.close();
    expect(() => inspectSqliteInventory(directory)).toThrow(/paper_bot_tombstones.*ownerUserId/i);

    const missingJournalDirectory = path.resolve(temporaryDirectory(), "missing-paper-journal");
    seedRuntimeData(missingJournalDirectory);
    const missingJournal = new DatabaseSync(path.resolve(missingJournalDirectory, "trading.db"));
    missingJournal.exec("DROP TABLE paper_events");
    missingJournal.close();
    expect(() => inspectSqliteInventory(missingJournalDirectory)).toThrow(/schema 9.*paper_events/i);

    const incompleteJournalDirectory = path.resolve(temporaryDirectory(), "incomplete-paper-journal");
    seedRuntimeData(incompleteJournalDirectory);
    const incompleteJournal = new DatabaseSync(path.resolve(incompleteJournalDirectory, "trading.db"));
    incompleteJournal.exec("ALTER TABLE paper_events DROP COLUMN ledgerEpoch");
    incompleteJournal.close();
    expect(() => inspectSqliteInventory(incompleteJournalDirectory)).toThrow(/paper_events.*ledgerEpoch/i);
  });

  it("rejects a hash-consistent incomplete v9 generation before PostgreSQL restore", async () => {
    const workspace = temporaryDirectory();
    const created = await createGeneration(workspace);
    const runtimeDirectory = path.resolve(created.generationDirectory, "runtime");
    const tradingPath = path.resolve(runtimeDirectory, "trading.db");
    const trading = new DatabaseSync(tradingPath);
    trading.exec("DROP TABLE paper_bot_tombstones");
    trading.close();

    const runtimeManifestPath = path.resolve(runtimeDirectory, "backup-manifest.json");
    const runtimeManifest = JSON.parse(readFileSync(runtimeManifestPath, "utf8"));
    const runtimeTrading = runtimeManifest.files.find((entry: { name: string }) => entry.name === "trading.db");
    runtimeTrading.size = readFileSync(tradingPath).length;
    runtimeTrading.sha256 = fileSha256(tradingPath);
    writeFileSync(runtimeManifestPath, `${JSON.stringify(runtimeManifest, null, 2)}\n`, { mode: 0o600 });

    const recoveryManifest = readManifest(created.generationDirectory);
    const recoveryTrading = recoveryManifest.sqlite.files.find((entry: { name: string }) => entry.name === "trading.db");
    recoveryTrading.size = runtimeTrading.size;
    recoveryTrading.sha256 = runtimeTrading.sha256;
    recoveryManifest.sqlite.manifestSha256 = fileSha256(runtimeManifestPath);
    recoveryManifest.sqlite.counts.paperBotTombstones = 0;
    writeManifest(created.generationDirectory, recoveryManifest);

    const targetDatabase = `saltanatbotv2_test_restore_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
    await expect(restoreProjectRecovery({
      generationDirectory: created.generationDirectory,
      targetDatabase,
      targetDataDirectory: path.resolve(workspace, "incomplete-v9-target"),
      currentDataDirectory: created.dataDirectory,
      postgres: created.runtime.postgres,
      runTool: created.runtime.runTool,
      pgRestore: "pg_restore"
    })).rejects.toThrow(/schema 9.*paper_bot_tombstones/i);
    expect(created.runtime.databases.has(targetDatabase)).toBe(false);
    expect(created.runtime.toolCalls.filter((call) => call.command === "pg_restore" && call.args[0] !== "--list"))
      .toEqual([]);
  });

  it("includes owners found only in every v9 paper recovery table", () => {
    const directory = path.resolve(temporaryDirectory(), "paper-owner-runtime");
    seedRuntimeData(directory);
    const tables = [
      "paper_portfolios",
      "paper_portfolio_epochs",
      "paper_bot_allocations",
      "paper_valuation_marks",
      "paper_portfolio_mutations",
      "paper_bot_revision_evidence",
      "paper_bot_tombstones",
      "paper_portfolio_events",
      "paper_portfolio_projections"
    ];
    const database = new DatabaseSync(path.resolve(directory, "trading.db"));
    for (const [index, table] of tables.entries()) {
      database.prepare(`INSERT INTO "${table}" (id, ownerUserId) VALUES (?, ?)`)
        .run(`paper-owner-row-${index}`, `paper-owner-${index}`);
    }
    database.close();

    expect(inspectSqliteInventory(directory).ownerUserIds).toEqual([
      "owner-a",
      "owner-b",
      ...tables.map((_, index) => `paper-owner-${index}`)
    ]);
  });

  it("keeps pre-v13 manifests compatible and requires every schema 13 control-plane count", async () => {
    const workspace = temporaryDirectory();
    const legacyRuntime = fakeRecoveryRuntime();
    legacyRuntime.inventory.migrations = migrationsThrough(11);
    const legacy = await createGeneration(path.resolve(workspace, "schema-11"), legacyRuntime);
    expect(readManifest(legacy.generationDirectory).postgres.counts).not.toHaveProperty("executorCommands");
    expect(verifyProjectRecovery(legacy.generationDirectory, {
      runTool: legacyRuntime.runTool,
      pgRestore: "pg_restore"
    }).manifest.postgres.migrations).toHaveLength(11);

    const currentRuntime = fakeRecoveryRuntime();
    currentRuntime.inventory.migrations = migrationsThrough(12);
    currentRuntime.inventory.counts.executorCommands = 6;
    const current = await createGeneration(path.resolve(workspace, "schema-12"), currentRuntime);
    expect(readManifest(current.generationDirectory).postgres.counts.executorCommands).toBe(6);
    const restored = await restoreProjectRecovery({
      generationDirectory: current.generationDirectory,
      targetDatabase: `saltanatbotv2_test_restore_${randomUUID().replaceAll("-", "").slice(0, 8)}`,
      targetDataDirectory: path.resolve(workspace, "schema-12-restored-data"),
      currentDataDirectory: current.dataDirectory,
      postgres: currentRuntime.postgres,
      runTool: currentRuntime.runTool,
      pgRestore: "pg_restore"
    });
    expect(restored.postgres.counts.executorCommands).toBe(6);

    const incompleteManifest = readManifest(current.generationDirectory);
    incompleteManifest.postgres.counts.executorCommands = undefined;
    writeManifest(current.generationDirectory, incompleteManifest);
    expect(() => verifyProjectRecovery(current.generationDirectory, {
      runTool: currentRuntime.runTool,
      pgRestore: "pg_restore"
    })).toThrow(/executor commands.*count is invalid/i);

    const alertRuntime = fakeRecoveryRuntime();
    alertRuntime.inventory.migrations = migrationsThrough(13);
    alertRuntime.inventory.counts.executorCommands = 6;
    Object.assign(alertRuntime.inventory.counts, alertControlPlaneCounts());
    const alerts = await createGeneration(path.resolve(workspace, "schema-13"), alertRuntime);
    expect(readManifest(alerts.generationDirectory).postgres.counts).toMatchObject(
      alertControlPlaneCounts()
    );
    const alertRestored = await restoreProjectRecovery({
      generationDirectory: alerts.generationDirectory,
      targetDatabase: `saltanatbotv2_test_restore_${randomUUID().replaceAll("-", "").slice(0, 8)}`,
      targetDataDirectory: path.resolve(workspace, "schema-13-restored-data"),
      currentDataDirectory: alerts.dataDirectory,
      postgres: alertRuntime.postgres,
      runTool: alertRuntime.runTool,
      pgRestore: "pg_restore"
    });
    expect(alertRestored.postgres.counts).toMatchObject(alertControlPlaneCounts());

    const incompleteAlertManifest = readManifest(alerts.generationDirectory);
    incompleteAlertManifest.postgres.counts.notificationDeliveries = undefined;
    writeManifest(alerts.generationDirectory, incompleteAlertManifest);
    expect(() => verifyProjectRecovery(alerts.generationDirectory, {
      runTool: alertRuntime.runTool,
      pgRestore: "pg_restore"
    })).toThrow(/notification deliveries.*count is invalid/i);
  });

  it("kills a recovery process group while its direct leader remains alive", async () => {
    const workspace = temporaryDirectory();
    const descendantMarker = path.resolve(workspace, "descendant-survived");
    const startedAt = Date.now();
    expect(() =>
      runRecoveryTool(
        process.execPath,
        [
          "-e",
          `
            const { spawn } = require("node:child_process");
            spawn(
              process.execPath,
              [
                "-e",
                ${JSON.stringify(`setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(descendantMarker)}, "survived"), 500)`)}
              ],
              { stdio: "ignore" }
            );
            setInterval(() => undefined, 1000);
          `
        ],
        { timeout: 100, env: { PATH: process.env.PATH ?? "" } }
      )
    ).toThrow(/timed out after 100ms and was killed/i);
    expect(Date.now() - startedAt).toBeLessThan(3_000);
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(existsSync(descendantMarker)).toBe(false);
  });

  it("rejects arbitrary direct PostgreSQL wrapper executables", async () => {
    const workspace = temporaryDirectory();
    const created = await createGeneration(workspace);

    expect(() =>
      verifyProjectRecovery(created.generationDirectory, {
        pgRestore: "/bin/bash",
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }
      })
    ).toThrow(/raw pg_restore binary|could not be resolved/i);
  });

  it("refuses to create or restore a generation outside public-http-paper", async () => {
    const workspace = temporaryDirectory();
    const dataDirectory = path.resolve(workspace, "source-data");
    seedRuntimeData(dataDirectory);
    const runtime = fakeRecoveryRuntime();
    await expect(
      createProjectRecoveryBackup({
        outputDirectory: path.resolve(workspace, "generation"),
        dataDirectory,
        env: { RUNTIME_PROFILE: "private-live" },
        postgres: runtime.postgres,
        runTool: runtime.runTool,
        pgDump: "pg_dump",
        pgRestore: "pg_restore"
      })
    ).rejects.toThrow(/public-http-paper/i);
    expect(runtime.toolCalls).toEqual([]);
  });

  it("rejects invalid release identity before opening PostgreSQL or SQLite", async () => {
    const workspace = temporaryDirectory();
    const dataDirectory = path.resolve(workspace, "source-data");
    seedRuntimeData(dataDirectory);
    const runtime = fakeRecoveryRuntime();
    await expect(
      createProjectRecoveryBackup({
        outputDirectory: path.resolve(workspace, "generation"),
        dataDirectory,
        releaseCommit: "main",
        postgres: runtime.postgres,
        runTool: runtime.runTool,
        pgDump: "pg_dump",
        pgRestore: "pg_restore"
      })
    ).rejects.toThrow(/hexadecimal Git object ID/i);
    expect(runtime.toolCalls).toEqual([]);
  });

  it("does not recursively remove staging after an unexpected entry appears", async () => {
    const workspace = temporaryDirectory();
    const dataDirectory = path.resolve(workspace, "source-data");
    seedRuntimeData(dataDirectory);
    const runtime = fakeRecoveryRuntime({ failDumpWithForeignEntry: true });
    await expect(
      createProjectRecoveryBackup({
        outputDirectory: path.resolve(workspace, "generation"),
        dataDirectory,
        releaseCommit: RELEASE_COMMIT,
        postgres: runtime.postgres,
        runTool: runtime.runTool,
        pgDump: "pg_dump",
        pgRestore: "pg_restore"
      })
    ).rejects.toThrow(/backup failed and cleanup was incomplete/i);
    const staging = readdirSync(workspace).find((name) => name.startsWith("generation.partial-"));
    expect(staging).toBeDefined();
    expect(readFileSync(path.resolve(workspace, staging!, "foreign-staging.txt"), "utf8")).toBe("must survive");
  });

  it("preserves a known-name file replaced after staging verification", async () => {
    const workspace = temporaryDirectory();
    const dataDirectory = path.resolve(workspace, "source-data");
    const outputDirectory = path.resolve(workspace, "generation");
    seedRuntimeData(dataDirectory);
    const runtime = fakeRecoveryRuntime();
    let stagingDirectory = "";
    const displacedDump = path.resolve(workspace, "displaced-postgres.dump");

    await expect(
      createProjectRecoveryBackup({
        outputDirectory,
        dataDirectory,
        releaseCommit: RELEASE_COMMIT,
        postgres: runtime.postgres,
        runTool: runtime.runTool,
        pgDump: "pg_dump",
        pgRestore: "pg_restore",
        beforeBackupPublish(context: { stagingDirectory: string }) {
          stagingDirectory = context.stagingDirectory;
          const dump = path.resolve(stagingDirectory, "postgres.dump");
          renameSync(dump, displacedDump);
          copyFileSync(displacedDump, dump);
          chmodSync(dump, 0o600);
        }
      })
    ).rejects.toThrow(/cleanup was incomplete/i);

    expect(readFileSync(path.resolve(stagingDirectory, "postgres.dump"))).toEqual(readFileSync(displacedDump));
    expect(existsSync(outputDirectory)).toBe(false);
  });

  it("rejects SQLite owners absent from the held PostgreSQL snapshot", async () => {
    const workspace = temporaryDirectory();
    const dataDirectory = path.resolve(workspace, "source-data");
    const outputDirectory = path.resolve(workspace, "generation");
    seedRuntimeData(dataDirectory);
    const runtime = fakeRecoveryRuntime({
      postgresUserIds: ["owner-a", "owner-c"]
    });

    let failure: unknown;
    try {
      await createProjectRecoveryBackup({
        outputDirectory,
        dataDirectory,
        releaseCommit: RELEASE_COMMIT,
        postgres: runtime.postgres,
        runTool: runtime.runTool,
        pgDump: "pg_dump",
        pgRestore: "pg_restore"
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors.some((error) => /owners are absent from the PostgreSQL snapshot/i.test(String((error as Error).message)))).toBe(true);
    expect(existsSync(outputDirectory)).toBe(false);
  });

  it("does not replace a foreign output raced before its exclusive claim", async () => {
    const workspace = temporaryDirectory();
    const dataDirectory = path.resolve(workspace, "source-data");
    const outputDirectory = path.resolve(workspace, "generation");
    seedRuntimeData(dataDirectory);
    const runtime = fakeRecoveryRuntime();
    let foreignIdentity: { dev: bigint | number; ino: bigint | number } | undefined;

    await expect(
      createProjectRecoveryBackup({
        outputDirectory,
        dataDirectory,
        releaseCommit: RELEASE_COMMIT,
        postgres: runtime.postgres,
        runTool: runtime.runTool,
        pgDump: "pg_dump",
        pgRestore: "pg_restore",
        beforeBackupPublish() {
          mkdirSync(outputDirectory, { mode: 0o700 });
          const entry = lstatSync(outputDirectory);
          foreignIdentity = { dev: entry.dev, ino: entry.ino };
        }
      })
    ).rejects.toThrow(/exclusive claim/i);

    const retained = lstatSync(outputDirectory);
    expect({ dev: retained.dev, ino: retained.ino }).toEqual(foreignIdentity);
    expect(readdirSync(outputDirectory)).toEqual([]);
  });

  it("creates one verified PostgreSQL/SQLite generation from an exported snapshot", async () => {
    const workspace = temporaryDirectory();
    const created = await createGeneration(workspace);
    const verified = verifyProjectRecovery(created.generationDirectory, {
      runTool: created.runtime.runTool,
      pgRestore: "pg_restore"
    });

    expect(verified.manifest).toMatchObject({
      format: "saltanatbotv2-project-recovery",
      version: 1,
      runtimeProfile: "public-http-paper",
      releaseCommit: RELEASE_COMMIT,
      postgres: {
        database: "saltanatbotv2_test",
        counts: {
          users: 3,
          workspaces: 4,
          workspaceRevisions: 7,
          computeJobs: 2,
          userOnboarding: 2
        }
      },
      sqlite: {
        counts: {
          tradingBots: 2,
          tradingAccounts: 1,
          tradingCredentials: 0,
          orders: 1,
          fills: 1,
          paperEvents: 1,
          paperPortfolios: 1,
          paperPortfolioEpochs: 1,
          paperBotAllocations: 1,
          paperValuationMarks: 1,
          paperPortfolioMutations: 1,
          paperBotRevisionEvidence: 1,
          paperBotTombstones: 1,
          paperPortfolioJournalEvents: 1,
          paperPortfolioProjections: 1,
          candles: 2,
          multiLegRuns: 1
        }
      }
    });
    expect(verified.manifest.capture.spanMs).toBeLessThanOrEqual(300_000);
    expect(created.runtime.toolCalls.map((call) => call.command)).toEqual(["pg_dump", "pg_restore", "pg_restore", "pg_restore"]);
    expect(created.runtime.toolCalls.find((call) => call.command === "pg_dump")?.timeout).toBe(300_000);
    expect(created.runtime.toolCalls.flatMap((call) => call.args).some((argument) => argument.includes("systemctl"))).toBe(false);
    for (const call of created.runtime.toolCalls.filter((entry) => entry.command === "pg_restore")) {
      expect(call.timeout).toBe(60_000);
      expect(call.env).not.toHaveProperty("UNRELATED_SECRET");
      expect(call.env).not.toHaveProperty("PGPASSFILE");
      expect(call.env).not.toHaveProperty("PGSERVICE");
      expect(call.env).not.toHaveProperty("PGOPTIONS");
    }
  });

  it("rejects a corrupted PostgreSQL dump and an excessive capture span", async () => {
    const workspace = temporaryDirectory();
    const created = await createGeneration(workspace);
    writeFileSync(path.resolve(created.generationDirectory, "postgres.dump"), "corrupt", { mode: 0o600 });
    expect(() =>
      verifyProjectRecovery(created.generationDirectory, {
        runTool: created.runtime.runTool,
        pgRestore: "pg_restore"
      })
    ).toThrow(/dump (size|checksum) mismatch/i);

    const second = await createGeneration(path.resolve(workspace, "second"));
    const manifest = readManifest(second.generationDirectory);
    const late = new Date(Date.parse(manifest.capture.postgres.startedAt) + 6 * 60_000).toISOString();
    manifest.capture.sqlite.completedAt = late;
    manifest.capture.spanMs = 6 * 60_000;
    manifest.createdAt = late;
    writeManifest(second.generationDirectory, manifest);
    expect(() =>
      verifyProjectRecovery(second.generationDirectory, {
        runTool: second.runtime.runTool,
        pgRestore: "pg_restore"
      })
    ).toThrow(/capture span/i);
  });

  it("requires a bounded runtime manifest and an explicit release identity", async () => {
    const workspace = temporaryDirectory();
    const created = await createGeneration(workspace);
    const manifest = readManifest(created.generationDirectory);
    manifest.releaseCommit = undefined;
    writeManifest(created.generationDirectory, manifest);
    expect(() =>
      verifyProjectRecovery(created.generationDirectory, {
        runTool: created.runtime.runTool,
        pgRestore: "pg_restore"
      })
    ).toThrow(/release commit/i);

    const second = await createGeneration(path.resolve(workspace, "second"));
    writeFileSync(path.resolve(second.generationDirectory, "runtime", "backup-manifest.json"), Buffer.alloc(1024 * 1024 + 1, 0x20), { mode: 0o600 });
    expect(() =>
      verifyProjectRecovery(second.generationDirectory, {
        runTool: second.runtime.runTool,
        pgRestore: "pg_restore"
      })
    ).toThrow(/runtime backup manifest is too large/i);
  });

  it("restores only into a new project-prefixed database and separate absent data directory", async () => {
    const workspace = temporaryDirectory();
    const created = await createGeneration(workspace);
    const targetDataDirectory = path.resolve(workspace, "replacement-data");
    const targetDatabase = `saltanatbotv2_test_restore_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
    const result = await restoreProjectRecovery({
      generationDirectory: created.generationDirectory,
      targetDatabase,
      targetDataDirectory,
      currentDataDirectory: created.dataDirectory,
      postgres: created.runtime.postgres,
      runTool: created.runtime.runTool,
      pgRestore: "pg_restore"
    });

    expect(created.runtime.databases.get(targetDatabase)).toMatchObject({
      marker: result.marker,
      databaseOid: result.databaseOid
    });
    expect(result.postgres.counts).toEqual(created.runtime.inventory.counts);
    expect(readRuntimeMarker(targetDataDirectory)).toEqual({ value: "source" });
    expect(readRuntimeMarker(created.dataDirectory)).toEqual({ value: "source" });
    expect(result.marker).toContain(result.generationId);
    expect(created.runtime.toolCalls.find((call) => call.command === "pg_restore" && call.args[0] !== "--list")?.timeout).toBe(600_000);
  });

  it("accepts an existing empty data directory but refuses current, non-empty and symlink targets", async () => {
    const workspace = temporaryDirectory();
    const created = await createGeneration(workspace);
    const emptyTarget = path.resolve(workspace, "empty-target");
    mkdirSync(emptyTarget, { mode: 0o700 });
    const emptyDatabase = `saltanatbotv2_test_restore_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
    await expect(
      restoreProjectRecovery({
        generationDirectory: created.generationDirectory,
        targetDatabase: emptyDatabase,
        targetDataDirectory: emptyTarget,
        currentDataDirectory: created.dataDirectory,
        postgres: created.runtime.postgres,
        runTool: created.runtime.runTool,
        pgRestore: "pg_restore"
      })
    ).resolves.toMatchObject({ targetDatabase: emptyDatabase });

    await expect(
      restoreProjectRecovery({
        generationDirectory: created.generationDirectory,
        targetDatabase: `saltanatbotv2_test_restore_${randomUUID().replaceAll("-", "").slice(0, 8)}`,
        targetDataDirectory: created.dataDirectory,
        currentDataDirectory: created.dataDirectory,
        postgres: created.runtime.postgres,
        runTool: created.runtime.runTool,
        pgRestore: "pg_restore"
      })
    ).rejects.toThrow(/current runtime data directory/i);

    const nonempty = path.resolve(workspace, "nonempty");
    mkdirSync(nonempty);
    writeFileSync(path.resolve(nonempty, "keep.txt"), "do not touch");
    await expect(
      restoreProjectRecovery({
        generationDirectory: created.generationDirectory,
        targetDatabase: `saltanatbotv2_test_restore_${randomUUID().replaceAll("-", "").slice(0, 8)}`,
        targetDataDirectory: nonempty,
        currentDataDirectory: created.dataDirectory,
        postgres: created.runtime.postgres,
        runTool: created.runtime.runTool,
        pgRestore: "pg_restore"
      })
    ).rejects.toThrow(/absent or empty/i);
    expect(readFileSync(path.resolve(nonempty, "keep.txt"), "utf8")).toBe("do not touch");

    const real = path.resolve(workspace, "real");
    const link = path.resolve(workspace, "link");
    mkdirSync(real);
    symlinkSync(real, link, "dir");
    await expect(
      restoreProjectRecovery({
        generationDirectory: created.generationDirectory,
        targetDatabase: `saltanatbotv2_test_restore_${randomUUID().replaceAll("-", "").slice(0, 8)}`,
        targetDataDirectory: link,
        currentDataDirectory: created.dataDirectory,
        postgres: created.runtime.postgres,
        runTool: created.runtime.runTool,
        pgRestore: "pg_restore"
      })
    ).rejects.toThrow(/symbolic link/i);
  });

  it("rejects intermediate symlinks for generations, output parents, current data and target parents", async () => {
    const workspace = temporaryDirectory();
    const created = await createGeneration(workspace);
    const generationLink = path.resolve(workspace, "generation-link");
    symlinkSync(created.generationDirectory, generationLink, "dir");
    expect(() =>
      verifyProjectRecovery(generationLink, {
        runTool: created.runtime.runTool,
        pgRestore: "pg_restore"
      })
    ).toThrow(/symbolic-link components/i);

    const realOutputParent = path.resolve(workspace, "real-output-parent");
    const outputParentLink = path.resolve(workspace, "output-parent-link");
    mkdirSync(realOutputParent, { mode: 0o700 });
    symlinkSync(realOutputParent, outputParentLink, "dir");
    const outputRuntime = fakeRecoveryRuntime();
    await expect(
      createProjectRecoveryBackup({
        outputDirectory: path.resolve(outputParentLink, "generation"),
        dataDirectory: created.dataDirectory,
        releaseCommit: RELEASE_COMMIT,
        postgres: outputRuntime.postgres,
        runTool: outputRuntime.runTool,
        pgDump: "pg_dump",
        pgRestore: "pg_restore"
      })
    ).rejects.toThrow(/symbolic-link components/i);
    expect(outputRuntime.toolCalls).toEqual([]);

    const currentLink = path.resolve(workspace, "current-link");
    symlinkSync(created.dataDirectory, currentLink, "dir");
    await expect(
      restoreProjectRecovery({
        generationDirectory: created.generationDirectory,
        targetDatabase: `saltanatbotv2_test_restore_${randomUUID().replaceAll("-", "").slice(0, 8)}`,
        targetDataDirectory: path.resolve(workspace, "replacement-via-current-link"),
        currentDataDirectory: currentLink,
        postgres: created.runtime.postgres,
        runTool: created.runtime.runTool,
        pgRestore: "pg_restore"
      })
    ).rejects.toThrow(/symbolic-link components/i);

    const realTargetParent = path.resolve(workspace, "real-target-parent");
    const targetParentLink = path.resolve(workspace, "target-parent-link");
    mkdirSync(realTargetParent, { mode: 0o700 });
    symlinkSync(realTargetParent, targetParentLink, "dir");
    await expect(
      restoreProjectRecovery({
        generationDirectory: created.generationDirectory,
        targetDatabase: `saltanatbotv2_test_restore_${randomUUID().replaceAll("-", "").slice(0, 8)}`,
        targetDataDirectory: path.resolve(targetParentLink, "replacement"),
        currentDataDirectory: created.dataDirectory,
        postgres: created.runtime.postgres,
        runTool: created.runtime.runTool,
        pgRestore: "pg_restore"
      })
    ).rejects.toThrow(/symbolic-link components/i);
  });

  it("does not remove a foreign target that appears after validation", async () => {
    const workspace = temporaryDirectory();
    const targetDataDirectory = path.resolve(workspace, "replacement-race");
    let foreignIdentity: { dev: bigint | number; ino: bigint | number } | undefined;
    const runtime = fakeRecoveryRuntime({
      beforeRestore() {
        unlinkSync(path.resolve(targetDataDirectory, ".saltanat-recovery-claim"));
        rmdirSync(targetDataDirectory);
        mkdirSync(targetDataDirectory, { mode: 0o700 });
        const entry = lstatSync(targetDataDirectory);
        foreignIdentity = { dev: entry.dev, ino: entry.ino };
      }
    });
    const created = await createGeneration(workspace, runtime);
    const targetDatabase = `saltanatbotv2_test_restore_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
    await expect(
      restoreProjectRecovery({
        generationDirectory: created.generationDirectory,
        targetDatabase,
        targetDataDirectory,
        currentDataDirectory: created.dataDirectory,
        postgres: runtime.postgres,
        runTool: runtime.runTool,
        pgRestore: "pg_restore"
      })
    ).rejects.toThrow(/identity changed|cleanup was incomplete/i);
    const retained = lstatSync(targetDataDirectory);
    expect({ dev: retained.dev, ino: retained.ino }).toEqual(foreignIdentity);
    expect(readdirSync(targetDataDirectory)).toEqual([]);
    expect(runtime.databases.has(targetDatabase)).toBe(true);
  });

  it("pins verified recovery input before creating a replacement database", async () => {
    const workspace = temporaryDirectory();
    const runtime = fakeRecoveryRuntime({
      afterSecondArchiveVerification(dumpPath) {
        writeFileSync(dumpPath, "tampered-postgresql-custom-dump", { mode: 0o600 });
      }
    });
    const created = await createGeneration(workspace, runtime);
    const targetDatabase = `saltanatbotv2_test_restore_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
    await expect(
      restoreProjectRecovery({
        generationDirectory: created.generationDirectory,
        targetDatabase,
        targetDataDirectory: path.resolve(workspace, "replacement-after-swap"),
        currentDataDirectory: created.dataDirectory,
        postgres: runtime.postgres,
        runTool: runtime.runTool,
        pgRestore: "pg_restore"
      })
    ).rejects.toThrow(/pinned|dump size mismatch|size changed|checksum changed/i);
    expect(runtime.databases.has(targetDatabase)).toBe(false);
    expect(readdirSync(workspace).some((name) => name.startsWith(".saltanat-recovery-input-"))).toBe(false);
  });

  it("retains paired resources when a restore adapter throws after publication without returning provenance", async () => {
    const workspace = temporaryDirectory();
    const created = await createGeneration(workspace);
    const targetDataDirectory = path.resolve(workspace, "replacement-post-publish-failure");
    const targetDatabase = `saltanatbotv2_test_restore_${randomUUID().replaceAll("-", "").slice(0, 8)}`;

    await expect(
      restoreProjectRecovery({
        generationDirectory: created.generationDirectory,
        targetDatabase,
        targetDataDirectory,
        currentDataDirectory: created.dataDirectory,
        postgres: created.runtime.postgres,
        runTool: created.runtime.runTool,
        pgRestore: "pg_restore",
        restoreRuntimeBackup(options: Parameters<typeof restoreRuntimeBackup>[0]) {
          restoreRuntimeBackup(options);
          throw new Error("injected previous cleanup failure after publish");
        }
      })
    ).rejects.toThrow(/cleanup was incomplete/i);

    expect(existsSync(targetDataDirectory)).toBe(true);
    expect(created.runtime.databases.has(targetDatabase)).toBe(true);
    expect(readdirSync(workspace).some((name) => name.startsWith(".saltanat-recovery-input-"))).toBe(true);
  });

  it("does not delete an exact-content replacement after the restored target identity changes", async () => {
    const workspace = temporaryDirectory();
    const created = await createGeneration(workspace);
    const targetDataDirectory = path.resolve(workspace, "existing-empty-target");
    const displacedTarget = path.resolve(workspace, "displaced-restored-target");
    mkdirSync(targetDataDirectory, { mode: 0o700 });
    const targetDatabase = `saltanatbotv2_test_restore_${randomUUID().replaceAll("-", "").slice(0, 8)}`;

    await expect(
      restoreProjectRecovery({
        generationDirectory: created.generationDirectory,
        targetDatabase,
        targetDataDirectory,
        currentDataDirectory: created.dataDirectory,
        postgres: created.runtime.postgres,
        runTool: created.runtime.runTool,
        pgRestore: "pg_restore",
        async afterRuntimeRestore() {
          renameSync(targetDataDirectory, displacedTarget);
          mkdirSync(targetDataDirectory, { mode: 0o700 });
          for (const name of readdirSync(displacedTarget)) {
            copyFileSync(path.resolve(displacedTarget, name), path.resolve(targetDataDirectory, name));
            chmodSync(path.resolve(targetDataDirectory, name), 0o600);
          }
          throw new Error("injected target identity replacement");
        }
      })
    ).rejects.toThrow(/cleanup was incomplete/i);

    expect(readRuntimeMarker(targetDataDirectory)).toEqual({
      value: "source"
    });
    expect(existsSync(displacedTarget)).toBe(true);
    expect(created.runtime.databases.has(targetDatabase)).toBe(true);
  });

  it("writes the reviewed generation path directly into the restore manifest", async () => {
    const workspace = temporaryDirectory();
    const created = await createGeneration(workspace);
    const targetDataDirectory = path.resolve(workspace, "replacement-manifest-race");
    const targetDatabase = `saltanatbotv2_test_restore_${randomUUID().replaceAll("-", "").slice(0, 8)}`;

    await restoreProjectRecovery({
      generationDirectory: created.generationDirectory,
      targetDatabase,
      targetDataDirectory,
      currentDataDirectory: created.dataDirectory,
      postgres: created.runtime.postgres,
      runTool: created.runtime.runTool,
      pgRestore: "pg_restore"
    });

    const restoreManifest = JSON.parse(readFileSync(path.resolve(targetDataDirectory, ".restore-manifest.json"), "utf8"));
    expect(restoreManifest.restoredFrom).toBe(path.resolve(created.generationDirectory, "runtime"));
    expect(readdirSync(targetDataDirectory).some((name) => name.includes(".partial-"))).toBe(false);
  });

  it("rejects a replacement parent whose permissions change after validation", async () => {
    const workspace = temporaryDirectory();
    const targetDataDirectory = path.resolve(workspace, "replacement-mode-race");
    const runtime = fakeRecoveryRuntime({
      beforeRestore() {
        chmodSync(workspace, 0o777);
      }
    });
    const created = await createGeneration(workspace, runtime);
    const targetDatabase = `saltanatbotv2_test_restore_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
    await expect(
      restoreProjectRecovery({
        generationDirectory: created.generationDirectory,
        targetDatabase,
        targetDataDirectory,
        currentDataDirectory: created.dataDirectory,
        postgres: runtime.postgres,
        runTool: runtime.runTool,
        pgRestore: "pg_restore"
      })
    ).rejects.toThrow(/cleanup was incomplete/i);
    expect(runtime.databases.has(targetDatabase)).toBe(true);
    expect(existsSync(targetDataDirectory)).toBe(true);
    expect(existsSync(path.resolve(targetDataDirectory, ".saltanat-recovery-claim"))).toBe(true);
    chmodSync(workspace, 0o700);
  });

  it("refuses recursive cleanup when unexpected data appears after runtime restore", async () => {
    const workspace = temporaryDirectory();
    const created = await createGeneration(workspace);
    const targetDataDirectory = path.resolve(workspace, "replacement-after-restore");
    const targetDatabase = `saltanatbotv2_test_restore_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
    await expect(
      restoreProjectRecovery({
        generationDirectory: created.generationDirectory,
        targetDatabase,
        targetDataDirectory,
        currentDataDirectory: created.dataDirectory,
        postgres: created.runtime.postgres,
        runTool: created.runtime.runTool,
        pgRestore: "pg_restore",
        async afterRuntimeRestore() {
          writeFileSync(path.resolve(targetDataDirectory, "foreign-after-restore.txt"), "must survive");
        }
      })
    ).rejects.toThrow(/cleanup was incomplete/i);
    expect(readFileSync(path.resolve(targetDataDirectory, "foreign-after-restore.txt"), "utf8")).toBe("must survive");
    expect(created.runtime.databases.has(targetDatabase)).toBe(true);
    expect(readdirSync(workspace).some((name) => name.startsWith(".saltanat-recovery-input-"))).toBe(true);
  });

  it("refuses current, incorrectly named and pre-existing PostgreSQL targets", async () => {
    const workspace = temporaryDirectory();
    const created = await createGeneration(workspace);
    const options = {
      generationDirectory: created.generationDirectory,
      targetDataDirectory: path.resolve(workspace, "replacement"),
      currentDataDirectory: created.dataDirectory,
      postgres: created.runtime.postgres,
      runTool: created.runtime.runTool,
      pgRestore: "pg_restore"
    };
    await expect(restoreProjectRecovery({ ...options, targetDatabase: "saltanatbotv2_test" })).rejects.toThrow(/must start with/i);
    await expect(restoreProjectRecovery({ ...options, targetDatabase: "foreign_restore_database" })).rejects.toThrow(/must start with/i);

    const existing = `saltanatbotv2_test_restore_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
    created.runtime.databases.set(existing, { marker: "foreign", databaseOid: "99999" });
    await expect(restoreProjectRecovery({ ...options, targetDatabase: existing })).rejects.toThrow(/already exists/i);
    expect(created.runtime.databases.get(existing)).toEqual({ marker: "foreign", databaseOid: "99999" });
  });

  it("drops only its marked replacement after pg_restore or inventory verification fails", async () => {
    const workspace = temporaryDirectory();
    const failingRuntime = fakeRecoveryRuntime({ failRestore: true });
    const created = await createGeneration(workspace, failingRuntime);
    const targetDatabase = `saltanatbotv2_test_restore_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
    const targetDataDirectory = path.resolve(workspace, "replacement");
    await expect(
      restoreProjectRecovery({
        generationDirectory: created.generationDirectory,
        targetDatabase,
        targetDataDirectory,
        currentDataDirectory: created.dataDirectory,
        postgres: failingRuntime.postgres,
        runTool: failingRuntime.runTool,
        pgRestore: "pg_restore"
      })
    ).rejects.toThrow(/injected pg_restore failure/i);
    expect(failingRuntime.databases.has(targetDatabase)).toBe(false);
    expect(existsSync(targetDataDirectory)).toBe(false);

    const mismatchedInventory = sourceInventory();
    mismatchedInventory.counts.users += 1;
    const mismatchRuntime = fakeRecoveryRuntime({ restoredInventory: mismatchedInventory });
    const second = await createGeneration(path.resolve(workspace, "second"), mismatchRuntime);
    const secondDatabase = `saltanatbotv2_test_restore_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
    await expect(
      restoreProjectRecovery({
        generationDirectory: second.generationDirectory,
        targetDatabase: secondDatabase,
        targetDataDirectory: path.resolve(workspace, "second-replacement"),
        currentDataDirectory: second.dataDirectory,
        postgres: mismatchRuntime.postgres,
        runTool: mismatchRuntime.runTool,
        pgRestore: "pg_restore"
      })
    ).rejects.toThrow(/PostgreSQL counts mismatch/i);
    expect(mismatchRuntime.databases.has(secondDatabase)).toBe(false);

    const mismatchedAlertInventory = sourceInventory();
    mismatchedAlertInventory.migrations = migrationsThrough(13);
    mismatchedAlertInventory.counts.executorCommands = 6;
    Object.assign(mismatchedAlertInventory.counts, alertControlPlaneCounts());
    mismatchedAlertInventory.counts.notificationOutbox =
      alertControlPlaneCounts().notificationOutbox + 1;
    const alertMismatchRuntime = fakeRecoveryRuntime({
      restoredInventory: mismatchedAlertInventory
    });
    alertMismatchRuntime.inventory.migrations = migrationsThrough(13);
    alertMismatchRuntime.inventory.counts.executorCommands = 6;
    Object.assign(alertMismatchRuntime.inventory.counts, alertControlPlaneCounts());
    const third = await createGeneration(path.resolve(workspace, "third"), alertMismatchRuntime);
    const thirdDatabase = `saltanatbotv2_test_restore_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
    await expect(
      restoreProjectRecovery({
        generationDirectory: third.generationDirectory,
        targetDatabase: thirdDatabase,
        targetDataDirectory: path.resolve(workspace, "third-replacement"),
        currentDataDirectory: third.dataDirectory,
        postgres: alertMismatchRuntime.postgres,
        runTool: alertMismatchRuntime.runTool,
        pgRestore: "pg_restore"
      })
    ).rejects.toThrow(/PostgreSQL counts mismatch/i);
    expect(alertMismatchRuntime.databases.has(thirdDatabase)).toBe(false);
  });

  it("releases an existing empty target claim when PostgreSQL restore fails before SQLite publication", async () => {
    const workspace = temporaryDirectory();
    const failingRuntime = fakeRecoveryRuntime({ failRestore: true });
    const created = await createGeneration(workspace, failingRuntime);
    const targetDataDirectory = path.resolve(workspace, "existing-empty-before-pg-failure");
    mkdirSync(targetDataDirectory, { mode: 0o700 });
    const originalIdentity = lstatSync(targetDataDirectory);
    const targetDatabase = `saltanatbotv2_test_restore_${randomUUID().replaceAll("-", "").slice(0, 8)}`;

    await expect(
      restoreProjectRecovery({
        generationDirectory: created.generationDirectory,
        targetDatabase,
        targetDataDirectory,
        currentDataDirectory: created.dataDirectory,
        postgres: failingRuntime.postgres,
        runTool: failingRuntime.runTool,
        pgRestore: "pg_restore"
      })
    ).rejects.toThrow(/injected pg_restore failure/i);

    const retained = lstatSync(targetDataDirectory);
    expect({ dev: retained.dev, ino: retained.ino }).toEqual({
      dev: originalIdentity.dev,
      ino: originalIdentity.ino
    });
    expect(readdirSync(targetDataDirectory)).toEqual([]);
    expect(failingRuntime.databases.has(targetDatabase)).toBe(false);
  });

  it("runs a drill in isolated resources and removes the exact marked database and data directory", async () => {
    const workspace = temporaryDirectory();
    const created = await createGeneration(workspace);
    const drill = await drillProjectRecovery({
      generationDirectory: created.generationDirectory,
      currentDataDirectory: created.dataDirectory,
      temporaryRoot: workspace,
      postgres: created.runtime.postgres,
      runTool: created.runtime.runTool,
      pgRestore: "pg_restore"
    });

    expect(drill.targetDatabase).toMatch(/^saltanatbotv2_test_drill_/);
    expect(drill.cleanup).toEqual({ databaseDropped: true, dataDirectoryRemoved: true });
    expect(created.runtime.databases.has(drill.targetDatabase)).toBe(false);
    expect(existsSync(drill.targetDataDirectory)).toBe(false);
  });

  it("retains the marked drill database when SQLite cleanup is not proven", async () => {
    const workspace = temporaryDirectory();
    const created = await createGeneration(workspace);
    let retainedDatabase = "";
    let retainedDataDirectory = "";

    await expect(
      drillProjectRecovery({
        generationDirectory: created.generationDirectory,
        currentDataDirectory: created.dataDirectory,
        temporaryRoot: workspace,
        postgres: created.runtime.postgres,
        runTool: created.runtime.runTool,
        pgRestore: "pg_restore",
        beforeDrillCleanup({
          targetDatabase,
          targetDataDirectory
        }: {
          targetDatabase: string;
          targetDataDirectory: string;
        }) {
          retainedDatabase = targetDatabase;
          retainedDataDirectory = targetDataDirectory;
          writeFileSync(path.resolve(targetDataDirectory, "foreign-drill-file.txt"), "preserve paired drill state");
        }
      })
    ).rejects.toThrow(/drill cleanup was incomplete/i);

    expect(created.runtime.databases.has(retainedDatabase)).toBe(true);
    expect(readFileSync(path.resolve(retainedDataDirectory, "foreign-drill-file.txt"), "utf8")).toBe("preserve paired drill state");
  });

  it("removes the drill root when validation fails before restore starts", async () => {
    const workspace = temporaryDirectory();
    const created = await createGeneration(workspace);
    await expect(
      drillProjectRecovery({
        generationDirectory: created.generationDirectory,
        currentDataDirectory: path.resolve(workspace, "missing-current-data"),
        temporaryRoot: workspace,
        postgres: created.runtime.postgres,
        runTool: created.runtime.runTool,
        pgRestore: "pg_restore"
      })
    ).rejects.toThrow();
    expect(readdirSync(workspace).some((name) => name.startsWith("saltanat-recovery-drill-"))).toBe(false);
  });
});
