import type { DatabaseSync } from "node:sqlite";
import type { BotConfig, TradingAccount, TradingAccountExchange } from "./types.js";
import { botTradingAccountId, legacyTradingAccountId, withResolvedBotAccountId } from "./tradingAccounts.js";
import { LEGACY_TRADING_OWNER_ID } from "./storeSchema.js";
import { assertTradingAccountCapacity } from "./resourceQuotas.js";
import { assertCredentialWriteAllowed, assertPrivateExchangeAccess, type RuntimePolicy } from "../runtimeProfile.js";

interface CredentialsCodec {
  seal(plain: string, aad: string): string;
  open(payload: string, aad: string): string;
}

export interface TradingAccountAuthorizationState {
  ownerUserId: string;
  accountId: string;
  exchange: TradingAccountExchange;
  enabled: boolean;
  authorizationRevision: number;
  credentialRevision: number;
  credentialsConfigured: boolean;
}

export interface TradingOwnerAuthorityState {
  ownerUserId: string;
  armed: boolean;
  epoch: number;
  updatedAt: number;
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
  ensureOwnerAuthorityRow(db, owner, account.createdAt);
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
    SET label = ?, ownership = ?, enabled = ?, updatedAt = ?,
        authorizationRevision = authorizationRevision + 1
    WHERE ownerUserId = ? AND id = ? AND exchange = ?
  `)
      .run(account.label, account.ownership, account.enabled ? 1 : 0, account.updatedAt, owner, account.id, account.exchange).changes > 0
  );
}

export function getTradingAccountAuthorizationStateForOwner(
  ownerUserId: string,
  accountId: string
): TradingAccountAuthorizationState | undefined {
  return getTradingAccountAuthorizationStateFromForOwner(database(), ownerUserId, accountId);
}

export function getTradingAccountAuthorizationStateFromForOwner(
  db: DatabaseSync,
  ownerUserId: string,
  accountId: string
): TradingAccountAuthorizationState | undefined {
  const owner = normalizeOwnerUserId(ownerUserId);
  const row = db.prepare(`
    SELECT account.ownerUserId, account.id AS accountId, account.exchange,
      account.enabled, account.authorizationRevision, account.credentialRevision,
      CASE WHEN credentials.accountId IS NULL THEN 0 ELSE 1 END AS credentialsConfigured
    FROM trading_accounts account
    LEFT JOIN trading_account_credentials credentials
      ON credentials.ownerUserId = account.ownerUserId AND credentials.accountId = account.id
    WHERE account.ownerUserId = ? AND account.id = ?
  `).get(owner, accountId) as {
    ownerUserId: string;
    accountId: string;
    exchange: TradingAccountExchange;
    enabled: number;
    authorizationRevision: number;
    credentialRevision: number;
    credentialsConfigured: number;
  } | undefined;
  if (!row) return undefined;
  return {
    ownerUserId: row.ownerUserId,
    accountId: row.accountId,
    exchange: row.exchange,
    enabled: row.enabled === 1,
    authorizationRevision: requireRevision(row.authorizationRevision, "account authorization"),
    credentialRevision: requireRevision(row.credentialRevision, "credential", true),
    credentialsConfigured: row.credentialsConfigured === 1
  };
}

export function getTradingOwnerAuthorityForOwner(ownerUserId: string): TradingOwnerAuthorityState {
  return getTradingOwnerAuthorityFromForOwner(database(), ownerUserId);
}

export function getTradingOwnerAuthorityFromForOwner(
  db: DatabaseSync,
  ownerUserId: string
): TradingOwnerAuthorityState {
  const owner = normalizeOwnerUserId(ownerUserId);
  const row = db.prepare(`
    SELECT ownerUserId, armed, epoch, updatedAt
    FROM trading_owner_authority WHERE ownerUserId = ?
  `).get(owner) as { ownerUserId: string; armed: number; epoch: number; updatedAt: number } | undefined;
  if (!row) return { ownerUserId: owner, armed: false, epoch: 0, updatedAt: 0 };
  return {
    ownerUserId: row.ownerUserId,
    armed: row.armed === 1,
    epoch: requireRevision(row.epoch, "owner authority"),
    updatedAt: row.updatedAt
  };
}

/** Every call advances the epoch, including an idempotent disarm. */
export function setTradingOwnerArmedForOwner(
  ownerUserId: string,
  armed: boolean,
  updatedAt = Date.now()
): TradingOwnerAuthorityState {
  return setTradingOwnerArmedInForOwner(database(), ownerUserId, armed, updatedAt);
}

export function setTradingOwnerArmedInForOwner(
  db: DatabaseSync,
  ownerUserId: string,
  armed: boolean,
  updatedAt = Date.now()
): TradingOwnerAuthorityState {
  const owner = normalizeOwnerUserId(ownerUserId);
  const row = db.prepare(`
    INSERT INTO trading_owner_authority (ownerUserId, armed, epoch, updatedAt)
    VALUES (?, ?, 1, ?)
    ON CONFLICT(ownerUserId) DO UPDATE SET
      armed = excluded.armed,
      epoch = trading_owner_authority.epoch + 1,
      updatedAt = excluded.updatedAt
    RETURNING ownerUserId, armed, epoch, updatedAt
  `).get(owner, armed ? 1 : 0, updatedAt) as {
    ownerUserId: string;
    armed: number;
    epoch: number;
    updatedAt: number;
  };
  return {
    ownerUserId: row.ownerUserId,
    armed: row.armed === 1,
    epoch: requireRevision(row.epoch, "owner authority"),
    updatedAt: row.updatedAt
  };
}

export function disarmAllTradingOwners(db: DatabaseSync, updatedAt = Date.now()): number {
  const result = db.prepare(`
    UPDATE trading_owner_authority
    SET armed = 0, epoch = epoch + 1, updatedAt = ?
  `).run(updatedAt);
  return Number(result.changes);
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

export function getTradingAccountCredentialsForOwner<T = unknown>(ownerUserId: string, accountId: string, runtimePolicy?: RuntimePolicy): T | undefined {
  assertPrivateExchangeAccess("exchange credential decryption", "read", runtimePolicy);
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

export function setTradingAccountCredentialsForOwner(ownerUserId: string, accountId: string, value: unknown, runtimePolicy?: RuntimePolicy): void {
  assertCredentialWriteAllowed("exchange credential storage", runtimePolicy);
  const db = database();
  const owner = normalizeOwnerUserId(ownerUserId);
  immediateTransaction(db, () => {
    const account = getTradingAccountFromForOwner(db, owner, accountId);
    if (!account) throw new Error(`Trading account ${accountId} does not belong to owner ${owner}`);
    const encryptedValue = codec().seal(JSON.stringify(value), credentialAad(owner, accountId, account.exchange));
    const updatedAt = Date.now();
    db.prepare(`
      INSERT INTO trading_account_credentials (ownerUserId, accountId, encryptedValue, updatedAt)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(ownerUserId, accountId) DO UPDATE SET
        encryptedValue = excluded.encryptedValue,
        updatedAt = excluded.updatedAt
    `).run(owner, accountId, encryptedValue, updatedAt);
    const changed = db.prepare(`
      UPDATE trading_accounts
      SET credentialRevision = credentialRevision + 1, updatedAt = ?
      WHERE ownerUserId = ? AND id = ?
    `).run(updatedAt, owner, accountId).changes;
    if (changed !== 1) throw new Error(`Trading account ${accountId} changed during credential rotation`);
  });
}

export function deleteTradingAccountCredentialsForOwner(ownerUserId: string, accountId: string): boolean {
  const db = database();
  const owner = normalizeOwnerUserId(ownerUserId);
  return immediateTransaction(db, () => {
    const deleted = db.prepare(`
      DELETE FROM trading_account_credentials WHERE ownerUserId = ? AND accountId = ?
    `).run(owner, accountId).changes > 0;
    if (deleted) {
      const changed = db.prepare(`
        UPDATE trading_accounts
        SET credentialRevision = credentialRevision + 1, updatedAt = ?
        WHERE ownerUserId = ? AND id = ?
      `).run(Date.now(), owner, accountId).changes;
      if (changed !== 1) throw new Error(`Trading account ${accountId} changed during credential deletion`);
    }
    return deleted;
  });
}

function ensureOwnerAuthorityRow(db: DatabaseSync, ownerUserId: string, updatedAt: number): void {
  db.prepare(`
    INSERT OR IGNORE INTO trading_owner_authority (ownerUserId, armed, epoch, updatedAt)
    VALUES (?, 0, 1, ?)
  `).run(ownerUserId, updatedAt);
}

function immediateTransaction<T>(db: DatabaseSync, operation: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function requireRevision(value: number, label: string, allowZero = false): number {
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`Invalid ${label} revision`);
  return value;
}

function database(): DatabaseSync {
  if (!runtimeDatabase) throw new Error("Trading account store is not initialized");
  return runtimeDatabase;
}

function codec(): CredentialsCodec {
  if (!runtimeCodec) throw new Error("Trading credential codec is not initialized");
  return runtimeCodec;
}
