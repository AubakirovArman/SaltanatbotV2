export type ArbitrageExchange = "binance" | "bybit";

export interface ArbitrageOpportunity {
  id: string;
  symbol: string;
  spotExchange: ArbitrageExchange;
  futuresExchange: ArbitrageExchange;
  spotBid: number;
  spotAsk: number;
  spotAskSize: number;
  futuresBid: number;
  futuresAsk: number;
  futuresBidSize: number;
  grossSpreadBps: number;
  estimatedTotalCostBps: number;
  netEdgeBps: number;
  topBookCapacityUsd: number;
  fundingRate: number;
  nextFundingTime?: number;
  capturedAt: number;
}

export interface ArbitrageDepthLeg {
  exchange: ArbitrageExchange; market: "spot" | "perpetual"; side: "buy" | "sell";
  requestedNotionalUsd: number; filledNotionalUsd: number; quantity: number; averagePrice: number;
  worstPrice: number; topPrice: number; slippageBps: number; levelsUsed: number; complete: boolean; capturedAt: number;
}

export interface ArbitrageDepthResponse {
  symbol: string; requestedNotionalUsd: number; spot: ArbitrageDepthLeg; perpetual: ArbitrageDepthLeg;
  grossSpreadBps: number; complete: boolean; capturedAt: number;
}

export interface ArbitrageScanResponse {
  updatedAt: number;
  stale: boolean;
  scannedSymbols: number;
  estimatedTotalCostBps: number;
  opportunities: ArbitrageOpportunity[];
  sources: Array<{ exchange: ArbitrageExchange; market: "spot" | "perpetual"; ok: boolean; message?: string }>;
}

export async function fetchArbitrageScan(costBps: number, signal?: AbortSignal): Promise<ArbitrageScanResponse> {
  const query = new URLSearchParams({ costBps: String(costBps), minSpreadBps: "-1000", limit: "500" });
  const response = await fetch(`/api/arbitrage?${query}`, { signal });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `Arbitrage API ${response.status}`);
  }
  return parseArbitrageScan(await response.json());
}

export async function fetchArbitrageDepth(row: Pick<ArbitrageOpportunity, "symbol" | "spotExchange" | "futuresExchange">, notionalUsd: number, signal?: AbortSignal): Promise<ArbitrageDepthResponse> {
  const query = new URLSearchParams({ symbol: row.symbol, spotExchange: row.spotExchange, futuresExchange: row.futuresExchange, notionalUsd: String(notionalUsd) });
  const response = await fetch(`/api/arbitrage/depth?${query}`, { signal });
  if (!response.ok) { const body = await response.json().catch(() => ({})) as { error?: string }; throw new Error(body.error ?? `Arbitrage depth API ${response.status}`); }
  return parseArbitrageDepth(await response.json());
}

export function createArbitrageSocket(): WebSocket {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  return new WebSocket(`${protocol}://${window.location.host}/arbitrage-stream`);
}

export function parseArbitrageStreamMessage(value: unknown): { type: "snapshot"; data: ArbitrageScanResponse } | { type: "error"; message: string } {
  const input = record(value, "arbitrage stream message");
  if (input.type === "arbitrage_snapshot") return { type: "snapshot", data: parseArbitrageScan(input.data) };
  if (input.type === "arbitrage_error") return { type: "error", message: string(input.message, "message") };
  throw new Error("Unsupported arbitrage stream message");
}

export function parseArbitrageScan(value: unknown): ArbitrageScanResponse {
  const input = record(value, "arbitrage response");
  const rawOpportunities = array(input.opportunities, "opportunities", 500);
  const rawSources = array(input.sources, "sources", 8);
  return {
    updatedAt: finite(input.updatedAt, "updatedAt"),
    stale: boolean(input.stale, "stale"),
    scannedSymbols: finite(input.scannedSymbols, "scannedSymbols"),
    estimatedTotalCostBps: finite(input.estimatedTotalCostBps, "estimatedTotalCostBps"),
    opportunities: rawOpportunities.map((value, index) => opportunity(value, index)),
    sources: rawSources.map((value, index) => {
      const source = record(value, `sources[${index}]`);
      const exchange = exchangeId(source.exchange, `sources[${index}].exchange`);
      const market = string(source.market, `sources[${index}].market`);
      if (market !== "spot" && market !== "perpetual") throw new Error(`sources[${index}].market is unsupported`);
      return { exchange, market, ok: boolean(source.ok, `sources[${index}].ok`), message: optionalString(source.message, `sources[${index}].message`) };
    })
  };
}

function opportunity(value: unknown, index: number): ArbitrageOpportunity {
  const row = record(value, `opportunities[${index}]`);
  return {
    id: string(row.id, "id"), symbol: string(row.symbol, "symbol"),
    spotExchange: exchangeId(row.spotExchange, "spotExchange"),
    futuresExchange: exchangeId(row.futuresExchange, "futuresExchange"),
    spotBid: finite(row.spotBid, "spotBid"),
    spotAsk: finite(row.spotAsk, "spotAsk"), spotAskSize: finite(row.spotAskSize, "spotAskSize"),
    futuresBid: finite(row.futuresBid, "futuresBid"), futuresAsk: finite(row.futuresAsk, "futuresAsk"), futuresBidSize: finite(row.futuresBidSize, "futuresBidSize"),
    grossSpreadBps: finite(row.grossSpreadBps, "grossSpreadBps"),
    estimatedTotalCostBps: finite(row.estimatedTotalCostBps, "estimatedTotalCostBps"),
    netEdgeBps: finite(row.netEdgeBps, "netEdgeBps"),
    topBookCapacityUsd: finite(row.topBookCapacityUsd, "topBookCapacityUsd"),
    fundingRate: finite(row.fundingRate, "fundingRate"),
    nextFundingTime: row.nextFundingTime === undefined ? undefined : finite(row.nextFundingTime, "nextFundingTime"),
    capturedAt: finite(row.capturedAt, "capturedAt")
  };
}

export function parseArbitrageDepth(value: unknown): ArbitrageDepthResponse {
  const input = record(value, "arbitrage depth response");
  return {
    symbol: string(input.symbol, "symbol"), requestedNotionalUsd: finite(input.requestedNotionalUsd, "requestedNotionalUsd"),
    spot: depthLeg(input.spot, "spot"), perpetual: depthLeg(input.perpetual, "perpetual"),
    grossSpreadBps: finite(input.grossSpreadBps, "grossSpreadBps"), complete: boolean(input.complete, "complete"), capturedAt: finite(input.capturedAt, "capturedAt")
  };
}

function depthLeg(value: unknown, label: string): ArbitrageDepthLeg {
  const row = record(value, label);
  const market = string(row.market, `${label}.market`);
  const side = string(row.side, `${label}.side`);
  if (market !== "spot" && market !== "perpetual") throw new Error(`${label}.market is unsupported`);
  if (side !== "buy" && side !== "sell") throw new Error(`${label}.side is unsupported`);
  return {
    exchange: exchangeId(row.exchange, `${label}.exchange`), market, side,
    requestedNotionalUsd: finite(row.requestedNotionalUsd, `${label}.requestedNotionalUsd`), filledNotionalUsd: finite(row.filledNotionalUsd, `${label}.filledNotionalUsd`),
    quantity: finite(row.quantity, `${label}.quantity`), averagePrice: finite(row.averagePrice, `${label}.averagePrice`), worstPrice: finite(row.worstPrice, `${label}.worstPrice`),
    topPrice: finite(row.topPrice, `${label}.topPrice`), slippageBps: finite(row.slippageBps, `${label}.slippageBps`), levelsUsed: finite(row.levelsUsed, `${label}.levelsUsed`),
    complete: boolean(row.complete, `${label}.complete`), capturedAt: finite(row.capturedAt, `${label}.capturedAt`)
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function array(value: unknown, label: string, limit: number): unknown[] {
  if (!Array.isArray(value) || value.length > limit) throw new Error(`${label} must be an array with at most ${limit} rows`);
  return value;
}
function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${label} must be a non-empty string`);
  return value;
}
function optionalString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : string(value, label);
}
function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be finite`);
  return value;
}
function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}
function exchangeId(value: unknown, label: string): ArbitrageExchange {
  if (value !== "binance" && value !== "bybit") throw new Error(`${label} is unsupported`);
  return value;
}
