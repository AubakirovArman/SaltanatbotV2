import type { ArbitrageDepthResponse, ArbitrageOpportunity } from "./client";
import type { ArbitrageFeeProfile } from "./fees";
import { routeCostBps } from "./fees";

export interface ArbitragePaperPosition {
  id: string;
  routeId: string;
  symbol: string;
  spotExchange: "binance" | "bybit";
  futuresExchange: "binance" | "bybit";
  notionalUsd: number;
  spotQuantity: number;
  futuresQuantity: number;
  spotEntry: number;
  futuresEntry: number;
  openedAt: number;
  estimatedRoundTripCostUsd: number;
  closedAt?: number;
  realizedPnlUsd?: number;
}

const KEY = "sbv2:arbitrage-paper:v1";

export function openPaperPosition(row: ArbitrageOpportunity, depth: ArbitrageDepthResponse, profile: ArbitrageFeeProfile, now = Date.now()): ArbitragePaperPosition {
  if (!depth.complete) throw new Error("Insufficient order-book depth");
  return {
    id: `arb-paper-${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    routeId: row.id,
    symbol: row.symbol,
    spotExchange: row.spotExchange,
    futuresExchange: row.futuresExchange,
    notionalUsd: depth.requestedNotionalUsd,
    spotQuantity: depth.spot.quantity,
    futuresQuantity: depth.perpetual.quantity,
    spotEntry: depth.spot.averagePrice,
    futuresEntry: depth.perpetual.averagePrice,
    openedAt: now,
    estimatedRoundTripCostUsd: (depth.requestedNotionalUsd * routeCostBps(row, profile)) / 10_000
  };
}

export function paperPnl(position: ArbitragePaperPosition, quote: ArbitrageOpportunity | undefined): number | undefined {
  if (position.realizedPnlUsd !== undefined) return position.realizedPnlUsd;
  if (!quote) return undefined;
  return position.spotQuantity * (quote.spotBid - position.spotEntry) + position.futuresQuantity * (position.futuresEntry - quote.futuresAsk) - position.estimatedRoundTripCostUsd;
}

export function closePaperPosition(position: ArbitragePaperPosition, quote: ArbitrageOpportunity, now = Date.now()): ArbitragePaperPosition {
  return { ...position, closedAt: now, realizedPnlUsd: paperPnl(position, quote) ?? 0 };
}

export function loadPaperPositions(): ArbitragePaperPosition[] {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? "[]") as Array<ArbitragePaperPosition & { quantity?: number }>;
    if (!Array.isArray(value)) return [];
    return value
      .slice(0, 100)
      .filter((row) => row && typeof row.id === "string" && Number.isFinite(row.notionalUsd))
      .map((row) => ({
        ...row,
        spotQuantity: Number.isFinite(row.spotQuantity) ? row.spotQuantity : Number(row.quantity ?? 0),
        futuresQuantity: Number.isFinite(row.futuresQuantity) ? row.futuresQuantity : Number(row.quantity ?? 0)
      }));
  } catch {
    return [];
  }
}
export function storePaperPositions(positions: ArbitragePaperPosition[]) {
  localStorage.setItem(KEY, JSON.stringify(positions.slice(0, 100)));
}

export interface ArbitragePaperAnalytics {
  total: number;
  open: number;
  closed: number;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  winRatePct: number;
  averageClosedPnlUsd: number;
  bestClosedPnlUsd: number;
  worstClosedPnlUsd: number;
}

export function paperAnalytics(positions: ArbitragePaperPosition[], quotes: ArbitrageOpportunity[]): ArbitragePaperAnalytics {
  const closed = positions.filter((position) => position.realizedPnlUsd !== undefined);
  const open = positions.filter((position) => position.realizedPnlUsd === undefined);
  const realized = closed.map((position) => position.realizedPnlUsd ?? 0);
  const unrealized = open.map(
    (position) =>
      paperPnl(
        position,
        quotes.find((row) => row.id === position.routeId)
      ) ?? 0
  );
  return {
    total: positions.length,
    open: open.length,
    closed: closed.length,
    realizedPnlUsd: sum(realized),
    unrealizedPnlUsd: sum(unrealized),
    winRatePct: closed.length ? (realized.filter((value) => value > 0).length / closed.length) * 100 : 0,
    averageClosedPnlUsd: closed.length ? sum(realized) / closed.length : 0,
    bestClosedPnlUsd: closed.length ? Math.max(...realized) : 0,
    worstClosedPnlUsd: closed.length ? Math.min(...realized) : 0
  };
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}
