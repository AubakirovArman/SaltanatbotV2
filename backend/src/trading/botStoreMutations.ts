import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { replayPaperLedger } from "./paperLedger.js";
import { listPaperLedgerEventsFrom } from "./paperLedgerStore.js";
import { PAPER_MONEY_MICROS_MAX } from "./paperPortfolioMigration.js";
import { releaseFlatPaperBotAllocationIn } from "./paperPortfolioStore.js";
import { recordPaperBotTombstoneIn } from "./paperPortfolioEvidenceStore.js";
import { recordBotStatusTransition } from "./storeLifecycle.js";
import { normalizeOwnerUserId } from "./tradingAccountStore.js";
import type { BotConfig, BotStatus } from "./types.js";

export interface BotRuntimeStatusMutation {
  botId: string;
  expectedRevision: number;
  status: BotStatus;
  updatedAt: number;
}

export interface BotDeleteOptions {
  expectedRevision?: number;
  reason?: string;
  deletedAt?: number;
  /** Token-mode upgrade compatibility only. Release exact flat paper capital
   * before deletion; database-auth callers must use the fenced workflow. */
  releaseLegacyFlatAllocation?: boolean;
}

export class BotStoreMutationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "BotStoreMutationError";
  }
}

export interface ActivePaperBotAllocationBinding {
  ownerUserId: string;
  botId: string;
  botRevision: number;
  portfolioId: string;
  ledgerEpoch: number;
  allocationMicros: number;
}

interface StoredBotRow {
  ownerUserId: string;
  config: string;
  revision: number;
}

interface ActivePaperAllocationRow {
  portfolioId: string;
  ledgerEpoch: number;
  botRevision: number;
  reservedCapitalMicros: number;
  portfolioRevision: number;
  currentEpoch: number;
  portfolioStatus: string;
  epochStatus: string;
}

/** Fail closed unless this exact owner/bot revision still owns active capital
 * in the active epoch of its active paper portfolio. */
export function assertPaperBotActiveAllocationInto(
  database: DatabaseSync,
  ownerUserId: string,
  config: BotConfig
): ActivePaperBotAllocationBinding {
  const owner = normalizeOwnerUserId(ownerUserId);
  const botId = identifier(config.id, "bot id");
  if (config.exchange !== "paper") fail("NOT_PAPER_BOT", `Bot ${botId} is not a paper bot`);
  if (config.ownerUserId !== undefined && config.ownerUserId !== owner) {
    fail("NOT_FOUND", `Bot ${botId} was not found`);
  }
  const botRevision = bindingInteger(config.revision, "bot revision");
  const portfolioId = bindingIdentifier(config.paperPortfolioId, "paper portfolio id");
  const ledgerEpoch = bindingInteger(config.paperLedgerEpoch, "paper ledger epoch");
  const allocationMicros = bindingInteger(config.paperAllocationMicros, "paper allocation");
  return transaction(database, () => {
    const row = readBot(database, owner, botId);
    if (!row) fail("NOT_FOUND", `Bot ${botId} was not found`);
    if (row.revision !== botRevision) fail("REVISION_CONFLICT", `Bot ${botId} revision changed`);
    const stored = parseConfig(row.config, botId);
    if (
      stored.exchange !== "paper"
      || stored.paperPortfolioId !== portfolioId
      || stored.paperLedgerEpoch !== ledgerEpoch
      || stored.paperAllocationMicros !== allocationMicros
    ) {
      fail("PAPER_BINDING_CONFLICT", `Paper bot ${botId} binding changed`);
    }
    const active = database.prepare(`
      SELECT 1
      FROM paper_portfolios portfolio
      JOIN paper_portfolio_epochs epoch
        ON epoch.ownerUserId = portfolio.ownerUserId
        AND epoch.portfolioId = portfolio.id
        AND epoch.ledgerEpoch = portfolio.currentEpoch
      JOIN paper_bot_allocations allocation
        ON allocation.ownerUserId = portfolio.ownerUserId
        AND allocation.portfolioId = portfolio.id
        AND allocation.ledgerEpoch = epoch.ledgerEpoch
      WHERE portfolio.ownerUserId = ? AND portfolio.id = ?
        AND portfolio.status = 'active' AND portfolio.currentEpoch = ?
        AND epoch.status = 'active'
        AND allocation.botId = ? AND allocation.botRevision = ?
        AND allocation.reservedCapitalMicros = ? AND allocation.status = 'active'
    `).get(owner, portfolioId, ledgerEpoch, botId, botRevision, allocationMicros);
    if (!active) {
      fail("ACTIVE_ALLOCATION_REQUIRED", `Paper bot ${botId} has no exact active portfolio allocation`);
    }
    return { ownerUserId: owner, botId, botRevision, portfolioId, ledgerEpoch, allocationMicros };
  });
}

/** Runtime start/stop/error is mutable state, not a new immutable bot config revision. */
export function updateBotRuntimeStatusInto(
  database: DatabaseSync,
  ownerUserId: string,
  input: BotRuntimeStatusMutation
): BotConfig {
  const owner = normalizeOwnerUserId(ownerUserId);
  const botId = identifier(input.botId, "bot id");
  const expectedRevision = revision(input.expectedRevision);
  const updatedAt = timestamp(input.updatedAt, "bot status time");
  if (input.status !== "running" && input.status !== "stopped" && input.status !== "error") {
    fail("INVALID_STATUS", "Invalid bot runtime status");
  }
  return transaction(database, () => {
    const row = readBot(database, owner, botId);
    if (!row) fail("NOT_FOUND", `Bot ${botId} was not found`);
    if (row.revision !== expectedRevision) fail("REVISION_CONFLICT", `Bot ${botId} revision changed`);
    const previous = parseConfig(row.config, botId);
    const nextStored: BotConfig = { ...previous, status: input.status, updatedAt };
    const changed = database.prepare(`
      UPDATE bots SET config = ?, updatedAt = ?
      WHERE ownerUserId = ? AND id = ? AND revision = ?
    `).run(JSON.stringify(nextStored), updatedAt, owner, botId, expectedRevision).changes;
    if (changed !== 1) fail("REVISION_CONFLICT", `Bot ${botId} revision changed`);
    const result = { ...nextStored, ownerUserId: owner, revision: expectedRevision };
    recordBotStatusTransition(database, result, previous.status);
    return result;
  });
}

/** Owner-scoped delete. Paper bots retain every journal/evidence row and get
 * an immutable tombstone; live bots retain the established destructive cleanup. */
export function deleteBotIntoForOwner(
  database: DatabaseSync,
  ownerUserId: string,
  botIdInput: string,
  options: BotDeleteOptions = {}
): boolean {
  const owner = normalizeOwnerUserId(ownerUserId);
  const botId = identifier(botIdInput, "bot id");
  const expectedRevision = options.expectedRevision === undefined ? undefined : revision(options.expectedRevision);
  const deletedAt = timestamp(options.deletedAt ?? Date.now(), "bot deletion time");
  return transaction(database, () => {
    const row = readBot(database, owner, botId);
    if (!row) return false;
    if (expectedRevision !== undefined && row.revision !== expectedRevision) {
      fail("REVISION_CONFLICT", `Bot ${botId} revision changed`);
    }
    const config = parseConfig(row.config, botId);
    if (config.exchange === "paper") {
      if (options.releaseLegacyFlatAllocation) {
        releaseLegacyFlatPaperAllocation(database, owner, botId, row, config, deletedAt);
      }
      deletePaperBot(database, owner, botId, row, options.reason ?? "bot-delete", deletedAt);
    }
    else if (config.exchange === "binance" || config.exchange === "bybit") deleteLiveBot(database, botId);
    else fail("INVALID_CONFIG", `Bot ${botId} has an unsupported exchange`);
    const deleted = database.prepare("DELETE FROM bots WHERE ownerUserId = ? AND id = ? AND revision = ?")
      .run(owner, botId, row.revision).changes;
    if (deleted !== 1) fail("REVISION_CONFLICT", `Bot ${botId} revision changed`);
    deleteBotSettings(database, botId);
    return true;
  });
}

export function deleteBotInto(database: DatabaseSync, botIdInput: string, options: BotDeleteOptions = {}): boolean {
  const botId = identifier(botIdInput, "bot id");
  const row = database.prepare("SELECT ownerUserId FROM bots WHERE id = ?").get(botId) as { ownerUserId: string } | undefined;
  return row ? deleteBotIntoForOwner(database, row.ownerUserId, botId, options) : false;
}

function releaseLegacyFlatPaperAllocation(
  database: DatabaseSync,
  owner: string,
  botId: string,
  bot: StoredBotRow,
  config: BotConfig,
  deletedAt: number
): void {
  const allocations = database.prepare(`
    SELECT allocation.portfolioId, allocation.ledgerEpoch, allocation.botRevision,
      allocation.reservedCapitalMicros, portfolio.revision AS portfolioRevision,
      portfolio.currentEpoch, portfolio.status AS portfolioStatus,
      epoch.status AS epochStatus
    FROM paper_bot_allocations allocation
    JOIN paper_portfolios portfolio
      ON portfolio.ownerUserId = allocation.ownerUserId
      AND portfolio.id = allocation.portfolioId
    JOIN paper_portfolio_epochs epoch
      ON epoch.ownerUserId = allocation.ownerUserId
      AND epoch.portfolioId = allocation.portfolioId
      AND epoch.ledgerEpoch = allocation.ledgerEpoch
    WHERE allocation.ownerUserId = ? AND allocation.botId = ?
      AND allocation.status = 'active'
  `).all(owner, botId) as unknown as ActivePaperAllocationRow[];
  if (allocations.length === 0) return;
  if (allocations.length !== 1) {
    fail("PAPER_BINDING_CONFLICT", `Paper bot ${botId} has ambiguous active capital`);
  }
  const allocation = allocations[0]!;
  if (
    allocation.botRevision !== bot.revision
    || allocation.currentEpoch !== allocation.ledgerEpoch
    || allocation.portfolioStatus !== "active"
    || allocation.epochStatus !== "active"
    || config.paperPortfolioId !== allocation.portfolioId
    || config.paperLedgerEpoch !== allocation.ledgerEpoch
    || config.paperAllocationMicros !== allocation.reservedCapitalMicros
  ) {
    fail("PAPER_BINDING_CONFLICT", `Paper bot ${botId} active portfolio binding is inconsistent`);
  }
  const state = replayPaperLedger(
    listPaperLedgerEventsFrom(database, botId, allocation.ledgerEpoch),
    botId,
    allocation.ledgerEpoch
  );
  if (!state.initialized || state.position || state.orders.length > 0) {
    fail("OPEN_RISK", `Paper bot ${botId} must be flat with zero open orders before deletion`);
  }
  const returnedCapitalMicros = paperMoneyMicros(state.balance);
  const requestHash = createHash("sha256").update(JSON.stringify({
    owner,
    botId,
    botRevision: bot.revision,
    portfolioId: allocation.portfolioId,
    ledgerEpoch: allocation.ledgerEpoch,
    returnedCapitalMicros
  })).digest("hex");
  releaseFlatPaperBotAllocationIn(database, owner, {
    mutationId: `legacy-delete-${requestHash}`,
    idempotencyKey: `legacy-delete:${requestHash}`,
    requestHash,
    now: deletedAt,
    portfolioId: allocation.portfolioId,
    expectedRevision: allocation.portfolioRevision,
    expectedLedgerEpoch: allocation.ledgerEpoch,
    evidence: {
      botId,
      botRevision: bot.revision,
      positionFlat: true,
      openOrders: 0,
      returnedCapitalMicros,
      checkedAt: deletedAt,
      source: "legacy-token-delete-flat-ledger",
      verified: true
    }
  });
}

function paperMoneyMicros(value: number): number {
  const micros = Math.round(value * 1_000_000);
  if (
    !Number.isFinite(value)
    || value < 0
    || !Number.isSafeInteger(micros)
    || micros > PAPER_MONEY_MICROS_MAX
    || Math.abs(value - micros / 1_000_000) > 1e-9
  ) {
    fail("INVALID_MONEY", "Paper balance is not representable in fixed USDT micros");
  }
  return micros;
}

function deletePaperBot(
  database: DatabaseSync,
  owner: string,
  botId: string,
  row: StoredBotRow,
  reason: string,
  deletedAt: number
): void {
  const active = database.prepare(`
    SELECT 1 FROM paper_bot_allocations WHERE ownerUserId = ? AND botId = ? AND status = 'active'
  `).get(owner, botId);
  if (active) fail("ACTIVE_ALLOCATION", `Paper bot ${botId} still has active portfolio capital`);
  const immutable = database.prepare(`
    SELECT config FROM paper_bot_revision_evidence
    WHERE ownerUserId = ? AND botId = ? AND botRevision = ?
  `).get(owner, botId, row.revision) as { config: string } | undefined;
  recordPaperBotTombstoneIn(database, owner, {
    botId,
    botRevision: row.revision,
    config: immutable?.config ?? row.config,
    reason,
    deletedAt
  });
}

function deleteLiveBot(database: DatabaseSync, botId: string): void {
  database.prepare("DELETE FROM fills WHERE botId = ?").run(botId);
  database.prepare("DELETE FROM order_events WHERE botId = ?").run(botId);
  database.prepare("DELETE FROM orders WHERE botId = ?").run(botId);
  database.prepare("DELETE FROM logs WHERE botId = ?").run(botId);
  database.prepare("DELETE FROM positions WHERE botId = ?").run(botId);
  database.prepare("DELETE FROM strategy_runs WHERE botId = ?").run(botId);
}

function deleteBotSettings(database: DatabaseSync, botId: string): void {
  database.prepare("DELETE FROM settings WHERE key = ? OR key = ? OR key = ?").run(`paper:${botId}`, `state:${botId}`, `dcaState:${botId}`);
  database.prepare("DELETE FROM settings WHERE key LIKE ?").run(`inventory:${botId}:%`);
  database.prepare("DELETE FROM settings WHERE key LIKE ?").run(`futures-exposure:${botId}:%`);
}

function readBot(database: DatabaseSync, owner: string, botId: string): StoredBotRow | undefined {
  return database.prepare(`
    SELECT ownerUserId, config, revision FROM bots WHERE ownerUserId = ? AND id = ?
  `).get(owner, botId) as unknown as StoredBotRow | undefined;
}

function parseConfig(serialized: string, botId: string): BotConfig {
  let value: unknown;
  try { value = JSON.parse(serialized); } catch { fail("INVALID_CONFIG", `Bot ${botId} config is not valid JSON`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("INVALID_CONFIG", `Bot ${botId} config is invalid`);
  return value as BotConfig;
}

let savepointSequence = 0;

function transaction<T>(database: DatabaseSync, operation: () => T): T {
  const owns = !database.isTransaction;
  const savepoint = owns ? undefined : `bot_store_${++savepointSequence}`;
  if (owns) database.exec("BEGIN IMMEDIATE");
  else database.exec(`SAVEPOINT ${savepoint}`);
  try {
    const result = operation();
    if (owns) database.exec("COMMIT");
    else database.exec(`RELEASE SAVEPOINT ${savepoint}`);
    return result;
  } catch (error) {
    if (owns && database.isTransaction) database.exec("ROLLBACK");
    else if (database.isTransaction) {
      database.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      database.exec(`RELEASE SAVEPOINT ${savepoint}`);
    }
    throw error;
  }
}

function identifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 200) fail("INVALID_ID", `${label} must contain from 1 through 200 characters`);
  return normalized;
}

function revision(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) fail("INVALID_REVISION", "Bot revision must be a positive integer");
  return value;
}

function timestamp(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) fail("INVALID_TIMESTAMP", `${label} must be a positive integer`);
  return value;
}

function bindingIdentifier(value: string | undefined, label: string): string {
  if (value === undefined) fail("ACTIVE_ALLOCATION_REQUIRED", `${label} is required`);
  return identifier(value, label);
}

function bindingInteger(value: number | undefined, label: string): number {
  if (!Number.isSafeInteger(value) || (value ?? 0) <= 0) {
    fail("ACTIVE_ALLOCATION_REQUIRED", `${label} must be a positive integer`);
  }
  return value as number;
}

function fail(code: string, message: string): never { throw new BotStoreMutationError(code, message); }
