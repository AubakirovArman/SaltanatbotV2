import { createHash } from "node:crypto";
import { MAX_EXECUTOR_COMMAND_RESULT_BYTES } from "../database/executorCommandTypes.js";
import type { PaperPortfolioReadPayload } from "./paperPortfolioCommandContract.js";
import type {
  PaperPortfolioDetail,
  PaperPortfolioReadService,
  PaperRobotRuntimeMetadata
} from "./paperPortfolioReadService.js";
import { PaperPortfolioStoreError } from "./paperPortfolioStoreSupport.js";
import type { PaperMoney, PaperRobotJournal } from "./paperPortfolioTypes.js";

export const PAPER_SNAPSHOT_RESULT_SCHEMA_VERSION = "paper-telegram-snapshot-v1" as const;
export const PAPER_TRADES_RESULT_SCHEMA_VERSION = "paper-telegram-trades-v1" as const;
export const PAPER_SNAPSHOT_ROBOT_LIMIT = 20;
export const PAPER_TRADES_FILL_LIMIT = 10;

const MONEY_SCALE = 1_000_000n;
const MONEY_PATTERN = /^(-)?(\d+)\.(\d{6})$/;

/** JSON-safe evidence union mirrored from EvidenceValue for bounded results. */
type ReadEvidence =
  | { status: "available"; value: PaperMoney; observedAt: number; source: string }
  | { status: "unavailable"; reason: string };

/**
 * Executes one read-only paper executor command against the EXISTING durable
 * read models. It never mutates the trading store; unavailable evidence stays
 * unavailable instead of degrading to a numeric zero.
 */
export function executePaperPortfolioRead(
  reads: PaperPortfolioReadService,
  ownerUserId: string,
  payload: PaperPortfolioReadPayload,
  asOf = Date.now()
): Record<string, unknown> {
  const detail = reads.detail(ownerUserId, defaultPortfolioId(reads, ownerUserId, asOf), asOf);
  const result = payload.kind === "paper-portfolio.snapshot"
    ? snapshotResult(detail, asOf)
    : tradesResult(detail, payload.botId, asOf);
  return boundedResult(result);
}

/**
 * Read commands leave no durable SQLite mutation receipt, so the applied
 * acknowledgement hashes the exact command identity plus its bounded result.
 */
export function paperPortfolioReadReceiptHash(
  identity: { id: string; ownerUserId: string; idempotencyKey: string; requestHash: string },
  result: Record<string, unknown>
): string {
  return createHash("sha256")
    .update(stableStringify({
      commandId: identity.id,
      ownerUserId: identity.ownerUserId,
      idempotencyKey: identity.idempotencyKey,
      requestHash: identity.requestHash,
      result
    }))
    .digest("hex");
}

/** Deterministic 8-hex short handle shown in Telegram robot lists. */
export function paperRobotHandle(botId: string): string {
  const canonicalHex = /^(?:bot-)?([0-9a-f]{8,})$/i.exec(botId)?.[1];
  if (canonicalHex) return canonicalHex.slice(0, 8).toLowerCase();
  return createHash("sha256").update(botId).digest("hex").slice(0, 8);
}

function defaultPortfolioId(
  reads: PaperPortfolioReadService,
  ownerUserId: string,
  asOf: number
): string {
  const portfolios = reads.list(ownerUserId, asOf).portfolios;
  const defaultPortfolio = portfolios.find(
    (portfolio) => portfolio.isDefault && portfolio.status === "active"
  );
  if (!defaultPortfolio) {
    throw new PaperPortfolioStoreError("NOT_FOUND", "No active default paper portfolio exists");
  }
  return defaultPortfolio.id;
}

function snapshotResult(detail: PaperPortfolioDetail, asOf: number): Record<string, unknown> {
  const aggregates = detail.snapshot.aggregates;
  const robots = detail.snapshot.robots.map((projection) => {
    const metadata = detail.robots.find((robot) => robot.botId === projection.botId);
    return {
      idPrefix8: paperRobotHandle(projection.botId),
      fullId: projection.botId,
      botRevision: projection.botRevision,
      name: metadata?.name ?? null,
      status: metadata?.status ?? "idle",
      realizedPnl: projection.metrics.realizedNetCashPnl,
      recentWinLoss: recentWinLoss(metadata?.journal)
    };
  });
  return {
    schemaVersion: PAPER_SNAPSHOT_RESULT_SCHEMA_VERSION,
    kind: "paper-portfolio.snapshot",
    asOf,
    portfolio: {
      id: detail.portfolio.id,
      name: detail.portfolio.name,
      portfolioRevision: detail.portfolio.revision,
      ledgerEpoch: detail.snapshot.ledgerEpoch
    },
    capital: {
      available: aggregates.availableCapital,
      reserved: aggregates.reservedCapital,
      initial: aggregates.initialCapital
    },
    equity: readEvidence(aggregates.equity),
    unrealizedPnl: readEvidence(aggregates.unrealizedPnl),
    realizedPnl: {
      total: aggregates.realizedNetCashPnl,
      utcDay: utcDayRealized(detail.robots.map((robot) => robot.journal), asOf)
    },
    robots: robots.slice(0, PAPER_SNAPSHOT_ROBOT_LIMIT),
    robotsTruncated: robots.length > PAPER_SNAPSHOT_ROBOT_LIMIT
  };
}

function tradesResult(
  detail: PaperPortfolioDetail,
  botId: string,
  asOf: number
): Record<string, unknown> {
  const metadata = robotMetadata(detail, botId);
  const fills = metadata.journal.recentFills;
  return {
    schemaVersion: PAPER_TRADES_RESULT_SCHEMA_VERSION,
    kind: "paper-robot.trades",
    asOf,
    portfolioId: detail.portfolio.id,
    robot: {
      idPrefix8: paperRobotHandle(botId),
      fullId: botId,
      name: metadata.name ?? null,
      status: metadata.status ?? "idle"
    },
    trades: fills.items.slice(0, PAPER_TRADES_FILL_LIMIT).map((fill) => ({
      time: fill.ts,
      symbol: fill.symbol,
      side: fill.side,
      qty: fill.qty,
      price: fill.price
    })),
    truncated: fills.truncated || fills.items.length > PAPER_TRADES_FILL_LIMIT
  };
}

/**
 * Resolve a robot by exact id or by its deterministic 8-hex Telegram handle.
 * A handle must match exactly one robot; anything else fails honestly.
 */
function robotMetadata(detail: PaperPortfolioDetail, botId: string): PaperRobotRuntimeMetadata {
  const exact = detail.robots.find((robot) => robot.botId === botId);
  if (exact) return exact;
  if (/^[0-9a-f]{8}$/.test(botId)) {
    const matches = detail.robots.filter((robot) => paperRobotHandle(robot.botId) === botId);
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) {
      throw new PaperPortfolioStoreError(
        "AMBIGUOUS_ROBOT",
        "The robot handle matches more than one robot in the default portfolio"
      );
    }
  }
  throw new PaperPortfolioStoreError(
    "NOT_FOUND",
    "Paper robot was not found in the default portfolio"
  );
}

/**
 * Wins/losses counted over the BOUNDED recent-fill window of the journal:
 * closing fills with strictly positive / strictly negative realized PnL. The
 * truncated flag makes the bounded basis explicit to the formatter.
 */
function recentWinLoss(
  journal: PaperRobotJournal | undefined
): { wins: number; losses: number; truncated: boolean } | null {
  if (!journal) return null;
  let wins = 0;
  let losses = 0;
  for (const fill of journal.recentFills.items) {
    if (fill.kind !== "close") continue;
    const units = moneyUnits(fill.realizedPnl);
    if (units > 0n) wins += 1;
    else if (units < 0n) losses += 1;
  }
  return { wins, losses, truncated: journal.recentFills.truncated };
}

/**
 * Realized PnL for the current UTC calendar day, derived only from the exact
 * cumulative realized-cash curve points. A downsampled curve cannot prove the
 * day boundary, so it honestly reports unavailable instead of a guess.
 */
function utcDayRealized(journals: readonly PaperRobotJournal[], asOf: number): ReadEvidence {
  const boundary = new Date(asOf);
  const dayStart = Date.UTC(
    boundary.getUTCFullYear(),
    boundary.getUTCMonth(),
    boundary.getUTCDate()
  );
  let total = 0n;
  for (const journal of journals) {
    const cashPoints = journal.curve.points.filter(
      (point): point is Extract<typeof point, { basis: "cash-realized" }> =>
        point.basis === "cash-realized"
    );
    const finalPoint = cashPoints.at(-1);
    if (!finalPoint) continue;
    if (journal.curve.truncated) {
      return {
        status: "unavailable",
        reason: "The realized cash history was downsampled, so the UTC-day boundary is not exact."
      };
    }
    const baseline = [...cashPoints].reverse().find((point) => point.ts < dayStart);
    total += moneyUnits(finalPoint.realizedNetCashPnl)
      - (baseline ? moneyUnits(baseline.realizedNetCashPnl) : 0n);
  }
  return {
    status: "available",
    value: formatMoney(total),
    observedAt: asOf,
    source: "paper-ledger-realized-cash"
  };
}

/** Result JSONB must stay within the frozen executor command result budget. */
function boundedResult(result: Record<string, unknown>): Record<string, unknown> {
  let bounded = result;
  while (resultBytes(bounded) > MAX_EXECUTOR_COMMAND_RESULT_BYTES) {
    const robots = bounded.robots;
    if (!Array.isArray(robots) || robots.length === 0) {
      throw new PaperPortfolioStoreError(
        "RESULT_TOO_LARGE",
        "Paper executor read result exceeds the durable result budget"
      );
    }
    bounded = { ...bounded, robots: robots.slice(0, robots.length - 1), robotsTruncated: true };
  }
  return bounded;
}

function resultBytes(result: Record<string, unknown>): number {
  return Buffer.byteLength(JSON.stringify(result), "utf8");
}

function readEvidence(
  value:
    | { status: "available"; value: PaperMoney; observedAt: number; source: string }
    | { status: "stale"; lastValue: PaperMoney; observedAt: number; source: string; staleByMs: number; reason: string }
    | { status: "unavailable"; reason: string }
): Record<string, unknown> {
  return { ...value };
}

function moneyUnits(value: PaperMoney): bigint {
  const match = MONEY_PATTERN.exec(value);
  if (!match) {
    throw new PaperPortfolioStoreError("INVALID_MONEY", "Paper money is not in canonical form");
  }
  const units = BigInt(match[2]!) * MONEY_SCALE + BigInt(match[3]!);
  return match[1] ? -units : units;
}

function formatMoney(value: bigint): PaperMoney {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / MONEY_SCALE;
  const fraction = (absolute % MONEY_SCALE).toString().padStart(6, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
