import { execFileSync, spawnSync } from "node:child_process";
import { scryptSync } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { inspectEncryptedTradingRows, restoreRuntimeBackup } from "../../scripts/runtime-data.mjs";
import { sealCredentialPayload } from "../src/trading/credentialCrypto.js";

const root = path.resolve(import.meta.dirname, "../..");
const script = path.resolve(root, "scripts/runtime-data.mjs");
const temporaryDirectories: string[] = [];
const TEST_SECRET = "11".repeat(32);
const BACKUP_SECRET = "22".repeat(32);
const STALE_SECRET = "33".repeat(32);
const TEST_KEY = scryptSync(TEST_SECRET, "marketforge", 32);

function temporaryDirectory() {
  const directory = mkdtempSync(path.join(tmpdir(), "saltanat-runtime-data-"));
  temporaryDirectories.push(directory);
  return directory;
}

function seedRuntimeData(dataDir: string, marker = "original", encryptedRows = false) {
  mkdirSync(dataDir, { recursive: true });
  const trading = new DatabaseSync(path.resolve(dataDir, "trading.db"));
  trading.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, encrypted INTEGER NOT NULL DEFAULT 0)");
  trading.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("marker", marker);
  if (encryptedRows) trading.prepare("INSERT INTO settings (key, value, encrypted) VALUES (?, ?, 1)").run("encrypted-fixture", sealCredentialPayload(TEST_KEY, "{}"));
  trading.close();
  const candles = new DatabaseSync(path.resolve(dataDir, "candles.db"));
  candles.exec("CREATE TABLE candles (symbol TEXT PRIMARY KEY, close REAL NOT NULL)");
  candles.prepare("INSERT INTO candles (symbol, close) VALUES (?, ?)").run("BTCUSDT", 100_000);
  candles.close();
  const paperMultiLeg = new DatabaseSync(path.resolve(dataDir, "arbitrage-paper-multi-leg.sqlite"));
  paperMultiLeg.exec("CREATE TABLE runs (runId TEXT PRIMARY KEY, status TEXT NOT NULL)");
  paperMultiLeg.prepare("INSERT INTO runs (runId, status) VALUES (?, ?)").run("paper-backup-fixture", "completed");
  paperMultiLeg.close();
  writeFileSync(path.resolve(dataDir, ".secret"), TEST_SECRET, { mode: 0o600 });
  writeFileSync(path.resolve(dataDir, ".authtoken"), "test-token", { mode: 0o600 });
}

function run(...args: string[]) {
  return execFileSync(process.execPath, [script, ...args], { cwd: root, encoding: "utf8" });
}

function runtimeMarker(dataDir: string) {
  const database = new DatabaseSync(path.resolve(dataDir, "trading.db"), { readOnly: true });
  try {
    return database.prepare("SELECT value FROM settings WHERE key = 'marker'").get();
  } finally {
    database.close();
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("runtime data backup and restore", () => {
  it("backs up both databases and the encryption material with a verified manifest", () => {
    const workspace = temporaryDirectory();
    const dataDir = path.resolve(workspace, "data");
    const backupDir = path.resolve(workspace, "backup");
    seedRuntimeData(dataDir);

    expect(run("backup", "--data-dir", dataDir, "--output", backupDir)).toContain("created and verified");
    expect(run("verify", backupDir)).toContain("verified (4 files)");

    const manifest = JSON.parse(readFileSync(path.resolve(backupDir, "backup-manifest.json"), "utf8"));
    expect(manifest.format).toBe("saltanatbotv2-runtime-backup");
    expect(manifest.files.find((entry: { name: string }) => entry.name === "trading.db")).toMatchObject({
      sqliteUserVersion: 0
    });
    expect(manifest.files.map((entry: { name: string }) => entry.name)).toEqual([".secret", "arbitrage-paper-multi-leg.sqlite", "candles.db", "trading.db"]);
    expect(() => readFileSync(path.resolve(backupDir, ".authtoken"), "utf8")).toThrow();
  });

  it("normalizes WAL databases into portable single-file backups", () => {
    const workspace = temporaryDirectory();
    const dataDir = path.resolve(workspace, "data");
    const backupDir = path.resolve(workspace, "backup");
    seedRuntimeData(dataDir);
    const databasePath = path.resolve(dataDir, "arbitrage-paper-multi-leg.sqlite");
    const writer = new DatabaseSync(databasePath);
    writer.exec("PRAGMA journal_mode=WAL");
    writer.prepare("INSERT INTO runs (runId, status) VALUES (?, ?)").run("wal-row", "completed");

    expect(run("backup", "--data-dir", dataDir, "--output", backupDir)).toContain("created and verified");
    writer.close();
    expect(run("verify", backupDir)).toContain("verified (4 files)");
    expect(() => readFileSync(`${path.resolve(backupDir, "arbitrage-paper-multi-leg.sqlite")}-shm`)).toThrow();
    expect(() => readFileSync(`${path.resolve(backupDir, "arbitrage-paper-multi-leg.sqlite")}-wal`)).toThrow();
  });

  it("restores atomically and refuses to overwrite runtime state without force", () => {
    const workspace = temporaryDirectory();
    const sourceDir = path.resolve(workspace, "source");
    const targetDir = path.resolve(workspace, "target");
    const backupDir = path.resolve(workspace, "backup");
    seedRuntimeData(sourceDir, "from-backup");
    seedRuntimeData(targetDir, "must-not-survive");
    writeFileSync(path.resolve(targetDir, "ordinary-restore-sentinel.txt"), "ordinary swap removes this");
    run("backup", "--data-dir", sourceDir, "--output", backupDir);

    const refused = spawnSync(process.execPath, [script, "restore", backupDir, "--data-dir", targetDir], {
      cwd: root,
      encoding: "utf8"
    });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("Restore target is not empty");

    expect(run("restore", backupDir, "--data-dir", targetDir, "--force")).toContain("restored and verified");
    const restored = new DatabaseSync(path.resolve(targetDir, "trading.db"), { readOnly: true });
    expect(restored.prepare("SELECT value FROM settings WHERE key = 'marker'").get()).toMatchObject({
      value: "from-backup"
    });
    restored.close();
    const restoredPaperMultiLeg = new DatabaseSync(path.resolve(targetDir, "arbitrage-paper-multi-leg.sqlite"), { readOnly: true });
    expect(restoredPaperMultiLeg.prepare("SELECT status FROM runs WHERE runId = ?").get("paper-backup-fixture")).toMatchObject({ status: "completed" });
    restoredPaperMultiLeg.close();
    expect(readFileSync(path.resolve(targetDir, ".secret"), "utf8")).toBe(TEST_SECRET);
    expect(existsSync(path.resolve(targetDir, "ordinary-restore-sentinel.txt"))).toBe(false);
  });

  it("restores a stopped named volume in place while preserving unrelated files", () => {
    const workspace = temporaryDirectory();
    const sourceDir = path.resolve(workspace, "source");
    const targetDir = path.resolve(workspace, "target");
    const backupDir = path.resolve(workspace, "backup");
    seedRuntimeData(sourceDir, "from-in-place-backup");
    rmSync(path.resolve(sourceDir, "candles.db"));
    rmSync(path.resolve(sourceDir, "arbitrage-paper-multi-leg.sqlite"));
    writeFileSync(path.resolve(sourceDir, ".secret"), BACKUP_SECRET, { mode: 0o600 });
    run("backup", "--data-dir", sourceDir, "--output", backupDir);

    seedRuntimeData(targetDir, "stale-target");
    writeFileSync(path.resolve(targetDir, ".secret"), STALE_SECRET, { mode: 0o600 });
    writeFileSync(path.resolve(targetDir, ".restore-manifest.json"), "stale restore manifest", { mode: 0o600 });
    const unrelated = path.resolve(targetDir, "operator-notes.txt");
    writeFileSync(unrelated, "preserve me", { mode: 0o640 });
    const nested = path.resolve(targetDir, "unrelated-directory");
    mkdirSync(nested);
    writeFileSync(path.resolve(nested, "note.txt"), "also preserve me");
    const staleSidecars = ["trading.db", "candles.db", "arbitrage-paper-multi-leg.sqlite"].flatMap((name) => ["-wal", "-shm", "-journal"].map((suffix) => path.resolve(targetDir, `${name}${suffix}`)));
    for (const sidecar of staleSidecars) writeFileSync(sidecar, "stale sidecar");
    const before = statSync(targetDir);

    expect(run("restore", backupDir, "--data-dir", targetDir, "--in-place", "--force")).toContain("restored and verified");

    const after = statSync(targetDir);
    expect({ dev: after.dev, ino: after.ino }).toEqual({ dev: before.dev, ino: before.ino });
    expect(runtimeMarker(targetDir)).toMatchObject({ value: "from-in-place-backup" });
    expect(readFileSync(path.resolve(targetDir, ".secret"), "utf8")).toBe(BACKUP_SECRET);
    expect(readFileSync(unrelated, "utf8")).toBe("preserve me");
    expect(readFileSync(path.resolve(nested, "note.txt"), "utf8")).toBe("also preserve me");
    expect(existsSync(path.resolve(targetDir, "candles.db"))).toBe(false);
    expect(existsSync(path.resolve(targetDir, "arbitrage-paper-multi-leg.sqlite"))).toBe(false);
    expect(existsSync(path.resolve(targetDir, ".authtoken"))).toBe(false);
    for (const sidecar of staleSidecars) expect(existsSync(sidecar)).toBe(false);
    expect(JSON.parse(readFileSync(path.resolve(targetDir, ".restore-manifest.json"), "utf8"))).toMatchObject({
      format: "saltanatbotv2-runtime-backup",
      restoredFrom: backupDir
    });
    expect(readdirSync(targetDir).some((name) => name.startsWith(".restore-stage-") || name.startsWith(".restore-rollback-"))).toBe(false);
  });

  it("refuses a nonempty in-place target without force", () => {
    const workspace = temporaryDirectory();
    const sourceDir = path.resolve(workspace, "source");
    const targetDir = path.resolve(workspace, "target");
    const backupDir = path.resolve(workspace, "backup");
    seedRuntimeData(sourceDir, "new-value");
    seedRuntimeData(targetDir, "old-value");
    run("backup", "--data-dir", sourceDir, "--output", backupDir);

    const refused = spawnSync(process.execPath, [script, "restore", backupDir, "--data-dir", targetDir, "--in-place"], {
      cwd: root,
      encoding: "utf8"
    });

    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("Restore target is not empty");
    expect(runtimeMarker(targetDir)).toMatchObject({ value: "old-value" });
    expect(readdirSync(targetDir).some((name) => name.startsWith(".restore-stage-") || name.startsWith(".restore-rollback-"))).toBe(false);
  });

  it("rejects symlink and non-directory in-place targets", () => {
    const workspace = temporaryDirectory();
    const sourceDir = path.resolve(workspace, "source");
    const realTarget = path.resolve(workspace, "real-target");
    const symlinkTarget = path.resolve(workspace, "target-link");
    const fileTarget = path.resolve(workspace, "target-file");
    const backupDir = path.resolve(workspace, "backup");
    seedRuntimeData(sourceDir);
    mkdirSync(realTarget);
    symlinkSync(realTarget, symlinkTarget, "dir");
    writeFileSync(fileTarget, "not a directory");
    run("backup", "--data-dir", sourceDir, "--output", backupDir);

    const symlinkResult = spawnSync(process.execPath, [script, "restore", backupDir, "--data-dir", symlinkTarget, "--in-place", "--force"], { cwd: root, encoding: "utf8" });
    const fileResult = spawnSync(process.execPath, [script, "restore", backupDir, "--data-dir", fileTarget, "--in-place", "--force"], { cwd: root, encoding: "utf8" });

    expect(symlinkResult.status).toBe(1);
    expect(symlinkResult.stderr).toContain("must not be a symbolic link");
    expect(lstatSync(symlinkTarget).isSymbolicLink()).toBe(true);
    expect(fileResult.status).toBe(1);
    expect(fileResult.stderr).toContain("must be a directory");
    expect(readFileSync(fileTarget, "utf8")).toBe("not a directory");
  });

  it("rolls every managed file back when an in-place publish rename fails", () => {
    const workspace = temporaryDirectory();
    const sourceDir = path.resolve(workspace, "source");
    const targetDir = path.resolve(workspace, "target");
    const backupDir = path.resolve(workspace, "backup");
    seedRuntimeData(sourceDir, "new-value");
    writeFileSync(path.resolve(sourceDir, ".secret"), BACKUP_SECRET, { mode: 0o600 });
    seedRuntimeData(targetDir, "old-value");
    writeFileSync(path.resolve(targetDir, ".secret"), STALE_SECRET, { mode: 0o600 });
    writeFileSync(path.resolve(targetDir, ".restore-manifest.json"), "old restore manifest", { mode: 0o600 });
    writeFileSync(path.resolve(targetDir, "unrelated.txt"), "preserved");
    const oldSidecars = ["trading.db-wal", "candles.db-shm", "arbitrage-paper-multi-leg.sqlite-journal"];
    for (const name of oldSidecars) writeFileSync(path.resolve(targetDir, name), `old ${name}`);
    run("backup", "--data-dir", sourceDir, "--output", backupDir);
    let injected = false;

    expect(() =>
      restoreRuntimeBackup({
        backupDirectory: backupDir,
        dataDirectory: targetDir,
        force: true,
        inPlace: true,
        renameFile(source: string, destination: string) {
          if (!injected && path.basename(path.dirname(source)).startsWith(".restore-stage-") && path.basename(destination) === "trading.db") {
            injected = true;
            throw new Error("injected publish failure");
          }
          renameSync(source, destination);
        }
      })
    ).toThrow("injected publish failure");

    expect(injected).toBe(true);
    for (const name of oldSidecars) expect(readFileSync(path.resolve(targetDir, name), "utf8")).toBe(`old ${name}`);
    for (const name of oldSidecars) rmSync(path.resolve(targetDir, name));
    expect(runtimeMarker(targetDir)).toMatchObject({ value: "old-value" });
    expect(readFileSync(path.resolve(targetDir, ".secret"), "utf8")).toBe(STALE_SECRET);
    expect(readFileSync(path.resolve(targetDir, ".restore-manifest.json"), "utf8")).toBe("old restore manifest");
    expect(readFileSync(path.resolve(targetDir, "unrelated.txt"), "utf8")).toBe("preserved");
    expect(readdirSync(targetDir).some((name) => name.startsWith(".restore-stage-") || name.startsWith(".restore-rollback-"))).toBe(false);
  });

  it("rejects a backup after any manifested file is modified", () => {
    const workspace = temporaryDirectory();
    const dataDir = path.resolve(workspace, "data");
    const backupDir = path.resolve(workspace, "backup");
    seedRuntimeData(dataDir);
    run("backup", "--data-dir", dataDir, "--output", backupDir);
    writeFileSync(path.resolve(backupDir, ".secret"), "tampered");

    const result = spawnSync(process.execPath, [script, "verify", backupDir], { cwd: root, encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/size mismatch|checksum mismatch/);
  });

  it("never mutates a backup while rejecting an unmanifested SQLite sidecar", () => {
    const workspace = temporaryDirectory();
    const dataDir = path.resolve(workspace, "data");
    const backupDir = path.resolve(workspace, "backup");
    const sidecar = path.resolve(backupDir, "trading.db-wal");
    seedRuntimeData(dataDir);
    run("backup", "--data-dir", dataDir, "--output", backupDir);
    writeFileSync(sidecar, "unexpected sidecar");

    const result = spawnSync(process.execPath, [script, "verify", backupDir], { cwd: root, encoding: "utf8" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unmanifested file: trading.db-wal");
    expect(readFileSync(sidecar, "utf8")).toBe("unexpected sidecar");
  });

  it("reports a read-only encrypted-row inventory without reading key material", () => {
    const workspace = temporaryDirectory();
    const dataDir = path.resolve(workspace, "data");
    seedRuntimeData(dataDir, "inventory", true);
    const database = new DatabaseSync(path.resolve(dataDir, "trading.db"));
    database.exec("CREATE TABLE trading_account_credentials (encryptedValue TEXT NOT NULL)");
    database.prepare("INSERT INTO trading_account_credentials (encryptedValue) VALUES (?)").run("opaque-account-ciphertext");
    database.close();

    expect(inspectEncryptedTradingRows(path.resolve(dataDir, "trading.db"))).toEqual({ encryptedSettings: 1, accountCredentials: 1, total: 2 });
    expect(run("inventory", "--data-dir", dataDir)).toContain("settings=1, accountCredentials=1, total=2");
  });

  it("includes committed WAL rows in the read-only inventory", () => {
    const workspace = temporaryDirectory();
    const dataDir = path.resolve(workspace, "data");
    seedRuntimeData(dataDir, "wal-inventory");
    const databasePath = path.resolve(dataDir, "trading.db");
    const writer = new DatabaseSync(databasePath);
    writer.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0");
    writer.prepare("INSERT INTO settings (key, value, encrypted) VALUES (?, ?, 1)").run("wal-ciphertext", "opaque");
    const walPath = `${databasePath}-wal`;
    const databaseBefore = readFileSync(databasePath);
    const walBefore = readFileSync(walPath);

    try {
      expect(inspectEncryptedTradingRows(databasePath)).toEqual({ encryptedSettings: 1, accountCredentials: 0, total: 1 });
      expect(run("inventory", "--data-dir", dataDir)).toContain("settings=1, accountCredentials=0, total=1");
      expect(readFileSync(databasePath)).toEqual(databaseBefore);
      expect(readFileSync(walPath)).toEqual(walBefore);
    } finally {
      writer.close();
    }
  });

  it("refuses to create or verify a backup that omits the key", () => {
    const workspace = temporaryDirectory();
    const dataDir = path.resolve(workspace, "data");
    const refusedBackup = path.resolve(workspace, "refused-backup");
    seedRuntimeData(dataDir, "encrypted-source", true);
    rmSync(path.resolve(dataDir, ".secret"));

    const missingSourceKey = spawnSync(process.execPath, [script, "backup", "--data-dir", dataDir, "--output", refusedBackup], { cwd: root, encoding: "utf8" });
    expect(missingSourceKey.status).toBe(1);
    expect(missingSourceKey.stderr).toMatch(/does not contain \.secret/i);
    expect(existsSync(refusedBackup)).toBe(false);

    const validData = path.resolve(workspace, "valid-data");
    const incompleteBackup = path.resolve(workspace, "incomplete-backup");
    seedRuntimeData(validData, "encrypted-backup", true);
    run("backup", "--data-dir", validData, "--output", incompleteBackup);
    const manifestPath = path.resolve(incompleteBackup, "backup-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.files = manifest.files.filter((entry: { name: string }) => entry.name !== ".secret");
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    rmSync(path.resolve(incompleteBackup, ".secret"));

    const missingBackupKey = spawnSync(process.execPath, [script, "verify", incompleteBackup], { cwd: root, encoding: "utf8" });
    expect(missingBackupKey.status).toBe(1);
    expect(missingBackupKey.stderr).toMatch(/does not contain \.secret/i);
  });

  it("rejects an unencrypted trading database without its mandatory master key", () => {
    const workspace = temporaryDirectory();
    const dataDir = path.resolve(workspace, "data");
    const backupDir = path.resolve(workspace, "backup");
    seedRuntimeData(dataDir, "empty-key-unit");
    rmSync(path.resolve(dataDir, ".secret"));

    const result = spawnSync(process.execPath, [script, "backup", "--data-dir", dataDir, "--output", backupDir], { cwd: root, encoding: "utf8" });

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/does not contain \.secret/i);
    expect(existsSync(backupDir)).toBe(false);
  });

  it("rejects a well-formed master key that cannot decrypt the backed-up rows", () => {
    const workspace = temporaryDirectory();
    const dataDir = path.resolve(workspace, "data");
    const backupDir = path.resolve(workspace, "backup");
    seedRuntimeData(dataDir, "wrong-key", true);
    writeFileSync(path.resolve(dataDir, ".secret"), BACKUP_SECRET, { mode: 0o600 });

    const result = spawnSync(process.execPath, [script, "backup", "--data-dir", dataDir, "--output", backupDir], { cwd: root, encoding: "utf8" });

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/cannot decrypt every encrypted trading row/i);
    expect(existsSync(backupDir)).toBe(false);
  });

  it("rejects a backup key that became group or world readable", () => {
    const workspace = temporaryDirectory();
    const dataDir = path.resolve(workspace, "data");
    const backupDir = path.resolve(workspace, "backup");
    seedRuntimeData(dataDir);
    run("backup", "--data-dir", dataDir, "--output", backupDir);
    const keyPath = path.resolve(backupDir, ".secret");
    chmodSync(keyPath, 0o644);

    const result = spawnSync(process.execPath, [script, "verify", backupDir], { cwd: root, encoding: "utf8" });

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/permissions must be 0600 or read-only 0400/i);
    expect(lstatSync(keyPath).mode & 0o777).toBe(0o644);
  });
});
