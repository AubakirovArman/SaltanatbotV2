import { execFileSync, spawnSync } from "node:child_process";
import { scryptSync } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntimeBackup, inspectEncryptedTradingRows, restoreRuntimeBackup, verifyRuntimeBackup } from "../../scripts/runtime-data.mjs";
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
  });

  it("writes a normalized restoredFrom override into the staged restore manifest", () => {
    const workspace = temporaryDirectory();
    const sourceDir = path.resolve(workspace, "source");
    const targetDir = path.resolve(workspace, "target");
    const backupDir = path.resolve(workspace, "backup");
    const restoredFrom = path.resolve(workspace, "generation", "..", "verified-generation", "runtime");
    let stagedRestoredFrom = "";
    seedRuntimeData(sourceDir, "from-backup");
    run("backup", "--data-dir", sourceDir, "--output", backupDir);

    restoreRuntimeBackup({
      backupDirectory: backupDir,
      dataDirectory: targetDir,
      restoredFrom,
      afterRestoreStaged({ stagingDir }: { stagingDir: string }) {
        stagedRestoredFrom = JSON.parse(readFileSync(path.resolve(stagingDir, ".restore-manifest.json"), "utf8")).restoredFrom;
      }
    });

    expect(stagedRestoredFrom).toBe(path.resolve(restoredFrom));
    expect(JSON.parse(readFileSync(path.resolve(targetDir, ".restore-manifest.json"), "utf8")).restoredFrom).toBe(path.resolve(restoredFrom));
  });

  it("refuses force replacement of a target with unmanaged entries and preserves them", () => {
    const workspace = temporaryDirectory();
    const sourceDir = path.resolve(workspace, "source");
    const targetDir = path.resolve(workspace, "target");
    const backupDir = path.resolve(workspace, "backup");
    const foreignFile = path.resolve(targetDir, "operator-notes.txt");
    seedRuntimeData(sourceDir, "from-backup");
    seedRuntimeData(targetDir, "must-survive");
    writeFileSync(foreignFile, "do not delete");
    run("backup", "--data-dir", sourceDir, "--output", backupDir);

    expect(() =>
      restoreRuntimeBackup({
        backupDirectory: backupDir,
        dataDirectory: targetDir,
        force: true
      })
    ).toThrow(/unexpected entry.*operator-notes\.txt/i);

    expect(readFileSync(foreignFile, "utf8")).toBe("do not delete");
    expect(runtimeMarker(targetDir)).toMatchObject({ value: "must-survive" });
  });

  it("preserves a foreign file injected into backup staging instead of recursively deleting it", async () => {
    const workspace = temporaryDirectory();
    const dataDir = path.resolve(workspace, "data");
    const backupDir = path.resolve(workspace, "backup");
    let foreignFile = "";
    seedRuntimeData(dataDir);

    await expect(
      createRuntimeBackup({
        dataDirectory: dataDir,
        outputDirectory: backupDir,
        afterBackupStaged({ stagingDir }: { stagingDir: string }) {
          foreignFile = path.resolve(stagingDir, "foreign-staging.txt");
          writeFileSync(foreignFile, "preserve me");
          throw new Error("injected backup failure");
        }
      })
    ).rejects.toThrow(/cleanup was refused/i);

    expect(readFileSync(foreignFile, "utf8")).toBe("preserve me");
    expect(existsSync(backupDir)).toBe(false);
  });

  it("preserves an allowed-name replacement raced over a staged backup entry", async () => {
    const workspace = temporaryDirectory();
    const dataDir = path.resolve(workspace, "data");
    const backupDir = path.resolve(workspace, "backup");
    const displacedSecret = path.resolve(workspace, "tool-created-staged-secret");
    let stagingDir = "";
    let foreignIdentity: { dev: bigint | number; ino: bigint | number } | undefined;
    seedRuntimeData(dataDir);

    await expect(
      createRuntimeBackup({
        dataDirectory: dataDir,
        outputDirectory: backupDir,
        afterBackupStaged({ stagingDir: candidate }: { stagingDir: string }) {
          stagingDir = candidate;
          const stagedSecret = path.resolve(stagingDir, ".secret");
          renameSync(stagedSecret, displacedSecret);
          writeFileSync(stagedSecret, TEST_SECRET, { mode: 0o600 });
          const replacement = lstatSync(stagedSecret);
          foreignIdentity = { dev: replacement.dev, ino: replacement.ino };
          throw new Error("injected allowed-name replacement");
        }
      })
    ).rejects.toThrow(/cleanup was refused/i);

    const retained = lstatSync(path.resolve(stagingDir, ".secret"));
    expect({ dev: retained.dev, ino: retained.ino }).toEqual(foreignIdentity);
    expect(readFileSync(path.resolve(stagingDir, ".secret"), "utf8")).toBe(TEST_SECRET);
    expect(readFileSync(displacedSecret, "utf8")).toBe(TEST_SECRET);
    expect(existsSync(backupDir)).toBe(false);
  });

  it("does not replace a foreign backup output raced before its exclusive claim", async () => {
    const workspace = temporaryDirectory();
    const dataDir = path.resolve(workspace, "data");
    const backupDir = path.resolve(workspace, "backup");
    seedRuntimeData(dataDir);
    let foreignIdentity: { dev: bigint | number; ino: bigint | number } | undefined;

    await expect(
      createRuntimeBackup({
        dataDirectory: dataDir,
        outputDirectory: backupDir,
        beforeBackupPublish({ outputDir }: { outputDir: string }) {
          mkdirSync(outputDir, { mode: 0o700 });
          const entry = lstatSync(outputDir);
          foreignIdentity = { dev: entry.dev, ino: entry.ino };
        }
      })
    ).rejects.toThrow(/exclusive claim/i);

    const retained = lstatSync(backupDir);
    expect({ dev: retained.dev, ino: retained.ino }).toEqual(foreignIdentity);
    expect(readdirSync(backupDir)).toEqual([]);
  });

  it("rejects an oversized runtime manifest before parsing it", async () => {
    const workspace = temporaryDirectory();
    const dataDir = path.resolve(workspace, "data");
    const backupDir = path.resolve(workspace, "backup");
    seedRuntimeData(dataDir);
    await createRuntimeBackup({ dataDirectory: dataDir, outputDirectory: backupDir });
    writeFileSync(path.resolve(backupDir, "backup-manifest.json"), Buffer.alloc(1024 * 1024 + 1, 0x20), { mode: 0o600 });

    expect(() => verifyRuntimeBackup(backupDir)).toThrow(/manifest is too large/i);
  });

  it("preserves a foreign file injected into restore staging instead of recursively deleting it", () => {
    const workspace = temporaryDirectory();
    const sourceDir = path.resolve(workspace, "source");
    const targetDir = path.resolve(workspace, "target");
    const backupDir = path.resolve(workspace, "backup");
    let foreignFile = "";
    seedRuntimeData(sourceDir);
    run("backup", "--data-dir", sourceDir, "--output", backupDir);

    expect(() =>
      restoreRuntimeBackup({
        backupDirectory: backupDir,
        dataDirectory: targetDir,
        afterRestoreStaged({ stagingDir }: { stagingDir: string }) {
          foreignFile = path.resolve(stagingDir, "foreign-staging.txt");
          writeFileSync(foreignFile, "preserve me");
          throw new Error("injected restore failure");
        }
      })
    ).toThrow(/rollback or cleanup is incomplete/i);

    expect(readFileSync(foreignFile, "utf8")).toBe("preserve me");
    expect(existsSync(targetDir)).toBe(true);
  });

  it.each([
    { label: "claimed ordinary restore", inPlace: false },
    { label: "direct in-place restore", inPlace: true }
  ])("preserves an allowed-name replacement in restore staging ($label)", ({ inPlace }) => {
    const workspace = temporaryDirectory();
    const sourceDir = path.resolve(workspace, "source");
    const targetDir = path.resolve(workspace, "target");
    const backupDir = path.resolve(workspace, "backup");
    const displacedSecret = path.resolve(workspace, `tool-created-restore-secret-${inPlace}`);
    let stagingDir = "";
    let foreignIdentity: { dev: bigint | number; ino: bigint | number } | undefined;
    seedRuntimeData(sourceDir);
    run("backup", "--data-dir", sourceDir, "--output", backupDir);

    expect(() =>
      restoreRuntimeBackup({
        backupDirectory: backupDir,
        dataDirectory: targetDir,
        inPlace,
        afterRestoreStaged({ stagingDir: candidate }: { stagingDir: string }) {
          stagingDir = candidate;
          const stagedSecret = path.resolve(stagingDir, ".secret");
          renameSync(stagedSecret, displacedSecret);
          writeFileSync(stagedSecret, TEST_SECRET, { mode: 0o600 });
          const replacement = lstatSync(stagedSecret);
          foreignIdentity = { dev: replacement.dev, ino: replacement.ino };
          throw new Error("injected allowed-name restore replacement");
        }
      })
    ).toThrow(/rollback or cleanup is incomplete/i);

    const retained = lstatSync(path.resolve(stagingDir, ".secret"));
    expect({ dev: retained.dev, ino: retained.ino }).toEqual(foreignIdentity);
    expect(readFileSync(path.resolve(stagingDir, ".secret"), "utf8")).toBe(TEST_SECRET);
    expect(readFileSync(displacedSecret, "utf8")).toBe(TEST_SECRET);
  });

  it("does not replace a foreign empty directory raced over its exclusive target claim", () => {
    const workspace = temporaryDirectory();
    const sourceDir = path.resolve(workspace, "source");
    const targetDir = path.resolve(workspace, "target");
    const backupDir = path.resolve(workspace, "backup");
    const displacedClaim = path.resolve(workspace, "displaced-runtime-claim");
    seedRuntimeData(sourceDir, "from-backup");
    run("backup", "--data-dir", sourceDir, "--output", backupDir);
    let foreignIdentity: { dev: bigint | number; ino: bigint | number } | undefined;

    expect(() =>
      restoreRuntimeBackup({
        backupDirectory: backupDir,
        dataDirectory: targetDir,
        afterRestoreStaged({ dataDir }: { dataDir: string }) {
          renameSync(dataDir, displacedClaim);
          mkdirSync(dataDir, { mode: 0o700 });
          const entry = lstatSync(dataDir);
          foreignIdentity = { dev: entry.dev, ino: entry.ino };
        }
      })
    ).toThrow(/exclusive target cleanup was incomplete|claim marker/i);

    const retained = lstatSync(targetDir);
    expect({ dev: retained.dev, ino: retained.ino }).toEqual(foreignIdentity);
    expect(readdirSync(targetDir)).toEqual([]);
    expect(existsSync(displacedClaim)).toBe(true);
  });

  it("does not move files from a replacement target after its claim identity is lost", () => {
    const workspace = temporaryDirectory();
    const sourceDir = path.resolve(workspace, "source");
    const targetDir = path.resolve(workspace, "target");
    const displacedTarget = path.resolve(workspace, "displaced-owned-target");
    const backupDir = path.resolve(workspace, "backup");
    seedRuntimeData(sourceDir, "from-backup");
    run("backup", "--data-dir", sourceDir, "--output", backupDir);
    let swapped = false;

    expect(() =>
      restoreRuntimeBackup({
        backupDirectory: backupDir,
        dataDirectory: targetDir,
        renameFile(source: string, destination: string) {
          renameSync(source, destination);
          if (!swapped && path.dirname(destination) === targetDir && path.basename(path.dirname(source)).startsWith(".restore-stage-")) {
            swapped = true;
            renameSync(targetDir, displacedTarget);
            mkdirSync(targetDir, { mode: 0o700 });
            writeFileSync(path.resolve(targetDir, "trading.db"), "FOREIGN-MUST-NOT-MOVE", { mode: 0o600 });
          }
        }
      })
    ).toThrow(/exclusive target cleanup was incomplete|claim|identity/i);

    expect(swapped).toBe(true);
    expect(readFileSync(path.resolve(targetDir, "trading.db"), "utf8")).toBe("FOREIGN-MUST-NOT-MOVE");
    expect(existsSync(displacedTarget)).toBe(true);
  });

  it("preserves an allowed-name replacement raced over a rollback destination", () => {
    const workspace = temporaryDirectory();
    const sourceDir = path.resolve(workspace, "source");
    const targetDir = path.resolve(workspace, "target");
    const backupDir = path.resolve(workspace, "backup");
    const displacedSecret = path.resolve(workspace, "tool-created-rollback-secret");
    let racedDestination = "";
    let foreignIdentity: { dev: bigint | number; ino: bigint | number } | undefined;
    seedRuntimeData(sourceDir, "from-backup");
    run("backup", "--data-dir", sourceDir, "--output", backupDir);

    expect(() =>
      restoreRuntimeBackup({
        backupDirectory: backupDir,
        dataDirectory: targetDir,
        renameFile(source: string, destination: string) {
          const sourceParent = path.basename(path.dirname(source));
          const destinationParent = path.basename(path.dirname(destination));
          if (sourceParent.startsWith(".restore-stage-") && path.dirname(destination) === targetDir && path.basename(source) === "arbitrage-paper-multi-leg.sqlite") {
            throw new Error("injected publish failure");
          }
          renameSync(source, destination);
          if (path.dirname(source) === targetDir && destinationParent.startsWith(".restore-stage-") && path.basename(source) === ".secret") {
            racedDestination = destination;
            renameSync(destination, displacedSecret);
            writeFileSync(destination, TEST_SECRET, { mode: 0o600 });
            const replacement = lstatSync(destination);
            foreignIdentity = { dev: replacement.dev, ino: replacement.ino };
          }
        }
      })
    ).toThrow(/rollback or cleanup is incomplete/i);

    const retained = lstatSync(racedDestination);
    expect({ dev: retained.dev, ino: retained.ino }).toEqual(foreignIdentity);
    expect(readFileSync(racedDestination, "utf8")).toBe(TEST_SECRET);
    expect(readFileSync(displacedSecret, "utf8")).toBe(TEST_SECRET);
  });

  it("preserves an ambiguous allowed-name destination raced into the rollback directory", () => {
    const workspace = temporaryDirectory();
    const sourceDir = path.resolve(workspace, "source");
    const targetDir = path.resolve(workspace, "target");
    const backupDir = path.resolve(workspace, "backup");
    const displacedSecret = path.resolve(workspace, "expected-previous-secret");
    let rollbackDir = "";
    let foreignIdentity: { dev: bigint | number; ino: bigint | number } | undefined;
    seedRuntimeData(sourceDir, "from-backup");
    seedRuntimeData(targetDir, "previous-target");
    writeFileSync(path.resolve(targetDir, ".secret"), STALE_SECRET, { mode: 0o600 });
    run("backup", "--data-dir", sourceDir, "--output", backupDir);

    expect(() =>
      restoreRuntimeBackup({
        backupDirectory: backupDir,
        dataDirectory: targetDir,
        force: true,
        renameFile(source: string, destination: string) {
          renameSync(source, destination);
          if (source === path.resolve(targetDir, ".secret") && path.basename(path.dirname(destination)).startsWith(".restore-rollback-")) {
            rollbackDir = path.dirname(destination);
            renameSync(destination, displacedSecret);
            writeFileSync(destination, STALE_SECRET, { mode: 0o600 });
            const replacement = lstatSync(destination);
            foreignIdentity = { dev: replacement.dev, ino: replacement.ino };
          }
        }
      })
    ).toThrow(/rollback or cleanup is incomplete/i);

    const retained = lstatSync(path.resolve(rollbackDir, ".secret"));
    expect({ dev: retained.dev, ino: retained.ino }).toEqual(foreignIdentity);
    expect(readFileSync(path.resolve(rollbackDir, ".secret"), "utf8")).toBe(STALE_SECRET);
    expect(readFileSync(displacedSecret, "utf8")).toBe(STALE_SECRET);
  });

  it("preserves an allowed-name rollback replacement during successful publish cleanup", () => {
    const workspace = temporaryDirectory();
    const sourceDir = path.resolve(workspace, "source");
    const targetDir = path.resolve(workspace, "target");
    const backupDir = path.resolve(workspace, "backup");
    const displacedSecret = path.resolve(workspace, "published-previous-secret");
    let rollbackDir = "";
    let foreignIdentity: { dev: bigint | number; ino: bigint | number } | undefined;
    seedRuntimeData(sourceDir, "from-backup");
    seedRuntimeData(targetDir, "previous-target");
    writeFileSync(path.resolve(targetDir, ".secret"), STALE_SECRET, { mode: 0o600 });
    run("backup", "--data-dir", sourceDir, "--output", backupDir);

    expect(() =>
      restoreRuntimeBackup({
        backupDirectory: backupDir,
        dataDirectory: targetDir,
        force: true,
        renameFile(source: string, destination: string) {
          renameSync(source, destination);
          if (path.basename(path.dirname(destination)).startsWith(".restore-rollback-")) {
            rollbackDir = path.dirname(destination);
          }
          if (path.basename(path.dirname(source)).startsWith(".restore-stage-") && path.basename(source) === ".restore-manifest.json") {
            const rollbackSecret = path.resolve(rollbackDir, ".secret");
            renameSync(rollbackSecret, displacedSecret);
            writeFileSync(rollbackSecret, STALE_SECRET, { mode: 0o600 });
            const replacement = lstatSync(rollbackSecret);
            foreignIdentity = { dev: replacement.dev, ino: replacement.ino };
          }
        }
      })
    ).toThrow(/published, but cleanup was refused/i);

    const retained = lstatSync(path.resolve(rollbackDir, ".secret"));
    expect({ dev: retained.dev, ino: retained.ino }).toEqual(foreignIdentity);
    expect(readFileSync(path.resolve(rollbackDir, ".secret"), "utf8")).toBe(STALE_SECRET);
    expect(readFileSync(displacedSecret, "utf8")).toBe(STALE_SECRET);
    expect(runtimeMarker(targetDir)).toMatchObject({ value: "from-backup" });
  });

  it("preserves a foreign file raced into rollback after the restored files are published", () => {
    const workspace = temporaryDirectory();
    const sourceDir = path.resolve(workspace, "source");
    const targetDir = path.resolve(workspace, "target");
    const backupDir = path.resolve(workspace, "backup");
    seedRuntimeData(sourceDir, "from-backup");
    seedRuntimeData(targetDir, "previous-target");
    run("backup", "--data-dir", sourceDir, "--output", backupDir);
    let rollbackDir = "";
    let injected = false;

    expect(() =>
      restoreRuntimeBackup({
        backupDirectory: backupDir,
        dataDirectory: targetDir,
        force: true,
        renameFile(source: string, destination: string) {
          renameSync(source, destination);
          if (path.basename(path.dirname(destination)).includes(".restore-rollback-")) {
            rollbackDir = path.dirname(destination);
          }
          if (!injected && destination === path.resolve(targetDir, "trading.db") && path.basename(path.dirname(source)).includes(".restore-stage-")) {
            injected = true;
            writeFileSync(path.resolve(rollbackDir, "raced-operator-file.txt"), "preserve raced previous data");
          }
        }
      })
    ).toThrow(/published, but cleanup was refused/i);

    expect(injected).toBe(true);
    expect(runtimeMarker(targetDir)).toMatchObject({ value: "from-backup" });
    expect(readFileSync(path.resolve(rollbackDir, "raced-operator-file.txt"), "utf8")).toBe("preserve raced previous data");
    expect(runtimeMarker(rollbackDir)).toMatchObject({ value: "previous-target" });
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
    expect(symlinkResult.stderr).toContain("must not contain symbolic links");
    expect(lstatSync(symlinkTarget).isSymbolicLink()).toBe(true);
    expect(fileResult.status).toBe(1);
    expect(fileResult.stderr).toContain("non-directory components");
    expect(readFileSync(fileTarget, "utf8")).toBe("not a directory");
  });

  it("rejects intermediate symlink components for backup, verify and restore", async () => {
    const workspace = temporaryDirectory();
    const dataDir = path.resolve(workspace, "data");
    const safeBackup = path.resolve(workspace, "safe-backup");
    seedRuntimeData(dataDir);
    await createRuntimeBackup({
      dataDirectory: dataDir,
      outputDirectory: safeBackup
    });

    const realParent = path.resolve(workspace, "real-parent");
    const linkedParent = path.resolve(workspace, "linked-parent");
    const backupRootLink = path.resolve(workspace, "backup-root-link");
    mkdirSync(realParent, { mode: 0o700 });
    symlinkSync(realParent, linkedParent, "dir");
    symlinkSync(workspace, backupRootLink, "dir");

    await expect(
      createRuntimeBackup({
        dataDirectory: dataDir,
        outputDirectory: path.resolve(linkedParent, "backup")
      })
    ).rejects.toThrow(/symbolic links/i);
    expect(() => verifyRuntimeBackup(path.resolve(backupRootLink, path.basename(safeBackup)))).toThrow(/symbolic links/i);
    expect(() =>
      restoreRuntimeBackup({
        backupDirectory: safeBackup,
        dataDirectory: path.resolve(linkedParent, "target")
      })
    ).toThrow(/symbolic links/i);
    expect(existsSync(path.resolve(realParent, "target"))).toBe(false);
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
