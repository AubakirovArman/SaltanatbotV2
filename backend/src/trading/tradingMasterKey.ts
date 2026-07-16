import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import { chmodSync, constants, closeSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { openCredentialPayload } from "./credentialCrypto.js";
import { credentialAad } from "./tradingAccountStore.js";
import type { TradingAccountExchange } from "./types.js";

const SECRET_HEX_LENGTH = 64;
const SECRET_MODE = 0o600;
const KEY_DERIVATION_SALT = "marketforge";

export interface TradingMasterKeyPaths {
  dataDirectory: string;
  databasePath: string;
  secretPath: string;
}

export interface EncryptedTradingRowInventory {
  encryptedSettings: number;
  accountCredentials: number;
  total: number;
}

export interface TradingDatabaseIdentity {
  device: number;
  inode: number;
}

export interface PreparedTradingMasterKey {
  key: Buffer;
  databaseIdentity: TradingDatabaseIdentity | undefined;
}

/**
 * Load the per-install trading key without ever repairing or replacing an
 * existing installation's root of trust. Existing ciphertext is opened from
 * a read-only SQLite connection before the caller can migrate the database.
 */
export function loadTradingMasterKey(paths: TradingMasterKeyPaths): Buffer {
  return prepareTradingMasterKey(paths).key;
}

/** Prepare the key and retain the exact database identity proven by it. */
export function prepareTradingMasterKey(paths: TradingMasterKeyPaths): PreparedTradingMasterKey {
  const dataDirectory = resolve(paths.dataDirectory);
  const databasePath = resolve(paths.databasePath);
  const secretPath = resolve(paths.secretPath);
  if (dirname(databasePath) !== dataDirectory || dirname(secretPath) !== dataDirectory) {
    throw new Error("Trading database and master key must be direct children of the runtime data directory");
  }

  const dataEntry = lstatIfExists(dataDirectory);
  if (dataEntry?.isSymbolicLink() || (dataEntry && !dataEntry.isDirectory())) {
    throw new Error("Trading runtime data path must be a real directory");
  }
  const databaseEntry = lstatIfExists(databasePath);
  if (databaseEntry?.isSymbolicLink() || (databaseEntry && !databaseEntry.isFile())) {
    throw new Error("Trading database path must be a regular file");
  }
  const databaseIdentity = databaseEntry ? fileIdentity(databaseEntry) : undefined;
  const existingDatabase = databaseIdentity !== undefined;
  if (!dataEntry) mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  else if (!existingDatabase) chmodSync(dataDirectory, 0o700);

  let secretEntry = lstatIfExists(secretPath);
  if (!secretEntry) {
    if (existingDatabase) {
      throw new Error("Trading master key is missing for the existing trading database; refusing to create a replacement");
    }
    publishNewSecret(dataDirectory, databasePath, secretPath);
    secretEntry = lstatIfExists(secretPath);
  }
  if (!secretEntry) throw new Error("Trading master key creation did not publish a file");
  if (secretEntry.isSymbolicLink() || !secretEntry.isFile()) {
    throw new Error("Trading master key must be a regular file and must not be a symbolic link");
  }

  const key = readAndDeriveSecret(secretPath, { device: secretEntry.dev, inode: secretEntry.ino });
  if (existingDatabase) validateEncryptedTradingRows(databasePath, key, databaseIdentity);
  assertTradingDatabaseIdentity(databasePath, databaseIdentity);
  return { key, databaseIdentity };
}

/** Read-only ciphertext inventory and decryption proof used before migrations. */
export function validateEncryptedTradingRows(databasePath: string, key: Buffer, expectedIdentity = readTradingDatabaseIdentity(databasePath)): EncryptedTradingRowInventory {
  if (!expectedIdentity) throw new Error("Trading database disappeared before encrypted-row validation");
  assertTradingDatabaseIdentity(databasePath, expectedIdentity);
  const database = openReadOnlyDatabase(databasePath);
  try {
    assertTradingDatabaseIdentity(databasePath, expectedIdentity);
    const hasEncryptedSettings = settingsEncryptedColumnExists(database);
    const invalidEncryptedFlags = hasEncryptedSettings ? Number((database.prepare("SELECT count(*) AS count FROM settings WHERE encrypted NOT IN (0, 1)").get() as { count: number }).count) : 0;
    if (invalidEncryptedFlags > 0) {
      throw new Error(`Trading settings contain ${invalidEncryptedFlags} invalid encrypted flag value(s); expected only 0 or 1`);
    }
    const encryptedSettings = hasEncryptedSettings ? Number((database.prepare("SELECT count(*) AS count FROM settings WHERE encrypted <> 0").get() as { count: number }).count) : 0;
    const accountCredentials = tableExists(database, "trading_account_credentials") ? Number((database.prepare("SELECT count(*) AS count FROM trading_account_credentials").get() as { count: number }).count) : 0;

    try {
      if (encryptedSettings > 0) {
        const rows = database.prepare("SELECT value FROM settings WHERE encrypted <> 0").all() as Array<{ value: string }>;
        for (const row of rows) openCredentialPayload(key, row.value);
      }
      if (accountCredentials > 0) validateAccountCredentials(database, key);
    } catch (cause) {
      throw new Error("Trading master key cannot decrypt the existing encrypted trading rows; database was not modified", { cause });
    }
    return { encryptedSettings, accountCredentials, total: encryptedSettings + accountCredentials };
  } finally {
    database.close();
  }
}

function validateAccountCredentials(database: DatabaseSync, key: Buffer): void {
  if (!tableExists(database, "trading_accounts")) {
    throw new Error("Encrypted account credentials exist without the account registry");
  }
  const rows = database
    .prepare(`
    SELECT credential.ownerUserId, credential.accountId, credential.encryptedValue, account.exchange
    FROM trading_account_credentials credential
    LEFT JOIN trading_accounts account
      ON account.ownerUserId = credential.ownerUserId AND account.id = credential.accountId
    ORDER BY credential.ownerUserId, credential.accountId
  `)
    .all() as Array<{ ownerUserId: string; accountId: string; encryptedValue: string; exchange: unknown }>;
  for (const row of rows) {
    if (row.exchange !== "binance" && row.exchange !== "bybit") {
      throw new Error("Encrypted account credential has no valid account binding");
    }
    openCredentialPayload(key, row.encryptedValue, credentialAad(row.ownerUserId, row.accountId, row.exchange as TradingAccountExchange));
  }
}

function readAndDeriveSecret(secretPath: string, expected: { device: number; inode: number }): Buffer {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(secretPath, constants.O_RDONLY | noFollowFlag());
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) throw new Error("Trading master key must be a regular file");
    if (stat.dev !== expected.device || stat.ino !== expected.inode) {
      throw new Error("Trading master key changed while startup was validating it; refusing to continue");
    }
    const currentUid = process.getuid?.();
    if (currentUid !== undefined && stat.uid !== currentUid) {
      throw new Error(`Trading master key must be owned by the service uid ${currentUid}`);
    }
    const permissions = stat.mode & 0o777;
    if (permissions !== 0o600 && permissions !== 0o400) {
      throw new Error("Trading master key permissions must be 0600 or read-only 0400");
    }
    if (stat.size < SECRET_HEX_LENGTH || stat.size > SECRET_HEX_LENGTH + 2) throw malformedSecretError();
    const secret = readFileSync(descriptor, "utf8");
    if (!isSupportedSecretValue(secret)) throw malformedSecretError();
    // Preserve the exact legacy derivation. Historical operator-created files
    // may contain one trailing LF/CRLF, which the old loader passed to scrypt.
    return scryptSync(secret, KEY_DERIVATION_SALT, 32);
  } catch (cause) {
    if (cause instanceof Error && cause.message.startsWith("Trading master key")) throw cause;
    throw new Error("Trading master key must be a readable regular file and must not be a symbolic link", { cause });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function publishNewSecret(dataDirectory: string, databasePath: string, secretPath: string): void {
  const temporaryPath = resolve(dataDirectory, `.secret.new-${randomUUID()}`);
  let descriptor: number | undefined;
  let failure: Error | undefined;
  try {
    descriptor = openSync(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollowFlag(), SECRET_MODE);
    writeFileSync(descriptor, randomBytes(32).toString("hex"), { encoding: "utf8" });
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    if (lstatIfExists(databasePath)) {
      throw new Error("Trading database appeared during key initialization; refusing to publish a new master key");
    }
    linkSync(temporaryPath, secretPath);
    fsyncDirectory(dataDirectory);
  } catch (cause) {
    failure = publicationError(cause);
  }
  if (descriptor !== undefined) {
    try {
      closeSync(descriptor);
    } catch (cause) {
      failure ??= new Error("Unable to close the temporary trading master key", { cause });
    }
  }
  try {
    unlinkSync(temporaryPath);
    fsyncDirectory(dataDirectory);
  } catch (cause) {
    if (!isMissing(cause)) failure ??= new Error("Unable to remove the temporary trading master key after publication", { cause });
  }
  if (failure) throw failure;
}

function openReadOnlyDatabase(databasePath: string): DatabaseSync {
  // Unlike immutable=1, a true read-only connection observes committed WAL
  // frames. It cannot create or migrate the database.
  const url = pathToFileURL(resolve(databasePath));
  url.searchParams.set("mode", "ro");
  url.searchParams.set("nofollow", "1");
  return new DatabaseSync(url, { readOnly: true });
}

/**
 * Re-check the pathname through both lstat and an O_NOFOLLOW descriptor. This
 * binds validation and the immediately following writable SQLite open to the
 * same inode as far as the Node SQLite API permits.
 */
export function assertTradingDatabaseIdentity(databasePath: string, expected: TradingDatabaseIdentity | undefined): TradingDatabaseIdentity | undefined {
  const resolved = resolve(databasePath);
  const entry = lstatIfExists(resolved);
  if (!expected) {
    if (entry) throw new Error("Trading database appeared during protected initialization; refusing to open it for writing");
    return undefined;
  }
  if (!entry || entry.isSymbolicLink() || !entry.isFile()) {
    throw new Error("Trading database changed or disappeared during protected initialization");
  }
  assertSameIdentity(fileIdentity(entry), expected);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(resolved, constants.O_RDONLY | noFollowFlag());
    const descriptorStat = fstatSync(descriptor);
    if (!descriptorStat.isFile()) throw new Error("Trading database must remain a regular file");
    assertSameIdentity(fileIdentity(descriptorStat), expected);
  } catch (cause) {
    if (cause instanceof Error && cause.message.startsWith("Trading database")) throw cause;
    throw new Error("Trading database identity could not be verified without following symbolic links", { cause });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  return expected;
}

export function readTradingDatabaseIdentity(databasePath: string): TradingDatabaseIdentity | undefined {
  const entry = lstatIfExists(resolve(databasePath));
  if (!entry) return undefined;
  if (entry.isSymbolicLink() || !entry.isFile()) throw new Error("Trading database path must be a regular file");
  return fileIdentity(entry);
}

function settingsEncryptedColumnExists(database: DatabaseSync): boolean {
  if (!tableExists(database, "settings")) return false;
  return (database.prepare("PRAGMA table_info(settings)").all() as Array<{ name: string }>).some((column) => column.name === "encrypted");
}

function tableExists(database: DatabaseSync, name: string): boolean {
  return database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

function lstatIfExists(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

function noFollowFlag(): number {
  return "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
}

function fileIdentity(stat: { dev: number; ino: number }): TradingDatabaseIdentity {
  return { device: stat.dev, inode: stat.ino };
}

function assertSameIdentity(actual: TradingDatabaseIdentity, expected: TradingDatabaseIdentity): void {
  if (actual.device !== expected.device || actual.inode !== expected.inode) {
    throw new Error("Trading database inode changed during protected initialization; refusing to continue");
  }
}

function fsyncDirectory(directory: string): void {
  const directoryFlag = "O_DIRECTORY" in constants ? constants.O_DIRECTORY : 0;
  const descriptor = openSync(directory, constants.O_RDONLY | directoryFlag | noFollowFlag());
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function malformedSecretError(): Error {
  return new Error("Trading master key is malformed; expected 64 hexadecimal characters with at most one preserved trailing line ending");
}

function isSupportedSecretValue(value: string): boolean {
  const lineEndingLength = value.endsWith("\r\n") ? 2 : value.endsWith("\n") ? 1 : 0;
  const hexadecimal = value.slice(0, value.length - lineEndingLength);
  return hexadecimal.length === SECRET_HEX_LENGTH && /^[0-9a-fA-F]+$/.test(hexadecimal);
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isAlreadyExists(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

function publicationError(cause: unknown): Error {
  if (cause instanceof Error && cause.message.startsWith("Trading database appeared")) return cause;
  if (isAlreadyExists(cause)) {
    return new Error("Another process published the trading master key concurrently; no file was overwritten. Stop duplicate starters and retry once with a single process.", { cause });
  }
  return new Error("Unable to atomically create the trading master key for a new installation", { cause });
}
