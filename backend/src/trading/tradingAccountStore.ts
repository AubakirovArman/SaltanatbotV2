import type { DatabaseSync } from "node:sqlite";
import type { BotConfig, TradingAccount, TradingAccountExchange } from "./types.js";
import { botTradingAccountId, legacyTradingAccountId, withResolvedBotAccountId } from "./tradingAccounts.js";
import { LEGACY_TRADING_OWNER_ID } from "./storeSchema.js";
import { assertTradingAccountCapacity } from "./resourceQuotas.js";
import { assertCredentialWriteAllowed, assertPrivateExchangeAccess } from "../runtimeProfile.js";

interface CredentialsCodec {
  seal(plain: string, aad: string): string;
  open(payload: string, aad: string): string;
}

let runtimeDatabase: DatabaseSync | undefined;
let runtimeCodec: CredentialsCodec | undefined;

export function configureTradingAccountStore(database: DatabaseSync, codec: CredentialsCodec): void {
  runtimeDatabase = database;
  runtimeCodec = codec;
}

export function normalizeOwnerUserId(value: string): string {
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 160) {
    throw new Error("ownerUserId must contain from 1 through 160 characters");
  }
  return normalized;
}

export function credentialAad(ownerUserId: string, accountId: string, exchange: TradingAccountExchange): string {
  // JSON array encoding is unambiguous even when an identifier contains the
  // separator characters that a concatenated string would have to escape.
  return JSON.stringify(["trading-credentials", 1, normalizeOwnerUserId(ownerUserId), accountId, exchange]);
}

type TradingAccountRow = Omit<TradingAccount, "enabled"> & { enabled: number };

function accountFromRow(row: TradingAccountRow): TradingAccount {
  return { ...row, enabled: row.enabled === 1 };
}

/** Internal engine view across all owners. Request handlers must use the
 * explicit owner-scoped variant. */
export function listTradingAccounts(): TradingAccount[] {
  return listTradingAccountsFrom(database());
}

export function listTradingAccountsFrom(db: DatabaseSync): TradingAccount[] {
  return (
    db
      .prepare(`
    SELECT id, ownerUserId, label, exchange, ownership, enabled, createdAt, updatedAt
    FROM trading_accounts ORDER BY updatedAt DESC, id ASC
  `)
      .all() as unknown as TradingAccountRow[]
  ).map(accountFromRow);
}

export function listTradingAccountsForOwner(ownerUserId: string): TradingAccount[] {
  return listTradingAccountsFromForOwner(database(), ownerUserId);
}

export function listTradingAccountsFromForOwner(db: DatabaseSync, ownerUserId: string): TradingAccount[] {
  const owner = normalizeOwnerUserId(ownerUserId);
  return (
    db
      .prepare(`
    SELECT id, ownerUserId, label, exchange, ownership, enabled, createdAt, updatedAt
    FROM trading_accounts WHERE ownerUserId = ?
    ORDER BY updatedAt DESC, id ASC
  `)
      .all(owner) as unknown as TradingAccountRow[]
  ).map(accountFromRow);
}

/** Internal unscoped lookup for an already-authorized engine config. */
export function getTradingAccount(id: string): TradingAccount | undefined {
  return getTradingAccountFrom(database(), id);
}

export function getTradingAccountFrom(db: DatabaseSync, id: string): TradingAccount | undefined {
  const row = db
    .prepare(`
    SELECT id, ownerUserId, label, exchange, ownership, enabled, createdAt, updatedAt
    FROM trading_accounts WHERE id = ?
  `)
    .get(id) as TradingAccountRow | undefined;
  return row ? accountFromRow(row) : undefined;
}

export function getTradingAccountForOwner(ownerUserId: string, id: string): TradingAccount | undefined {
  return getTradingAccountFromForOwner(database(), ownerUserId, id);
}

export function getTradingAccountFromForOwner(db: DatabaseSync, ownerUserId: string, id: string): TradingAccount | undefined {
  const owner = normalizeOwnerUserId(ownerUserId);
  const row = db
    .prepare(`
    SELECT id, ownerUserId, label, exchange, ownership, enabled, createdAt, updatedAt
    FROM trading_accounts WHERE ownerUserId = ? AND id = ?
  `)
    .get(owner, id) as TradingAccountRow | undefined;
  return row ? accountFromRow(row) : undefined;
}

export function insertTradingAccount(account: TradingAccount): void {
  insertTradingAccountForOwner(account.ownerUserId ?? LEGACY_TRADING_OWNER_ID, account);
}

export function insertTradingAccountInto(db: DatabaseSync, account: TradingAccount): void {
  insertTradingAccountIntoForOwner(db, account.ownerUserId ?? LEGACY_TRADING_OWNER_ID, account);
}

export function insertTradingAccountForOwner(ownerUserId: string, account: TradingAccount, maxAccounts?: number): void {
  insertTradingAccountIntoForOwner(database(), ownerUserId, account, maxAccounts);
}

export function insertTradingAccountIntoForOwner(db: DatabaseSync, ownerUserId: string, account: TradingAccount, maxAccounts?: number): void {
  const owner = normalizeOwnerUserId(ownerUserId);
  const insert = () =>
    db
      .prepare(`
    INSERT INTO trading_accounts (id, ownerUserId, label, exchange, ownership, enabled, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)
      .run(account.id, owner, account.label, account.exchange, account.ownership, account.enabled ? 1 : 0, account.createdAt, account.updatedAt);
  if (maxAccounts === undefined) {
    insert();
    return;
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.prepare("SELECT count(*) AS count FROM trading_accounts WHERE ownerUserId = ?").get(owner) as { count: number };
    assertTradingAccountCapacity(Number(row.count), maxAccounts);
    insert();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function updateTradingAccount(account: TradingAccount): boolean {
  const db = database();
  const owner = account.ownerUserId ?? getTradingAccountFrom(db, account.id)?.ownerUserId ?? LEGACY_TRADING_OWNER_ID;
  return updateTradingAccountInForOwner(db, owner, account);
}

export function updateTradingAccountIn(db: DatabaseSync, account: TradingAccount): boolean {
  const owner = account.ownerUserId ?? getTradingAccountFrom(db, account.id)?.ownerUserId ?? LEGACY_TRADING_OWNER_ID;
  return updateTradingAccountInForOwner(db, owner, account);
}

export function updateTradingAccountForOwner(ownerUserId: string, account: TradingAccount): boolean {
  return updateTradingAccountInForOwner(database(), ownerUserId, account);
}

export function updateTradingAccountInForOwner(db: DatabaseSync, ownerUserId: string, account: TradingAccount): boolean {
  const owner = normalizeOwnerUserId(ownerUserId);
  return (
    db
      .prepare(`
    UPDATE trading_accounts
    SET label = ?, ownership = ?, enabled = ?, updatedAt = ?
    WHERE ownerUserId = ? AND id = ? AND exchange = ?
  `)
      .run(account.label, account.ownership, account.enabled ? 1 : 0, account.updatedAt, owner, account.id, account.exchange).changes > 0
  );
}

export function ensureLegacyTradingAccount(exchange: TradingAccountExchange, now = Date.now()): TradingAccount {
  return ensureLegacyTradingAccountForOwner(LEGACY_TRADING_OWNER_ID, exchange, now);
}

export function ensureLegacyTradingAccountForOwner(ownerUserId: string, exchange: TradingAccountExchange, now = Date.now()): TradingAccount {
  const db = database();
  const owner = normalizeOwnerUserId(ownerUserId);
  const id = legacyTradingAccountId(exchange);
  const existing = getTradingAccountFromForOwner(db, owner, id);
  if (existing) return existing;
  if (getTradingAccountFrom(db, id)) throw new Error(`Legacy trading account ${id} belongs to another owner`);
  const account: TradingAccount = {
    id,
    ownerUserId: owner,
    label: `${exchange === "binance" ? "Binance" : "Bybit"} default (migrated)`,
    exchange,
    ownership: "own",
    enabled: true,
    createdAt: now,
    updatedAt: now
  };
  insertTradingAccountIntoForOwner(db, owner, account);
  return account;
}

export class TradingAccountInUseError extends Error {
  constructor(
    readonly accountId: string,
    readonly botIds: readonly string[]
  ) {
    super(`Trading account ${accountId} is used by ${botIds.length} bot(s).`);
  }
}

export function deleteTradingAccount(id: string): boolean {
  const db = database();
  return deleteTradingAccountFromForOwner(db, getTradingAccountFrom(db, id)?.ownerUserId, id);
}

export function deleteTradingAccountFrom(db: DatabaseSync, id: string): boolean {
  return deleteTradingAccountFromForOwner(db, getTradingAccountFrom(db, id)?.ownerUserId, id);
}

export function deleteTradingAccountForOwner(ownerUserId: string, id: string): boolean {
  return deleteTradingAccountFromForOwner(database(), ownerUserId, id);
}

export function deleteTradingAccountFromForOwner(db: DatabaseSync, ownerUserId: string | undefined, id: string): boolean {
  if (ownerUserId === undefined) return false;
  const owner = normalizeOwnerUserId(ownerUserId);
  db.exec("BEGIN IMMEDIATE");
  try {
    const botIds = (db.prepare("SELECT config FROM bots WHERE ownerUserId = ?").all(owner) as Array<{ config: string }>)
      .map((row) => withResolvedBotAccountId(JSON.parse(row.config) as BotConfig))
      .filter((bot) => botTradingAccountId(bot) === id)
      .map((bot) => bot.id);
    if (botIds.length > 0) throw new TradingAccountInUseError(id, botIds);
    const deleted = db.prepare("DELETE FROM trading_accounts WHERE ownerUserId = ? AND id = ?").run(owner, id).changes > 0;
    db.exec("COMMIT");
    return deleted;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function getTradingAccountCredentialsForOwner<T = unknown>(ownerUserId: string, accountId: string): T | undefined {
  assertPrivateExchangeAccess("exchange credential decryption", "read");
  const db = database();
  const owner = normalizeOwnerUserId(ownerUserId);
  const account = getTradingAccountFromForOwner(db, owner, accountId);
  if (!account) return undefined;
  const row = db
    .prepare(`
    SELECT encryptedValue FROM trading_account_credentials
    WHERE ownerUserId = ? AND accountId = ?
  `)
    .get(owner, accountId) as { encryptedValue: string } | undefined;
  if (!row) return undefined;
  return JSON.parse(codec().open(row.encryptedValue, credentialAad(owner, accountId, account.exchange))) as T;
}

/** Credential presence for UI/status surfaces without decrypting secret data. */
export function hasTradingAccountCredentialsForOwner(ownerUserId: string, accountId: string): boolean {
  const owner = normalizeOwnerUserId(ownerUserId);
  return database()
    .prepare(`
      SELECT 1 AS present FROM trading_account_credentials
      WHERE ownerUserId = ? AND accountId = ? LIMIT 1
    `)
    .get(owner, accountId) !== undefined;
}

export function setTradingAccountCredentialsForOwner(ownerUserId: string, accountId: string, value: unknown): void {
  assertCredentialWriteAllowed();
  const db = database();
  const owner = normalizeOwnerUserId(ownerUserId);
  const account = getTradingAccountFromForOwner(db, owner, accountId);
  if (!account) throw new Error(`Trading account ${accountId} does not belong to owner ${owner}`);
  const encryptedValue = codec().seal(JSON.stringify(value), credentialAad(owner, accountId, account.exchange));
  db.prepare(`
    INSERT INTO trading_account_credentials (ownerUserId, accountId, encryptedValue, updatedAt)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(ownerUserId, accountId) DO UPDATE SET
      encryptedValue = excluded.encryptedValue,
      updatedAt = excluded.updatedAt
  `).run(owner, accountId, encryptedValue, Date.now());
}

export function deleteTradingAccountCredentialsForOwner(ownerUserId: string, accountId: string): boolean {
  const owner = normalizeOwnerUserId(ownerUserId);
  return (
    database()
      .prepare(`
    DELETE FROM trading_account_credentials WHERE ownerUserId = ? AND accountId = ?
  `)
      .run(owner, accountId).changes > 0
  );
}

function database(): DatabaseSync {
  if (!runtimeDatabase) throw new Error("Trading account store is not initialized");
  return runtimeDatabase;
}

function codec(): CredentialsCodec {
  if (!runtimeCodec) throw new Error("Trading credential codec is not initialized");
  return runtimeCodec;
}
