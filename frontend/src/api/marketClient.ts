import {
  parseCandlesResponse,
  parseCatalogResponse,
  parseQuoteStreamMessage as parseContractQuoteStreamMessage,
  parseSparklinesResponse,
  parseStreamMessage as parseContractStreamMessage,
  type SparklineSeries,
} from "@saltanatbotv2/contracts";
import type { DataExchange, DataMarketType, PriceType, Timeframe } from "../types";
import { marketWebSocketPool } from "./sharedWebSocketPool";

export async function getCatalog() {
  return request("/api/catalog", undefined, parseCatalogResponse);
}

export async function getCandles(
  symbol: string,
  timeframe: Timeframe,
  limit = 320,
  endTime?: number,
  exchange: DataExchange = "binance",
  init?: { signal?: AbortSignal; marketType?: DataMarketType; priceType?: PriceType }
) {
  const query = new URLSearchParams({ symbol, timeframe, limit: String(limit), exchange });
  if (endTime !== undefined) query.set("endTime", String(endTime));
  if (init?.marketType) query.set("marketType", init.marketType);
  if (init?.priceType) query.set("priceType", init.priceType);
  return request(`/api/candles?${query}`, init, parseCandlesResponse);
}

export type { SparklineSeries };

export async function getSparklines(
  symbols: string[],
  timeframe: Timeframe,
  points = 32,
  exchange: DataExchange = "binance",
  route: { marketType?: DataMarketType; priceType?: PriceType; strict?: boolean } = {}
) {
  const query = new URLSearchParams({
    symbols: symbols.join(","),
    timeframe,
    points: String(points),
    exchange
  });
  if (route.marketType) query.set("marketType", route.marketType);
  if (route.priceType) query.set("priceType", route.priceType);
  if (route.strict) query.set("strict", "1");
  return request(`/api/sparklines?${query}`, undefined, parseSparklinesResponse);
}

export function createMarketSocket(
  symbol: string,
  timeframe: Timeframe,
  exchange: DataExchange = "binance",
  route: { marketType?: DataMarketType; priceType?: PriceType } = {}
) {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const params = new URLSearchParams({ symbol, timeframe, limit: "1000", exchange });
  if (route.marketType) params.set("marketType", route.marketType);
  if (route.priceType) params.set("priceType", route.priceType);
  return marketWebSocketPool.connect(`${protocol}://${window.location.host}/stream?${params}`);
}

export function createOrderBookSocket(symbol: string, exchange: DataExchange = "binance") {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const params = new URLSearchParams({ symbol, exchange });
  return new WebSocket(`${protocol}://${window.location.host}/orderbook?${params}`);
}

export function createTradeFlowSocket(symbol: string, exchange: DataExchange = "binance") {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const params = new URLSearchParams({ symbol, exchange });
  return new WebSocket(`${protocol}://${window.location.host}/trade-flow?${params}`);
}

export function createQuoteSocket(
  symbols: string[],
  timeframe: Timeframe,
  points = 32,
  exchange: DataExchange = "binance",
  route: { marketType?: DataMarketType; priceType?: PriceType; strict?: boolean } = {}
) {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const params = new URLSearchParams({ symbols: symbols.join(","), timeframe, points: String(points), exchange });
  if (route.marketType) params.set("marketType", route.marketType);
  if (route.priceType) params.set("priceType", route.priceType);
  if (route.strict) params.set("strict", "1");
  return new WebSocket(`${protocol}://${window.location.host}/quotes?${params}`);
}

export function parseQuoteStreamMessage(data: string) {
  return parseContractQuoteStreamMessage(JSON.parse(data) as unknown);
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
