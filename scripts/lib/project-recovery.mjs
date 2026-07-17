import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, existsSync, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, readdirSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { createRuntimeBackup, restoreRuntimeBackup, verifyRuntimeBackup } from "../runtime-data.mjs";
import { createPostgresRecoveryOperations, resolveRecoveryConnections } from "./project-recovery-postgres.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const DEFAULT_RUNTIME_DATA_DIRECTORY = path.resolve(root, "backend/data");
export const PROJECT_RECOVERY_FORMAT = "saltanatbotv2-project-recovery";
export const PROJECT_RECOVERY_VERSION = 1;
export const PROJECT_RECOVERY_MANIFEST = "recovery-manifest.json";
export const PROJECT_RECOVERY_POSTGRES_DUMP = "postgres.dump";
export const PROJECT_RECOVERY_RUNTIME_DIRECTORY = "runtime";
export const PROJECT_RECOVERY_MAX_CAPTURE_SPAN_MS = 5 * 60_000;
const RUNTIME_PROFILE = "public-http-paper";
const REPLACEMENT_CLAIM_FILE = ".saltanat-recovery-claim";
const MAX_RECOVERY_MANIFEST_BYTES = 1024 * 1024;
const DEFAULT_PG_DUMP_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_PG_RESTORE_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_PG_RESTORE_LIST_TIMEOUT_MS = 60_000;
const DEFAULT_GIT_TIMEOUT_MS = 10_000;
const ROOT_ENTRIES = [PROJECT_RECOVERY_MANIFEST, PROJECT_RECOVERY_POSTGRES_DUMP, PROJECT_RECOVERY_RUNTIME_DIRECTORY];
const RUNTIME_STAGING_ENTRIES = new Set([
  "trading.db",
  "trading.db-wal",
  "trading.db-shm",
  "trading.db-journal",
  "candles.db",
  "candles.db-wal",
  "candles.db-shm",
  "candles.db-journal",
  "arbitrage-paper-multi-leg.sqlite",
  "arbitrage-paper-multi-leg.sqlite-wal",
  "arbitrage-paper-multi-leg.sqlite-shm",
  "arbitrage-paper-multi-leg.sqlite-journal",
  ".secret",
  ".authtoken",
  "backup-manifest.json"
]);
const SQLITE_TRADING_BASE_COUNT_KEYS = ["tradingBots", "tradingAccounts", "tradingCredentials", "orders", "fills", "paperEvents"];
const SQLITE_PAPER_PORTFOLIO_TABLES = [
  ["paperPortfolios", "paper_portfolios"],
  ["paperPortfolioEpochs", "paper_portfolio_epochs"],
  ["paperBotAllocations", "paper_bot_allocations"],
  ["paperValuationMarks", "paper_valuation_marks"],
  ["paperPortfolioMutations", "paper_portfolio_mutations"],
  ["paperBotRevisionEvidence", "paper_bot_revision_evidence"],
  ["paperBotTombstones", "paper_bot_tombstones"],
  ["paperPortfolioJournalEvents", "paper_portfolio_events"],
  ["paperPortfolioProjections", "paper_portfolio_projections"]
];
const SQLITE_PAPER_PORTFOLIO_COUNT_KEYS = SQLITE_PAPER_PORTFOLIO_TABLES.map(([key]) => key);
const SQLITE_AUXILIARY_COUNT_KEYS = ["candles", "multiLegRuns"];

export async function createProjectRecoveryBackup(options) {
  const outputDirectory = requiredPath(options?.outputDirectory, "backup output directory");
  const dataDirectory = path.resolve(options?.dataDirectory ?? DEFAULT_RUNTIME_DATA_DIRECTORY);
  if (options?.releaseCommit !== undefined) validateReleaseCommit(options.releaseCommit);
  const dependencies = recoveryDependencies(options);
  assertNoSymlinkComponents(dataDirectory, "Runtime data directory");
  assertRealDirectory(dataDirectory, "Runtime data directory");
  if (isInside(dataDirectory, outputDirectory)) {
    throw new Error("Project recovery output must be outside the current runtime data directory");
  }
  if (lstatIfExists(outputDirectory)) throw new Error(`Project recovery output already exists: ${outputDirectory}`);
  const outputParent = path.dirname(outputDirectory);
  assertNoSymlinkComponents(outputParent, "Project recovery output parent");
  const outputParentEntry = assertRealDirectory(outputParent, "Project recovery output parent");
  const currentUid = process.getuid?.();
  if (currentUid !== undefined && outputParentEntry.uid !== currentUid) {
    throw new Error("Project recovery output parent must be owned by the recovery operator");
  }
  if ((outputParentEntry.mode & 0o022) !== 0) {
    throw new Error("Project recovery output parent must not be group or world writable");
  }
  const outputParentIdentity = filesystemIdentity(outputParentEntry);
  const stagingDirectory = `${outputDirectory}.partial-${dependencies.uuid()}`;
  mkdirSync(stagingDirectory, { mode: 0o700 });
  const stagingIdentity = filesystemIdentity(lstatSync(stagingDirectory));
  let stagingSnapshot;
  let outputClaim;
  const dumpPath = path.resolve(stagingDirectory, PROJECT_RECOVERY_POSTGRES_DUMP);
  const runtimeBackupDirectory = path.resolve(stagingDirectory, PROJECT_RECOVERY_RUNTIME_DIRECTORY);
  const postgresStartedAt = dependencies.timestamp();
  let postgresCompletedAt;
  let sqliteStartedAt;
  let sqliteCompletedAt;
  let runtimeResult;
  let sqliteInventory;

  try {
    const postgresInventory = await dependencies.postgres.withExportedSnapshot(async ({ snapshot, inventory }) => {
      dependencies.runTool(dependencies.pgDump, ["--format=custom", "--no-owner", "--no-privileges", `--snapshot=${snapshot}`, `--dbname=${dependencies.postgres.source.database}`, `--file=${dumpPath}`], {
        env: dependencies.postgres.source.toolEnvironment(),
        timeout: dependencies.toolTimeouts.pgDump
      });
      postgresCompletedAt = dependencies.timestamp();
      assertRegularFile(dumpPath, "PostgreSQL dump");
      chmodSync(dumpPath, 0o600);

      sqliteStartedAt = dependencies.timestamp();
      await createRuntimeBackup({
        dataDirectory,
        outputDirectory: runtimeBackupDirectory
      });
      sqliteCompletedAt = dependencies.timestamp();
      runtimeResult = verifyRuntimeBackup(runtimeBackupDirectory);
      sqliteInventory = inspectSqliteInventory(runtimeBackupDirectory);
      assertSqliteOwnersExistInPostgresSnapshot(sqliteInventory.ownerUserIds, inventory.userIds);
      return inventory;
    });
    if (!postgresCompletedAt || !sqliteStartedAt || !sqliteCompletedAt || !runtimeResult || !sqliteInventory) {
      throw new Error("Project recovery capture did not complete");
    }
    const capture = captureWindow({
      postgresStartedAt,
      postgresCompletedAt,
      sqliteStartedAt,
      sqliteCompletedAt
    });
    if (capture.spanMs > PROJECT_RECOVERY_MAX_CAPTURE_SPAN_MS) {
      throw new Error(`Project recovery capture span ${capture.spanMs}ms exceeds ${PROJECT_RECOVERY_MAX_CAPTURE_SPAN_MS}ms`);
    }

    const runtimeManifestPath = path.resolve(runtimeBackupDirectory, "backup-manifest.json");
    const dumpDigest = digestRegularFile(dumpPath);
    const manifest = {
      format: PROJECT_RECOVERY_FORMAT,
      version: PROJECT_RECOVERY_VERSION,
      generationId: dependencies.uuid(),
      createdAt: capture.completedAt,
      runtimeProfile: RUNTIME_PROFILE,
      capture,
      releaseCommit: resolveReleaseCommit(options?.releaseCommit, dependencies),
      postgres: {
        ...validatePostgresInventory(postgresInventory),
        dump: {
          file: PROJECT_RECOVERY_POSTGRES_DUMP,
          size: dumpDigest.size,
          sha256: dumpDigest.sha256
        }
      },
      sqlite: {
        runtimeDirectory: PROJECT_RECOVERY_RUNTIME_DIRECTORY,
        manifestFile: `${PROJECT_RECOVERY_RUNTIME_DIRECTORY}/backup-manifest.json`,
        manifestSha256: digestRegularFile(runtimeManifestPath).sha256,
        files: runtimeResult.manifest.files.map((entry) => ({
          name: entry.name,
          size: entry.size,
          sha256: entry.sha256,
          ...(entry.sqliteUserVersion === undefined ? {} : { sqliteUserVersion: entry.sqliteUserVersion })
        })),
        counts: sqliteInventory.counts,
        ownerSetSha256: sqliteInventory.ownerSetSha256
      }
    };
    const manifestPath = path.resolve(stagingDirectory, PROJECT_RECOVERY_MANIFEST);
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    verifyProjectRecovery(stagingDirectory, {
      runTool: dependencies.runTool,
      pgRestore: dependencies.pgRestore,
      toolEnvironment: dependencies.utilityEnvironment,
      pgRestoreListTimeoutMs: dependencies.toolTimeouts.pgRestoreList
    });
    stagingSnapshot = snapshotOwnedBackupStaging(stagingDirectory, stagingIdentity);
    assertDirectoryIdentity(stagingDirectory, stagingIdentity, "Project recovery staging directory");
    assertDirectoryIdentity(outputParent, outputParentIdentity, "Project recovery output parent");
    await dependencies.beforeBackupPublish({
      stagingDirectory,
      outputDirectory
    });
    assertOwnedBackupStagingSnapshot(stagingDirectory, stagingSnapshot);
    outputClaim = claimReplacementDataTarget(
      outputDirectory,
      {
        existed: false,
        parent: realpathSync(outputParent),
        parentIdentity: outputParentIdentity
      },
      dependencies.uuid
    );
    copyProjectRecoveryGenerationIntoClaim({
      stagingDirectory,
      outputDirectory,
      outputClaim,
      manifest
    });
    releaseReplacementDataClaim(outputDirectory, outputClaim);
    assertDirectoryIdentity(outputDirectory, outputClaim.identity, "Published project recovery generation");
    const published = verifyProjectRecovery(outputDirectory, {
      runTool: dependencies.runTool,
      pgRestore: dependencies.pgRestore,
      toolEnvironment: dependencies.utilityEnvironment,
      pgRestoreListTimeoutMs: dependencies.toolTimeouts.pgRestoreList
    });
    assertSameJson(published.manifest, manifest, "Published project recovery manifest");
    assertDirectoryIdentity(outputDirectory, outputClaim.identity, "Published project recovery generation");
    removeOwnedBackupStaging(stagingDirectory, stagingIdentity, stagingSnapshot);
    return { generationDirectory: outputDirectory, manifest };
  } catch (error) {
    const cleanupErrors = [];
    if (outputClaim && !outputClaim.released) {
      try {
        assertReplacementDataClaimMarker(outputDirectory, outputClaim);
        if (readdirSync(outputDirectory).some((name) => name !== outputClaim.markerName)) {
          throw new Error(`Partial project recovery publication was preserved for inspection: ${outputDirectory}`);
        }
        releaseReplacementDataClaim(outputDirectory, outputClaim);
        removeOwnedEmptyDirectory(outputDirectory, outputClaim.identity, "Claimed project recovery output");
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    try {
      removeOwnedBackupStaging(stagingDirectory, stagingIdentity, stagingSnapshot);
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError([error, ...cleanupErrors], `Project recovery backup failed and cleanup was incomplete: ${stagingDirectory}, ${outputDirectory}`);
    }
    throw error;
  }
}

export function verifyProjectRecovery(generationDirectory, options = {}) {
  const directory = path.resolve(requiredText(generationDirectory, "generation directory"));
  assertNoSymlinkComponents(directory, "Project recovery generation");
  const directoryEntry = assertRealDirectory(directory, "Project recovery generation");
  assertPrivateDirectory(directoryEntry, "Project recovery generation");
  const entries = readdirSync(directory).sort();
  if (JSON.stringify(entries) !== JSON.stringify([...ROOT_ENTRIES].sort())) {
    throw new Error(`Project recovery generation contains unsupported entries: ${entries.join(", ")}`);
  }
  const manifestPath = path.resolve(directory, PROJECT_RECOVERY_MANIFEST);
  const dumpPath = path.resolve(directory, PROJECT_RECOVERY_POSTGRES_DUMP);
  const runtimeDirectory = path.resolve(directory, PROJECT_RECOVERY_RUNTIME_DIRECTORY);
  const runtimeManifestPath = path.resolve(runtimeDirectory, "backup-manifest.json");
  const manifestEntry = assertRegularFile(manifestPath, "Project recovery manifest");
  if (manifestEntry.size > MAX_RECOVERY_MANIFEST_BYTES) throw new Error("Project recovery manifest is too large");
  assertPrivateFile(manifestEntry, directoryEntry, "Project recovery manifest");
  const dumpEntry = assertRegularFile(dumpPath, "PostgreSQL dump");
  assertPrivateFile(dumpEntry, directoryEntry, "PostgreSQL dump");
  const runtimeDirectoryEntry = assertRealDirectory(runtimeDirectory, "Runtime backup directory");
  assertPrivateDirectory(runtimeDirectoryEntry, "Runtime backup directory");
  if (runtimeDirectoryEntry.uid !== directoryEntry.uid) {
    throw new Error("Runtime backup directory owner does not match the recovery generation owner");
  }
  const runtimeManifestEntry = assertRegularFile(runtimeManifestPath, "Runtime backup manifest");
  if (runtimeManifestEntry.size > MAX_RECOVERY_MANIFEST_BYTES) {
    throw new Error("Runtime backup manifest is too large");
  }
  assertPrivateFile(runtimeManifestEntry, runtimeDirectoryEntry, "Runtime backup manifest");

  const manifest = validateRecoveryManifest(JSON.parse(readSmallRegularFile(manifestPath, manifestEntry, MAX_RECOVERY_MANIFEST_BYTES).toString("utf8")));
  const dumpDigest = digestRegularFile(dumpPath, dumpEntry);
  if (dumpDigest.size !== manifest.postgres.dump.size) throw new Error("PostgreSQL dump size mismatch");
  if (dumpDigest.sha256 !== manifest.postgres.dump.sha256) throw new Error("PostgreSQL dump checksum mismatch");
  if (digestRegularFile(runtimeManifestPath).sha256 !== manifest.sqlite.manifestSha256) {
    throw new Error("Runtime backup manifest checksum mismatch");
  }
  assertRuntimeRecoveryFiles(runtimeDirectory, runtimeDirectoryEntry, manifest.sqlite.files);
  if (!options.metadataOnly) {
    const runTool = options.runTool ?? defaultRunTool;
    const requestedPgRestore = options.pgRestore ?? process.env.RECOVERY_PG_RESTORE_BIN ?? "pg_restore";
    const pgRestore = options.runTool ? requestedPgRestore : reviewedRecoveryTool(requestedPgRestore, "pg_restore", options.env ?? process.env);
    runTool(pgRestore, ["--list", dumpPath], {
      env: options.toolEnvironment ?? utilityEnvironment(options.env ?? process.env),
      timeout: options.pgRestoreListTimeoutMs ?? recoveryToolTimeout(options.env ?? process.env, "RECOVERY_PG_RESTORE_LIST_TIMEOUT_MS", DEFAULT_PG_RESTORE_LIST_TIMEOUT_MS)
    });

    const runtimeResult = verifyRuntimeBackup(runtimeDirectory);
    const normalizedRuntimeFiles = runtimeResult.manifest.files.map((entry) => ({
      name: entry.name,
      size: entry.size,
      sha256: entry.sha256,
      ...(entry.sqliteUserVersion === undefined ? {} : { sqliteUserVersion: entry.sqliteUserVersion })
    }));
    assertSameJson(normalizedRuntimeFiles, manifest.sqlite.files, "Runtime backup file inventory");
    const sqliteInventory = inspectSqliteInventory(runtimeDirectory);
    assertSameJson(sqliteInventory.counts, manifest.sqlite.counts, "SQLite recovery counts");
    if (sqliteInventory.ownerSetSha256 !== manifest.sqlite.ownerSetSha256) {
      throw new Error("SQLite owner-set checksum mismatch");
    }
  }
  return {
    generationDirectory: directory,
    manifest,
    dumpPath,
    runtimeDirectory,
    runtimeRestoreSource: realpathSync(runtimeDirectory)
  };
}

function assertRuntimeRecoveryFiles(runtimeDirectory, directoryEntry, expectedFiles) {
  const expectedEntries = ["backup-manifest.json", ...expectedFiles.map((entry) => entry.name)].sort();
  const actualEntries = readdirSync(runtimeDirectory).sort();
  if (JSON.stringify(actualEntries) !== JSON.stringify(expectedEntries)) {
    throw new Error(`Runtime backup directory contains unsupported entries: ${actualEntries.join(", ")}`);
  }
  for (const expected of expectedFiles) {
    const file = path.resolve(runtimeDirectory, expected.name);
    const entry = assertRegularFile(file, `Runtime backup file ${expected.name}`);
    assertPrivateFile(entry, directoryEntry, `Runtime backup file ${expected.name}`);
    const digest = digestRegularFile(file, entry);
    if (digest.size !== expected.size || digest.sha256 !== expected.sha256) {
      throw new Error(`Runtime backup file ${expected.name} does not match the recovery manifest`);
    }
  }
}

export async function restoreProjectRecovery(options) {
  const dependencies = recoveryDependencies(options);
  const sourceVerified = verifyProjectRecovery(options?.generationDirectory, {
    runTool: dependencies.runTool,
    pgRestore: dependencies.pgRestore,
    toolEnvironment: dependencies.utilityEnvironment,
    metadataOnly: true
  });
  const sourceSqlite = inspectSqliteInventory(sourceVerified.runtimeDirectory);
  assertSameJson(sourceSqlite.counts, sourceVerified.manifest.sqlite.counts, "Source SQLite recovery counts");
  if (sourceSqlite.ownerSetSha256 !== sourceVerified.manifest.sqlite.ownerSetSha256) {
    throw new Error("Source SQLite owner-set checksum mismatch");
  }
  const targetKind = options?.targetKind === "drill" ? "drill" : "restore";
  const targetDatabase = validateTargetDatabase(options?.targetDatabase, sourceVerified.manifest.postgres.database, targetKind);
  const targetOwner = validatePostgresRole(options?.targetOwner ?? sourceVerified.manifest.postgres.owner);
  const currentDataDirectory = path.resolve(options?.currentDataDirectory ?? DEFAULT_RUNTIME_DATA_DIRECTORY);
  assertNoSymlinkComponents(currentDataDirectory, "Current runtime data directory");
  assertRealDirectory(currentDataDirectory, "Current runtime data directory");
  const targetDataDirectory = requiredPath(options?.targetDataDirectory, "replacement data directory");
  const targetDataState = validateReplacementDataTarget({
    targetDataDirectory,
    currentDataDirectory,
    generationDirectory: sourceVerified.generationDirectory
  });
  if (targetDatabase === sourceVerified.manifest.postgres.database || targetDatabase === dependencies.postgres.source.database) {
    throw new Error("Replacement PostgreSQL database must not be the current project database");
  }
  if (await dependencies.postgres.databaseExists(targetDatabase)) {
    throw new Error(`Replacement PostgreSQL database already exists: ${targetDatabase}`);
  }

  const operationId = dependencies.uuid();
  const marker = `${PROJECT_RECOVERY_FORMAT}:v${PROJECT_RECOVERY_VERSION}:${sourceVerified.manifest.generationId}:${operationId}`;
  let databaseIdentity;
  let dataTouched = false;
  let pinnedGeneration;
  let restoredDataSnapshot;
  let cleanupVerified = sourceVerified;
  let targetClaim;
  try {
    targetClaim = claimReplacementDataTarget(targetDataDirectory, targetDataState, dependencies.uuid);
    pinnedGeneration = pinProjectRecoveryGeneration(sourceVerified, targetDataState, dependencies);
    const verified = assertPinnedGenerationUnchanged(pinnedGeneration);
    databaseIdentity = await dependencies.postgres.createDatabase(targetDatabase, targetOwner, marker);
    if (!databaseIdentity?.databaseOid) {
      throw new Error(`Could not create replacement PostgreSQL database ${targetDatabase}`);
    }
    dependencies.runTool(dependencies.pgRestore, ["--exit-on-error", "--single-transaction", "--no-owner", "--no-privileges", `--role=${targetOwner}`, `--dbname=${targetDatabase}`, verified.dumpPath], {
      env: dependencies.postgres.operator.toolEnvironment(targetDatabase),
      timeout: dependencies.toolTimeouts.pgRestore
    });
    const restored = await dependencies.postgres.readVerifiedInventory(targetDatabase, marker, databaseIdentity.databaseOid);
    const restoredDatabaseIdentity = restored.identity;
    if (restoredDatabaseIdentity?.marker !== marker || restoredDatabaseIdentity.databaseOid !== databaseIdentity.databaseOid) {
      throw new Error("Replacement PostgreSQL database lost its project recovery ownership marker");
    }
    const restoredPostgres = restored.inventory;
    assertPostgresInventoryMatches(restoredPostgres, sourceVerified.manifest.postgres, targetDatabase, targetOwner);

    assertReplacementDataClaimUnchanged(targetDataDirectory, targetClaim);
    cleanupVerified = verified;
    dataTouched = true;
    dependencies.restoreRuntimeBackup({
      backupDirectory: verified.runtimeDirectory,
      dataDirectory: targetDataDirectory,
      force: false,
      inPlace: true,
      expectedTargetClaim: targetClaim,
      restoredFrom: sourceVerified.runtimeRestoreSource
    });
    releaseReplacementDataClaim(targetDataDirectory, targetClaim);
    cleanupVerified = sourceVerified;
    restoredDataSnapshot = assertOwnedRestoredDataTarget(targetDataDirectory, sourceVerified);
    const restoredSqlite = inspectSqliteInventory(targetDataDirectory);
    assertSameJson(restoredSqlite.counts, sourceVerified.manifest.sqlite.counts, "Restored SQLite counts");
    if (restoredSqlite.ownerSetSha256 !== sourceVerified.manifest.sqlite.ownerSetSha256) {
      throw new Error("Restored SQLite owner-set checksum mismatch");
    }
    await dependencies.afterRuntimeRestore({ targetDataDirectory });
    assertRestoredDataSnapshot(targetDataDirectory, restoredDataSnapshot);
    removeOwnedBackupStaging(pinnedGeneration.directory, pinnedGeneration.identity, pinnedGeneration.snapshot);
    pinnedGeneration = undefined;
    return {
      generationId: sourceVerified.manifest.generationId,
      targetDatabase,
      targetDataDirectory,
      targetOwner,
      marker,
      databaseOid: databaseIdentity.databaseOid,
      dataDirectoryIdentity: restoredDataSnapshot.identity,
      dataDirectorySnapshot: restoredDataSnapshot,
      postgres: restoredPostgres,
      sqlite: restoredSqlite
    };
  } catch (error) {
    const cleanupErrors = [];
    const postgresToolCleanupSafe = !hasUnverifiedRecoveryToolCleanup(error);
    let dataCleanupSafe = !dataTouched && !targetClaim;
    if (dataTouched) {
      let claimReleased = targetClaim?.released === true;
      try {
        if (!claimReleased) {
          releaseReplacementDataClaim(targetDataDirectory, targetClaim);
          claimReleased = true;
        }
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      if (claimReleased) {
        try {
          if (targetClaim.created && replacementClaimDirectoryIsEmpty(targetDataDirectory, targetClaim)) {
            removeOwnedEmptyDirectory(targetDataDirectory, targetClaim.identity, "Claimed replacement data target");
          } else {
            cleanupReplacementDataTarget({
              targetDataDirectory,
              targetDataState,
              verified: cleanupVerified,
              expectedIdentity: targetClaim.identity,
              expectedSnapshot: restoredDataSnapshot,
              uuid: dependencies.uuid,
              allowOriginalState: true
            });
          }
          dataCleanupSafe = true;
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
    } else if (targetClaim) {
      try {
        releaseReplacementDataClaim(targetDataDirectory, targetClaim);
        if (targetClaim.created) {
          removeOwnedEmptyDirectory(targetDataDirectory, targetClaim.identity, "Claimed replacement data target");
        } else {
          assertDirectoryIdentity(targetDataDirectory, targetClaim.identity, "Claimed replacement data target");
          if (readdirSync(targetDataDirectory).length !== 0) {
            throw new Error("Existing replacement data target changed before claim cleanup");
          }
        }
        dataCleanupSafe = true;
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (pinnedGeneration && dataCleanupSafe && postgresToolCleanupSafe) {
      try {
        removeOwnedBackupStaging(pinnedGeneration.directory, pinnedGeneration.identity, pinnedGeneration.snapshot);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (databaseIdentity && dataCleanupSafe && postgresToolCleanupSafe) {
      try {
        await dependencies.postgres.dropDatabase(targetDatabase, marker, databaseIdentity.databaseOid);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (databaseIdentity && (!dataCleanupSafe || !postgresToolCleanupSafe)) {
      cleanupErrors.push(new Error(`Replacement PostgreSQL database ${targetDatabase} and pinned recovery input were retained because ${!postgresToolCleanupSafe ? "PostgreSQL recovery-tool cleanup" : "SQLite cleanup"} was not proven safe`));
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError([error, ...cleanupErrors], `Project recovery restore failed and isolated replacement cleanup was incomplete (${targetDatabase}, ${targetDataDirectory})`);
    }
    throw error;
  }
}

export async function drillProjectRecovery(options) {
  const dependencies = recoveryDependencies(options);
  const verified = verifyProjectRecovery(options?.generationDirectory, {
    runTool: dependencies.runTool,
    pgRestore: dependencies.pgRestore,
    toolEnvironment: dependencies.utilityEnvironment,
    metadataOnly: true
  });
  const temporaryRoot = path.resolve(options?.temporaryRoot ?? tmpdir());
  assertNoSymlinkComponents(temporaryRoot, "Recovery drill temporary root");
  assertRealDirectory(temporaryRoot, "Recovery drill temporary root");
  const drillRoot = mkdtempSync(path.join(temporaryRoot, "saltanat-recovery-drill-"));
  chmodSync(drillRoot, 0o700);
  const drillRootIdentity = filesystemIdentity(lstatSync(drillRoot));
  const targetDataDirectory = path.resolve(drillRoot, "data");
  let restored;
  try {
    const targetDataState = validateReplacementDataTarget({
      targetDataDirectory,
      currentDataDirectory: path.resolve(options?.currentDataDirectory ?? DEFAULT_RUNTIME_DATA_DIRECTORY),
      generationDirectory: verified.generationDirectory
    });
    const targetDatabase = recoveryDatabaseName(verified.manifest.postgres.database, "drill", dependencies.timestamp(), dependencies.uuid());
    restored = await restoreProjectRecovery({
      ...options,
      postgres: dependencies.postgres,
      runTool: dependencies.runTool,
      pgDump: dependencies.pgDump,
      pgRestore: dependencies.pgRestore,
      generationDirectory: verified.generationDirectory,
      targetKind: "drill",
      targetDatabase,
      targetDataDirectory
    });
    await dependencies.beforeDrillCleanup({
      restored,
      drillRoot,
      targetDatabase,
      targetDataDirectory
    });
    const cleanupErrors = [];
    let dataCleanupVerified = false;
    try {
      cleanupReplacementDataTarget({
        targetDataDirectory,
        targetDataState,
        verified,
        expectedIdentity: restored.dataDirectoryIdentity,
        expectedSnapshot: restored.dataDirectorySnapshot,
        uuid: dependencies.uuid,
        allowOriginalState: false
      });
      removeOwnedEmptyDirectory(drillRoot, drillRootIdentity, "Recovery drill root");
      dataCleanupVerified = true;
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (dataCleanupVerified) {
      try {
        const dropped = await dependencies.postgres.dropDatabase(targetDatabase, restored.marker, restored.databaseOid);
        if (!dropped) throw new Error(`Recovery drill database disappeared before verified cleanup: ${targetDatabase}`);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, `Recovery drill cleanup was incomplete (${targetDatabase}, ${drillRoot})`);
    }
    return {
      generationId: restored.generationId,
      targetDatabase,
      targetDataDirectory,
      postgres: restored.postgres,
      sqlite: restored.sqlite,
      cleanup: { databaseDropped: true, dataDirectoryRemoved: true }
    };
  } catch (error) {
    if (!restored) {
      try {
        removeOwnedEmptyDirectory(drillRoot, drillRootIdentity, "Recovery drill root");
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], `Recovery drill failed and temporary root cleanup was incomplete: ${drillRoot}`);
      }
    }
    throw error;
  }
}

export function inspectSqliteInventory(dataDirectory) {
  const directory = path.resolve(dataDirectory);
  const tradingPath = path.resolve(directory, "trading.db");
  const candlesPath = path.resolve(directory, "candles.db");
  const multiLegPath = path.resolve(directory, "arbitrage-paper-multi-leg.sqlite");
  const owners = new Set();
  const tradingSchemaVersion = sqliteSchemaVersion(tradingPath);
  if (tradingSchemaVersion >= 9) {
    assertSqlitePaperPortfolioSchema(tradingPath, tradingSchemaVersion);
  }
  const counts = {
    tradingBots: sqliteTableCount(tradingPath, "bots"),
    tradingAccounts: sqliteTableCount(tradingPath, "trading_accounts"),
    tradingCredentials: sqliteTableCount(tradingPath, "trading_account_credentials"),
    orders: sqliteTableCount(tradingPath, "orders"),
    fills: sqliteTableCount(tradingPath, "fills"),
    paperEvents: sqliteTableCount(tradingPath, "paper_events"),
    ...(tradingSchemaVersion >= 9
      ? Object.fromEntries(
          SQLITE_PAPER_PORTFOLIO_TABLES.map(([key, table]) => [key, sqliteTableCount(tradingPath, table)])
        )
      : {}),
    candles: sqliteTableCount(candlesPath, "candles"),
    multiLegRuns: sqliteTableCount(multiLegPath, "runs")
  };
  if (existsSync(tradingPath)) {
    const database = openImmutableSqlite(tradingPath);
    try {
      for (const table of [
        "bots",
        "trading_accounts",
        "orders",
        "fills",
        "paper_events",
        ...SQLITE_PAPER_PORTFOLIO_TABLES.map(([, table]) => table)
      ]) {
        if (!sqliteTableExists(database, table) || !sqliteColumnExists(database, table, "ownerUserId")) continue;
        for (const row of database.prepare(`SELECT DISTINCT ownerUserId FROM "${table}" WHERE ownerUserId IS NOT NULL`).iterate()) {
          if (typeof row.ownerUserId === "string" && row.ownerUserId.length > 0) owners.add(row.ownerUserId);
        }
      }
    } finally {
      database.close();
    }
  }
  const result = {
    counts,
    ownerSetSha256: createHash("sha256")
      .update(JSON.stringify([...owners].sort()), "utf8")
      .digest("hex")
  };
  Object.defineProperty(result, "ownerUserIds", {
    value: Object.freeze([...owners].sort()),
    enumerable: false,
    writable: false,
    configurable: false
  });
  return result;
}

function assertSqliteOwnersExistInPostgresSnapshot(sqliteOwnerUserIds, postgresUserIds) {
  if (!Array.isArray(postgresUserIds)) {
    throw new Error("PostgreSQL recovery inventory is missing the snapshot user set");
  }
  const postgresUsers = new Set(postgresUserIds);
  const missing = sqliteOwnerUserIds.filter((ownerUserId) => !postgresUsers.has(ownerUserId));
  if (missing.length > 0) {
    throw new Error(`SQLite recovery owners are absent from the PostgreSQL snapshot (${missing.length} owner(s))`);
  }
}

function recoveryDependencies(options = {}) {
  const env = options.env ?? process.env;
  const runtimeProfile = env.RUNTIME_PROFILE?.trim() || RUNTIME_PROFILE;
  if (runtimeProfile !== RUNTIME_PROFILE) {
    throw new Error("Project recovery is restricted to the public-http-paper release profile");
  }
  let postgres = options.postgres;
  if (!postgres) {
    const connections = options.connections ?? resolveRecoveryConnections(env);
    postgres = createPostgresRecoveryOperations(connections);
  }
  const toolTimeouts = {
    pgDump: recoveryToolTimeout(env, "RECOVERY_PG_DUMP_TIMEOUT_MS", DEFAULT_PG_DUMP_TIMEOUT_MS),
    pgRestore: recoveryToolTimeout(env, "RECOVERY_PG_RESTORE_TIMEOUT_MS", DEFAULT_PG_RESTORE_TIMEOUT_MS),
    pgRestoreList: recoveryToolTimeout(env, "RECOVERY_PG_RESTORE_LIST_TIMEOUT_MS", DEFAULT_PG_RESTORE_LIST_TIMEOUT_MS),
    git: recoveryToolTimeout(env, "RECOVERY_GIT_TIMEOUT_MS", DEFAULT_GIT_TIMEOUT_MS)
  };
  const requestedPgDump = options.pgDump ?? env.RECOVERY_PG_DUMP_BIN ?? "pg_dump";
  const requestedPgRestore = options.pgRestore ?? env.RECOVERY_PG_RESTORE_BIN ?? "pg_restore";
  return {
    postgres,
    runTool: options.runTool ?? defaultRunTool,
    pgDump: options.runTool ? requestedPgDump : reviewedRecoveryTool(requestedPgDump, "pg_dump", env),
    pgRestore: options.runTool ? requestedPgRestore : reviewedRecoveryTool(requestedPgRestore, "pg_restore", env),
    timestamp: options.timestamp ?? (() => new Date().toISOString()),
    uuid: options.uuid ?? randomUUID,
    toolTimeouts,
    utilityEnvironment: utilityEnvironment(env),
    afterRuntimeRestore: options.afterRuntimeRestore ?? (async () => undefined),
    beforeBackupPublish: options.beforeBackupPublish ?? (async () => undefined),
    beforeDrillCleanup: options.beforeDrillCleanup ?? (async () => undefined),
    restoreRuntimeBackup: options.restoreRuntimeBackup ?? restoreRuntimeBackup,
    gitCommit: options.gitCommit ?? (() => detectGitCommit(options.runTool ?? defaultRunTool, utilityEnvironment(env), toolTimeouts.git))
  };
}

function pinProjectRecoveryGeneration(sourceVerified, targetDataState, dependencies) {
  assertDirectoryIdentity(targetDataState.parent, targetDataState.parentIdentity, "Replacement data parent");
  const parentDirectory = targetDataState.parent;
  const directory = mkdtempSync(path.join(parentDirectory, ".saltanat-recovery-input-"));
  chmodSync(directory, 0o700);
  const identity = filesystemIdentity(lstatSync(directory));
  let snapshot;
  try {
    copyVerifiedRegularFile(path.resolve(sourceVerified.generationDirectory, PROJECT_RECOVERY_POSTGRES_DUMP), path.resolve(directory, PROJECT_RECOVERY_POSTGRES_DUMP), {
      label: "Pinned PostgreSQL dump",
      size: sourceVerified.manifest.postgres.dump.size,
      sha256: sourceVerified.manifest.postgres.dump.sha256
    });
    const runtimeDirectory = path.resolve(directory, PROJECT_RECOVERY_RUNTIME_DIRECTORY);
    mkdirSync(runtimeDirectory, { mode: 0o700 });
    const sourceRuntimeManifest = path.resolve(sourceVerified.runtimeDirectory, "backup-manifest.json");
    copyVerifiedRegularFile(sourceRuntimeManifest, path.resolve(runtimeDirectory, "backup-manifest.json"), {
      label: "Pinned runtime backup manifest",
      maximumSize: MAX_RECOVERY_MANIFEST_BYTES,
      sha256: sourceVerified.manifest.sqlite.manifestSha256
    });
    for (const expected of sourceVerified.manifest.sqlite.files) {
      copyVerifiedRegularFile(path.resolve(sourceVerified.runtimeDirectory, expected.name), path.resolve(runtimeDirectory, expected.name), {
        label: `Pinned runtime file ${expected.name}`,
        size: expected.size,
        sha256: expected.sha256
      });
    }
    copyVerifiedRegularFile(path.resolve(sourceVerified.generationDirectory, PROJECT_RECOVERY_MANIFEST), path.resolve(directory, PROJECT_RECOVERY_MANIFEST), {
      label: "Pinned project recovery manifest",
      maximumSize: MAX_RECOVERY_MANIFEST_BYTES
    });
    const verified = verifyProjectRecovery(directory, {
      runTool: dependencies.runTool,
      pgRestore: dependencies.pgRestore,
      toolEnvironment: dependencies.utilityEnvironment,
      pgRestoreListTimeoutMs: dependencies.toolTimeouts.pgRestoreList
    });
    assertSameJson(verified.manifest, sourceVerified.manifest, "Pinned recovery manifest");
    snapshot = snapshotOwnedBackupStaging(directory, identity);
    return { directory, identity, snapshot, verified };
  } catch (error) {
    try {
      removeOwnedBackupStaging(directory, identity, snapshot);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], `Could not pin or clean the verified recovery generation: ${directory}`);
    }
    throw error;
  }
}

function assertPinnedGenerationUnchanged(pinnedGeneration) {
  assertDirectoryIdentity(pinnedGeneration.directory, pinnedGeneration.identity, "Pinned project recovery generation");
  assertOwnedBackupStagingSnapshot(pinnedGeneration.directory, pinnedGeneration.snapshot);
  const verified = verifyProjectRecovery(pinnedGeneration.directory, { metadataOnly: true });
  assertSameJson(verified.manifest, pinnedGeneration.verified.manifest, "Pinned recovery manifest");
  return verified;
}

function copyProjectRecoveryGenerationIntoClaim({ stagingDirectory, outputDirectory, outputClaim, manifest }) {
  assertReplacementDataClaimMarker(outputDirectory, outputClaim);
  copyVerifiedRegularFile(path.resolve(stagingDirectory, PROJECT_RECOVERY_POSTGRES_DUMP), path.resolve(outputDirectory, PROJECT_RECOVERY_POSTGRES_DUMP), {
    label: "Published PostgreSQL dump",
    size: manifest.postgres.dump.size,
    sha256: manifest.postgres.dump.sha256
  });

  assertReplacementDataClaimMarker(outputDirectory, outputClaim);
  const runtimeSource = path.resolve(stagingDirectory, PROJECT_RECOVERY_RUNTIME_DIRECTORY);
  const runtimeDestination = path.resolve(outputDirectory, PROJECT_RECOVERY_RUNTIME_DIRECTORY);
  mkdirSync(runtimeDestination, { mode: 0o700 });
  const runtimeIdentity = filesystemIdentity(assertRealDirectory(runtimeDestination, "Published runtime backup directory"));
  if (runtimeIdentity.uid !== outputClaim.identity.uid || (lstatSync(runtimeDestination).mode & 0o077) !== 0) {
    throw new Error("Published runtime backup directory ownership or permissions are invalid");
  }
  copyVerifiedRegularFile(path.resolve(runtimeSource, "backup-manifest.json"), path.resolve(runtimeDestination, "backup-manifest.json"), {
    label: "Published runtime backup manifest",
    maximumSize: MAX_RECOVERY_MANIFEST_BYTES,
    sha256: manifest.sqlite.manifestSha256
  });
  for (const expected of manifest.sqlite.files) {
    assertReplacementDataClaimMarker(outputDirectory, outputClaim);
    assertDirectoryIdentity(runtimeDestination, runtimeIdentity, "Published runtime backup directory");
    copyVerifiedRegularFile(path.resolve(runtimeSource, expected.name), path.resolve(runtimeDestination, expected.name), {
      label: `Published runtime backup file ${expected.name}`,
      size: expected.size,
      sha256: expected.sha256
    });
  }

  assertReplacementDataClaimMarker(outputDirectory, outputClaim);
  copyVerifiedRegularFile(path.resolve(stagingDirectory, PROJECT_RECOVERY_MANIFEST), path.resolve(outputDirectory, PROJECT_RECOVERY_MANIFEST), {
    label: "Published project recovery manifest",
    maximumSize: MAX_RECOVERY_MANIFEST_BYTES
  });
  assertDirectoryIdentity(runtimeDestination, runtimeIdentity, "Published runtime backup directory");
  const expectedRuntimeEntries = ["backup-manifest.json", ...manifest.sqlite.files.map((entry) => entry.name)].sort();
  if (JSON.stringify(readdirSync(runtimeDestination).sort()) !== JSON.stringify(expectedRuntimeEntries)) {
    throw new Error("Published runtime backup directory contents changed");
  }
  const expectedRootEntries = [outputClaim.markerName, ...ROOT_ENTRIES].sort();
  if (JSON.stringify(readdirSync(outputDirectory).sort()) !== JSON.stringify(expectedRootEntries)) {
    throw new Error("Published project recovery directory contents changed");
  }
  assertReplacementDataClaimMarker(outputDirectory, outputClaim);
}

function copyVerifiedRegularFile(source, destination, expected) {
  const pathEntry = assertRegularFile(source, expected.label);
  if (expected.size !== undefined && pathEntry.size !== expected.size) {
    throw new Error(`${expected.label} size changed before it was pinned`);
  }
  if (expected.maximumSize !== undefined && pathEntry.size > expected.maximumSize) {
    throw new Error(`${expected.label} is too large`);
  }
  let sourceDescriptor;
  let destinationDescriptor;
  const buffer = Buffer.alloc(1024 * 1024);
  const hash = createHash("sha256");
  try {
    sourceDescriptor = openSync(source, constants.O_RDONLY | noFollowFlag());
    const before = fstatSync(sourceDescriptor);
    if (!before.isFile() || before.dev !== pathEntry.dev || before.ino !== pathEntry.ino || before.size !== pathEntry.size) {
      throw new Error(`${expected.label} changed while it was opened`);
    }
    destinationDescriptor = openSync(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(), 0o600);
    let position = 0;
    while (position < before.size) {
      const bytesRead = readSync(sourceDescriptor, buffer, 0, Math.min(buffer.length, before.size - position), position);
      if (bytesRead <= 0) throw new Error(`${expected.label} changed while it was copied`);
      hash.update(buffer.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) {
        const bytesWritten = writeSync(destinationDescriptor, buffer, written, bytesRead - written, position + written);
        if (bytesWritten <= 0) throw new Error(`${expected.label} could not be pinned`);
        written += bytesWritten;
      }
      position += bytesRead;
    }
    const after = fstatSync(sourceDescriptor);
    const pathAfter = lstatSync(source);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || pathAfter.isSymbolicLink() || pathAfter.dev !== before.dev || pathAfter.ino !== before.ino || pathAfter.size !== before.size) {
      throw new Error(`${expected.label} changed while it was copied`);
    }
    const sha256 = hash.digest("hex");
    if (expected.sha256 !== undefined && sha256 !== expected.sha256) {
      throw new Error(`${expected.label} checksum changed before it was pinned`);
    }
    fchmodSync(destinationDescriptor, 0o600);
    fsyncSync(destinationDescriptor);
  } finally {
    buffer.fill(0);
    if (destinationDescriptor !== undefined) closeSync(destinationDescriptor);
    if (sourceDescriptor !== undefined) closeSync(sourceDescriptor);
  }
}

function validateRecoveryManifest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Project recovery manifest must be an object");
  if (value.format !== PROJECT_RECOVERY_FORMAT || value.version !== PROJECT_RECOVERY_VERSION) {
    throw new Error(`Unsupported project recovery format: ${value.format ?? "unknown"} v${value.version ?? "unknown"}`);
  }
  if (typeof value.generationId !== "string" || !isUuid(value.generationId)) throw new Error("Project recovery generationId is invalid");
  if (value.runtimeProfile !== RUNTIME_PROFILE) throw new Error("Project recovery runtime profile must be public-http-paper");
  const capture = validateCapture(value.capture);
  if (value.createdAt !== capture.completedAt) throw new Error("Project recovery createdAt does not match the capture window");
  const postgres = validatePostgresInventory(value.postgres);
  const dump = value.postgres?.dump;
  if (!dump || dump.file !== PROJECT_RECOVERY_POSTGRES_DUMP) throw new Error("Project recovery PostgreSQL dump path is invalid");
  postgres.dump = {
    file: PROJECT_RECOVERY_POSTGRES_DUMP,
    size: safeSize(dump.size, "PostgreSQL dump"),
    sha256: sha256Value(dump.sha256, "PostgreSQL dump")
  };
  const sqlite = value.sqlite;
  if (!sqlite || sqlite.runtimeDirectory !== PROJECT_RECOVERY_RUNTIME_DIRECTORY || sqlite.manifestFile !== `${PROJECT_RECOVERY_RUNTIME_DIRECTORY}/backup-manifest.json`) {
    throw new Error("Project recovery runtime backup paths are invalid");
  }
  const files = validateRuntimeFiles(sqlite.files);
  const counts = validateSqliteCounts(sqlite.counts, files);
  const ownerSetSha256 = sha256Value(sqlite.ownerSetSha256, "SQLite owner set");
  const manifestSha256 = sha256Value(sqlite.manifestSha256, "Runtime backup manifest");
  const releaseCommit = validateReleaseCommit(value.releaseCommit);
  return {
    format: PROJECT_RECOVERY_FORMAT,
    version: PROJECT_RECOVERY_VERSION,
    generationId: value.generationId,
    createdAt: value.createdAt,
    runtimeProfile: RUNTIME_PROFILE,
    capture,
    releaseCommit,
    postgres,
    sqlite: {
      runtimeDirectory: PROJECT_RECOVERY_RUNTIME_DIRECTORY,
      manifestFile: `${PROJECT_RECOVERY_RUNTIME_DIRECTORY}/backup-manifest.json`,
      manifestSha256,
      files,
      counts,
      ownerSetSha256
    }
  };
}

function validatePostgresInventory(value) {
  if (!value || typeof value !== "object") throw new Error("PostgreSQL recovery inventory is missing");
  const database = boundedText(value.database, "PostgreSQL database", 255);
  const owner = boundedText(value.owner, "PostgreSQL owner", 255);
  if (!Array.isArray(value.migrations) || value.migrations.length === 0) {
    throw new Error("PostgreSQL recovery inventory has no schema migrations");
  }
  const migrations = value.migrations.map((migration, index) => {
    if (!migration || migration.version !== index + 1) throw new Error("PostgreSQL migrations are not contiguous");
    return {
      version: migration.version,
      name: boundedText(migration.name, `PostgreSQL migration ${migration.version} name`, 160),
      checksum: sha256Value(migration.checksum, `PostgreSQL migration ${migration.version}`)
    };
  });
  const counts = value.counts;
  if (!counts || typeof counts !== "object") throw new Error("PostgreSQL recovery counts are missing");
  return {
    database,
    owner,
    migrations,
    counts: {
      users: safeCount(counts.users, "PostgreSQL users"),
      workspaces: safeCount(counts.workspaces, "PostgreSQL workspaces"),
      workspaceRevisions: safeCount(counts.workspaceRevisions, "PostgreSQL workspace revisions"),
      computeJobs: safeCount(counts.computeJobs, "PostgreSQL compute jobs"),
      userOnboarding: safeCount(counts.userOnboarding, "PostgreSQL onboarding rows"),
      ...(migrations.at(-1)?.version >= 12 || counts.executorCommands !== undefined
        ? { executorCommands: safeCount(counts.executorCommands, "PostgreSQL executor commands") }
        : {})
    }
  };
}

function validateCapture(value) {
  if (!value || typeof value !== "object") throw new Error("Project recovery capture window is missing");
  const postgres = validateTimeRange(value.postgres, "PostgreSQL");
  const sqlite = validateTimeRange(value.sqlite, "SQLite");
  const calculated = Math.max(postgres.completed, sqlite.completed) - Math.min(postgres.started, sqlite.started);
  if (!Number.isSafeInteger(value.spanMs) || value.spanMs !== calculated) {
    throw new Error("Project recovery capture span is invalid");
  }
  if (calculated > PROJECT_RECOVERY_MAX_CAPTURE_SPAN_MS) {
    throw new Error(`Project recovery capture span ${calculated}ms exceeds ${PROJECT_RECOVERY_MAX_CAPTURE_SPAN_MS}ms`);
  }
  return {
    postgres: { startedAt: value.postgres.startedAt, completedAt: value.postgres.completedAt },
    sqlite: { startedAt: value.sqlite.startedAt, completedAt: value.sqlite.completedAt },
    spanMs: calculated,
    completedAt: new Date(Math.max(postgres.completed, sqlite.completed)).toISOString()
  };
}

function validateTimeRange(value, label) {
  if (!value || typeof value !== "object") throw new Error(`${label} capture window is missing`);
  const started = parseTimestamp(value.startedAt, `${label} capture start`);
  const completed = parseTimestamp(value.completedAt, `${label} capture completion`);
  if (completed < started) throw new Error(`${label} capture completion precedes its start`);
  return { started, completed };
}

function captureWindow(value) {
  const postgresStarted = parseTimestamp(value.postgresStartedAt, "PostgreSQL capture start");
  const postgresCompleted = parseTimestamp(value.postgresCompletedAt, "PostgreSQL capture completion");
  const sqliteStarted = parseTimestamp(value.sqliteStartedAt, "SQLite capture start");
  const sqliteCompleted = parseTimestamp(value.sqliteCompletedAt, "SQLite capture completion");
  if (postgresCompleted < postgresStarted || sqliteCompleted < sqliteStarted) {
    throw new Error("Project recovery capture timestamps are not monotonic");
  }
  const completed = Math.max(postgresCompleted, sqliteCompleted);
  return {
    postgres: { startedAt: value.postgresStartedAt, completedAt: value.postgresCompletedAt },
    sqlite: { startedAt: value.sqliteStartedAt, completedAt: value.sqliteCompletedAt },
    spanMs: completed - Math.min(postgresStarted, sqliteStarted),
    completedAt: new Date(completed).toISOString()
  };
}

function validateReplacementDataTarget({ targetDataDirectory, currentDataDirectory, generationDirectory }) {
  const target = path.resolve(targetDataDirectory);
  const current = path.resolve(currentDataDirectory);
  const parent = path.dirname(target);
  assertNoSymlinkComponents(parent, "Replacement data parent");
  const parentEntry = assertRealDirectory(parent, "Replacement data parent");
  const currentUid = process.getuid?.();
  if (currentUid !== undefined && parentEntry.uid !== currentUid) {
    throw new Error("Replacement data parent must be owned by the recovery operator");
  }
  if ((parentEntry.mode & 0o022) !== 0) {
    throw new Error("Replacement data parent must not be group or world writable");
  }
  const canonicalParent = realpathSync(parent);
  const canonicalTarget = path.resolve(canonicalParent, path.basename(target));
  const canonicalCurrent = realpathSync(current);
  const canonicalGeneration = realpathSync(generationDirectory);
  if (sameFilesystemPath(canonicalTarget, canonicalCurrent) || isInside(canonicalCurrent, canonicalTarget) || isInside(canonicalTarget, canonicalCurrent)) {
    throw new Error("Replacement data directory must be separate from the current runtime data directory");
  }
  if (isInside(canonicalGeneration, canonicalTarget) || isInside(canonicalTarget, canonicalGeneration)) {
    throw new Error("Replacement data directory must be separate from the recovery generation");
  }
  const base = {
    existed: false,
    parent: canonicalParent,
    parentIdentity: filesystemIdentity(parentEntry)
  };
  if (!existsSync(target)) return base;
  const entry = lstatSync(target);
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new Error("Replacement data target must be a real directory and must not be a symbolic link");
  }
  if (realpathSync(target) !== canonicalTarget) {
    throw new Error("Replacement data target resolved outside its reviewed parent");
  }
  if (readdirSync(target).length > 0) throw new Error("Replacement data directory must be absent or empty");
  if (currentUid !== undefined && entry.uid !== currentUid) {
    throw new Error("Replacement data directory must be owned by the recovery operator");
  }
  if ((entry.mode & 0o077) !== 0) {
    throw new Error("Replacement data directory must not be group or world accessible");
  }
  return {
    ...base,
    existed: true,
    mode: entry.mode & 0o777,
    targetIdentity: filesystemIdentity(entry)
  };
}

function claimReplacementDataTarget(targetDataDirectory, state, uuid) {
  assertDirectoryIdentity(state.parent, state.parentIdentity, "Replacement data parent");
  let created = false;
  let identity;
  if (state.existed) {
    const entry = assertRealDirectory(targetDataDirectory, "Replacement data target");
    if (!sameIdentity(filesystemIdentity(entry), state.targetIdentity)) {
      throw new Error("Replacement data target changed before it could be claimed");
    }
    if (readdirSync(targetDataDirectory).length > 0) {
      throw new Error("Replacement data target became non-empty before it could be claimed");
    }
    identity = state.targetIdentity;
  } else {
    try {
      mkdirSync(targetDataDirectory, { mode: 0o700 });
    } catch (error) {
      if (error?.code === "EEXIST") {
        throw new Error("Replacement data target appeared before its exclusive claim");
      }
      throw error;
    }
    created = true;
    identity = filesystemIdentity(assertRealDirectory(targetDataDirectory, "Claimed replacement data target"));
    try {
      chmodSync(targetDataDirectory, 0o700);
      const entry = assertRealDirectory(targetDataDirectory, "Claimed replacement data target");
      identity = filesystemIdentity(entry);
      const currentUid = process.getuid?.();
      if (currentUid !== undefined && entry.uid !== currentUid) {
        throw new Error("Claimed replacement data target owner mismatch");
      }
      assertPrivateDirectory(entry, "Claimed replacement data target");
      assertDirectoryIdentity(state.parent, state.parentIdentity, "Replacement data parent");
    } catch (error) {
      try {
        removeOwnedEmptyDirectory(targetDataDirectory, identity, "Claimed replacement data target");
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], `Could not validate or clean replacement data target: ${targetDataDirectory}`);
      }
      throw error;
    }
  }

  const markerPath = path.resolve(targetDataDirectory, REPLACEMENT_CLAIM_FILE);
  const token = uuid();
  const material = Buffer.from(`${token}\n`, "utf8");
  let descriptor;
  let markerIdentity;
  try {
    descriptor = openSync(markerPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(), 0o600);
    const opened = fstatSync(descriptor);
    if (!opened.isFile()) {
      throw new Error("Replacement data claim marker is not a regular file");
    }
    markerIdentity = filesystemIdentity(opened);
    let written = 0;
    while (written < material.length) {
      const bytesWritten = writeSync(descriptor, material, written, material.length - written, written);
      if (bytesWritten <= 0) {
        throw new Error("Replacement data claim marker write failed");
      }
      written += bytesWritten;
    }
    fchmodSync(descriptor, 0o600);
    fsyncSync(descriptor);
    markerIdentity = filesystemIdentity(fstatSync(descriptor));
    closeSync(descriptor);
    descriptor = undefined;
    const claim = {
      created,
      identity,
      parent: state.parent,
      parentIdentity: state.parentIdentity,
      markerName: REPLACEMENT_CLAIM_FILE,
      markerIdentity,
      token,
      released: false
    };
    assertReplacementDataClaimUnchanged(targetDataDirectory, claim);
    return {
      ...claim
    };
  } catch (error) {
    if (descriptor !== undefined) {
      closeSync(descriptor);
      descriptor = undefined;
    }
    if (markerIdentity && existsSync(markerPath)) {
      const markerEntry = lstatSync(markerPath);
      if (markerEntry.isFile() && !markerEntry.isSymbolicLink() && sameIdentity(filesystemIdentity(markerEntry), markerIdentity)) {
        unlinkSync(markerPath);
      }
    }
    if (created && identity) {
      try {
        removeOwnedEmptyDirectory(targetDataDirectory, identity, "Claimed replacement data target");
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], `Could not claim or clean replacement data target: ${targetDataDirectory}`);
      }
    }
    throw error;
  } finally {
    material.fill(0);
  }
}

function assertReplacementDataClaimUnchanged(targetDataDirectory, claim) {
  const entry = assertReplacementDataClaimMarker(targetDataDirectory, claim);
  const entries = readdirSync(targetDataDirectory);
  if (entries.length !== 1 || entries[0] !== claim.markerName) {
    throw new Error("Claimed replacement data target contents changed");
  }
  return entry;
}

function assertReplacementDataClaimMarker(targetDataDirectory, claim) {
  assertDirectoryIdentity(claim.parent, claim.parentIdentity, "Replacement data parent");
  const entry = assertDirectoryIdentity(targetDataDirectory, claim.identity, "Claimed replacement data target");
  assertPrivateDirectory(entry, "Claimed replacement data target");
  const markerPath = path.resolve(targetDataDirectory, claim.markerName);
  const markerEntry = assertRegularFile(markerPath, "Replacement data claim marker");
  if (!sameIdentity(filesystemIdentity(markerEntry), claim.markerIdentity) || readSmallRegularFile(markerPath, markerEntry, 256).toString("utf8") !== `${claim.token}\n`) {
    throw new Error("Replacement data claim marker changed");
  }
  return entry;
}

function releaseReplacementDataClaim(targetDataDirectory, claim) {
  if (claim.released) return;
  assertReplacementDataClaimMarker(targetDataDirectory, claim);
  unlinkSync(path.resolve(targetDataDirectory, claim.markerName));
  claim.released = true;
}

function replacementClaimDirectoryIsEmpty(targetDataDirectory, claim) {
  if (!claim.released) return false;
  const entry = assertDirectoryIdentity(targetDataDirectory, claim.identity, "Claimed replacement data target");
  assertPrivateDirectory(entry, "Claimed replacement data target");
  return readdirSync(targetDataDirectory).length === 0;
}

function cleanupReplacementDataTarget({ targetDataDirectory, targetDataState, verified, expectedIdentity, expectedSnapshot, uuid, allowOriginalState }) {
  assertDirectoryIdentity(targetDataState.parent, targetDataState.parentIdentity, "Replacement data parent");
  if (allowOriginalState && replacementTargetMatchesOriginal(targetDataDirectory, targetDataState)) {
    return false;
  }
  if (!expectedSnapshot) {
    throw new Error("Restored replacement data cleanup provenance is unavailable");
  }
  const restoredSnapshot = assertOwnedRestoredDataTarget(targetDataDirectory, verified, expectedIdentity, expectedSnapshot);
  const quarantine = `${targetDataDirectory}.recovery-cleanup-${uuid()}`;
  if (existsSync(quarantine)) throw new Error(`Recovery cleanup quarantine already exists: ${quarantine}`);
  renameSync(targetDataDirectory, quarantine);
  const quarantinedEntry = lstatSync(quarantine);
  if (!sameIdentity(filesystemIdentity(quarantinedEntry), restoredSnapshot.identity)) {
    if (!existsSync(targetDataDirectory)) renameSync(quarantine, targetDataDirectory);
    throw new Error("Replacement data target changed while it was quarantined for cleanup");
  }
  try {
    assertOwnedRestoredDataTarget(quarantine, verified, restoredSnapshot.identity, restoredSnapshot);
    removeVerifiedRestoredDataDirectory(quarantine, verified, restoredSnapshot);
  } catch (error) {
    if (!existsSync(targetDataDirectory) && existsSync(quarantine)) {
      renameSync(quarantine, targetDataDirectory);
    }
    throw error;
  }
  if (targetDataState.existed) {
    mkdirSync(targetDataDirectory, { mode: targetDataState.mode ?? 0o700 });
    chmodSync(targetDataDirectory, targetDataState.mode ?? 0o700);
  }
  assertDirectoryIdentity(targetDataState.parent, targetDataState.parentIdentity, "Replacement data parent");
  return true;
}

function replacementTargetMatchesOriginal(targetDataDirectory, state) {
  if (!state.existed) return !existsSync(targetDataDirectory);
  if (!existsSync(targetDataDirectory)) return false;
  const entry = lstatSync(targetDataDirectory);
  return entry.isDirectory() && !entry.isSymbolicLink() && sameIdentity(filesystemIdentity(entry), state.targetIdentity) && readdirSync(targetDataDirectory).length === 0;
}

function assertOwnedRestoredDataTarget(targetDataDirectory, verified, expectedIdentity, expectedSnapshot) {
  const directoryEntry = assertRealDirectory(targetDataDirectory, "Restored replacement data directory");
  const identity = filesystemIdentity(directoryEntry);
  if (expectedIdentity && !sameIdentity(identity, expectedIdentity)) {
    throw new Error("Restored replacement data directory identity changed");
  }
  const currentUid = process.getuid?.();
  if (currentUid !== undefined && directoryEntry.uid !== currentUid) {
    throw new Error("Restored replacement data directory is no longer owned by the recovery operator");
  }
  assertPrivateDirectory(directoryEntry, "Restored replacement data directory");
  const expectedEntries = [...verified.manifest.sqlite.files.map((entry) => entry.name), ".restore-manifest.json"].sort();
  const actualEntries = readdirSync(targetDataDirectory).sort();
  if (JSON.stringify(actualEntries) !== JSON.stringify(expectedEntries)) {
    throw new Error("Restored replacement data directory contains unexpected files");
  }
  const files = {};
  for (const expected of verified.manifest.sqlite.files) {
    const file = path.resolve(targetDataDirectory, expected.name);
    const entry = assertRegularFile(file, `Restored runtime file ${expected.name}`);
    assertPrivateFile(entry, directoryEntry, `Restored runtime file ${expected.name}`);
    const digest = digestRegularFile(file, entry);
    if (digest.size !== expected.size || digest.sha256 !== expected.sha256) {
      throw new Error(`Restored runtime file ${expected.name} no longer matches the recovery generation`);
    }
    files[expected.name] = stableFileIdentity(entry);
  }
  const restoreManifestPath = path.resolve(targetDataDirectory, ".restore-manifest.json");
  const restoreManifestEntry = assertRegularFile(restoreManifestPath, "Runtime restore manifest");
  assertPrivateFile(restoreManifestEntry, directoryEntry, "Runtime restore manifest");
  const restoreManifest = JSON.parse(readSmallRegularFile(restoreManifestPath, restoreManifestEntry, MAX_RECOVERY_MANIFEST_BYTES).toString("utf8"));
  if (restoreManifest.format !== "saltanatbotv2-runtime-backup" || restoreManifest.version !== 1 || path.resolve(restoreManifest.restoredFrom ?? "") !== verified.runtimeRestoreSource) {
    throw new Error("Runtime restore manifest does not identify this recovery generation");
  }
  const restoredFiles = Array.isArray(restoreManifest.files)
    ? restoreManifest.files.map((entry) => ({
        name: entry.name,
        size: entry.size,
        sha256: entry.sha256,
        ...(entry.sqliteUserVersion === undefined ? {} : { sqliteUserVersion: entry.sqliteUserVersion })
      }))
    : [];
  assertSameJson(restoredFiles, verified.manifest.sqlite.files, "Runtime restore manifest file inventory");
  files[".restore-manifest.json"] = stableFileIdentity(restoreManifestEntry);
  const snapshot = { identity, files };
  if (expectedSnapshot) {
    assertRestoredDataSnapshot(targetDataDirectory, expectedSnapshot);
  }
  return snapshot;
}

function assertRestoredDataSnapshot(directory, expectedSnapshot) {
  const directoryEntry = assertDirectoryIdentity(directory, expectedSnapshot.identity, "Restored replacement data directory");
  const expectedNames = Object.keys(expectedSnapshot.files).sort();
  const actualNames = readdirSync(directory).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
    throw new Error("Restored replacement data directory changed after verification");
  }
  for (const name of expectedNames) {
    const entry = assertRegularFile(path.resolve(directory, name), `Restored runtime file ${name}`);
    assertPrivateFile(entry, directoryEntry, `Restored runtime file ${name}`);
    assertStableFileIdentity(entry, expectedSnapshot.files[name], `Restored runtime file ${name} identity changed`);
  }
  return directoryEntry;
}

function removeVerifiedRestoredDataDirectory(directory, verified, expectedSnapshot) {
  const remainingSnapshot = {
    identity: expectedSnapshot.identity,
    files: { ...expectedSnapshot.files }
  };
  const expectedEntries = [...verified.manifest.sqlite.files.map((entry) => entry.name), ".restore-manifest.json"].sort();
  for (const name of expectedEntries) {
    const directoryEntry = assertRestoredDataSnapshot(directory, remainingSnapshot);
    const file = path.resolve(directory, name);
    const entry = assertRegularFile(file, `Restored runtime file ${name}`);
    assertPrivateFile(entry, directoryEntry, `Restored runtime file ${name}`);
    assertStableFileIdentity(entry, remainingSnapshot.files[name], `Restored runtime file ${name} identity changed before cleanup`);
    unlinkSync(file);
    delete remainingSnapshot.files[name];
  }
  assertDirectoryIdentity(directory, remainingSnapshot.identity, "Restored replacement data directory");
  rmdirSync(directory);
}

function snapshotOwnedBackupStaging(stagingDirectory, expectedIdentity) {
  assertDirectoryIdentity(stagingDirectory, expectedIdentity, "Project recovery staging directory");
  assertExpectedBackupStagingEntries(stagingDirectory);
  const directories = {};
  const files = {};
  for (const name of readdirSync(stagingDirectory)) {
    const entryPath = path.resolve(stagingDirectory, name);
    if (name === PROJECT_RECOVERY_RUNTIME_DIRECTORY || /^runtime\.partial-[0-9a-f-]{8,80}$/i.test(name)) {
      const entry = assertRealDirectory(entryPath, "Runtime backup staging directory");
      if (entry.uid !== expectedIdentity.uid || (entry.mode & 0o077) !== 0) {
        throw new Error("Runtime backup staging directory ownership or permissions changed");
      }
      directories[name] = filesystemIdentity(entry);
      for (const child of readdirSync(entryPath)) {
        if (!RUNTIME_STAGING_ENTRIES.has(child)) {
          throw new Error(`Refusing to snapshot runtime recovery staging with unexpected entry: ${child}`);
        }
        const childEntry = assertRegularFile(path.resolve(entryPath, child), `Runtime backup staging file ${child}`);
        if (childEntry.uid !== expectedIdentity.uid || childEntry.nlink !== 1) {
          throw new Error(`Runtime backup staging file ownership or link count changed: ${child}`);
        }
        files[path.join(name, child)] = stableFileIdentity(childEntry);
      }
      continue;
    }
    const entry = assertRegularFile(entryPath, `Project recovery staging file ${name}`);
    if (entry.uid !== expectedIdentity.uid || entry.nlink !== 1) {
      throw new Error(`Project recovery staging file ownership or link count changed: ${name}`);
    }
    files[name] = stableFileIdentity(entry);
  }
  return {
    rootIdentity: expectedIdentity,
    directories,
    files
  };
}

function assertOwnedBackupStagingSnapshot(directory, snapshot) {
  assertDirectoryIdentity(directory, snapshot.rootIdentity, "Project recovery staging directory");
  const expectedRootEntries = [...Object.keys(snapshot.directories), ...Object.keys(snapshot.files).filter((name) => !name.includes(path.sep))].sort();
  const actualRootEntries = readdirSync(directory).sort();
  if (JSON.stringify(actualRootEntries) !== JSON.stringify(expectedRootEntries)) {
    throw new Error("Project recovery staging contents changed");
  }
  for (const [name, identity] of Object.entries(snapshot.directories)) {
    assertDirectoryIdentity(path.resolve(directory, name), identity, `Runtime backup staging directory ${name}`);
    const expectedChildren = Object.keys(snapshot.files)
      .filter((file) => path.dirname(file) === name)
      .map((file) => path.basename(file))
      .sort();
    const actualChildren = readdirSync(path.resolve(directory, name)).sort();
    if (JSON.stringify(actualChildren) !== JSON.stringify(expectedChildren)) {
      throw new Error(`Runtime backup staging contents changed: ${name}`);
    }
  }
  for (const [name, identity] of Object.entries(snapshot.files)) {
    const entry = assertRegularFile(path.resolve(directory, name), `Project recovery staging file ${name}`);
    assertStableFileIdentity(entry, identity, `Project recovery staging file identity changed: ${name}`);
  }
}

function removeOwnedBackupStaging(stagingDirectory, expectedIdentity, expectedSnapshot) {
  if (!existsSync(stagingDirectory)) return;
  assertDirectoryIdentity(stagingDirectory, expectedIdentity, "Project recovery staging directory");
  if (!expectedSnapshot) {
    if (readdirSync(stagingDirectory).length > 0) {
      throw new Error("Project recovery staging cleanup provenance is unavailable");
    }
    removeOwnedEmptyDirectory(stagingDirectory, expectedIdentity, "Project recovery staging directory");
    return;
  }
  assertOwnedBackupStagingSnapshot(stagingDirectory, expectedSnapshot);
  assertExpectedBackupStagingEntries(stagingDirectory);
  const quarantine = `${stagingDirectory}.cleanup-${randomUUID()}`;
  if (existsSync(quarantine)) throw new Error(`Recovery staging cleanup quarantine already exists: ${quarantine}`);
  renameSync(stagingDirectory, quarantine);
  if (!sameIdentity(filesystemIdentity(lstatSync(quarantine)), expectedIdentity)) {
    if (!existsSync(stagingDirectory)) renameSync(quarantine, stagingDirectory);
    throw new Error("Project recovery staging identity changed during cleanup");
  }
  try {
    assertOwnedBackupStagingSnapshot(quarantine, expectedSnapshot);
    removeExpectedBackupStagingTree(quarantine, expectedSnapshot);
  } catch (error) {
    if (!existsSync(stagingDirectory) && existsSync(quarantine)) {
      renameSync(quarantine, stagingDirectory);
    }
    throw error;
  }
}

function assertExpectedBackupStagingEntries(directory) {
  for (const entry of readdirSync(directory)) {
    if (!ROOT_ENTRIES.includes(entry) && !/^runtime\.partial-[0-9a-f-]{8,80}$/i.test(entry)) {
      throw new Error(`Refusing to remove recovery staging with unexpected entry: ${entry}`);
    }
  }
}

function removeExpectedBackupStagingTree(directory, expectedSnapshot) {
  const remaining = {
    rootIdentity: expectedSnapshot.rootIdentity,
    directories: { ...expectedSnapshot.directories },
    files: { ...expectedSnapshot.files }
  };
  for (const name of Object.keys(remaining.files).sort().reverse()) {
    assertOwnedBackupStagingSnapshot(directory, remaining);
    const entry = assertRegularFile(path.resolve(directory, name), `Project recovery staging file ${name}`);
    assertStableFileIdentity(entry, remaining.files[name], `Project recovery staging file identity changed before cleanup: ${name}`);
    unlinkSync(path.resolve(directory, name));
    delete remaining.files[name];
  }
  for (const name of Object.keys(remaining.directories).sort().reverse()) {
    assertOwnedBackupStagingSnapshot(directory, remaining);
    const child = path.resolve(directory, name);
    assertDirectoryIdentity(child, remaining.directories[name], `Runtime backup staging directory ${name}`);
    rmdirSync(child);
    delete remaining.directories[name];
  }
  assertOwnedBackupStagingSnapshot(directory, remaining);
  rmdirSync(directory);
}

function removeOwnedEmptyDirectory(directory, expectedIdentity, label) {
  if (!existsSync(directory)) return;
  assertDirectoryIdentity(directory, expectedIdentity, label);
  if (readdirSync(directory).length > 0) {
    throw new Error(`${label} is not empty; refusing recursive removal`);
  }
  const quarantine = `${directory}.cleanup-${randomUUID()}`;
  if (existsSync(quarantine)) throw new Error(`${label} cleanup quarantine already exists`);
  renameSync(directory, quarantine);
  if (!sameIdentity(filesystemIdentity(lstatSync(quarantine)), expectedIdentity)) {
    if (!existsSync(directory)) renameSync(quarantine, directory);
    throw new Error(`${label} identity changed during cleanup`);
  }
  if (readdirSync(quarantine).length > 0) {
    if (!existsSync(directory)) renameSync(quarantine, directory);
    throw new Error(`${label} became non-empty during cleanup`);
  }
  rmdirSync(quarantine);
}

function validateTargetDatabase(value, sourceDatabase, kind) {
  const database = requiredText(value, "replacement PostgreSQL database");
  if (!/^[a-z][a-z0-9_]{2,62}$/.test(database)) {
    throw new Error("Replacement PostgreSQL database must match ^[a-z][a-z0-9_]{2,62}$");
  }
  const prefix = `${databaseStem(sourceDatabase)}_${kind}_`;
  if (!database.startsWith(prefix) || database.length <= prefix.length) {
    throw new Error(`Replacement PostgreSQL database must start with ${prefix}`);
  }
  return database;
}

function validatePostgresRole(value) {
  const role = requiredText(value, "replacement PostgreSQL owner");
  if (role.length > 255 || /[\0\r\n]/.test(role)) throw new Error("Replacement PostgreSQL owner is invalid");
  return role;
}

function recoveryDatabaseName(sourceDatabase, kind, timestamp, uuid) {
  const time = parseTimestamp(timestamp, "Recovery drill timestamp");
  const suffix = `${new Date(time).toISOString().replace(/\D/g, "").slice(0, 14)}_${uuid.replaceAll("-", "").slice(0, 8)}`;
  const prefix = `${databaseStem(sourceDatabase)}_${kind}_`;
  return `${prefix}${suffix}`.slice(0, 63);
}

function databaseStem(database) {
  const stem = String(database)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const safe = /^[a-z]/.test(stem) ? stem : `db_${stem}`;
  return (safe || "saltanatbotv2").slice(0, 28);
}

function assertPostgresInventoryMatches(actual, expected, expectedDatabase, expectedOwner) {
  const normalized = validatePostgresInventory(actual);
  if (normalized.database !== expectedDatabase) {
    throw new Error("Restored PostgreSQL database identity mismatch");
  }
  if (normalized.owner !== expectedOwner) {
    throw new Error("Restored PostgreSQL owner mismatch");
  }
  assertSameJson(normalized.migrations, expected.migrations, "Restored PostgreSQL migrations");
  assertSameJson(normalized.counts, expected.counts, "Restored PostgreSQL counts");
}

function sqliteTableCount(databasePath, table) {
  if (!existsSync(databasePath)) return 0;
  assertRegularFile(databasePath, `SQLite database ${path.basename(databasePath)}`);
  const database = openImmutableSqlite(databasePath);
  try {
    if (!sqliteTableExists(database, table)) return 0;
    const value = database.prepare(`SELECT count(*) AS count FROM "${table}"`).get()?.count;
    return safeCount(Number(value), `SQLite ${table}`);
  } finally {
    database.close();
  }
}

function sqliteSchemaVersion(databasePath) {
  if (!existsSync(databasePath)) return 0;
  assertRegularFile(databasePath, `SQLite database ${path.basename(databasePath)}`);
  const database = openImmutableSqlite(databasePath);
  try {
    return safeCount(
      Number(database.prepare("PRAGMA user_version").get()?.user_version),
      `SQLite ${path.basename(databasePath)} schema version`
    );
  } finally {
    database.close();
  }
}

function assertSqlitePaperPortfolioSchema(databasePath, schemaVersion) {
  const database = openImmutableSqlite(databasePath);
  try {
    if (!sqliteTableExists(database, "paper_events")) {
      throw new Error(`SQLite trading schema ${schemaVersion} is missing required paper table paper_events`);
    }
    if (!sqliteColumnExists(database, "paper_events", "ledgerEpoch")) {
      throw new Error(`SQLite trading schema ${schemaVersion} paper table paper_events is missing ledgerEpoch`);
    }
    for (const [, table] of SQLITE_PAPER_PORTFOLIO_TABLES) {
      if (!sqliteTableExists(database, table)) {
        throw new Error(`SQLite trading schema ${schemaVersion} is missing required paper table ${table}`);
      }
      if (!sqliteColumnExists(database, table, "ownerUserId")) {
        throw new Error(`SQLite trading schema ${schemaVersion} paper table ${table} is missing ownerUserId`);
      }
    }
  } finally {
    database.close();
  }
}

function openImmutableSqlite(databasePath) {
  const url = pathToFileURL(databasePath);
  url.searchParams.set("immutable", "1");
  url.searchParams.set("nofollow", "1");
  return new DatabaseSync(url, { readOnly: true });
}

function sqliteTableExists(database, table) {
  return database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;
}

function sqliteColumnExists(database, table, column) {
  return database
    .prepare(`PRAGMA table_info("${table}")`)
    .all()
    .some((entry) => entry.name === column);
}

function validateRuntimeFiles(value) {
  if (!Array.isArray(value) || value.length === 0) throw new Error("Runtime backup file inventory is missing");
  return value.map((entry) => {
    if (!entry || typeof entry !== "object") throw new Error("Runtime backup file inventory is invalid");
    const name = boundedText(entry.name, "Runtime backup file name", 120);
    if (name.includes("/") || name.includes("\\") || name === "." || name === "..") {
      throw new Error(`Runtime backup file name is unsafe: ${name}`);
    }
    return {
      name,
      size: safeSize(entry.size, `Runtime backup file ${name}`),
      sha256: sha256Value(entry.sha256, `Runtime backup file ${name}`),
      ...(entry.sqliteUserVersion === undefined ? {} : { sqliteUserVersion: safeCount(entry.sqliteUserVersion, `Runtime backup SQLite version ${name}`) })
    };
  });
}

function validateSqliteCounts(value, files) {
  if (!value || typeof value !== "object") throw new Error("SQLite recovery counts are missing");
  const counts = Object.fromEntries(
    SQLITE_TRADING_BASE_COUNT_KEYS.map((key) => [key, safeCount(value[key], `SQLite ${key}`)])
  );
  const tradingVersion = files.find((entry) => entry.name === "trading.db")?.sqliteUserVersion ?? 0;
  const hasPaperPortfolioCount = SQLITE_PAPER_PORTFOLIO_COUNT_KEYS.some(
    (key) => value[key] !== undefined
  );
  if (tradingVersion >= 9 || hasPaperPortfolioCount) {
    for (const key of SQLITE_PAPER_PORTFOLIO_COUNT_KEYS) {
      counts[key] = safeCount(value[key], `SQLite ${key}`);
    }
  }
  for (const key of SQLITE_AUXILIARY_COUNT_KEYS) {
    counts[key] = safeCount(value[key], `SQLite ${key}`);
  }
  return counts;
}

function resolveReleaseCommit(configured, dependencies) {
  if (configured !== undefined) return validateReleaseCommit(configured);
  try {
    return validateReleaseCommit(dependencies.gitCommit());
  } catch {
    return "unknown";
  }
}

function detectGitCommit(runTool, env, timeout) {
  const result = runTool("git", ["rev-parse", "HEAD"], {
    cwd: root,
    env,
    timeout
  });
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(result.trim())) {
    throw new Error("Git returned an invalid commit");
  }
  const worktree = runTool("git", ["status", "--porcelain=v1", "--untracked-files=normal"], {
    cwd: root,
    env,
    timeout
  });
  if (worktree.trim().length > 0) return "unknown";
  return result.trim();
}

function validateReleaseCommit(value) {
  if (value !== "unknown" && (typeof value !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value))) {
    throw new Error("release commit must be unknown or an exact hexadecimal Git object ID");
  }
  return value;
}

function recoveryToolTimeout(env, name, fallback) {
  const configured = env[name];
  if (configured === undefined || String(configured).trim() === "") return fallback;
  if (!/^\d+$/.test(String(configured).trim())) {
    throw new Error(`${name} must be an integer timeout in milliseconds`);
  }
  const value = Number(configured);
  if (!Number.isSafeInteger(value) || value < 50 || value > 3_600_000) {
    throw new Error(`${name} must be between 50 and 3600000 milliseconds`);
  }
  return value;
}

export function runRecoveryTool(command, args, options = {}) {
  if (!Number.isSafeInteger(options.timeout) || options.timeout < 1 || options.timeout > 3_600_000) {
    throw new Error("Recovery tool timeout must be a positive bounded integer");
  }
  const spawnImplementation = options.spawnSync ?? spawnSync;
  const composeWrapper = composeRecoveryWrapper(command);
  const runId = composeWrapper ? randomUUID() : undefined;
  const executionEnvironment = composeWrapper
    ? {
        ...options.env,
        SALTANAT_RECOVERY_TOOL_RUN_ID: runId,
        SALTANAT_RECOVERY_TOOL_TIMEOUT_MS: String(options.timeout)
      }
    : options.env;
  const executionCwd = composeWrapper ? root : options.cwd;
  const timeoutBinary = "/usr/bin/timeout";
  const killGraceMs = Math.min(5_000, Math.max(500, Math.ceil(options.timeout / 10)));
  const startedAt = Date.now();
  const result = composeWrapper
    ? spawnImplementation(command, args, {
        cwd: executionCwd,
        env: executionEnvironment,
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
        timeout: options.timeout,
        killSignal: "SIGKILL"
      })
    : spawnImplementation(timeoutBinary, ["--signal=TERM", `--kill-after=${killGraceMs / 1_000}s`, "--", `${options.timeout / 1_000}s`, command, ...args], {
        cwd: executionCwd,
        env: executionEnvironment,
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024
      });
  if (composeWrapper) {
    const cleanupEnvironment = Object.fromEntries(Object.entries(executionEnvironment ?? {}).filter(([name]) => name !== "PGPASSWORD"));
    const cleanup = spawnImplementation(command, [`--cleanup-run=${runId}`], {
      cwd: root,
      env: cleanupEnvironment,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 30_000,
      killSignal: "SIGKILL"
    });
    if (cleanup.error || cleanup.signal || cleanup.status !== 0) {
      const error = new Error(`${command} recovery helper cleanup was not proven`);
      error.recoveryToolCleanupUnverified = true;
      throw error;
    }
  }
  const elapsedMs = Date.now() - startedAt;
  if (result.error?.code === "ETIMEDOUT" || result.status === 124 || (result.status === 137 && elapsedMs >= options.timeout)) {
    throw new Error(`${command} timed out after ${options.timeout}ms and was killed`);
  }
  if (result.error) {
    throw new Error(`${command} could not start${composeWrapper ? "" : ` through ${timeoutBinary}`}: ${result.error.message}`);
  }
  if (result.signal) {
    throw new Error(`${command} was terminated by ${result.signal}`);
  }
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "")
      .trim()
      .slice(0, 2_000);
    throw new Error(`${command} failed with exit code ${result.status}${detail ? `: ${detail}` : ""}`);
  }
  return String(result.stdout ?? "").trim();
}

function composeRecoveryWrapper(command) {
  if (typeof command !== "string" || !path.isAbsolute(command)) return false;
  const wrappers = new Set([path.resolve(root, "scripts/recovery-pg-dump.mjs"), path.resolve(root, "scripts/recovery-pg-restore.mjs")]);
  try {
    return wrappers.has(realpathSync(command));
  } catch {
    return false;
  }
}

function reviewedRecoveryTool(command, expectedName, env) {
  if (typeof command !== "string" || command.length < 1) {
    throw new Error(`${expectedName} recovery tool is invalid`);
  }
  if (composeRecoveryWrapper(command)) return realpathSync(command);
  let selected;
  if (path.isAbsolute(command)) {
    selected = realpathSync(command);
  } else {
    if (command !== expectedName) {
      throw new Error(`${expectedName} recovery tool must be the raw ${expectedName} binary or this project's bundled adapter`);
    }
    const searchPath = String(env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin");
    for (const directory of searchPath.split(path.delimiter)) {
      if (!path.isAbsolute(directory)) continue;
      const candidate = path.resolve(directory, expectedName);
      try {
        selected = realpathSync(candidate);
        break;
      } catch {
        // Continue to the next absolute PATH entry.
      }
    }
  }
  if (!selected || path.basename(selected) !== expectedName) {
    throw new Error(`${expectedName} recovery tool could not be resolved to the raw ${expectedName} binary`);
  }
  const entry = lstatSync(selected);
  if (entry.isSymbolicLink() || !entry.isFile() || entry.uid !== 0 || (entry.mode & 0o022) !== 0 || (entry.mode & 0o111) === 0) {
    throw new Error(`${expectedName} recovery tool must be a root-owned, non-writable executable`);
  }
  return selected;
}

function hasUnverifiedRecoveryToolCleanup(error, seen = new Set()) {
  if (!error || typeof error !== "object" || seen.has(error)) return false;
  seen.add(error);
  if (error.recoveryToolCleanupUnverified === true) return true;
  if (Array.isArray(error.errors) && error.errors.some((entry) => hasUnverifiedRecoveryToolCleanup(entry, seen))) {
    return true;
  }
  return hasUnverifiedRecoveryToolCleanup(error.cause, seen);
}

const defaultRunTool = runRecoveryTool;

function sameFilesystemPath(left, right) {
  if (path.resolve(left) === path.resolve(right)) return true;
  if (!existsSync(left) || !existsSync(right)) return false;
  return realpathSync(left) === realpathSync(right);
}

function lstatIfExists(value) {
  try {
    return lstatSync(value);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

function isInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertRealDirectory(directory, label) {
  const entry = lstatSync(directory);
  if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error(`${label} must be a real directory`);
  return entry;
}

function assertRegularFile(file, label) {
  const entry = lstatSync(file);
  if (entry.isSymbolicLink() || !entry.isFile()) throw new Error(`${label} must be a regular file`);
  return entry;
}

function assertPrivateDirectory(entry, label) {
  if ((entry.mode & 0o077) !== 0) throw new Error(`${label} must not be group or world accessible`);
}

function assertPrivateFile(entry, directoryEntry, label) {
  if ((entry.mode & 0o177) !== 0) throw new Error(`${label} must be owner-only and non-executable`);
  if (entry.uid !== directoryEntry.uid) throw new Error(`${label} owner does not match the recovery generation owner`);
}

function requiredPath(value, label) {
  return path.resolve(requiredText(value, label));
}

function requiredText(value, label) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 4_096 || /[\0\r\n]/.test(value)) {
    throw new Error(`${label} is required and must be valid text`);
  }
  return value.trim();
}

function boundedText(value, label, maximum) {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || /[\0\r\n]/.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function safeCount(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} count is invalid`);
  return value;
}

function safeSize(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} size is invalid`);
  return value;
}

function sha256Value(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new Error(`${label} SHA-256 is invalid`);
  return value;
}

function digestRegularFile(file, expectedEntry) {
  const pathEntry = expectedEntry ?? assertRegularFile(file, "Recovery file");
  let descriptor;
  const hash = createHash("sha256");
  const buffer = Buffer.alloc(1024 * 1024);
  try {
    descriptor = openSync(file, constants.O_RDONLY | noFollowFlag());
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.dev !== pathEntry.dev || before.ino !== pathEntry.ino || before.size !== pathEntry.size) {
      throw new Error(`Recovery file changed while it was opened: ${file}`);
    }
    let position = 0;
    while (position < before.size) {
      const bytesRead = readSync(descriptor, buffer, 0, Math.min(buffer.length, before.size - position), position);
      if (bytesRead <= 0) throw new Error(`Recovery file changed while it was hashed: ${file}`);
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = fstatSync(descriptor);
    const pathAfter = lstatSync(file);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || pathAfter.isSymbolicLink() || pathAfter.dev !== before.dev || pathAfter.ino !== before.ino || pathAfter.size !== before.size) {
      throw new Error(`Recovery file changed while it was hashed: ${file}`);
    }
    return {
      sha256: hash.digest("hex"),
      size: before.size,
      identity: filesystemIdentity(before)
    };
  } finally {
    buffer.fill(0);
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function readSmallRegularFile(file, expectedEntry, maximumBytes) {
  if (expectedEntry.size > maximumBytes) throw new Error(`Recovery file is too large: ${file}`);
  let descriptor;
  const buffer = Buffer.alloc(expectedEntry.size + 1);
  try {
    descriptor = openSync(file, constants.O_RDONLY | noFollowFlag());
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.dev !== expectedEntry.dev || before.ino !== expectedEntry.ino || before.size !== expectedEntry.size) {
      throw new Error(`Recovery file changed while it was opened: ${file}`);
    }
    const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0);
    if (bytesRead !== before.size) throw new Error(`Recovery file changed while it was read: ${file}`);
    const after = fstatSync(descriptor);
    const pathAfter = lstatSync(file);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || pathAfter.isSymbolicLink() || pathAfter.dev !== before.dev || pathAfter.ino !== before.ino || pathAfter.size !== before.size) {
      throw new Error(`Recovery file changed while it was read: ${file}`);
    }
    return Buffer.from(buffer.subarray(0, bytesRead));
  } finally {
    buffer.fill(0);
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function parseTimestamp(value, label) {
  if (typeof value !== "string" || value.length > 64) throw new Error(`${label} is invalid`);
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} is invalid`);
  return parsed;
}

function assertSameJson(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${label} mismatch`);
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function filesystemIdentity(entry) {
  return {
    dev: entry.dev,
    ino: entry.ino,
    uid: entry.uid,
    mode: entry.mode & 0o777
  };
}

function stableFileIdentity(entry) {
  return {
    ...filesystemIdentity(entry),
    nlink: entry.nlink,
    size: entry.size,
    mtimeMs: entry.mtimeMs,
    ctimeMs: entry.ctimeMs
  };
}

function assertStableFileIdentity(entry, expected, message) {
  const actual = stableFileIdentity(entry);
  for (const key of ["dev", "ino", "uid", "mode", "nlink", "size", "mtimeMs", "ctimeMs"]) {
    if (actual[key] !== expected?.[key]) throw new Error(message);
  }
}

function sameIdentity(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino && left.uid === right.uid && left.mode === right.mode);
}

function assertDirectoryIdentity(directory, expectedIdentity, label) {
  const entry = assertRealDirectory(directory, label);
  if (!sameIdentity(filesystemIdentity(entry), expectedIdentity)) {
    throw new Error(`${label} identity changed`);
  }
  return entry;
}

function assertNoSymlinkComponents(directory, label) {
  const absolute = path.resolve(directory);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const component of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const entry = lstatSync(current);
    if (entry.isSymbolicLink()) throw new Error(`${label} must not contain symbolic-link components`);
    if (!entry.isDirectory()) throw new Error(`${label} contains a non-directory component`);
  }
}

function utilityEnvironment(env) {
  const allowed = ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "LC_CTYPE", "LD_LIBRARY_PATH", "SSL_CERT_FILE", "SSL_CERT_DIR", "SYSTEMROOT", "WINDIR", "PATHEXT", "COMSPEC"];
  return Object.fromEntries(allowed.flatMap((name) => (env[name] === undefined ? [] : [[name, String(env[name])]])));
}

function noFollowFlag() {
  return "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
}
