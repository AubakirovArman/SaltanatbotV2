import {
  parseCandlesResponse,
  parseCatalogResponse,
  parseSparklinesResponse,
  parseStreamMessage as parseContractStreamMessage,
  type SparklineSeries,
} from "@saltanatbotv2/contracts";
import type { DataExchange, Timeframe } from "../types";

export async function getCatalog() {
  return request("/api/catalog", undefined, parseCatalogResponse);
}

export async function getCandles(
  symbol: string,
  timeframe: Timeframe,
  limit = 320,
  endTime?: number,
  exchange: DataExchange = "binance",
  init?: { signal?: AbortSignal }
) {
  const query = new URLSearchParams({ symbol, timeframe, limit: String(limit), exchange });
  if (endTime !== undefined) query.set("endTime", String(endTime));
  return request(`/api/candles?${query}`, init, parseCandlesResponse);
}

export type { SparklineSeries };

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
  return request(`/api/sparklines?${query}`, undefined, parseSparklinesResponse);
}

export function createMarketSocket(symbol: string, timeframe: Timeframe, exchange: DataExchange = "binance") {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const params = new URLSearchParams({ symbol, timeframe, limit: "1000", exchange });
  return new WebSocket(`${protocol}://${window.location.host}/stream?${params}`);
}

export function parseStreamMessage(data: string) {
  return parseContractStreamMessage(JSON.parse(data) as unknown);
}

async function request<T>(
  path: string,
  init: { signal?: AbortSignal } | undefined,
  parse: (value: unknown) => T,
): Promise<T> {
  const response = await fetch(path, { headers: { Accept: "application/json" }, signal: init?.signal });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${path}`);
  }
  return parse(await response.json());
}
