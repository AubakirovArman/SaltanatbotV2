import { fetchWithRetry } from "../../providers/http.js";
import type { ExchangeId, MarketType } from "../types.js";

/**
 * Exchange symbol trading filters. Live orders must obey the venue's LOT_SIZE
 * (quantity step), PRICE_FILTER (price tick) and MIN_NOTIONAL rules or the
 * exchange rejects them (Binance error -1013 "Filter failure"). These helpers
 * fetch and cache the relevant filters per symbol and round order qty/price to
 * the nearest valid increment before we sign a request.
 *
 * Everything here is fail-safe: a network/parse failure resolves to `undefined`
 * so callers fall back to their previous formatting rather than blocking a trade.
 */
export interface SymbolFilters {
  /** Quantity increment (LOT_SIZE stepSize). */
  stepSize: number;
  /** Price increment (PRICE_FILTER tickSize). */
  tickSize: number;
  /** Minimum order quantity (LOT_SIZE minQty). */
  minQty: number;
  /** Minimum order notional (price * qty), if the venue enforces one. */
  minNotional: number;
}

/**
 * Floor `value` to the nearest multiple of `step`. A zero/negative/undefined
 * step means "no constraint" and the value passes through unchanged. Uses a
 * decimal-aware round-trip to cancel binary float error (e.g. 0.1 + 0.2).
 */
export function roundToStep(value: number, step: number | undefined): number {
  if (!step || step <= 0 || !Number.isFinite(step)) return value;
  if (!Number.isFinite(value)) return value;
  // Number of decimals in the step drives the precision we snap back to.
  const decimals = decimalsOf(step);
  const steps = Math.floor(roundTo(value / step, 12));
  return roundTo(steps * step, decimals);
}

/** Floor a price to the nearest tick. Same semantics as {@link roundToStep}. */
export function roundToTick(price: number, tick: number | undefined): number {
  return roundToStep(price, tick);
}

/** Meets minQty and minNotional; returns a reason string when it fails. */
export function checkMinimums(qty: number, price: number, filters: SymbolFilters | undefined): string | undefined {
  if (!filters) return undefined;
  if (filters.minQty > 0 && qty < filters.minQty) {
    return `quantity ${qty} is below minQty ${filters.minQty}`;
  }
  if (filters.minNotional > 0 && price > 0 && qty * price < filters.minNotional) {
    return `notional ${roundTo(qty * price, 8)} is below minNotional ${filters.minNotional}`;
  }
  return undefined;
}

// ---------- caching ----------

const cache = new Map<string, SymbolFilters | undefined>();
const inflight = new Map<string, Promise<SymbolFilters | undefined>>();

function cacheKey(exchange: ExchangeId, symbol: string, market: MarketType): string {
  return `${exchange}:${market}:${symbol}`;
}

/** For tests: drop cached filters so a fresh fetch runs. */
export function clearFilterCache(): void {
  cache.clear();
  inflight.clear();
}

/**
 * Fetch (and memoise) Binance symbol filters. `futures` reads
 * /fapi/v1/exchangeInfo, `spot` reads /api/v3/exchangeInfo. Returns `undefined`
 * on any failure so the caller degrades to its old formatting.
 */
export async function binanceFilters(symbol: string, market: MarketType): Promise<SymbolFilters | undefined> {
  return loadCached("binance", symbol, market, () => fetchBinance(symbol, market));
}

/** Fetch (and memoise) Bybit symbol filters from /v5/market/instruments-info. */
export async function bybitFilters(symbol: string, market: MarketType): Promise<SymbolFilters | undefined> {
  return loadCached("bybit", symbol, market, () => fetchBybit(symbol, market));
}

async function loadCached(
  exchange: ExchangeId,
  symbol: string,
  market: MarketType,
  loader: () => Promise<SymbolFilters | undefined>
): Promise<SymbolFilters | undefined> {
  const key = cacheKey(exchange, symbol, market);
  if (cache.has(key)) return cache.get(key);
  const pending = inflight.get(key);
  if (pending) return pending;
  const promise = loader()
    .then((filters) => {
      // Only cache successes so a transient failure can be retried next call.
      if (filters) cache.set(key, filters);
      return filters;
    })
    .catch(() => undefined)
    .finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

// ---------- Binance ----------

async function fetchBinance(symbol: string, market: MarketType): Promise<SymbolFilters | undefined> {
  const base = market === "futures" ? "https://fapi.binance.com" : "https://api.binance.com";
  const path = market === "futures" ? "/fapi/v1/exchangeInfo" : "/api/v3/exchangeInfo";
  const res = await fetchWithRetry(`${base}${path}?symbol=${encodeURIComponent(symbol)}`);
  if (!res.ok) return undefined;
  const data = (await res.json()) as {
    symbols?: Array<{ symbol: string; filters?: Array<Record<string, string>> }>;
  };
  const row = data.symbols?.find((item) => item.symbol === symbol) ?? data.symbols?.[0];
  if (!row?.filters) return undefined;
  const byType = (type: string) => row.filters!.find((filter) => filter.filterType === type);
  const lot = byType("LOT_SIZE");
  const price = byType("PRICE_FILTER");
  // Futures use MIN_NOTIONAL.notional; spot uses NOTIONAL.minNotional (or the
  // legacy MIN_NOTIONAL.minNotional). Handle all shapes.
  const notional = byType("MIN_NOTIONAL") ?? byType("NOTIONAL");
  const filters: SymbolFilters = {
    stepSize: num(lot?.stepSize),
    tickSize: num(price?.tickSize),
    minQty: num(lot?.minQty),
    minNotional: num(notional?.notional ?? notional?.minNotional)
  };
  return sane(filters) ? filters : undefined;
}

// ---------- Bybit ----------

async function fetchBybit(symbol: string, market: MarketType): Promise<SymbolFilters | undefined> {
  const category = market === "futures" ? "linear" : "spot";
  const url = `https://api.bybit.com/v5/market/instruments-info?category=${category}&symbol=${encodeURIComponent(symbol)}`;
  const res = await fetchWithRetry(url);
  if (!res.ok) return undefined;
  const data = (await res.json()) as {
    retCode?: number;
    result?: {
      list?: Array<{
        symbol: string;
        lotSizeFilter?: { qtyStep?: string; basePrecision?: string; minOrderQty?: string; minOrderAmt?: string; minNotionalValue?: string };
        priceFilter?: { tickSize?: string };
      }>;
    };
  };
  if (data.retCode !== undefined && data.retCode !== 0) return undefined;
  const row = data.result?.list?.find((item) => item.symbol === symbol) ?? data.result?.list?.[0];
  if (!row) return undefined;
  const lot = row.lotSizeFilter;
  const filters: SymbolFilters = {
    // Linear uses qtyStep; spot uses basePrecision for the qty increment.
    stepSize: num(lot?.qtyStep ?? lot?.basePrecision),
    tickSize: num(row.priceFilter?.tickSize),
    minQty: num(lot?.minOrderQty),
    minNotional: num(lot?.minNotionalValue ?? lot?.minOrderAmt)
  };
  return sane(filters) ? filters : undefined;
}

// ---------- utilities ----------

/** A filter set is usable if it gives at least one real constraint. */
function sane(filters: SymbolFilters): boolean {
  return filters.stepSize > 0 || filters.tickSize > 0 || filters.minQty > 0 || filters.minNotional > 0;
}

function num(value: string | number | undefined): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/** Count decimal places, tolerating scientific notation (e.g. "1e-8"). */
function decimalsOf(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 0;
  const text = step.toExponential();
  const match = /e([+-]?\d+)/.exec(text);
  const exp = match ? Number(match[1]) : 0;
  const mantissaDecimals = (text.split("e")[0].split(".")[1] ?? "").length;
  return Math.max(0, mantissaDecimals - exp);
}

/** Round to N decimals to erase binary float noise. */
function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
