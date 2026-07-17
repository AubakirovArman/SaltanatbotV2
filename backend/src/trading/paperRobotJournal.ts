import type { DatabaseSync } from "node:sqlite";
import { replayPaperLedger, type PaperLedgerEvent } from "./paperLedger.js";
import {
  PAPER_REALIZED_CASH_CURVE_FORMULA_VERSION,
  PAPER_ROBOT_JOURNAL_SCHEMA_VERSION,
  type PaperCurrentEquityCurvePoint,
  type PaperMoney,
  type PaperRealizedCashCurvePoint,
  type PaperRecentFillSummary,
  type PaperRecentLedgerEventMetadata,
  type PaperRobotJournal,
  type PaperRobotProjection
} from "./paperPortfolioTypes.js";
import { PaperPortfolioStoreError } from "./paperPortfolioStoreSupport.js";

export const PAPER_ROBOT_CURVE_POINT_LIMIT = 256;
export const PAPER_ROBOT_RECENT_FILL_LIMIT = 50;
export const PAPER_ROBOT_RECENT_EVENT_LIMIT = 100;

const MONEY_SCALE = 1_000_000n;
const MAX_LEDGER_MONEY = 1_000_000_000;

interface PaperEventRow {
  id: string;
  botId: string;
  ledgerEpoch: number;
  sequence: number;
  type: PaperLedgerEvent["type"];
  idempotencyKey: string | null;
  data: string;
  ts: number;
}

export interface PaperRobotJournalIdentity {
  ownerUserId: string;
  portfolioId: string;
  ledgerEpoch: number;
  botId: string;
  botRevision: number;
  asOf: number;
}

/**
 * Builds a bounded read model from one exact owner/portfolio/epoch allocation.
 * The query never trusts the globally keyed paper ledger without first joining
 * it to the owner-scoped immutable allocation evidence.
 */
export function buildPaperRobotJournalFrom(
  database: DatabaseSync,
  identity: PaperRobotJournalIdentity,
  projection: PaperRobotProjection
): PaperRobotJournal {
  validateIdentity(identity, projection);
  const events = readOwnerScopedLedger(database, identity);
  const replayed = replayPaperLedger(events, identity.botId, identity.ledgerEpoch);
  if (
    events.length !== projection.ledger.eventCount
    || replayed.lastSequence !== projection.ledger.lastSequence
  ) {
    throw new PaperPortfolioStoreError(
      "LEDGER_EVIDENCE_CHANGED",
      "Paper robot journal does not match the canonical portfolio projection"
    );
  }

  const cashPoints = realizedCashPoints(events);
  const finalCash = cashPoints.at(-1)?.cashBalance;
  const finalRealized = cashPoints.at(-1)?.realizedNetCashPnl;
  if (
    finalCash !== projection.metrics.cashBalance
    || finalRealized !== projection.metrics.realizedNetCashPnl
  ) {
    throw new PaperPortfolioStoreError(
      "LEDGER_FORMULA_MISMATCH",
      "Paper robot journal cash evidence does not match authoritative metrics"
    );
  }

  const equityPoint = currentEquityPoint(projection);
  const cashLimit = PAPER_ROBOT_CURVE_POINT_LIMIT - (equityPoint ? 1 : 0);
  const boundedCashPoints = downsampleCashPoints(cashPoints, cashLimit);
  const fills = events.filter((event): event is Extract<PaperLedgerEvent, { type: "fill" }> => event.type === "fill");

  return {
    schemaVersion: PAPER_ROBOT_JOURNAL_SCHEMA_VERSION,
    ownerUserId: identity.ownerUserId,
    portfolioId: identity.portfolioId,
    ledgerEpoch: identity.ledgerEpoch,
    botId: identity.botId,
    botRevision: identity.botRevision,
    curve: {
      formulaVersion: PAPER_REALIZED_CASH_CURVE_FORMULA_VERSION,
      basis: "current-epoch-realized-cash",
      pointOrder: "oldest-first",
      truncated: boundedCashPoints.length !== cashPoints.length,
      sourceCashPointCount: cashPoints.length,
      points: equityPoint ? [...boundedCashPoints, equityPoint] : boundedCashPoints
    },
    recentFills: {
      order: "newest-first",
      truncated: fills.length > PAPER_ROBOT_RECENT_FILL_LIMIT,
      items: fills.slice(-PAPER_ROBOT_RECENT_FILL_LIMIT).reverse().map(fillSummary)
    },
    recentEvents: {
      order: "newest-first",
      truncated: events.length > PAPER_ROBOT_RECENT_EVENT_LIMIT,
      items: events.slice(-PAPER_ROBOT_RECENT_EVENT_LIMIT).reverse().map(eventMetadata)
    }
  };
}

function readOwnerScopedLedger(
  database: DatabaseSync,
  identity: PaperRobotJournalIdentity
): PaperLedgerEvent[] {
  const rows = database.prepare(`
    SELECT event.id, event.botId, event.ledgerEpoch, event.sequence, event.type,
           event.idempotencyKey, event.data, event.ts
    FROM paper_bot_allocations allocation
    JOIN paper_events event
      ON event.botId = allocation.botId
     AND event.ledgerEpoch = allocation.ledgerEpoch
    WHERE allocation.ownerUserId = ?
      AND allocation.portfolioId = ?
      AND allocation.ledgerEpoch = ?
      AND allocation.botId = ?
      AND allocation.botRevision = ?
    ORDER BY event.sequence ASC, event.id ASC
  `).all(
    identity.ownerUserId,
    identity.portfolioId,
    identity.ledgerEpoch,
    identity.botId,
    identity.botRevision
  ) as unknown as PaperEventRow[];
  if (rows.length === 0) {
    throw new PaperPortfolioStoreError("NOT_FOUND", "Paper robot allocation evidence was not found");
  }
  return rows.map((row) => {
    let data: unknown;
    try {
      data = JSON.parse(row.data);
    } catch {
      throw new PaperPortfolioStoreError("LEDGER_EVIDENCE_INVALID", "Paper robot ledger event is not valid JSON");
    }
    return {
      id: row.id,
      botId: row.botId,
      ledgerEpoch: row.ledgerEpoch,
      sequence: row.sequence,
      type: row.type,
      data,
      ts: row.ts,
      ...(row.idempotencyKey ? { idempotencyKey: row.idempotencyKey } : {})
    } as PaperLedgerEvent;
  });
}

function realizedCashPoints(events: readonly PaperLedgerEvent[]): PaperRealizedCashCurvePoint[] {
  let cashBalance = 0n;
  let realizedNetCashPnl = 0n;
  const points: PaperRealizedCashCurvePoint[] = [];
  for (const event of events) {
    let changed = false;
    if (event.type === "account_initialized") {
      cashBalance = moneyUnits(event.data.balance, "initial paper balance");
      changed = true;
    } else if (event.type === "fee") {
      const amount = moneyUnits(event.data.amount, "paper fee");
      cashBalance -= amount;
      realizedNetCashPnl -= amount;
      changed = true;
    } else if (event.type === "cash") {
      const amount = moneyUnits(event.data.amount, "paper cash event");
      cashBalance += amount;
      if (event.data.reason === "realized-pnl") realizedNetCashPnl += amount;
      changed = true;
    } else if (event.type === "funding") {
      cashBalance += moneyUnits(event.data.amount, "paper funding event");
      changed = true;
    }
    if (changed) {
      points.push({
        basis: "cash-realized",
        sequence: event.sequence,
        ts: event.ts,
        cashBalance: formatMoney(cashBalance),
        realizedNetCashPnl: formatMoney(realizedNetCashPnl)
      });
    }
  }
  return points;
}

function currentEquityPoint(projection: PaperRobotProjection): PaperCurrentEquityCurvePoint | undefined {
  const equity = projection.metrics.equity;
  if (equity.status !== "available") return undefined;
  return {
    basis: "current-equity",
    afterSequence: projection.ledger.lastSequence,
    // Stable across restarts: the point is dated by its newest durable input,
    // not by the wall-clock time of the read request.
    ts: Math.max(projection.ledger.observedAt, equity.observedAt),
    equity: equity.value,
    evidenceObservedAt: equity.observedAt,
    source: equity.source
  };
}

function fillSummary(event: Extract<PaperLedgerEvent, { type: "fill" }>): PaperRecentFillSummary {
  const fill = event.data.fill;
  return {
    fillId: fill.id,
    sequence: event.sequence,
    ts: event.ts,
    symbol: fill.symbol,
    side: fill.side,
    kind: fill.kind,
    qty: fill.qty,
    price: exactMoney(fill.price, "paper fill price"),
    fee: exactMoney(fill.fee, "paper fill fee"),
    ...(fill.feeAsset ? { feeAsset: fill.feeAsset } : {}),
    realizedPnl: exactMoney(fill.realizedPnl, "paper fill realized PnL")
  };
}

function eventMetadata(event: PaperLedgerEvent): PaperRecentLedgerEventMetadata {
  return { eventId: event.id, sequence: event.sequence, ts: event.ts, type: event.type };
}

function downsampleCashPoints(
  points: readonly PaperRealizedCashCurvePoint[],
  limit: number
): PaperRealizedCashCurvePoint[] {
  if (points.length <= limit) return [...points];
  if (limit <= 1) return [points.at(-1)!];
  return Array.from({ length: limit }, (_, index) => {
    const sourceIndex = Math.floor(index * (points.length - 1) / (limit - 1));
    return points[sourceIndex]!;
  });
}

function validateIdentity(identity: PaperRobotJournalIdentity, projection: PaperRobotProjection): void {
  if (
    !identity.ownerUserId.trim()
    || !identity.portfolioId.trim()
    || !identity.botId.trim()
    || !Number.isSafeInteger(identity.ledgerEpoch)
    || identity.ledgerEpoch <= 0
    || !Number.isSafeInteger(identity.botRevision)
    || identity.botRevision <= 0
    || !Number.isSafeInteger(identity.asOf)
    || identity.asOf <= 0
  ) {
    throw new PaperPortfolioStoreError("INVALID_IDENTITY", "Paper robot journal identity is invalid");
  }
  if (
    projection.ownerUserId !== identity.ownerUserId
    || projection.portfolioId !== identity.portfolioId
    || projection.ledgerEpoch !== identity.ledgerEpoch
    || projection.botId !== identity.botId
    || projection.botRevision !== identity.botRevision
  ) {
    throw new PaperPortfolioStoreError("IDENTITY_MISMATCH", "Paper robot journal identity does not match its projection");
  }
  if (identity.asOf < projection.ledger.observedAt) {
    throw new PaperPortfolioStoreError("INVALID_TIMESTAMP", "Paper robot journal predates its ledger evidence");
  }
}

function exactMoney(value: number, label: string): PaperMoney {
  return formatMoney(moneyUnits(value, label));
}

function moneyUnits(value: number, label: string): bigint {
  if (!Number.isFinite(value) || Math.abs(value) > MAX_LEDGER_MONEY) {
    throw new PaperPortfolioStoreError("INVALID_MONEY", `${label} is outside paper money bounds`);
  }
  const fixed = Math.abs(value).toFixed(6);
  const [whole, fraction] = fixed.split(".") as [string, string];
  const units = BigInt(whole) * MONEY_SCALE + BigInt(fraction);
  return value < 0 ? -units : units;
}

function formatMoney(value: bigint): PaperMoney {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / MONEY_SCALE;
  const fraction = (absolute % MONEY_SCALE).toString().padStart(6, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}
