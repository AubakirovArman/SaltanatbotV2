import { createDecipheriv, createHash, randomUUID, scryptSync } from "node:crypto";
import { chmodSync, closeSync, constants, copyFileSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync, backup as sqliteBackup } from "node:sqlite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultDataDir = resolve(root, "backend/data");
const databaseNames = ["trading.db", "candles.db", "arbitrage-paper-multi-leg.sqlite"];
const sensitiveNames = [".secret"];
// Kept only so backups created by pre-account-auth releases still verify and
// restore. New backups never copy the retired token file.
const legacySensitiveNames = [".authtoken"];
const allowedNames = new Set([...databaseNames, ...sensitiveNames, ...legacySensitiveNames]);
const manifestName = "backup-manifest.json";
const restoreManifestName = ".restore-manifest.json";
const sqliteSidecarNames = databaseNames.flatMap((name) => [`${name}-wal`, `${name}-shm`, `${name}-journal`]);
const inPlaceManagedNames = [...allowedNames, ...sqliteSidecarNames, restoreManifestName];
const formatName = "saltanatbotv2-runtime-backup";
const formatVersion = 1;
const keyDerivationSalt = "marketforge";

function fail(message) {
  throw new Error(message);
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function isInside(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function assertRegularFile(path, label) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} must be a regular file`);
  return stat;
}

function lstatIfExists(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function removeSqliteSidecars(path) {
  rmSync(`${path}-wal`, { force: true });
  rmSync(`${path}-shm`, { force: true });
  rmSync(`${path}-journal`, { force: true });
}

function normalizePortableSqlite(path) {
  const handle = new DatabaseSync(path);
  try {
    handle.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    handle.exec("PRAGMA journal_mode=DELETE");
  } finally {
    handle.close();
  }
  removeSqliteSidecars(path);
}

function assertSqliteIntegrity(path) {
  const immutablePath = pathToFileURL(path);
  immutablePath.searchParams.set("immutable", "1");
  const handle = new DatabaseSync(immutablePath, { readOnly: true });
  try {
    const rows = handle.prepare("PRAGMA quick_check").all();
    const messages = rows.map((row) => String(row.quick_check ?? Object.values(row)[0]));
    if (messages.length !== 1 || messages[0] !== "ok") {
      fail(`${path} failed SQLite quick_check: ${messages.join("; ") || "no result"}`);
    }
    const versionRow = handle.prepare("PRAGMA user_version").get();
    return Number(versionRow?.user_version ?? 0);
  } finally {
    handle.close();
  }
}

/** Count encrypted trading rows without selecting ciphertext or opening the key. */
export function inspectEncryptedTradingRows(databasePath) {
  const handle = new DatabaseSync(resolve(databasePath), { readOnly: true });
  try {
    const hasSettings = sqliteTableExists(handle, "settings");
    const hasEncryptedColumn =
      hasSettings &&
      handle
        .prepare("PRAGMA table_info(settings)")
        .all()
        .some((column) => column.name === "encrypted");
    const invalidEncryptedFlags = hasEncryptedColumn ? Number(handle.prepare("SELECT count(*) AS count FROM settings WHERE encrypted NOT IN (0, 1)").get()?.count ?? 0) : 0;
    if (invalidEncryptedFlags > 0) fail(`Trading settings contain ${invalidEncryptedFlags} invalid encrypted flag value(s); expected only 0 or 1`);
    const encryptedSettings = hasEncryptedColumn ? Number(handle.prepare("SELECT count(*) AS count FROM settings WHERE encrypted <> 0").get()?.count ?? 0) : 0;
    const accountCredentials = sqliteTableExists(handle, "trading_account_credentials") ? Number(handle.prepare("SELECT count(*) AS count FROM trading_account_credentials").get()?.count ?? 0) : 0;
    return { encryptedSettings, accountCredentials, total: encryptedSettings + accountCredentials };
  } finally {
    handle.close();
  }
}

function sqliteTableExists(database, name) {
  return database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

function readMasterKeyMaterial(path, label, expectedUid) {
  const entry = lstatSync(path);
  if (!entry.isFile() || entry.isSymbolicLink()) fail(`${label} must be a regular file and must not be a symbolic link`);
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | noFollowFlag());
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.dev !== entry.dev || stat.ino !== entry.ino) fail(`${label} changed while it was being opened`);
    if (expectedUid !== undefined && stat.uid !== expectedUid) fail(`${label} must be owned by uid ${expectedUid}`);
    const permissions = stat.mode & 0o777;
    if (permissions !== 0o600 && permissions !== 0o400) fail(`${label} permissions must be 0600 or read-only 0400`);
    if (stat.size < 64 || stat.size > 66) malformedMasterKey(label);
    const material = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    const pathAfter = lstatSync(path);
    if (after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size || pathAfter.dev !== stat.dev || pathAfter.ino !== stat.ino) {
      material.fill(0);
      fail(`${label} changed while it was being read`);
    }
    if (!isSupportedMasterKeyMaterial(material)) {
      material.fill(0);
      malformedMasterKey(label);
    }
    return material;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function malformedMasterKey(label) {
  fail(`${label} is malformed; expected 64 hexadecimal characters with at most one trailing line ending`);
}

function isSupportedMasterKeyMaterial(material) {
  let hexadecimalLength = material.length;
  if (material.at(-1) === 0x0a) {
    hexadecimalLength -= 1;
    if (material.at(-2) === 0x0d) hexadecimalLength -= 1;
  }
  if (hexadecimalLength !== 64) return false;
  for (let index = 0; index < hexadecimalLength; index += 1) {
    const byte = material[index];
    if (!((byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x46) || (byte >= 0x61 && byte <= 0x66))) return false;
  }
  return true;
}

function copyMasterKeyFile(source, destination) {
  const material = readMasterKeyMaterial(source, "Runtime trading master key", process.getuid?.());
  let descriptor;
  try {
    descriptor = openSync(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(), 0o600);
    writeFileSync(descriptor, material);
    fsyncSync(descriptor);
  } finally {
    material.fill(0);
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function proveEncryptedTradingRows(databasePath, key) {
  const inventory = inspectEncryptedTradingRows(databasePath);
  const handle = new DatabaseSync(resolve(databasePath), { readOnly: true });
  try {
    try {
      if (inventory.encryptedSettings > 0) {
        for (const row of handle.prepare("SELECT value FROM settings WHERE encrypted <> 0").iterate()) openEncryptedPayload(key, row.value);
      }
      if (inventory.accountCredentials > 0) proveAccountCredentials(handle, key);
    } catch {
      fail("Backup trading master key cannot decrypt every encrypted trading row");
    }
    return inventory;
  } finally {
    handle.close();
  }
}

function proveAccountCredentials(database, key) {
  if (!sqliteTableExists(database, "trading_accounts")) throw new Error("missing account registry");
  const rows = database
    .prepare(`
      SELECT credential.ownerUserId, credential.accountId, credential.encryptedValue, account.exchange
      FROM trading_account_credentials credential
      LEFT JOIN trading_accounts account
        ON account.ownerUserId = credential.ownerUserId AND account.id = credential.accountId
      ORDER BY credential.ownerUserId, credential.accountId
    `)
    .all();
  for (const row of rows) {
    if (row.exchange !== "binance" && row.exchange !== "bybit") throw new Error("invalid account binding");
    const aad = JSON.stringify(["trading-credentials", 1, String(row.ownerUserId).trim(), row.accountId, row.exchange]);
    openEncryptedPayload(key, row.encryptedValue, aad);
  }
}

function openEncryptedPayload(key, payload, aad) {
  const [ivBase64, tagBase64, dataBase64] = String(payload).split(".");
  if (!ivBase64 || !tagBase64 || !dataBase64) throw new Error("malformed encrypted trading value");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivBase64, "base64"));
  if (aad !== undefined) decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(Buffer.from(tagBase64, "base64"));
  decipher.update(Buffer.from(dataBase64, "base64"));
  decipher.final();
}

function noFollowFlag() {
  return "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
}

function readManifest(backupDir) {
  const manifestPath = resolve(backupDir, manifestName);
  if (!existsSync(manifestPath)) fail(`Backup manifest is missing: ${manifestPath}`);
  assertRegularFile(manifestPath, "Backup manifest");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.format !== formatName || manifest.version !== formatVersion) {
    fail(`Unsupported backup format: ${manifest.format ?? "unknown"} v${manifest.version ?? "unknown"}`);
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) fail("Backup manifest has no files");
  return manifest;
}

export function verifyRuntimeBackup(backupDirectory) {
  const backupDir = resolve(backupDirectory);
  const backupEntry = lstatSync(backupDir);
  if (backupEntry.isSymbolicLink() || !backupEntry.isDirectory()) fail("Backup path must be a real directory");
  const manifest = readManifest(backupDir);
  const seen = new Set();

  for (const entry of manifest.files) {
    if (!entry || typeof entry.name !== "string" || !allowedNames.has(entry.name)) {
      fail(`Backup manifest contains an unsupported file: ${entry?.name ?? "unknown"}`);
    }
    if (seen.has(entry.name)) fail(`Backup manifest contains a duplicate file: ${entry.name}`);
    seen.add(entry.name);
  }

  const actualFiles = readdirSync(backupDir).filter((name) => name !== manifestName);
  for (const name of actualFiles) {
    if (!seen.has(name)) fail(`Backup contains an unmanifested file: ${name}`);
  }
  if (!seen.has("trading.db")) fail("Backup does not contain trading.db");
  if (!seen.has(".secret")) fail("Backup does not contain .secret; trading.db and its master key are one recovery unit");

  for (const entry of manifest.files) {
    const file = resolve(backupDir, entry.name);
    if (dirname(file) !== backupDir || !existsSync(file)) fail(`Backup file is missing: ${entry.name}`);
    const stat = assertRegularFile(file, `Backup file ${entry.name}`);
    if (stat.size !== entry.size) fail(`Backup file size mismatch: ${entry.name}`);
    if (sha256(file) !== entry.sha256) fail(`Backup checksum mismatch: ${entry.name}`);
    if (databaseNames.includes(entry.name)) {
      const userVersion = assertSqliteIntegrity(file);
      if (entry.sqliteUserVersion !== undefined && entry.sqliteUserVersion !== userVersion) {
        fail(`Backup SQLite schema version mismatch: ${entry.name}`);
      }
    }
  }

  const material = readMasterKeyMaterial(resolve(backupDir, ".secret"), "Backup trading master key", backupEntry.uid);
  let key;
  try {
    key = scryptSync(material, keyDerivationSalt, 32);
  } finally {
    material.fill(0);
  }
  try {
    const encryptedRows = proveEncryptedTradingRows(resolve(backupDir, "trading.db"), key);
    return { backupDir, manifest, encryptedRows };
  } finally {
    key.fill(0);
  }
}

export async function createRuntimeBackup({ dataDirectory = defaultDataDir, outputDirectory }) {
  const dataDir = resolve(dataDirectory);
  if (!existsSync(dataDir)) fail(`Runtime data directory does not exist: ${dataDir}`);
  if (!outputDirectory) fail("backup requires --output <directory>");
  const outputDir = resolve(outputDirectory);
  if (isInside(dataDir, outputDir)) fail("Backup output must be outside the runtime data directory");
  if (existsSync(outputDir)) fail(`Backup output already exists: ${outputDir}`);

  mkdirSync(dirname(outputDir), { recursive: true });
  const stagingDir = `${outputDir}.partial-${randomUUID()}`;
  mkdirSync(stagingDir, { mode: 0o700 });

  try {
    const files = [];
    for (const name of databaseNames) {
      const source = resolve(dataDir, name);
      if (!existsSync(source)) continue;
      assertRegularFile(source, `Runtime file ${name}`);
      assertSqliteIntegrity(source);
      const destination = resolve(stagingDir, name);
      const handle = new DatabaseSync(source, { readOnly: true });
      try {
        await sqliteBackup(handle, destination);
      } finally {
        handle.close();
      }
      normalizePortableSqlite(destination);
      chmodSync(destination, 0o600);
      const sqliteUserVersion = assertSqliteIntegrity(destination);
      const stat = statSync(destination);
      files.push({ name, size: stat.size, sha256: sha256(destination), mode: "0600", sqliteUserVersion });
    }

    for (const name of sensitiveNames) {
      const source = resolve(dataDir, name);
      if (!existsSync(source)) continue;
      const destination = resolve(stagingDir, name);
      copyMasterKeyFile(source, destination);
      chmodSync(destination, 0o600);
      const stat = statSync(destination);
      files.push({ name, size: stat.size, sha256: sha256(destination), mode: "0600" });
    }

    if (!files.some((entry) => entry.name === "trading.db")) {
      fail(`Runtime database is missing: ${resolve(dataDir, "trading.db")}`);
    }

    const manifest = {
      format: formatName,
      version: formatVersion,
      createdAt: new Date().toISOString(),
      source: "backend/data",
      files: files.sort((left, right) => left.name.localeCompare(right.name))
    };
    const manifestPath = resolve(stagingDir, manifestName);
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    verifyRuntimeBackup(stagingDir);
    renameSync(stagingDir, outputDir);
    return { backupDir: outputDir, manifest };
  } catch (error) {
    rmSync(stagingDir, { recursive: true, force: true });
    throw error;
  }
}

function stageRuntimeRestore(backupDir, manifest, stagingDir) {
  for (const entry of manifest.files) {
    const destination = resolve(stagingDir, entry.name);
    copyFileSync(resolve(backupDir, entry.name), destination);
    chmodSync(destination, 0o600);
  }
  const stagedManifest = {
    ...manifest,
    restoredAt: new Date().toISOString(),
    restoredFrom: backupDir
  };
  writeFileSync(resolve(stagingDir, restoreManifestName), `${JSON.stringify(stagedManifest, null, 2)}\n`, {
    mode: 0o600
  });
  verifyStagedRuntimeRestore(stagingDir, manifest);
  return stagedManifest;
}

function verifyStagedRuntimeRestore(directory, manifest) {
  for (const entry of manifest.files) {
    const file = resolve(directory, entry.name);
    const stat = assertRegularFile(file, `Staged restore file ${entry.name}`);
    if (stat.size !== entry.size) fail(`Staged restore file size mismatch: ${entry.name}`);
    if (sha256(file) !== entry.sha256) fail(`Staged restore checksum mismatch: ${entry.name}`);
    if (databaseNames.includes(entry.name)) {
      const userVersion = assertSqliteIntegrity(file);
      if (entry.sqliteUserVersion !== undefined && entry.sqliteUserVersion !== userVersion) {
        fail(`Staged restore SQLite schema version mismatch: ${entry.name}`);
      }
    }
  }
  assertRegularFile(resolve(directory, restoreManifestName), "Restore manifest");
}

function rollbackInPlaceRestore({ dataDir, stagingDir, rollbackDir, installedNames, previousNames, renameFile }) {
  const errors = [];
  mkdirSync(stagingDir, { recursive: true, mode: 0o700 });
  for (const name of [...installedNames].reverse()) {
    const installed = resolve(dataDir, name);
    if (!lstatIfExists(installed)) continue;
    try {
      renameFile(installed, resolve(stagingDir, name));
    } catch (error) {
      errors.push(error);
    }
  }
  for (const name of [...previousNames].reverse()) {
    const previous = resolve(rollbackDir, name);
    if (!lstatIfExists(previous)) continue;
    const destination = resolve(dataDir, name);
    if (lstatIfExists(destination)) {
      errors.push(new Error(`Rollback target is occupied: ${destination}`));
      continue;
    }
    try {
      renameFile(previous, destination);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, `In-place restore rollback is incomplete: ${rollbackDir}`);
}

function restoreRuntimeBackupInPlace({ backupDir, manifest, dataDir, force, renameFile }) {
  const targetStat = lstatIfExists(dataDir);
  if (targetStat?.isSymbolicLink()) fail(`In-place restore target must not be a symbolic link: ${dataDir}`);
  if (targetStat && !targetStat.isDirectory()) fail(`In-place restore target must be a directory: ${dataDir}`);
  const targetCreated = !targetStat;
  const targetHasFiles = Boolean(targetStat && readdirSync(dataDir).length > 0);
  if (targetHasFiles && !force) {
    fail(`Restore target is not empty: ${dataDir}. Stop the application and pass --force to replace runtime files in place.`);
  }
  if (targetCreated) mkdirSync(dataDir, { recursive: true, mode: 0o700 });

  const stagingDir = resolve(dataDir, `.restore-stage-${randomUUID()}`);
  const rollbackDir = resolve(dataDir, `.restore-rollback-${randomUUID()}`);
  const previousNames = [];
  const installedNames = [];

  let stagedManifest;
  try {
    mkdirSync(stagingDir, { mode: 0o700 });
    mkdirSync(rollbackDir, { mode: 0o700 });
    stagedManifest = stageRuntimeRestore(backupDir, manifest, stagingDir);
    for (const name of inPlaceManagedNames) {
      const current = resolve(dataDir, name);
      if (!lstatIfExists(current)) continue;
      renameFile(current, resolve(rollbackDir, name));
      previousNames.push(name);
    }
    for (const name of [...manifest.files.map((entry) => entry.name), restoreManifestName]) {
      renameFile(resolve(stagingDir, name), resolve(dataDir, name));
      installedNames.push(name);
    }
    verifyStagedRuntimeRestore(dataDir, manifest);
  } catch (error) {
    let rollbackError;
    if (previousNames.length > 0 || installedNames.length > 0) {
      try {
        rollbackInPlaceRestore({ dataDir, stagingDir, rollbackDir, installedNames, previousNames, renameFile });
      } catch (candidate) {
        rollbackError = candidate;
      }
    }
    if (!rollbackError) {
      rmSync(stagingDir, { recursive: true, force: true });
      rmSync(rollbackDir, { recursive: true, force: true });
      if (targetCreated && readdirSync(dataDir).length === 0) rmSync(dataDir);
    }
    if (rollbackError) {
      throw new AggregateError([error, rollbackError], `In-place restore failed and rollback is incomplete; recovery files remain in ${rollbackDir}`);
    }
    throw error;
  }

  rmSync(stagingDir, { recursive: true, force: true });
  rmSync(rollbackDir, { recursive: true, force: true });
  return { dataDir, manifest: stagedManifest };
}

export function restoreRuntimeBackup({ backupDirectory, dataDirectory = defaultDataDir, force = false, inPlace = false, renameFile = renameSync }) {
  if (!backupDirectory) fail("restore requires a backup directory");
  const { backupDir, manifest } = verifyRuntimeBackup(backupDirectory);
  const dataDir = resolve(dataDirectory);
  if (isInside(dataDir, backupDir)) fail("Backup source must be outside the runtime data directory");
  if (inPlace) return restoreRuntimeBackupInPlace({ backupDir, manifest, dataDir, force, renameFile });
  const parent = dirname(dataDir);
  mkdirSync(parent, { recursive: true });

  const targetExists = existsSync(dataDir);
  const targetHasFiles = targetExists && readdirSync(dataDir).length > 0;
  if (targetHasFiles && !force) {
    fail(`Restore target is not empty: ${dataDir}. Stop the application and pass --force to replace it.`);
  }

  const stagingDir = resolve(parent, `.${dataDir.split(/[\\/]/).at(-1)}.restore-${randomUUID()}`);
  const previousDir = resolve(parent, `.${dataDir.split(/[\\/]/).at(-1)}.previous-${randomUUID()}`);
  mkdirSync(stagingDir, { mode: 0o700 });

  try {
    const stagedManifest = stageRuntimeRestore(backupDir, manifest, stagingDir);

    if (targetExists) renameSync(dataDir, previousDir);
    try {
      renameSync(stagingDir, dataDir);
    } catch (error) {
      if (existsSync(previousDir)) renameSync(previousDir, dataDir);
      throw error;
    }
    rmSync(previousDir, { recursive: true, force: true });
    return { dataDir, manifest: stagedManifest };
  } catch (error) {
    rmSync(stagingDir, { recursive: true, force: true });
    throw error;
  }
}

function readOption(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) fail(`${name} requires a value`);
  return value;
}

function printUsage() {
  console.log(`Usage:
  npm run data:backup -- --output <directory> [--data-dir <directory>]
  npm run data:verify -- <backup-directory>
  npm run data:restore -- <backup-directory> [--data-dir <directory>] [--force] [--in-place]
  npm run data:inventory -- [--data-dir <directory>]

Restore replaces runtime data only with --force. Use --in-place for a mounted data directory. Stop the application before restoring.`);
}

async function main(args) {
  const [command, positional] = args;
  if (!command || command === "help" || command === "--help") {
    printUsage();
    return;
  }
  const dataDirectory = readOption(args, "--data-dir") ?? defaultDataDir;
  if (command === "backup") {
    const result = await createRuntimeBackup({
      dataDirectory,
      outputDirectory: readOption(args, "--output")
    });
    console.log(`Runtime backup created and verified: ${result.backupDir}`);
    return;
  }
  if (command === "verify") {
    const result = verifyRuntimeBackup(positional);
    console.log(`Runtime backup verified (${result.manifest.files.length} files): ${result.backupDir}`);
    return;
  }
  if (command === "restore") {
    const result = restoreRuntimeBackup({
      backupDirectory: positional,
      dataDirectory,
      force: args.includes("--force"),
      inPlace: args.includes("--in-place")
    });
    console.log(`Runtime data restored and verified: ${result.dataDir}`);
    return;
  }
  if (command === "inventory") {
    const databasePath = resolve(dataDirectory, "trading.db");
    if (!existsSync(databasePath)) fail(`Runtime database is missing: ${databasePath}`);
    assertRegularFile(databasePath, "Runtime database");
    assertSqliteIntegrity(databasePath);
    const inventory = inspectEncryptedTradingRows(databasePath);
    console.log(`Encrypted trading row inventory: settings=${inventory.encryptedSettings}, accountCredentials=${inventory.accountCredentials}, total=${inventory.total}`);
    return;
  }
  fail(`Unknown command: ${command}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`Runtime data operation failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
