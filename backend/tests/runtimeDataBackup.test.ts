import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");
const script = path.resolve(root, "scripts/runtime-data.mjs");
const temporaryDirectories: string[] = [];

function temporaryDirectory() {
  const directory = mkdtempSync(path.join(tmpdir(), "saltanat-runtime-data-"));
  temporaryDirectories.push(directory);
  return directory;
}

function seedRuntimeData(dataDir: string, marker = "original") {
  mkdirSync(dataDir, { recursive: true });
  const trading = new DatabaseSync(path.resolve(dataDir, "trading.db"));
  trading.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  trading.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("marker", marker);
  trading.close();
  const candles = new DatabaseSync(path.resolve(dataDir, "candles.db"));
  candles.exec("CREATE TABLE candles (symbol TEXT PRIMARY KEY, close REAL NOT NULL)");
  candles.prepare("INSERT INTO candles (symbol, close) VALUES (?, ?)").run("BTCUSDT", 100_000);
  candles.close();
  writeFileSync(path.resolve(dataDir, ".secret"), "test-secret", { mode: 0o600 });
  writeFileSync(path.resolve(dataDir, ".authtoken"), "test-token", { mode: 0o600 });
}

function run(...args: string[]) {
  return execFileSync(process.execPath, [script, ...args], { cwd: root, encoding: "utf8" });
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
      sqliteUserVersion: 0,
    });
    expect(manifest.files.map((entry: { name: string }) => entry.name)).toEqual([
      ".authtoken",
      ".secret",
      "candles.db",
      "trading.db",
    ]);
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
      encoding: "utf8",
    });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain("Restore target is not empty");

    expect(run("restore", backupDir, "--data-dir", targetDir, "--force")).toContain("restored and verified");
    const restored = new DatabaseSync(path.resolve(targetDir, "trading.db"), { readOnly: true });
    expect(restored.prepare("SELECT value FROM settings WHERE key = 'marker'").get()).toMatchObject({
      value: "from-backup",
    });
    restored.close();
    expect(readFileSync(path.resolve(targetDir, ".secret"), "utf8")).toBe("test-secret");
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
});
