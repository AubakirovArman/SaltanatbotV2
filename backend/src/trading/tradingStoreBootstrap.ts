import { chmodSync, constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { assertTradingDatabaseIdentity, prepareTradingMasterKey, readTradingDatabaseIdentity, type TradingMasterKeyPaths } from "./tradingMasterKey.js";

export const TRADING_RUNTIME_LOCK_NAME = ".trading-runtime-lock.sqlite";

export interface ProtectedTradingStore {
  database: DatabaseSync;
  key: Buffer;
  close(): void;
}

interface RuntimeLock {
  close(): void;
}

/**
 * Open the trading store under a process-lifetime SQLite exclusive lock. The
 * separate coordination database contains no application data and SQLite
 * releases its lock automatically even after an ungraceful process exit.
 */
export function openProtectedTradingStore(paths: TradingMasterKeyPaths): ProtectedTradingStore {
  const lock = acquireTradingRuntimeLock(paths.dataDirectory);
  let database: DatabaseSync | undefined;
  try {
    const prepared = prepareTradingMasterKey(paths);
    chmodSync(path.resolve(paths.dataDirectory), 0o700);
    assertTradingDatabaseIdentity(paths.databasePath, prepared.databaseIdentity);
    database = new DatabaseSync(noFollowSqliteUrl(paths.databasePath));
    const openedIdentity = readTradingDatabaseIdentity(paths.databasePath);
    if (!openedIdentity) throw new Error("Trading database was not created by the protected writable open");
    if (prepared.databaseIdentity) assertTradingDatabaseIdentity(paths.databasePath, prepared.databaseIdentity);
    else assertTradingDatabaseIdentity(paths.databasePath, openedIdentity);
    chmodSync(path.resolve(paths.databasePath), 0o600);

    let closed = false;
    return {
      database,
      key: prepared.key,
      close() {
        if (closed) return;
        closed = true;
        try {
          database?.close();
        } finally {
          prepared.key.fill(0);
          lock.close();
        }
      }
    };
  } catch (error) {
    try {
      database?.close();
    } finally {
      lock.close();
    }
    throw error;
  }
}

/** Exported for process-level concurrency and crash-release regression tests. */
export function acquireTradingRuntimeLock(dataDirectory: string): RuntimeLock {
  const directory = path.resolve(dataDirectory);
  const directoryEntry = lstatIfExists(directory);
  if (directoryEntry?.isSymbolicLink() || (directoryEntry && !directoryEntry.isDirectory())) {
    throw new Error("Trading runtime lock directory must be a real directory");
  }
  if (!directoryEntry) mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lockPath = path.resolve(directory, TRADING_RUNTIME_LOCK_NAME);
  const lockIdentity = ensureCoordinationFile(lockPath);

  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(noFollowSqliteUrl(lockPath));
    database.exec(`
      PRAGMA busy_timeout = 0;
      PRAGMA journal_mode = DELETE;
      CREATE TABLE IF NOT EXISTS runtime_lock (singleton INTEGER PRIMARY KEY CHECK (singleton = 1));
      BEGIN EXCLUSIVE;
    `);
    assertCoordinationPathIdentity(lockPath, lockIdentity);
  } catch (cause) {
    database?.close();
    throw new Error("Another trading backend process already owns the runtime store; exactly one initializer/executor is allowed", { cause });
  }

  let closed = false;
  return {
    close() {
      if (closed) return;
      closed = true;
      try {
        database?.exec("ROLLBACK");
      } finally {
        database?.close();
      }
    }
  };
}

function ensureCoordinationFile(lockPath: string): { device: number; inode: number } {
  const existing = lstatIfExists(lockPath);
  if (!existing) {
    const descriptor = openSync(lockPath, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | noFollowFlag(), 0o600);
    closeSync(descriptor);
  }
  return assertCoordinationFile(lockPath);
}

function assertCoordinationFile(lockPath: string): { device: number; inode: number } {
  const entry = lstatIfExists(lockPath);
  if (!entry || entry.isSymbolicLink() || !entry.isFile()) throw new Error("Trading runtime coordination path must be a regular file");
  let descriptor: number | undefined;
  try {
    descriptor = openSync(lockPath, constants.O_RDWR | noFollowFlag());
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.dev !== entry.dev || stat.ino !== entry.ino) throw new Error("Trading runtime coordination file changed during startup");
    const currentUid = process.getuid?.();
    if (currentUid !== undefined && stat.uid !== currentUid) throw new Error(`Trading runtime coordination file must be owned by service uid ${currentUid}`);
    if ((stat.mode & 0o777) !== 0o600) throw new Error("Trading runtime coordination file permissions must be 0600");
    return { device: stat.dev, inode: stat.ino };
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function assertCoordinationPathIdentity(lockPath: string, expected: { device: number; inode: number }): void {
  // Do not open-and-close another descriptor here: POSIX record locks are
  // process-associated and closing a sibling descriptor can release SQLite's
  // active lock for this inode.
  const entry = lstatIfExists(lockPath);
  if (!entry || entry.isSymbolicLink() || !entry.isFile() || entry.dev !== expected.device || entry.ino !== expected.inode) {
    throw new Error("Trading runtime coordination file changed after the exclusive lock was acquired");
  }
}

function noFollowSqliteUrl(filePath: string): URL {
  const url = pathToFileURL(path.resolve(filePath));
  url.searchParams.set("nofollow", "1");
  return url;
}

function noFollowFlag(): number {
  return "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
}

function lstatIfExists(filePath: string) {
  try {
    return lstatSync(filePath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}
