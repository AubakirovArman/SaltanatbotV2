import type { CatalogResponse, Candle, DataExchange, StreamMessage, Timeframe } from "../types";

export async function getCatalog() {
  return request<CatalogResponse>("/api/catalog");
}

export async function getCandles(
  symbol: string,
  timeframe: Timeframe,
  limit = 320,
  endTime?: number,
  exchange: DataExchange = "binance"
) {
  const query = new URLSearchParams({ symbol, timeframe, limit: String(limit), exchange });
  if (endTime !== undefined) query.set("endTime", String(endTime));
  return request<{ candles: Candle[]; provider: string; hasMore?: boolean }>(`/api/candles?${query}`);
}

export interface SparklineSeries {
  last: number | null;
  changePct: number;
  points: number[];
}

export async function getSparklines(
  symbols: string[],
  timeframe: Timeframe,
  points = 32,
  exchange: DataExchange = "binance"
) {
  const query = new URLSearchParams({
    symbols: symbols.join(","),
    timeframe,
    points: String(points),
    exchange
  });
  return request<{ timeframe: Timeframe; series: Record<string, SparklineSeries | null> }>(
    `/api/sparklines?${query}`
  );
}

export function createMarketSocket(symbol: string, timeframe: Timeframe, exchange: DataExchange = "binance") {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const params = new URLSearchParams({ symbol, timeframe, limit: "1000", exchange });
  return new WebSocket(`${protocol}://${window.location.host}/stream?${params}`);
}

export function parseStreamMessage(data: string) {
  return JSON.parse(data) as StreamMessage;
}

async function request<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { Accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${path}`);
  }
  return response.json() as Promise<T>;
}
