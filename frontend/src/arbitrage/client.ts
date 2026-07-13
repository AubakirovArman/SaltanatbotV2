export type ArbitrageExchange = "binance" | "bybit";

export interface ArbitrageOpportunity {
  id: string;
  symbol: string;
  spotExchange: ArbitrageExchange;
  futuresExchange: ArbitrageExchange;
  spotAsk: number;
  spotAskSize: number;
  futuresBid: number;
  futuresBidSize: number;
  grossSpreadBps: number;
  estimatedTotalCostBps: number;
  netEdgeBps: number;
  topBookCapacityUsd: number;
  fundingRate: number;
  nextFundingTime?: number;
  capturedAt: number;
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
    spotAsk: finite(row.spotAsk, "spotAsk"), spotAskSize: finite(row.spotAskSize, "spotAskSize"),
    futuresBid: finite(row.futuresBid, "futuresBid"), futuresBidSize: finite(row.futuresBidSize, "futuresBidSize"),
    grossSpreadBps: finite(row.grossSpreadBps, "grossSpreadBps"),
    estimatedTotalCostBps: finite(row.estimatedTotalCostBps, "estimatedTotalCostBps"),
    netEdgeBps: finite(row.netEdgeBps, "netEdgeBps"),
    topBookCapacityUsd: finite(row.topBookCapacityUsd, "topBookCapacityUsd"),
    fundingRate: finite(row.fundingRate, "fundingRate"),
    nextFundingTime: row.nextFundingTime === undefined ? undefined : finite(row.nextFundingTime, "nextFundingTime"),
    capturedAt: finite(row.capturedAt, "capturedAt")
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
