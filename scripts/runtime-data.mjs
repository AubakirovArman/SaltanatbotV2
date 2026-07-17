import { createDecipheriv, createHash, randomUUID, scryptSync } from "node:crypto";
import { chmodSync, closeSync, constants, copyFileSync, existsSync, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, rmdirSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
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
const runtimeRestoreClaimName = ".saltanat-runtime-restore-claim";
const sqliteSidecarNames = databaseNames.flatMap((name) => [`${name}-wal`, `${name}-shm`, `${name}-journal`]);
const inPlaceManagedNames = [...allowedNames, ...sqliteSidecarNames, restoreManifestName];
const inPlaceManagedSet = new Set(inPlaceManagedNames);
const backupStagingNames = new Set([...allowedNames, ...sqliteSidecarNames, manifestName]);
const restoreStagingNames = new Set([...allowedNames, ...sqliteSidecarNames, restoreManifestName]);
const formatName = "saltanatbotv2-runtime-backup";
const formatVersion = 1;
const keyDerivationSalt = "marketforge";
const digestChunkSize = 1024 * 1024;
const maxManifestBytes = 1024 * 1024;

function fail(message) {
  throw new Error(message);
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameOwnedIdentity(entry, expected) {
  return sameIdentity(entry, expected) && entry.uid === expected.uid && (entry.mode & 0o777) === (expected.mode & 0o777);
}

function assertRuntimeTargetIdentity(path, expected, label) {
  const entry = lstatSync(path);
  if (!entry.isDirectory() || entry.isSymbolicLink() || !sameOwnedIdentity(entry, expected)) {
    fail(`${label} changed identity`);
  }
  return entry;
}

function assertRuntimeTargetClaim(path, claim, label) {
  const entry = assertRuntimeTargetIdentity(path, claim.identity, label);
  const markerPath = resolve(path, claim.markerName);
  const markerEntry = lstatSync(markerPath);
  if (!markerEntry.isFile() || markerEntry.isSymbolicLink() || !sameOwnedIdentity(markerEntry, claim.markerIdentity)) {
    fail(`${label} claim marker changed identity`);
  }
  if (readSmallRegularFile(markerPath, `${label} claim marker`, 256) !== `${claim.token}\n`) {
    fail(`${label} claim marker changed`);
  }
  return entry;
}

function createRuntimeTargetClaim(path, identity) {
  const markerPath = resolve(path, runtimeRestoreClaimName);
  const token = randomUUID();
  const material = Buffer.from(`${token}\n`, "utf8");
  let descriptor;
  let markerIdentity;
  try {
    descriptor = openSync(markerPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(), 0o600);
    const opened = fstatSync(descriptor);
    if (!opened.isFile()) fail("Runtime restore claim marker is not a regular file");
    markerIdentity = opened;
    let written = 0;
    while (written < material.length) {
      const bytesWritten = writeSync(descriptor, material, written, material.length - written, written);
      if (bytesWritten <= 0) fail("Runtime restore claim marker write failed");
      written += bytesWritten;
    }
    fchmodSync(descriptor, 0o600);
    fsyncSync(descriptor);
    markerIdentity = fstatSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    const claim = {
      identity,
      markerName: runtimeRestoreClaimName,
      markerIdentity,
      token,
      released: false
    };
    assertRuntimeTargetClaim(path, claim, "Runtime restore target");
    return claim;
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (markerIdentity && lstatIfExists(markerPath)) {
      const current = lstatSync(markerPath);
      if (current.isFile() && !current.isSymbolicLink() && sameOwnedIdentity(current, markerIdentity)) {
        unlinkSync(markerPath);
      }
    }
    throw error;
  } finally {
    material.fill(0);
  }
}

function releaseRuntimeTargetClaim(path, claim) {
  if (claim.released) return;
  assertRuntimeTargetClaim(path, claim, "Runtime restore target");
  unlinkSync(resolve(path, claim.markerName));
  claim.released = true;
}

function assertInPlaceRestoreTarget(dataDir, targetIdentity, expectedTargetClaim) {
  if (expectedTargetClaim) {
    return assertRuntimeTargetClaim(dataDir, expectedTargetClaim, "In-place restore target");
  }
  return assertRuntimeTargetIdentity(dataDir, targetIdentity, "In-place restore target");
}

function sameSnapshot(left, right) {
  return sameIdentity(left, right) && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function sha256(path, label = "File") {
  const entry = lstatSync(path);
  if (!entry.isFile() || entry.isSymbolicLink()) fail(`${label} must be a regular file`);
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | noFollowFlag());
    const before = fstatSync(descriptor);
    if (!before.isFile() || !sameIdentity(entry, before)) fail(`${label} changed while it was being opened`);
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(digestChunkSize);
    for (;;) {
      const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      digest.update(buffer.subarray(0, bytesRead));
    }
    const after = fstatSync(descriptor);
    const pathAfter = lstatSync(path);
    if (!after.isFile() || !pathAfter.isFile() || pathAfter.isSymbolicLink() || !sameSnapshot(before, after) || !sameSnapshot(before, pathAfter)) {
      fail(`${label} changed while it was being hashed`);
    }
    return digest.digest("hex");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function readSmallRegularFile(path, label, maximumBytes) {
  const entry = lstatSync(path);
  if (!entry.isFile() || entry.isSymbolicLink()) fail(`${label} must be a regular file`);
  if (entry.size > maximumBytes) fail(`${label} is too large`);
  let descriptor;
  const buffer = Buffer.alloc(entry.size + 1);
  try {
    descriptor = openSync(path, constants.O_RDONLY | noFollowFlag());
    const before = fstatSync(descriptor);
    if (!before.isFile() || !sameSnapshot(entry, before)) fail(`${label} changed while it was being opened`);
    const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0);
    if (bytesRead !== before.size) fail(`${label} changed while it was being read`);
    const after = fstatSync(descriptor);
    const pathAfter = lstatSync(path);
    if (!after.isFile() || !pathAfter.isFile() || pathAfter.isSymbolicLink() || !sameSnapshot(before, after) || !sameSnapshot(before, pathAfter)) {
      fail(`${label} changed while it was being read`);
    }
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    buffer.fill(0);
    if (descriptor !== undefined) closeSync(descriptor);
  }
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

function assertRealDirectoryPath(directory, label) {
  const absolute = resolve(directory);
  const rootPath = resolve(absolute, "/");
  let current = rootPath;
  const relativePath = relative(rootPath, absolute);
  const components = relativePath ? relativePath.split(/[\\/]/).filter(Boolean) : [];
  let entry = lstatSync(current);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    fail(`${label} root must be a real directory`);
  }
  for (const component of components) {
    current = resolve(current, component);
    entry = lstatSync(current);
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      fail(`${label} must not contain symbolic links or non-directory components: ${current}`);
    }
  }
  return entry;
}

function assertPrivateOperatorDirectory(directory, label) {
  const entry = assertRealDirectoryPath(directory, label);
  const currentUid = process.getuid?.();
  if (currentUid !== undefined && entry.uid !== currentUid) {
    fail(`${label} must be owned by the recovery operator`);
  }
  if ((entry.mode & 0o022) !== 0) {
    fail(`${label} must not be group or world writable`);
  }
  return entry;
}

function directorySnapshot(path, allowedEntries, label) {
  const rootEntry = lstatSync(path);
  if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) fail(`${label} must be a real directory`);
  const entries = new Map();
  for (const name of readdirSync(path).sort()) {
    if (!allowedEntries.has(name)) fail(`${label} contains an unexpected entry and will not be deleted: ${name}`);
    const entryPath = resolve(path, name);
    if (dirname(entryPath) !== resolve(path)) fail(`${label} contains an unsafe entry name: ${name}`);
    const entry = lstatSync(entryPath);
    if (!entry.isFile() || entry.isSymbolicLink()) fail(`${label} entry must be a regular file and will not be deleted: ${name}`);
    entries.set(name, entry);
  }
  return { root: rootEntry, entries };
}

function assertDirectorySnapshot(path, expected, label) {
  const current = directorySnapshot(path, new Set(expected.entries.keys()), label);
  if (!sameIdentity(current.root, expected.root)) fail(`${label} changed identity and will not be deleted`);
  if (current.entries.size !== expected.entries.size) fail(`${label} contents changed and will not be deleted`);
  for (const [name, entry] of expected.entries) {
    const currentEntry = current.entries.get(name);
    if (!currentEntry || !sameSnapshot(currentEntry, entry)) fail(`${label} entry changed and will not be deleted: ${name}`);
  }
  return current;
}

function removeClaimedFlatDirectory(path, expected, label) {
  assertDirectorySnapshot(path, expected, label);
  const claimedPath = `${path}.cleanup-${randomUUID()}`;
  if (lstatIfExists(claimedPath)) fail(`${label} cleanup claim path is unexpectedly occupied: ${claimedPath}`);
  renameSync(path, claimedPath);
  let movedRoot;
  try {
    movedRoot = lstatSync(claimedPath);
    if (!movedRoot.isDirectory() || movedRoot.isSymbolicLink() || !sameIdentity(movedRoot, expected.root)) {
      fail(`${label} changed identity while it was moved for cleanup; it will be restored`);
    }
    assertDirectorySnapshot(claimedPath, expected, label);
    for (const [name, entry] of expected.entries) {
      const rootEntry = lstatSync(claimedPath);
      if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink() || !sameIdentity(rootEntry, expected.root)) {
        fail(`${label} changed identity during cleanup; remaining files were preserved in ${claimedPath}`);
      }
      const entryPath = resolve(claimedPath, name);
      const currentEntry = lstatSync(entryPath);
      if (!currentEntry.isFile() || currentEntry.isSymbolicLink() || !sameSnapshot(currentEntry, entry)) {
        fail(`${label} entry changed during cleanup and was preserved: ${name}`);
      }
      unlinkSync(entryPath);
    }
    const rootEntry = lstatSync(claimedPath);
    if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink() || !sameIdentity(rootEntry, expected.root)) {
      fail(`${label} changed identity after cleanup; directory was preserved in ${claimedPath}`);
    }
    const remaining = readdirSync(claimedPath);
    if (remaining.length > 0) fail(`${label} gained unexpected entries during cleanup; they were preserved in ${claimedPath}: ${remaining.join(", ")}`);
    rmdirSync(claimedPath);
  } catch (error) {
    if (!lstatIfExists(path)) {
      const claimedEntry = lstatIfExists(claimedPath);
      if (movedRoot && claimedEntry?.isDirectory() && !claimedEntry.isSymbolicLink() && sameIdentity(claimedEntry, movedRoot)) {
        try {
          renameSync(claimedPath, path);
        } catch {
          // Leave the claimed directory at its unique path for operator recovery.
        }
      }
    }
    throw error;
  }
}

function removeOwnedFlatDirectory(path, expectedIdentity, allowedEntries, label) {
  const entry = lstatIfExists(path);
  if (!entry) fail(`${label} disappeared before cleanup and was not deleted`);
  if (!entry.isDirectory() || entry.isSymbolicLink() || !sameIdentity(entry, expectedIdentity)) {
    fail(`${label} changed identity and will not be deleted`);
  }
  const snapshot = directorySnapshot(path, allowedEntries, label);
  if (!sameIdentity(snapshot.root, expectedIdentity)) fail(`${label} changed identity and will not be deleted`);
  removeClaimedFlatDirectory(path, snapshot, label);
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
  const manifest = JSON.parse(readSmallRegularFile(manifestPath, "Backup manifest", maxManifestBytes));
  if (manifest.format !== formatName || manifest.version !== formatVersion) {
    fail(`Unsupported backup format: ${manifest.format ?? "unknown"} v${manifest.version ?? "unknown"}`);
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) fail("Backup manifest has no files");
  return manifest;
}

export function verifyRuntimeBackup(backupDirectory) {
  const backupDir = resolve(backupDirectory);
  const backupEntry = assertRealDirectoryPath(backupDir, "Backup path");
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
    if (sha256(file, `Backup file ${entry.name}`) !== entry.sha256) fail(`Backup checksum mismatch: ${entry.name}`);
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

export async function createRuntimeBackup({ dataDirectory = defaultDataDir, outputDirectory, afterBackupStaged = async () => {}, beforeBackupPublish = async () => {} }) {
  const dataDir = resolve(dataDirectory);
  if (!existsSync(dataDir)) fail(`Runtime data directory does not exist: ${dataDir}`);
  assertRealDirectoryPath(dataDir, "Runtime data directory");
  if (!outputDirectory) fail("backup requires --output <directory>");
  const outputDir = resolve(outputDirectory);
  if (isInside(dataDir, outputDir)) fail("Backup output must be outside the runtime data directory");
  if (lstatIfExists(outputDir)) fail(`Backup output already exists: ${outputDir}`);

  const outputParent = dirname(outputDir);
  const outputParentIdentity = assertPrivateOperatorDirectory(outputParent, "Backup output parent");
  const stagingDir = `${outputDir}.partial-${randomUUID()}`;
  assertRuntimeTargetIdentity(outputParent, outputParentIdentity, "Backup output parent");
  mkdirSync(stagingDir, { mode: 0o700 });
  assertRuntimeTargetIdentity(outputParent, outputParentIdentity, "Backup output parent");
  const stagingIdentity = lstatSync(stagingDir);
  let stagedSnapshot;
  let outputClaim;

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
      files.push({ name, size: stat.size, sha256: sha256(destination, `Backup staging file ${name}`), mode: "0600", sqliteUserVersion });
    }

    for (const name of sensitiveNames) {
      const source = resolve(dataDir, name);
      if (!existsSync(source)) continue;
      const destination = resolve(stagingDir, name);
      copyMasterKeyFile(source, destination);
      chmodSync(destination, 0o600);
      const stat = statSync(destination);
      files.push({ name, size: stat.size, sha256: sha256(destination, `Backup staging file ${name}`), mode: "0600" });
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
    const expectedStagingNames = new Set([...files.map((entry) => entry.name), manifestName]);
    stagedSnapshot = directorySnapshot(stagingDir, expectedStagingNames, "Backup staging directory");
    if (!sameIdentity(stagedSnapshot.root, stagingIdentity)) fail("Backup staging directory changed identity before publish");
    await afterBackupStaged({ stagingDir });
    assertDirectorySnapshot(stagingDir, stagedSnapshot, "Backup staging directory");
    await beforeBackupPublish({ stagingDir, outputDir });
    assertDirectorySnapshot(stagingDir, stagedSnapshot, "Backup staging directory");
    assertRuntimeTargetIdentity(outputParent, outputParentIdentity, "Backup output parent");
    try {
      mkdirSync(outputDir, { mode: 0o700 });
    } catch (publishError) {
      if (publishError?.code === "EEXIST") {
        fail(`Backup output appeared before its exclusive claim: ${outputDir}`);
      }
      throw publishError;
    }
    const outputEntry = lstatSync(outputDir);
    if (outputEntry.isSymbolicLink() || !outputEntry.isDirectory() || (outputEntry.mode & 0o077) !== 0) {
      fail("Claimed backup output must be an owner-only real directory");
    }
    const currentUid = process.getuid?.();
    if (currentUid !== undefined && outputEntry.uid !== currentUid) {
      fail("Claimed backup output must be owned by the backup operator");
    }
    outputClaim = createRuntimeTargetClaim(outputDir, outputEntry);
    for (const [name, sourceEntry] of stagedSnapshot.entries) {
      assertRuntimeTargetClaim(outputDir, outputClaim, "Claimed backup output");
      const source = resolve(stagingDir, name);
      const destination = resolve(outputDir, name);
      copyFileSync(source, destination, constants.COPYFILE_EXCL);
      chmodSync(destination, 0o600);
      const copied = lstatSync(destination);
      if (!copied.isFile() || copied.isSymbolicLink() || copied.size !== sourceEntry.size || sha256(destination, `Published backup file ${name}`) !== sha256(source, `Backup staging file ${name}`)) {
        fail(`Published backup file changed: ${name}`);
      }
    }
    assertRuntimeTargetClaim(outputDir, outputClaim, "Claimed backup output");
    releaseRuntimeTargetClaim(outputDir, outputClaim);
    assertRuntimeTargetIdentity(outputDir, outputClaim.identity, "Published backup output");
    verifyRuntimeBackup(outputDir);
    assertRuntimeTargetIdentity(outputDir, outputClaim.identity, "Published backup output");
    removeClaimedFlatDirectory(stagingDir, stagedSnapshot, "Backup staging directory");
    return { backupDir: outputDir, manifest };
  } catch (error) {
    const cleanupErrors = [];
    if (outputClaim && !outputClaim.released) {
      try {
        assertRuntimeTargetClaim(outputDir, outputClaim, "Claimed backup output");
        if (readdirSync(outputDir).some((name) => name !== outputClaim.markerName)) {
          throw new Error(`Partial backup publication was preserved for inspection: ${outputDir}`);
        }
        releaseRuntimeTargetClaim(outputDir, outputClaim);
        assertRuntimeTargetIdentity(outputDir, outputClaim.identity, "Claimed backup output");
        rmdirSync(outputDir);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    try {
      if (stagedSnapshot) {
        removeClaimedFlatDirectory(stagingDir, stagedSnapshot, "Backup staging directory");
      } else {
        removeOwnedFlatDirectory(stagingDir, stagingIdentity, backupStagingNames, "Backup staging directory");
      }
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError([error, ...cleanupErrors], `Runtime backup failed and cleanup was refused; inspect ${stagingDir} and ${outputDir}`);
    }
    throw error;
  }
}

function stageRuntimeRestore(backupDir, manifest, stagingDir, restoredFrom) {
  for (const entry of manifest.files) {
    const destination = resolve(stagingDir, entry.name);
    copyFileSync(resolve(backupDir, entry.name), destination);
    chmodSync(destination, 0o600);
  }
  const stagedManifest = {
    ...manifest,
    restoredAt: new Date().toISOString(),
    restoredFrom
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
    if (sha256(file, `Staged restore file ${entry.name}`) !== entry.sha256) fail(`Staged restore checksum mismatch: ${entry.name}`);
    if (databaseNames.includes(entry.name)) {
      const userVersion = assertSqliteIntegrity(file);
      if (entry.sqliteUserVersion !== undefined && entry.sqliteUserVersion !== userVersion) {
        fail(`Staged restore SQLite schema version mismatch: ${entry.name}`);
      }
    }
  }
  assertRegularFile(resolve(directory, restoreManifestName), "Restore manifest");
}

function rollbackInPlaceRestore({ dataDir, stagingDir, stagingIdentity, stagingSnapshot, rollbackDir, rollbackIdentity, rollbackSnapshot, targetIdentity, expectedTargetClaim, installedFiles, previousFiles, renameFile }) {
  const errors = [];
  assertInPlaceRestoreTarget(dataDir, targetIdentity, expectedTargetClaim);
  assertRuntimeTargetIdentity(stagingDir, stagingIdentity, "In-place restore staging directory");
  assertRuntimeTargetIdentity(rollbackDir, rollbackIdentity, "In-place restore rollback directory");
  for (const installedFile of [...installedFiles].reverse()) {
    const installed = resolve(dataDir, installedFile.name);
    try {
      assertInPlaceRestoreTarget(dataDir, targetIdentity, expectedTargetClaim);
      assertDirectorySnapshot(stagingDir, stagingSnapshot, "In-place restore staging directory");
      const installedEntry = lstatIfExists(installed);
      if (!installedEntry || !sameOwnedIdentity(installedEntry, installedFile.identity)) {
        fail(`Installed restore file changed before rollback: ${installedFile.name}`);
      }
      const destination = resolve(stagingDir, installedFile.name);
      if (lstatIfExists(destination)) {
        fail(`Rollback staging target is occupied: ${destination}`);
      }
      renameFile(installed, destination);
      assertInPlaceRestoreTarget(dataDir, targetIdentity, expectedTargetClaim);
      assertRuntimeTargetIdentity(stagingDir, stagingIdentity, "In-place restore staging directory");
      const movedEntry = lstatIfExists(destination);
      if (!movedEntry || !sameOwnedIdentity(movedEntry, installedFile.identity)) {
        fail(`Installed restore file changed while it was moved for rollback: ${installedFile.name}`);
      }
      stagingSnapshot.entries.set(installedFile.name, movedEntry);
      assertDirectorySnapshot(stagingDir, stagingSnapshot, "In-place restore staging directory");
    } catch (error) {
      errors.push(error);
      break;
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, `In-place restore rollback is incomplete: ${rollbackDir}`);
  }
  for (const previousFile of [...previousFiles].reverse()) {
    const previous = resolve(rollbackDir, previousFile.name);
    try {
      assertInPlaceRestoreTarget(dataDir, targetIdentity, expectedTargetClaim);
      assertDirectorySnapshot(rollbackDir, rollbackSnapshot, "In-place restore rollback directory");
      const previousEntry = lstatIfExists(previous);
      if (!previousEntry || !sameOwnedIdentity(previousEntry, previousFile.identity)) {
        fail(`Previous runtime file changed before rollback: ${previousFile.name}`);
      }
      const destination = resolve(dataDir, previousFile.name);
      if (lstatIfExists(destination)) {
        fail(`Rollback target is occupied: ${destination}`);
      }
      renameFile(previous, destination);
      assertInPlaceRestoreTarget(dataDir, targetIdentity, expectedTargetClaim);
      assertRuntimeTargetIdentity(rollbackDir, rollbackIdentity, "In-place restore rollback directory");
      const movedEntry = lstatIfExists(destination);
      if (!movedEntry || !sameOwnedIdentity(movedEntry, previousFile.identity)) {
        fail(`Previous runtime file changed while it was moved for rollback: ${previousFile.name}`);
      }
      rollbackSnapshot.entries.delete(previousFile.name);
      assertDirectorySnapshot(rollbackDir, rollbackSnapshot, "In-place restore rollback directory");
    } catch (error) {
      errors.push(error);
      break;
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, `In-place restore rollback is incomplete: ${rollbackDir}`);
}

function restoreRuntimeBackupInPlace({ backupDir, manifest, dataDir, force, renameFile, afterRestoreStaged, expectedTargetClaim, restoredFrom }) {
  const targetParent = dirname(dataDir);
  const targetParentIdentity = assertPrivateOperatorDirectory(targetParent, "In-place restore target parent");
  let targetStat = lstatIfExists(dataDir);
  if (targetStat?.isSymbolicLink()) fail(`In-place restore target must not be a symbolic link: ${dataDir}`);
  if (targetStat && !targetStat.isDirectory()) fail(`In-place restore target must be a directory: ${dataDir}`);
  if (targetStat && expectedTargetClaim) {
    assertRuntimeTargetClaim(dataDir, expectedTargetClaim, "In-place restore target");
  }
  const targetCreated = !targetStat;
  const targetHasFiles = Boolean(targetStat && readdirSync(dataDir).some((name) => name !== expectedTargetClaim?.markerName));
  if (targetHasFiles && !force) {
    fail(`Restore target is not empty: ${dataDir}. Stop the application and pass --force to replace runtime files in place.`);
  }
  if (targetCreated) {
    assertRuntimeTargetIdentity(targetParent, targetParentIdentity, "In-place restore target parent");
    mkdirSync(dataDir, { mode: 0o700 });
    targetStat = lstatSync(dataDir);
    assertRuntimeTargetIdentity(targetParent, targetParentIdentity, "In-place restore target parent");
  }
  const targetIdentity = expectedTargetClaim?.identity ?? targetStat;

  const stagingDir = resolve(dataDir, `.restore-stage-${randomUUID()}`);
  const rollbackDir = resolve(dataDir, `.restore-rollback-${randomUUID()}`);
  const previousFiles = [];
  const installedFiles = [];

  let stagedManifest;
  let stagingIdentity;
  let stagingSnapshot;
  let rollbackIdentity;
  let rollbackSnapshot;
  let rollbackCleanupAmbiguous = false;
  const ambiguousRollbackEntries = new Map();
  try {
    mkdirSync(stagingDir, { mode: 0o700 });
    stagingIdentity = lstatSync(stagingDir);
    mkdirSync(rollbackDir, { mode: 0o700 });
    rollbackIdentity = lstatSync(rollbackDir);
    rollbackSnapshot = directorySnapshot(rollbackDir, new Set(), "In-place restore rollback directory");
    if (!sameIdentity(rollbackSnapshot.root, rollbackIdentity)) {
      fail("In-place restore rollback directory changed identity after creation");
    }
    stagedManifest = stageRuntimeRestore(backupDir, manifest, stagingDir, restoredFrom);
    stagingSnapshot = directorySnapshot(stagingDir, new Set([...manifest.files.map((entry) => entry.name), restoreManifestName]), "In-place restore staging directory");
    if (!sameIdentity(stagingSnapshot.root, stagingIdentity)) {
      fail("In-place restore staging directory changed identity after staging");
    }
    afterRestoreStaged({ stagingDir, dataDir });
    assertDirectorySnapshot(stagingDir, stagingSnapshot, "In-place restore staging directory");
    assertInPlaceRestoreTarget(dataDir, targetIdentity, expectedTargetClaim);
    for (const name of inPlaceManagedNames) {
      assertInPlaceRestoreTarget(dataDir, targetIdentity, expectedTargetClaim);
      assertDirectorySnapshot(rollbackDir, rollbackSnapshot, "In-place restore rollback directory");
      const current = resolve(dataDir, name);
      const currentEntry = lstatIfExists(current);
      if (!currentEntry) continue;
      const destination = resolve(rollbackDir, name);
      if (lstatIfExists(destination)) {
        fail(`Restore rollback target is occupied: ${destination}`);
      }
      renameFile(current, destination);
      assertInPlaceRestoreTarget(dataDir, targetIdentity, expectedTargetClaim);
      assertRuntimeTargetIdentity(rollbackDir, rollbackIdentity, "In-place restore rollback directory");
      const movedEntry = lstatIfExists(destination);
      if (!movedEntry || !sameOwnedIdentity(movedEntry, currentEntry)) {
        rollbackCleanupAmbiguous = true;
        if (movedEntry) ambiguousRollbackEntries.set(name, movedEntry);
        fail(`Runtime file changed while it was moved to rollback: ${name}`);
      }
      previousFiles.push({ name, identity: movedEntry });
      rollbackSnapshot.entries.set(name, movedEntry);
      assertDirectorySnapshot(rollbackDir, rollbackSnapshot, "In-place restore rollback directory");
    }
    for (const name of [...manifest.files.map((entry) => entry.name), restoreManifestName]) {
      assertInPlaceRestoreTarget(dataDir, targetIdentity, expectedTargetClaim);
      assertRuntimeTargetIdentity(stagingDir, stagingIdentity, "In-place restore staging directory");
      const source = resolve(stagingDir, name);
      const sourceEntry = lstatSync(source);
      const expectedSourceEntry = stagingSnapshot.entries.get(name);
      if (!expectedSourceEntry || !sameSnapshot(sourceEntry, expectedSourceEntry)) {
        fail(`Staged restore file changed before it was published: ${name}`);
      }
      const destination = resolve(dataDir, name);
      if (lstatIfExists(destination)) {
        fail(`Restore publish target is occupied: ${destination}`);
      }
      renameFile(source, destination);
      const installedEntry = lstatSync(destination);
      if (!sameOwnedIdentity(installedEntry, sourceEntry)) {
        fail(`Runtime file changed while it was published: ${name}`);
      }
      installedFiles.push({ name, identity: installedEntry });
      stagingSnapshot.entries.delete(name);
      assertDirectorySnapshot(stagingDir, stagingSnapshot, "In-place restore staging directory");
    }
    verifyStagedRuntimeRestore(dataDir, manifest);
  } catch (error) {
    let rollbackError;
    const cleanupErrors = [];
    if (previousFiles.length > 0 || installedFiles.length > 0) {
      try {
        rollbackInPlaceRestore({
          dataDir,
          stagingDir,
          stagingIdentity,
          stagingSnapshot,
          rollbackDir,
          rollbackIdentity,
          rollbackSnapshot,
          targetIdentity,
          expectedTargetClaim,
          installedFiles,
          previousFiles,
          renameFile
        });
      } catch (candidate) {
        rollbackError = candidate;
      }
    }
    if (!rollbackError) {
      if (stagingIdentity && lstatIfExists(stagingDir)) {
        try {
          if (stagingSnapshot) {
            removeClaimedFlatDirectory(stagingDir, stagingSnapshot, "In-place restore staging directory");
          } else {
            removeOwnedFlatDirectory(stagingDir, stagingIdentity, restoreStagingNames, "In-place restore staging directory");
          }
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      if (rollbackIdentity && lstatIfExists(rollbackDir)) {
        try {
          if (rollbackCleanupAmbiguous) {
            throw new Error(`In-place restore rollback directory contains ${ambiguousRollbackEntries.size || "untracked"} ambiguous moved entry or entries and was preserved`);
          }
          if (rollbackSnapshot) {
            removeClaimedFlatDirectory(rollbackDir, rollbackSnapshot, "In-place restore rollback directory");
          } else {
            removeOwnedFlatDirectory(rollbackDir, rollbackIdentity, inPlaceManagedSet, "In-place restore rollback directory");
          }
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      if (targetCreated) {
        try {
          assertRuntimeTargetIdentity(dataDir, targetIdentity, "In-place restore target");
          if (readdirSync(dataDir).length === 0) rmdirSync(dataDir);
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
    }
    if (rollbackError || cleanupErrors.length > 0) {
      throw new AggregateError([error, ...(rollbackError ? [rollbackError] : []), ...cleanupErrors], `In-place restore failed and rollback or cleanup is incomplete; recovery files remain under ${dataDir}`);
    }
    throw error;
  }

  const cleanupErrors = [];
  try {
    removeClaimedFlatDirectory(stagingDir, stagingSnapshot, "In-place restore staging directory");
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    removeClaimedFlatDirectory(rollbackDir, rollbackSnapshot, "In-place restore rollback directory");
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, `In-place restore was published, but cleanup was refused; inspect ${stagingDir} and ${rollbackDir}`);
  }
  return { dataDir, manifest: stagedManifest };
}

export function restoreRuntimeBackup({ backupDirectory, dataDirectory = defaultDataDir, force = false, inPlace = false, renameFile = renameSync, afterRestoreStaged = () => {}, expectedTargetClaim, restoredFrom }) {
  if (!backupDirectory) fail("restore requires a backup directory");
  const { backupDir, manifest } = verifyRuntimeBackup(backupDirectory);
  if (restoredFrom !== undefined && (typeof restoredFrom !== "string" || restoredFrom.trim() === "")) {
    fail("restoredFrom must be a non-empty filesystem path");
  }
  const normalizedRestoredFrom = restoredFrom === undefined ? backupDir : resolve(restoredFrom);
  const dataDir = resolve(dataDirectory);
  if (isInside(dataDir, backupDir)) fail("Backup source must be outside the runtime data directory");
  if (inPlace) {
    if (lstatIfExists(dataDir)) {
      assertRealDirectoryPath(dataDir, "In-place restore target");
    } else {
      assertPrivateOperatorDirectory(dirname(dataDir), "In-place restore target parent");
    }
    return restoreRuntimeBackupInPlace({
      backupDir,
      manifest,
      dataDir,
      force,
      renameFile,
      afterRestoreStaged,
      expectedTargetClaim,
      restoredFrom: normalizedRestoredFrom
    });
  }
  const parent = dirname(dataDir);
  const parentIdentity = assertPrivateOperatorDirectory(parent, "Restore target parent");
  let targetEntry = lstatIfExists(dataDir);
  let targetCreated = false;
  if (!targetEntry) {
    assertRuntimeTargetIdentity(parent, parentIdentity, "Restore target parent");
    try {
      mkdirSync(dataDir, { mode: 0o700 });
    } catch (error) {
      if (error?.code === "EEXIST") {
        fail(`Restore target appeared before its exclusive claim: ${dataDir}`);
      }
      throw error;
    }
    targetCreated = true;
    targetEntry = lstatSync(dataDir);
    assertRuntimeTargetIdentity(parent, parentIdentity, "Restore target parent");
  } else {
    assertRealDirectoryPath(dataDir, "Restore target");
  }
  if (targetEntry.isSymbolicLink() || !targetEntry.isDirectory()) {
    fail(`Restore target must be a real directory: ${dataDir}`);
  }
  const currentUid = process.getuid?.();
  if (currentUid !== undefined && targetEntry.uid !== currentUid) {
    fail(`Restore target must be owned by the recovery operator: ${dataDir}`);
  }
  if ((targetEntry.mode & 0o022) !== 0) {
    fail(`Restore target must not be group or world writable: ${dataDir}`);
  }
  const targetSnapshot = directorySnapshot(dataDir, restoreStagingNames, "Existing runtime target");
  if (targetSnapshot.entries.size > 0 && !force) {
    fail(`Restore target is not empty: ${dataDir}. Stop the application and pass --force to replace it.`);
  }
  const claim = createRuntimeTargetClaim(dataDir, targetEntry);
  try {
    const result = restoreRuntimeBackupInPlace({
      backupDir,
      manifest,
      dataDir,
      force,
      renameFile,
      afterRestoreStaged,
      expectedTargetClaim: claim,
      restoredFrom: normalizedRestoredFrom
    });
    releaseRuntimeTargetClaim(dataDir, claim);
    return result;
  } catch (error) {
    const cleanupErrors = [];
    try {
      releaseRuntimeTargetClaim(dataDir, claim);
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
    if (targetCreated && claim.released) {
      try {
        const current = assertRuntimeTargetIdentity(dataDir, claim.identity, "Runtime restore target");
        if (readdirSync(dataDir).length === 0) {
          rmdirSync(dataDir);
        } else if (!current.isDirectory()) {
          fail("Runtime restore target changed type");
        }
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError([error, ...cleanupErrors], `Runtime restore failed and exclusive target cleanup was incomplete: ${dataDir}`);
    }
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
