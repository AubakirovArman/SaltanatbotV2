import type { DatabaseSync } from "node:sqlite";
import { listPaperLedgerEventsFrom } from "./paperLedgerStore.js";
import { projectPaperPortfolio } from "./paperPortfolioMetrics.js";
import {
  PAPER_METRICS_FORMULA_VERSION,
  PAPER_PORTFOLIO_SCHEMA_VERSION,
  type PaperDurableMarkInput,
  type PaperMoney,
  type PaperPortfolioProjection,
  type PaperRobotProjectionInput
} from "./paperPortfolioTypes.js";
import {
  getPaperPortfolioEpochFrom,
  getPaperPortfolioFrom,
  listPaperBotAllocationsFrom
} from "./paperPortfolioStore.js";
import { PAPER_MONEY_MICROS_MAX } from "./paperPortfolioMigration.js";
import {
  PaperPortfolioStoreError,
  type PaperBotAllocation,
  type PaperPortfolio,
  type PaperValuationMark
} from "./paperPortfolioStoreSupport.js";
import type { BotConfig, MarketType } from "./types.js";

export const PAPER_MARK_FRESHNESS_CEILING_MS = 48 * 60 * 60 * 1_000;

export interface PaperPortfolioSnapshotRecord {
  portfolio: PaperPortfolio;
  snapshot: PaperPortfolioProjection;
  botConfigs: Map<string, BotConfig>;
}

/**
 * Build the canonical snapshot only from the executor-owned SQLite ledger,
 * fixed-capital reservations and durable valuation marks.
 */
export function buildPaperPortfolioSnapshotFrom(
  database: DatabaseSync,
  ownerUserId: string,
  portfolioId: string,
  asOf = Date.now()
): PaperPortfolioSnapshotRecord {
  requireTimestamp(asOf);
  const portfolio = getPaperPortfolioFrom(database, ownerUserId, portfolioId);
  if (!portfolio) throw new PaperPortfolioStoreError("NOT_FOUND", "Paper portfolio was not found");
  const epoch = getPaperPortfolioEpochFrom(database, ownerUserId, portfolio.id, portfolio.currentEpoch);
  if (!epoch) throw new PaperPortfolioStoreError("EPOCH_NOT_FOUND", "Paper portfolio epoch was not found");
  const allocations = listPaperBotAllocationsFrom(database, ownerUserId, portfolio.id, epoch.ledgerEpoch);
  const botConfigs = new Map<string, BotConfig>();
  const robots = allocations.map((allocation) => {
    const config = exactBotRevision(database, allocation);
    botConfigs.set(allocation.botId, config);
    return robotProjectionInput(database, allocation, config);
  });
  const snapshot = projectPaperPortfolio({
    schemaVersion: PAPER_PORTFOLIO_SCHEMA_VERSION,
    formulaVersion: PAPER_METRICS_FORMULA_VERSION,
    ownerUserId,
    portfolioId: portfolio.id,
    ledgerEpoch: epoch.ledgerEpoch,
    epochStartedAt: epoch.startedAt,
    asOf,
    markFreshnessMs: PAPER_MARK_FRESHNESS_CEILING_MS,
    initialCapital: formatMicros(epoch.initialCapitalMicros),
    unallocatedCash: formatMicros(epoch.cashBalanceMicros),
    robots
  });
  return { portfolio, snapshot, botConfigs };
}

function robotProjectionInput(
  database: DatabaseSync,
  allocation: PaperBotAllocation,
  config: BotConfig
): PaperRobotProjectionInput {
  const market = marketType(config.market, allocation.botId);
  const ledgerEvents = listPaperLedgerEventsFrom(database, allocation.botId, allocation.ledgerEpoch);
  const currentMarks = listMarks(database, allocation).map(markInput);
  return {
    ownerUserId: allocation.ownerUserId,
    portfolioId: allocation.portfolioId,
    ledgerEpoch: allocation.ledgerEpoch,
    botId: allocation.botId,
    botRevision: allocation.botRevision,
    market,
    allocationStatus: allocation.status,
    allocation: formatMicros(allocation.reservedCapitalMicros),
    ledgerEvents,
    currentMarks
  };
}

function exactBotRevision(database: DatabaseSync, allocation: PaperBotAllocation): BotConfig {
  const evidence = database.prepare(`
    SELECT config FROM paper_bot_revision_evidence
    WHERE ownerUserId = ? AND botId = ? AND botRevision = ?
  `).get(
    allocation.ownerUserId,
    allocation.botId,
    allocation.botRevision
  ) as { config: string } | undefined;
  const current = evidence ?? database.prepare(`
    SELECT config FROM bots
    WHERE ownerUserId = ? AND id = ? AND revision = ?
  `).get(
    allocation.ownerUserId,
    allocation.botId,
    allocation.botRevision
  ) as { config: string } | undefined;
  if (!current) {
    throw new PaperPortfolioStoreError(
      "BOT_REVISION_EVIDENCE_MISSING",
      `Paper bot ${allocation.botId} revision ${allocation.botRevision} has no immutable configuration evidence`
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(current.config);
  } catch {
    throw new PaperPortfolioStoreError("BOT_REVISION_EVIDENCE_INVALID", "Paper bot revision evidence is not valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PaperPortfolioStoreError("BOT_REVISION_EVIDENCE_INVALID", "Paper bot revision evidence is not an object");
  }
  const config = value as BotConfig;
  if (
    config.id !== allocation.botId
    || config.exchange !== "paper"
    || config.paperPortfolioId !== allocation.portfolioId
    || config.paperLedgerEpoch !== allocation.ledgerEpoch
    || config.paperAllocationMicros !== allocation.reservedCapitalMicros
  ) {
    throw new PaperPortfolioStoreError(
      "BOT_REVISION_EVIDENCE_MISMATCH",
      `Paper bot ${allocation.botId} revision evidence does not match its capital reservation`
    );
  }
  return { ...config, ownerUserId: allocation.ownerUserId, revision: allocation.botRevision };
}

function listMarks(database: DatabaseSync, allocation: PaperBotAllocation): PaperValuationMark[] {
  const rows = database.prepare(`
    SELECT * FROM paper_valuation_marks
    WHERE ownerUserId = ? AND portfolioId = ? AND ledgerEpoch = ?
      AND botId = ? AND botRevision = ?
    ORDER BY symbol
  `).all(
    allocation.ownerUserId,
    allocation.portfolioId,
    allocation.ledgerEpoch,
    allocation.botId,
    allocation.botRevision
  ) as Array<Omit<PaperValuationMark, "evidence"> & { evidence: string }>;
  return rows.map((row) => {
    let evidence: unknown;
    try {
      evidence = JSON.parse(row.evidence);
    } catch {
      throw new PaperPortfolioStoreError("MARK_EVIDENCE_INVALID", "Paper valuation mark evidence is not valid JSON");
    }
    return { ...row, evidence };
  });
}

function markInput(mark: PaperValuationMark): PaperDurableMarkInput {
  return {
    ownerUserId: mark.ownerUserId,
    portfolioId: mark.portfolioId,
    ledgerEpoch: mark.ledgerEpoch,
    botId: mark.botId,
    botRevision: mark.botRevision,
    symbol: mark.symbol,
    price: formatMicros(mark.priceMicros),
    observedAt: mark.asOf,
    expiresAt: mark.expiresAt,
    persistedAt: mark.persistedAt,
    source: mark.source,
    durable: true
  };
}

function marketType(value: unknown, botId: string): MarketType {
  if (value === "spot" || value === "futures") return value;
  throw new PaperPortfolioStoreError("BOT_REVISION_EVIDENCE_INVALID", `Paper bot ${botId} has an invalid market`);
}

export function formatMicros(value: number): PaperMoney {
  if (!Number.isSafeInteger(value) || value < 0 || value > PAPER_MONEY_MICROS_MAX) {
    throw new PaperPortfolioStoreError("INVALID_MONEY", "Paper money is outside fixed USDT-micros bounds");
  }
  const units = BigInt(value);
  const whole = units / 1_000_000n;
  const fraction = (units % 1_000_000n).toString().padStart(6, "0");
  return `${whole}.${fraction}`;
}

function requireTimestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new PaperPortfolioStoreError("INVALID_TIMESTAMP", "Paper snapshot time must be a positive integer");
  }
}
