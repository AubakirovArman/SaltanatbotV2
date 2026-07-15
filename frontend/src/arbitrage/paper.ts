import { assertArbitrageDepthBinding, type ArbitrageDepthResponse, type ArbitrageOpportunity } from "./client";
import { readTenantLocalItem, writeTenantLocalItem } from "../app/tenantLocalStorage";
import type { ArbitrageFeeProfile } from "./fees";
import { routeNonFundingCostBps } from "./fees";

export interface ArbitragePaperPosition {
  id: string;
  routeId: string;
  identityScope: ArbitrageOpportunity["identityScope"];
  assetId: string;
  economicAssetId?: string;
  spotInstrumentId: string;
  futuresInstrumentId: string;
  symbol: string;
  spotExchange: "binance" | "bybit";
  futuresExchange: "binance" | "bybit";
  notionalUsd: number;
  matchedQuantity: number;
  spotQuantity: number;
  futuresQuantity: number;
  quantityStep: number;
  precisionVerified: boolean;
  roundingDustQuantity: number;
  residualDeltaQuantity: number;
  spotEntry: number;
  futuresEntry: number;
  openedAt: number;
  estimatedRoundTripCostUsd: number;
  fundingPnlUsd: number;
  lastFundingSettlementTime?: number;
  closedAt?: number;
  spotExit?: number;
  futuresExit?: number;
  exitCapturedAt?: number;
  realizedPnlUsd?: number;
}

const KEY = "sbv2:arbitrage-paper:v1";

export function openPaperPosition(row: ArbitrageOpportunity, depth: ArbitrageDepthResponse, profile: ArbitrageFeeProfile, now = Date.now()): ArbitragePaperPosition {
  assertArbitrageDepthBinding(depth, row, "entry");
  if (depth.direction !== "entry") throw new Error("Paper entry requires entry-side order-book depth");
  assertTrustedPaperDepth(depth);
  if (!depth.complete) throw new Error("Insufficient order-book depth");
  if (!(depth.quantityStep > 0) || !Number.isFinite(depth.quantityStep)) throw new Error("Order-book quantity step is invalid");
  const tolerance = quantityTolerance(depth.quantityStep, depth.matchedQuantity);
  const actualResidualDelta = depth.spot.quantity - depth.perpetual.quantity;
  if (
    !(depth.matchedQuantity > 0) ||
    !Number.isFinite(depth.matchedQuantity) ||
    Math.abs(depth.spot.quantity - depth.matchedQuantity) > tolerance ||
    Math.abs(depth.perpetual.quantity - depth.matchedQuantity) > tolerance ||
    Math.abs(actualResidualDelta) > tolerance ||
    Math.abs(depth.residualDeltaQuantity) > tolerance
  ) {
    throw new Error("Order-book legs are not delta-neutral");
  }
  const executedNotionalUsd = depth.spot.filledNotionalUsd;
  return {
    id: `arb-paper-${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    routeId: row.id,
    identityScope: row.identityScope,
    assetId: row.assetId,
    ...(depth.economicAssetId ? { economicAssetId: depth.economicAssetId } : {}),
    spotInstrumentId: row.spotInstrumentId,
    futuresInstrumentId: row.futuresInstrumentId,
    symbol: row.symbol,
    spotExchange: row.spotExchange,
    futuresExchange: row.futuresExchange,
    notionalUsd: executedNotionalUsd,
    matchedQuantity: depth.matchedQuantity,
    spotQuantity: depth.matchedQuantity,
    futuresQuantity: depth.matchedQuantity,
    quantityStep: depth.quantityStep,
    precisionVerified: depth.precisionVerified,
    roundingDustQuantity: depth.roundingDustQuantity,
    residualDeltaQuantity: 0,
    spotEntry: depth.spot.averagePrice,
    futuresEntry: depth.perpetual.averagePrice,
    openedAt: now,
    // Funding is appended from confirmed settlement events in the paper ledger.
    // Charging the projected funding estimate here would count it a second time.
    estimatedRoundTripCostUsd: (executedNotionalUsd * routeNonFundingCostBps(row, profile, executedNotionalUsd)) / 10_000,
    fundingPnlUsd: 0
  };
}

export function paperPnl(position: ArbitragePaperPosition, quote: ArbitrageOpportunity | undefined): number | undefined {
  if (position.realizedPnlUsd !== undefined) return position.realizedPnlUsd;
  if (!quote || !paperOpportunityMatches(position, quote)) return undefined;
  return position.spotQuantity * (quote.spotBid - position.spotEntry) + position.futuresQuantity * (position.futuresEntry - quote.futuresAsk) - position.estimatedRoundTripCostUsd + position.fundingPnlUsd;
}

export function closePaperPosition(position: ArbitragePaperPosition, quote: ArbitrageOpportunity, now = Date.now()): ArbitragePaperPosition {
  assertPaperOpportunityBinding(position, quote);
  return { ...position, closedAt: now, spotExit: quote.spotBid, futuresExit: quote.futuresAsk, exitCapturedAt: quote.capturedAt, realizedPnlUsd: paperPnl(position, quote) ?? 0 };
}

export function closePaperPositionWithDepth(position: ArbitragePaperPosition, depth: ArbitrageDepthResponse, now = Date.now()): ArbitragePaperPosition {
  assertArbitrageDepthBinding(depth, position, "exit");
  assertTrustedPaperDepth(depth);
  if (depth.direction !== "exit" || !depth.complete || depth.spot.side !== "sell" || depth.perpetual.side !== "buy") {
    throw new Error("Paper exit requires complete executable exit-side depth");
  }
  const tolerance = quantityTolerance(Math.max(position.quantityStep, depth.quantityStep), position.matchedQuantity);
  if (Math.abs(depth.matchedQuantity - position.matchedQuantity) > tolerance || Math.abs(depth.spot.quantity - position.spotQuantity) > tolerance || Math.abs(depth.perpetual.quantity - position.futuresQuantity) > tolerance || Math.abs(depth.residualDeltaQuantity) > tolerance) {
    throw new Error("Paper exit would leave residual directional exposure");
  }
  const realizedPnlUsd = position.spotQuantity * (depth.spot.averagePrice - position.spotEntry) + position.futuresQuantity * (position.futuresEntry - depth.perpetual.averagePrice) - position.estimatedRoundTripCostUsd + position.fundingPnlUsd;
  return {
    ...position,
    closedAt: now,
    spotExit: depth.spot.averagePrice,
    futuresExit: depth.perpetual.averagePrice,
    exitCapturedAt: depth.capturedAt,
    realizedPnlUsd
  };
}

export function assertPaperOpportunityBinding(position: ArbitragePaperPosition, quote: ArbitrageOpportunity) {
  if (!paperOpportunityMatches(position, quote)) throw new Error("Current opportunity does not match the open paper position");
}

function paperOpportunityMatches(position: ArbitragePaperPosition, quote: ArbitrageOpportunity) {
  return (
    position.routeId === quote.id &&
    position.symbol === quote.symbol &&
    position.spotExchange === quote.spotExchange &&
    position.futuresExchange === quote.futuresExchange &&
    position.identityScope === quote.identityScope &&
    position.assetId === quote.assetId &&
    position.spotInstrumentId === quote.spotInstrumentId &&
    position.futuresInstrumentId === quote.futuresInstrumentId
  );
}

export function loadPaperPositions(ownerId?: string): ArbitragePaperPosition[] {
  try {
    const value = JSON.parse(readTenantLocalItem(localStorage, KEY, ownerId) ?? "[]") as Array<Partial<ArbitragePaperPosition> & Pick<ArbitragePaperPosition, "id" | "notionalUsd"> & { quantity?: number }>;
    if (!Array.isArray(value)) return [];
    return value
      .slice(0, 100)
      .filter((row) => row && typeof row.id === "string" && Number.isFinite(row.notionalUsd))
      .map((row) => migrateLegacyPaperPosition(row));
  } catch {
    return [];
  }
}
export function storePaperPositions(positions: ArbitragePaperPosition[], ownerId?: string) {
  writeTenantLocalItem(localStorage, KEY, JSON.stringify(positions.slice(0, 100)), ownerId);
}

export interface ArbitragePaperAnalytics {
  total: number;
  open: number;
  closed: number;
  realizedPnlUsd: number;
  /** Present only when every open position has a matching executable quote. */
  unrealizedPnlUsd?: number;
  /** Subtotal for the open positions that currently have matching quotes. */
  knownUnrealizedPnlUsd: number;
  pricedOpenPositions: number;
  winRatePct: number;
  averageClosedPnlUsd: number;
  bestClosedPnlUsd: number;
  worstClosedPnlUsd: number;
}

export function paperAnalytics(positions: ArbitragePaperPosition[], quotes: ArbitrageOpportunity[]): ArbitragePaperAnalytics {
  const closed = positions.filter((position) => position.realizedPnlUsd !== undefined);
  const open = positions.filter((position) => position.realizedPnlUsd === undefined);
  const realized = closed.map((position) => position.realizedPnlUsd ?? 0);
  const unrealized = open.map((position) =>
    paperPnl(
      position,
      quotes.find((row) => row.id === position.routeId)
    )
  );
  const knownUnrealized = unrealized.filter((value): value is number => value !== undefined);
  const knownUnrealizedPnlUsd = sum(knownUnrealized);
  return {
    total: positions.length,
    open: open.length,
    closed: closed.length,
    realizedPnlUsd: sum(realized),
    ...(knownUnrealized.length === open.length ? { unrealizedPnlUsd: knownUnrealizedPnlUsd } : {}),
    knownUnrealizedPnlUsd,
    pricedOpenPositions: knownUnrealized.length,
    winRatePct: closed.length ? (realized.filter((value) => value > 0).length / closed.length) * 100 : 0,
    averageClosedPnlUsd: closed.length ? sum(realized) / closed.length : 0,
    bestClosedPnlUsd: closed.length ? Math.max(...realized) : 0,
    worstClosedPnlUsd: closed.length ? Math.min(...realized) : 0
  };
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}

export function migrateLegacyPaperPosition(row: Partial<ArbitragePaperPosition> & Pick<ArbitragePaperPosition, "id" | "notionalUsd"> & { quantity?: number }): ArbitragePaperPosition {
  const legacyQuantity = nonNegativeFiniteOr(row.quantity, 0);
  const legacySpot = nonNegativeFiniteOr(row.spotQuantity, legacyQuantity);
  const legacyPerpetual = nonNegativeFiniteOr(row.futuresQuantity, legacyQuantity);
  const matchedQuantity = nonNegativeFiniteOr(row.matchedQuantity, Math.min(legacySpot, legacyPerpetual));
  const legacyMismatch = Math.abs(legacySpot - legacyPerpetual);
  const identity = migratedPaperIdentity(row);
  return {
    ...(row as ArbitragePaperPosition),
    ...identity,
    matchedQuantity,
    spotQuantity: matchedQuantity,
    futuresQuantity: matchedQuantity,
    quantityStep: positiveFiniteOr(row.quantityStep, 1e-8),
    precisionVerified: row.precisionVerified === true,
    roundingDustQuantity: finiteOr(row.roundingDustQuantity, legacyMismatch),
    residualDeltaQuantity: 0,
    fundingPnlUsd: finiteOr(row.fundingPnlUsd, 0)
  };
}

function migratedPaperIdentity(row: Partial<ArbitragePaperPosition>): Pick<ArbitragePaperPosition, "identityScope" | "assetId" | "economicAssetId" | "spotInstrumentId" | "futuresInstrumentId"> {
  const symbol = row.symbol ?? "UNKNOWN";
  const spotExchange = row.spotExchange ?? "binance";
  const futuresExchange = row.futuresExchange ?? "binance";
  const baseAsset = symbol.replace(/USDT$/, "").toLowerCase();
  const reviewed = symbol === "BTCUSDT" ? "crypto:bitcoin" : symbol === "ETHUSDT" ? "crypto:ethereum" : undefined;
  const identityScope = row.identityScope ?? (spotExchange === futuresExchange ? "venue-native" : "cross-venue-reviewed");
  return {
    identityScope,
    assetId: row.assetId ?? (identityScope === "venue-native" ? `${spotExchange}:${baseAsset}` : (reviewed ?? `legacy-unverified:${baseAsset}`)),
    ...((row.economicAssetId ?? reviewed) ? { economicAssetId: row.economicAssetId ?? reviewed } : {}),
    spotInstrumentId: row.spotInstrumentId ?? `${spotExchange}:spot:${symbol}`,
    futuresInstrumentId: row.futuresInstrumentId ?? `${futuresExchange}:perpetual:${symbol}`
  };
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function nonNegativeFiniteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function positiveFiniteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function quantityTolerance(step: number, quantity: number): number {
  return Math.max(step * 1e-9, Number.EPSILON * Math.max(1, Math.abs(quantity)) * 16);
}

function assertTrustedPaperDepth(depth: ArbitrageDepthResponse) {
  if (!depth.timing.exchangeTimestampsVerified) throw new Error("Paper trading requires venue-verified timestamps for both order books");
  if (depth.timing.quality !== "fresh") throw new Error("Paper trading requires fresh, synchronized order books");
  if (!depth.constraints.verified) throw new Error("Paper trading requires verified instrument status, settlement and minimum-order constraints");
  if (!depth.precisionVerified || depth.quantityStepSource !== "instrument") {
    throw new Error("Paper trading requires verified instrument quantity steps");
  }
}
