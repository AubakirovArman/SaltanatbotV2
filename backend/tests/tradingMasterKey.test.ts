import { scryptSync } from "node:crypto";
import { spawn } from "node:child_process";
import { chmodSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sealCredentialPayload } from "../src/trading/credentialCrypto.js";
import { credentialAad } from "../src/trading/tradingAccountStore.js";
import { assertTradingDatabaseIdentity, loadTradingMasterKey, readTradingDatabaseIdentity, validateEncryptedTradingRows } from "../src/trading/tradingMasterKey.js";
import { TRADING_RUNTIME_LOCK_NAME } from "../src/trading/tradingStoreBootstrap.js";

const LEGACY_SECRET = "ab".repeat(32);
const OTHER_SECRET = "cd".repeat(32);
const directories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("fail-stop trading master key", () => {
  it("atomically creates a 0600 key only for a new installation", () => {
    const paths = temporaryPaths();

    const key = loadTradingMasterKey(paths);
    const winner = loadTradingMasterKey(paths);

    const stat = lstatSync(paths.secretPath);
    expect(key).toHaveLength(32);
    expect(winner).toEqual(key);
    expect(stat.isFile()).toBe(true);
    expect(stat.isSymbolicLink()).toBe(false);
    expect(stat.mode & 0o777).toBe(0o600);
    expect(stat.size).toBe(64);
    expect(readdirSync(paths.dataDirectory).filter((name) => name.startsWith(".secret.new-"))).toEqual([]);
  });

  it("preserves the legacy 32-byte hexadecimal seed derivation", () => {
    const paths = existingDatabasePaths();
    writeSecret(paths.secretPath, LEGACY_SECRET);

    expect(loadTradingMasterKey(paths)).toEqual(scryptSync(LEGACY_SECRET, "marketforge", 32));
  });

  it.each(["\n", "\r\n"])("preserves the exact legacy derivation with a trailing %j", (lineEnding) => {
    const paths = temporaryPaths();
    mkdirSync(paths.dataDirectory, { recursive: true });
    const legacyFileValue = `${LEGACY_SECRET}${lineEnding}`;
    const key = scryptSync(legacyFileValue, "marketforge", 32);
    const database = new DatabaseSync(paths.databasePath);
    database.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, encrypted INTEGER NOT NULL)");
    database.prepare("INSERT INTO settings (key, value, encrypted) VALUES (?, ?, 1)").run("notify", sealCredentialPayload(key, "{}"));
    database.close();
    writeSecret(paths.secretPath, legacyFileValue);

    expect(loadTradingMasterKey(paths)).toEqual(key);
  });

  it("never creates a replacement key beside an existing database", () => {
    const paths = existingDatabasePaths();
    const before = readFileSync(paths.databasePath);

    expect(() => loadTradingMasterKey(paths)).toThrow(/missing.*existing trading database/i);
    expect(readFileSync(paths.databasePath)).toEqual(before);
    expect(() => lstatSync(paths.secretPath)).toThrow();
  });

  it("publishes one winner or returns an actionable error during concurrent first start", { timeout: 20_000 }, async () => {
    const paths = temporaryPaths();
    const runner = path.resolve(path.dirname(paths.dataDirectory), "concurrent-key-runner.ts");
    const moduleUrl = pathToFileURL(path.resolve(import.meta.dirname, "../src/trading/tradingMasterKey.ts")).href;
    writeFileSync(
      runner,
      `
      import { loadTradingMasterKey } from ${JSON.stringify(moduleUrl)};
      const paths = JSON.parse(process.argv[2]);
      try {
        loadTradingMasterKey(paths);
        process.stdout.write("ok");
      } catch (error) {
        process.stderr.write(error instanceof Error ? error.message : String(error));
        process.exitCode = 2;
      }
    `
    );
    const cli = process.execPath;

    const results = await Promise.all(Array.from({ length: 6 }, () => runChild(cli, runner, paths)));

    expect(results.some((result) => result.status === 0 && result.stdout === "ok")).toBe(true);
    for (const result of results.filter((candidate) => candidate.status !== 0)) {
      expect(result.stderr).toMatch(/another process published.*no file was overwritten.*single process/i);
    }
    expect(loadTradingMasterKey(paths)).toHaveLength(32);
    expect(readdirSync(paths.dataDirectory).filter((name) => name.startsWith(".secret.new-"))).toEqual([]);
  });

  it.each([
    ["malformed", () => "not-a-64-character-hex-key", 0o600, /malformed/],
    ["multiple-line-ending", () => `${LEGACY_SECRET}\n\n`, 0o600, /malformed/],
    ["world-readable", () => LEGACY_SECRET, 0o604, /permissions/],
    ["group-readable", () => LEGACY_SECRET, 0o640, /permissions/]
  ] as const)("rejects a %s key before database writes", (_name, content, mode, message) => {
    const paths = existingDatabasePaths();
    writeSecret(paths.secretPath, content(), mode);
    const before = readFileSync(paths.databasePath);

    expect(() => loadTradingMasterKey(paths)).toThrow(message);
    expect(readFileSync(paths.databasePath)).toEqual(before);
  });

  it("rejects key symlinks and directories before database writes", () => {
    const symlinkPaths = existingDatabasePaths();
    const target = path.resolve(path.dirname(symlinkPaths.dataDirectory), "outside-secret");
    writeSecret(target, LEGACY_SECRET);
    symlinkSync(target, symlinkPaths.secretPath);
    const symlinkBefore = readFileSync(symlinkPaths.databasePath);

    expect(() => loadTradingMasterKey(symlinkPaths)).toThrow(/symbolic link|regular file/i);
    expect(readFileSync(symlinkPaths.databasePath)).toEqual(symlinkBefore);

    const directoryPaths = existingDatabasePaths();
    mkdirSync(directoryPaths.secretPath);
    const directoryBefore = readFileSync(directoryPaths.databasePath);
    expect(() => loadTradingMasterKey(directoryPaths)).toThrow(/regular file/i);
    expect(readFileSync(directoryPaths.databasePath)).toEqual(directoryBefore);
  });

  it.skipIf(process.getuid === undefined)("rejects a key owned by another uid", () => {
    const paths = existingDatabasePaths();
    writeSecret(paths.secretPath, LEGACY_SECRET);
    const ownerUid = lstatSync(paths.secretPath).uid;
    const before = readFileSync(paths.databasePath);
    vi.spyOn(process, "getuid").mockReturnValue(ownerUid + 1);

    expect(() => loadTradingMasterKey(paths)).toThrow(/owned by the service uid/i);
    expect(readFileSync(paths.databasePath)).toEqual(before);
  });

  it("proves the key against encrypted settings before allowing migrations", () => {
    const paths = temporaryPaths();
    mkdirSync(paths.dataDirectory, { recursive: true });
    const expectedKey = scryptSync(LEGACY_SECRET, "marketforge", 32);
    const database = new DatabaseSync(paths.databasePath);
    database.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, encrypted INTEGER NOT NULL)");
    database.prepare("INSERT INTO settings (key, value, encrypted) VALUES (?, ?, 1)").run("notify", sealCredentialPayload(expectedKey, JSON.stringify({ enabled: true })));
    database.close();
    writeSecret(paths.secretPath, OTHER_SECRET);
    const before = readFileSync(paths.databasePath);

    expect(() => loadTradingMasterKey(paths)).toThrow(/cannot decrypt.*not modified/i);
    expect(readFileSync(paths.databasePath)).toEqual(before);
  });

  it("fails closed on any encrypted flag outside the runtime 0/1 domain", () => {
    const paths = temporaryPaths();
    mkdirSync(paths.dataDirectory, { recursive: true });
    const expectedKey = scryptSync(LEGACY_SECRET, "marketforge", 32);
    const database = new DatabaseSync(paths.databasePath);
    database.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, encrypted INTEGER NOT NULL)");
    database.prepare("INSERT INTO settings (key, value, encrypted) VALUES (?, ?, 2)").run("notify", sealCredentialPayload(expectedKey, "{}"));
    database.close();
    writeSecret(paths.secretPath, OTHER_SECRET);
    const before = readFileSync(paths.databasePath);

    expect(() => loadTradingMasterKey(paths)).toThrow(/invalid encrypted flag/i);
    expect(readFileSync(paths.databasePath)).toEqual(before);
  });

  it("observes committed encrypted rows that are still in the WAL", () => {
    const paths = temporaryPaths();
    mkdirSync(paths.dataDirectory, { recursive: true });
    const expectedKey = scryptSync(LEGACY_SECRET, "marketforge", 32);
    const writer = new DatabaseSync(paths.databasePath);
    writer.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0");
    writer.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, encrypted INTEGER NOT NULL)");
    writer.prepare("INSERT INTO settings (key, value, encrypted) VALUES (?, ?, 1)").run("notify", sealCredentialPayload(expectedKey, "{}"));
    writeSecret(paths.secretPath, OTHER_SECRET);
    const walPath = `${paths.databasePath}-wal`;
    const databaseBefore = readFileSync(paths.databasePath);
    const walBefore = readFileSync(walPath);

    try {
      expect(() => loadTradingMasterKey(paths)).toThrow(/cannot decrypt.*not modified/i);
      expect(readFileSync(paths.databasePath)).toEqual(databaseBefore);
      expect(readFileSync(walPath)).toEqual(walBefore);
    } finally {
      writer.close();
    }
  });

  it("validates account-bound AEAD rows through a read-only inventory", () => {
    const paths = temporaryPaths();
    mkdirSync(paths.dataDirectory, { recursive: true });
    const key = scryptSync(LEGACY_SECRET, "marketforge", 32);
    const database = new DatabaseSync(paths.databasePath);
    database.exec(`
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, encrypted INTEGER NOT NULL);
      CREATE TABLE trading_accounts (ownerUserId TEXT NOT NULL, id TEXT NOT NULL, exchange TEXT NOT NULL);
      CREATE TABLE trading_account_credentials (ownerUserId TEXT NOT NULL, accountId TEXT NOT NULL, encryptedValue TEXT NOT NULL);
    `);
    database.prepare("INSERT INTO settings (key, value, encrypted) VALUES (?, ?, 1)").run("notify", sealCredentialPayload(key, "{}"));
    database.prepare("INSERT INTO trading_accounts (ownerUserId, id, exchange) VALUES (?, ?, ?)").run("owner", "account", "bybit");
    database.prepare("INSERT INTO trading_account_credentials (ownerUserId, accountId, encryptedValue) VALUES (?, ?, ?)").run("owner", "account", sealCredentialPayload(key, "{}", credentialAad("owner", "account", "bybit")));
    database.close();
    writeSecret(paths.secretPath, LEGACY_SECRET);

    expect(validateEncryptedTradingRows(paths.databasePath, key)).toEqual({ encryptedSettings: 1, accountCredentials: 1, total: 2 });
    expect(loadTradingMasterKey(paths)).toEqual(key);
  });

  it("detects a database inode replacement before a writable open", () => {
    const paths = existingDatabasePaths();
    const identity = readTradingDatabaseIdentity(paths.databasePath);
    expect(identity).toBeDefined();
    renameSync(paths.databasePath, `${paths.databasePath}.original`);
    const replacement = new DatabaseSync(paths.databasePath);
    replacement.exec("CREATE TABLE replacement (value TEXT NOT NULL)");
    replacement.close();

    expect(() => assertTradingDatabaseIdentity(paths.databasePath, identity)).toThrow(/inode changed/i);
  });

  it.skipIf(process.platform === "win32")("allows exactly one store initializer and releases the lock after a crash", { timeout: 20_000 }, async () => {
    const paths = temporaryPaths();
    const runner = path.resolve(path.dirname(paths.dataDirectory), "protected-store-runner.ts");
    const moduleUrl = pathToFileURL(path.resolve(import.meta.dirname, "../src/trading/tradingStoreBootstrap.ts")).href;
    writeFileSync(
      runner,
      `
      import { openProtectedTradingStore } from ${JSON.stringify(moduleUrl)};
      const paths = JSON.parse(process.argv[2]);
      try {
        const store = openProtectedTradingStore(paths);
        process.stdout.write("locked\\n");
        if (process.argv[3] === "hold") setInterval(() => void store.database, 1000);
        else { store.close(); process.stdout.write("released\\n"); }
      } catch (error) {
        process.stderr.write(error instanceof Error ? error.message : String(error));
        process.exitCode = 2;
      }
    `
    );
    const cli = process.execPath;
    const holder = spawn(cli, ["--import", "tsx", runner, JSON.stringify(paths), "hold"], { stdio: ["ignore", "pipe", "pipe"] });

    try {
      await waitForOutput(holder, "locked");
      const contender = await runChild(cli, runner, paths, "once");
      expect(contender.status).toBe(2);
      expect(contender.stderr).toMatch(/another trading backend process.*exactly one/i);
      expect(lstatSync(path.resolve(paths.dataDirectory, TRADING_RUNTIME_LOCK_NAME)).mode & 0o777).toBe(0o600);
      expect(readdirSync(paths.dataDirectory).filter((name) => name.startsWith(`${TRADING_RUNTIME_LOCK_NAME}-`))).toEqual([]);
    } finally {
      const closed = new Promise<void>((resolve) => holder.once("close", () => resolve()));
      holder.kill("SIGKILL");
      await closed;
    }

    const afterCrash = await runChild(cli, runner, paths, "once");
    expect(afterCrash.status).toBe(0);
    expect(afterCrash.stdout).toBe("locked\nreleased\n");
  });
});

function temporaryPaths() {
  const root = mkdtempSync(path.join(tmpdir(), "saltanat-master-key-"));
  directories.push(root);
  const dataDirectory = path.resolve(root, "data");
  return {
    dataDirectory,
    databasePath: path.resolve(dataDirectory, "trading.db"),
    secretPath: path.resolve(dataDirectory, ".secret")
  };
}

function existingDatabasePaths() {
  const paths = temporaryPaths();
  mkdirSync(paths.dataDirectory, { recursive: true });
  const database = new DatabaseSync(paths.databasePath);
  database.exec("CREATE TABLE marker (value TEXT NOT NULL)");
  database.close();
  return paths;
}

function writeSecret(secretPath: string, value: string, mode = 0o600): void {
  writeFileSync(secretPath, value, { mode });
  chmodSync(secretPath, mode);
}

function runChild(cli: string, runner: string, paths: ReturnType<typeof temporaryPaths>, ...extra: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cli, ["--import", "tsx", runner, JSON.stringify(paths), ...extra], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function waitForOutput(child: ReturnType<typeof spawn>, expected: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for child output: ${expected}`)), 5_000);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (!chunk.includes(expected)) return;
      clearTimeout(timeout);
      resolve();
    });
    child.once("exit", (status) => {
      if (status === null) return;
      clearTimeout(timeout);
      reject(new Error(`Child exited with ${status} before output: ${expected}`));
    });
  });
}
