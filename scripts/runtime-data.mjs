import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync, backup as sqliteBackup } from "node:sqlite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultDataDir = resolve(root, "backend/data");
const databaseNames = ["trading.db", "candles.db", "arbitrage-paper-multi-leg.sqlite"];
const sensitiveNames = [".secret", ".authtoken"];
const allowedNames = new Set([...databaseNames, ...sensitiveNames]);
const manifestName = "backup-manifest.json";
const formatName = "saltanatbotv2-runtime-backup";
const formatVersion = 1;

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

function assertSqliteIntegrity(path) {
  const handle = new DatabaseSync(path, { readOnly: true });
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
  const manifest = readManifest(backupDir);
  const seen = new Set();

  for (const entry of manifest.files) {
    if (!entry || typeof entry.name !== "string" || !allowedNames.has(entry.name)) {
      fail(`Backup manifest contains an unsupported file: ${entry?.name ?? "unknown"}`);
    }
    if (seen.has(entry.name)) fail(`Backup manifest contains a duplicate file: ${entry.name}`);
    seen.add(entry.name);
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

  const actualFiles = readdirSync(backupDir).filter((name) => name !== manifestName);
  for (const name of actualFiles) {
    if (!seen.has(name)) fail(`Backup contains an unmanifested file: ${name}`);
  }
  if (!seen.has("trading.db")) fail("Backup does not contain trading.db");

  return { backupDir, manifest };
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
      chmodSync(destination, 0o600);
      const sqliteUserVersion = assertSqliteIntegrity(destination);
      const stat = statSync(destination);
      files.push({ name, size: stat.size, sha256: sha256(destination), mode: "0600", sqliteUserVersion });
    }

    for (const name of sensitiveNames) {
      const source = resolve(dataDir, name);
      if (!existsSync(source)) continue;
      assertRegularFile(source, `Runtime file ${name}`);
      const destination = resolve(stagingDir, name);
      copyFileSync(source, destination);
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
      files: files.sort((left, right) => left.name.localeCompare(right.name)),
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

export function restoreRuntimeBackup({ backupDirectory, dataDirectory = defaultDataDir, force = false }) {
  if (!backupDirectory) fail("restore requires a backup directory");
  const { backupDir, manifest } = verifyRuntimeBackup(backupDirectory);
  const dataDir = resolve(dataDirectory);
  if (isInside(dataDir, backupDir)) fail("Backup source must be outside the runtime data directory");
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
    for (const entry of manifest.files) {
      const destination = resolve(stagingDir, entry.name);
      copyFileSync(resolve(backupDir, entry.name), destination);
      chmodSync(destination, 0o600);
    }
    const stagedManifest = {
      ...manifest,
      restoredAt: new Date().toISOString(),
      restoredFrom: backupDir,
    };
    writeFileSync(resolve(stagingDir, ".restore-manifest.json"), `${JSON.stringify(stagedManifest, null, 2)}\n`, {
      mode: 0o600,
    });
    for (const name of databaseNames) {
      const database = resolve(stagingDir, name);
      if (existsSync(database)) assertSqliteIntegrity(database);
    }

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
  npm run data:restore -- <backup-directory> [--data-dir <directory>] [--force]

Restore replaces runtime data only with --force. Stop the application before restoring.`);
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
      outputDirectory: readOption(args, "--output"),
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
    });
    console.log(`Runtime data restored and verified: ${result.dataDir}`);
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
