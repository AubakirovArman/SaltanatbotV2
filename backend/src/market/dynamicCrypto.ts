import type { Instrument } from "../types.js";
import { fetchWithRetry } from "../providers/http.js";

/**
 * Dynamic crypto instrument discovery.
 *
 * The curated list in catalog.ts covers ~53 pairs; real exchanges list hundreds.
 * This module fetches the live USDT-spot universe from Binance (and, when cheap,
 * Bybit) so the terminal exposes the full breadth of tradable pairs, while the
 * curated list remains the resilient fallback used by catalog.ts when this fetch
 * fails or times out.
 *
 * Everything here is best-effort and fail-safe: any error yields an empty array,
 * signalling the caller to keep its fallback. All network calls are bounded by a
 * short AbortController timeout and routed through fetchWithRetry for 429/418
 * backoff.
 */

/** Hard cap on how many pairs we expose, to keep the catalog payload reasonable. */
const MAX_PAIRS = 200;
/** Per-request timeout — a slow exchange must not delay startup indefinitely. */
const FETCH_TIMEOUT_MS = 5000;

interface BinanceSymbol {
  symbol: string;
  status: string;
  baseAsset: string;
  quoteAsset: string;
  isSpotTradingAllowed?: boolean;
  filters?: Array<{ filterType: string; tickSize?: string }>;
}

interface BybitInstrument {
  symbol: string;
  baseCoin: string;
  quoteCoin: string;
  status: string;
  priceFilter?: { tickSize?: string };
}

interface DiscoveredPair {
  symbol: string;
  base: string;
  tickSize?: string;
}

interface BinanceTicker {
  symbol: string;
  price: string;
}

/**
 * Fetch the tradable USDT-spot universe and build Instrument entries. Prefers
 * pairs listed on BOTH exchanges when Bybit responds; otherwise Binance alone.
 * Returns [] on total failure so catalog.ts keeps its curated fallback.
 */
export async function fetchDynamicCrypto(): Promise<Instrument[]> {
  const [binance, bybit, prices] = await Promise.all([fetchBinancePairs(), fetchBybitPairs(), fetchBinancePrices()]);
  if (binance.length === 0) return []; // Binance is the required source of truth.
  // A real positive seed is required for the public synthetic fallback. If the
  // ticker request is unavailable, retain the curated catalog instead of
  // publishing dynamic instruments that would later produce zero OHLC bars.
  if (prices.size === 0) return [];

  const bybitSymbols = new Set(bybit.map((p) => p.symbol));
  // If Bybit responded, prefer the intersection (pairs available on both); else
  // fall back to Binance's full list.
  const selected =
    bybitSymbols.size > 0 ? binance.filter((p) => bybitSymbols.has(p.symbol)) : binance;
  const pairs = (selected.length > 0 ? selected : binance).filter((pair) => prices.has(pair.symbol));

  pairs.sort((a, b) => a.symbol.localeCompare(b.symbol));
  const capped = pairs.slice(0, MAX_PAIRS);

  return capped.map((pair) => buildInstrument(pair, prices.get(pair.symbol)!));
}

function buildInstrument(pair: DiscoveredPair, basePrice: number): Instrument {
  const decimals = decimalsFromTickSize(pair.tickSize);
  return {
    symbol: pair.symbol,
    displayName: `${pair.base} / Tether`,
    assetClass: "crypto",
    exchange: "Binance / Bybit",
    currency: "USDT",
    provider: "binance",
    // This quote seeds the clearly-labelled public synthetic fallback if the
    // exchange feed later becomes unavailable. It is never used by live bots.
    basePrice,
    decimals: decimals ?? 4
  };
}

async function fetchBinancePrices(): Promise<Map<string, number>> {
  try {
    const body = await fetchJson<BinanceTicker[]>("https://api.binance.com/api/v3/ticker/price");
    const out = new Map<string, number>();
    for (const ticker of body ?? []) {
      const price = Number(ticker.price);
      if (ticker.symbol && Number.isFinite(price) && price > 0) out.set(ticker.symbol, price);
    }
    return out;
  } catch {
    return new Map();
  }
}

async function fetchBinancePairs(): Promise<DiscoveredPair[]> {
  try {
    const body = await fetchJson<{ symbols?: BinanceSymbol[] }>("https://api.binance.com/api/v3/exchangeInfo");
    const symbols = body?.symbols ?? [];
    const out: DiscoveredPair[] = [];
    for (const s of symbols) {
      if (s.quoteAsset !== "USDT" || s.status !== "TRADING" || s.isSpotTradingAllowed === false) continue;
      const tickSize = s.filters?.find((f) => f.filterType === "PRICE_FILTER")?.tickSize;
      out.push({ symbol: s.symbol, base: s.baseAsset, tickSize });
    }
    return out;
  } catch {
    return [];
  }
}

async function fetchBybitPairs(): Promise<DiscoveredPair[]> {
  try {
    const body = await fetchJson<{ retCode?: number; result?: { list?: BybitInstrument[] } }>(
      "https://api.bybit.com/v5/market/instruments-info?category=spot"
    );
    if (!body || body.retCode !== 0) return [];
    const list = body.result?.list ?? [];
    const out: DiscoveredPair[] = [];
    for (const i of list) {
      if (i.quoteCoin !== "USDT" || i.status !== "Trading") continue;
      out.push({ symbol: i.symbol, base: i.baseCoin, tickSize: i.priceFilter?.tickSize });
    }
    return out;
  } catch {
    return [];
  }
}

/** GET + parse JSON with a bounded timeout and rate-limit-aware retries. */
async function fetchJson<T>(url: string): Promise<T | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchWithRetry(url, { signal: controller.signal });
    if (!response.ok) return undefined;
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Infer display decimals from an exchange tick size (e.g. "0.01000000" -> 2,
 * "0.0001" -> 4). Falls back to undefined when unparseable so the caller can
 * apply its own default.
 */
export function decimalsFromTickSize(tickSize: string | undefined): number | undefined {
  if (!tickSize) return undefined;
  const value = Number(tickSize);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  if (value >= 1) return 0;
  // Count fractional digits up to the last significant digit, e.g. 0.00010000.
  const decimalsStr = tickSize.includes(".") ? tickSize.split(".")[1] ?? "" : "";
  const trimmed = decimalsStr.replace(/0+$/, "");
  const places = trimmed.length;
  // Clamp to a sane range for UI formatting.
  return Math.min(Math.max(places, 0), 8);
}

/** Heuristic decimals by price magnitude — used when no tick size is available. */
export function decimalsFromPrice(price: number): number {
  if (!Number.isFinite(price) || price <= 0) return 4;
  if (price >= 1000) return 2;
  if (price >= 1) return 3;
  if (price >= 0.01) return 4;
  if (price >= 0.0001) return 6;
  return 8;
}
