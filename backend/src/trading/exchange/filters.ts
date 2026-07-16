import { createHash } from "node:crypto";
import { fetchWithRetry } from "../../providers/http.js";
import type { ExchangeId, MarketType } from "../types.js";

export const FILTER_TTL_MS = 5 * 60 * 1_000;

/** Exact, symbol-scoped venue rules proven by one bounded public response. */
export interface SymbolFilters {
  exchange: Exclude<ExchangeId, "paper">;
  market: MarketType;
  symbol: string;
  status: "trading";
  /** LOT_SIZE/base quantity increment used by resting orders. */
  stepSize: string;
  /** Effective quantity increment used by market orders. */
  marketStepSize: string;
  /** PRICE_FILTER/price tick. */
  tickSize: string;
  minQty: string;
  marketMinQty: string;
  maxQty: string;
  marketMaxQty: string;
  minNotional: string;
  minNotionalAppliesToMarket: boolean;
  maxNotional?: string;
  maxNotionalAppliesToMarket?: boolean;
  minPrice?: string;
  maxPrice?: string;
  fingerprint: string;
  verifiedAt: number;
  expiresAt: number;
}

export class InstrumentRulesError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InstrumentRulesError";
  }
}

/**
 * Exact decimal floor used for wire values. Venue increments stay as strings;
 * BigInt arithmetic avoids IEEE-754 drift around step/tick boundaries.
 */
export function floorToIncrement(value: string | number, increment: string | number): string {
  const amount = decimal(value, "value");
  const step = positiveDecimal(increment, "increment");
  const scale = Math.max(amount.scale, step.scale);
  const amountUnits = rescale(amount, scale);
  const stepUnits = rescale(step, scale);
  return formatDecimal({ units: (amountUnits / stepUnits) * stepUnits, scale });
}

export function requirePositiveDecimal(value: string | number, label: string): string {
  return formatDecimal(positiveDecimal(value, label));
}

export function compareExactDecimals(left: string | number, right: string | number): number {
  return compareDecimal(decimal(left, "left decimal"), decimal(right, "right decimal"));
}

export function addExactDecimals(values: Array<string | number>): string {
  if (values.length === 0) return "0";
  const parsed = values.map((value) => decimal(value, "decimal sum value"));
  const scale = Math.max(...parsed.map((value) => value.scale));
  return formatDecimal({ units: parsed.reduce((total, value) => total + rescale(value, scale), 0n), scale });
}

/** Floor an exact percentage of a decimal quantity directly to a venue step. */
export function floorPercentToIncrement(value: string | number, percent: string | number, increment: string | number): string {
  const amount = positiveDecimal(value, "value");
  const ratio = positiveDecimal(percent, "percent");
  const step = positiveDecimal(increment, "increment");
  if (compareDecimal(ratio, decimal(100, "100 percent")) > 0) {
    throw new InstrumentRulesError("percent must not exceed 100");
  }
  const numerator = amount.units * ratio.units * 10n ** BigInt(step.scale);
  const denominator = 100n * 10n ** BigInt(amount.scale + ratio.scale) * step.units;
  const units = (numerator / denominator) * step.units;
  return formatDecimal({ units, scale: step.scale });
}

/** Apply a positive percentage and floor the result to an exact price tick. */
export function adjustByPercentToIncrement(value: string | number, percent: string | number, direction: "above" | "below", increment: string | number): string {
  const amount = positiveDecimal(value, "value");
  const ratio = positiveDecimal(percent, "percent");
  const hundred = decimal(100, "100 percent");
  if (direction === "below" && compareDecimal(ratio, hundred) >= 0) {
    throw new InstrumentRulesError("downward percent must be below 100");
  }
  const scale = Math.max(ratio.scale, hundred.scale);
  const factorUnits = direction === "above" ? rescale(hundred, scale) + rescale(ratio, scale) : rescale(hundred, scale) - rescale(ratio, scale);
  const factor = normalizeDecimal({ units: factorUnits, scale });
  const step = positiveDecimal(increment, "increment");
  const numerator = amount.units * factor.units * 10n ** BigInt(step.scale);
  const denominator = 100n * 10n ** BigInt(amount.scale + factor.scale) * step.units;
  return formatDecimal({ units: (numerator / denominator) * step.units, scale: step.scale });
}

/** Compatibility helper for callers that need a number after exact snapping. */
export function roundToStep(value: number, step: string | number | undefined): number {
  if (step === undefined || !Number.isFinite(value)) return value;
  try {
    return Number(floorToIncrement(value, step));
  } catch {
    return value;
  }
}

export function roundToTick(price: number, tick: string | number | undefined): number {
  return roundToStep(price, tick);
}

export function quantityIncrement(filters: SymbolFilters, marketOrder: boolean): string {
  return marketOrder ? filters.marketStepSize : filters.stepSize;
}

export function minimumQuantity(filters: SymbolFilters, marketOrder: boolean): string {
  return marketOrder ? filters.marketMinQty : filters.minQty;
}

export function checkPriceBounds(price: string | number, filters: SymbolFilters): string | undefined {
  try {
    const value = positiveDecimal(price, "price");
    if (filters.minPrice && compareDecimal(value, positiveDecimal(filters.minPrice, "minPrice")) < 0) {
      return `price ${formatDecimal(value)} is below minPrice ${filters.minPrice}`;
    }
    if (filters.maxPrice && compareDecimal(value, positiveDecimal(filters.maxPrice, "maxPrice")) > 0) {
      return `price ${formatDecimal(value)} is above maxPrice ${filters.maxPrice}`;
    }
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : "price rule validation failed";
  }
}

/** Meets positive quantity/price, minQty and the applicable minNotional. */
export function checkMinimums(
  qty: string | number,
  price: string | number,
  filters: SymbolFilters | undefined,
  options: {
    marketOrder?: boolean;
    validatePriceBounds?: boolean;
    skipMinNotional?: boolean;
  } = {}
): string | undefined {
  if (!filters) return "verified instrument rules are unavailable";
  try {
    const quantity = positiveDecimal(qty, "quantity");
    const referencePrice = positiveDecimal(price, "price");
    const marketOrder = options.marketOrder === true;
    const minQty = positiveDecimal(minimumQuantity(filters, marketOrder), "minQty");
    if (compareDecimal(quantity, minQty) < 0) {
      return `quantity ${formatDecimal(quantity)} is below minQty ${formatDecimal(minQty)}`;
    }
    const maxQty = positiveDecimal(marketOrder ? filters.marketMaxQty : filters.maxQty, "maxQty");
    if (compareDecimal(quantity, maxQty) > 0) {
      return `quantity ${formatDecimal(quantity)} is above maxQty ${formatDecimal(maxQty)}`;
    }
    if (options.validatePriceBounds !== false) {
      const priceViolation = checkPriceBounds(price, filters);
      if (priceViolation) return priceViolation;
    }
    const notional = multiplyDecimal(quantity, referencePrice);
    if (!options.skipMinNotional && (!marketOrder || filters.minNotionalAppliesToMarket)) {
      const minimum = positiveDecimal(filters.minNotional, "minNotional");
      if (compareDecimal(notional, minimum) < 0) {
        return `notional ${formatDecimal(notional)} is below minNotional ${formatDecimal(minimum)}`;
      }
    }
    if (filters.maxNotional && (!marketOrder || filters.maxNotionalAppliesToMarket)) {
      const maximum = positiveDecimal(filters.maxNotional, "maxNotional");
      if (compareDecimal(notional, maximum) > 0) {
        return `notional ${formatDecimal(notional)} is above maxNotional ${formatDecimal(maximum)}`;
      }
    }
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : "instrument rule validation failed";
  }
}

export function assertFreshSymbolFilters(filters: SymbolFilters, expected: { exchange: Exclude<ExchangeId, "paper">; market: MarketType; symbol: string }, now = Date.now()): SymbolFilters {
  if (filters.exchange !== expected.exchange || filters.market !== expected.market || filters.symbol !== expected.symbol) {
    throw new InstrumentRulesError(`Instrument rules identity mismatch for ${expected.exchange}:${expected.market}:${expected.symbol}`);
  }
  if (!Number.isSafeInteger(filters.verifiedAt) || !Number.isSafeInteger(filters.expiresAt) || filters.verifiedAt > now || filters.expiresAt <= now || filters.expiresAt <= filters.verifiedAt || filters.expiresAt - filters.verifiedAt > FILTER_TTL_MS) {
    throw new InstrumentRulesError(`Verified instrument rules are stale for ${expected.symbol}`);
  }
  if (filters.status !== "trading") throw new InstrumentRulesError(`${expected.symbol} is not in trading status`);
  for (const [name, value] of Object.entries({
    stepSize: filters.stepSize,
    marketStepSize: filters.marketStepSize,
    tickSize: filters.tickSize,
    minQty: filters.minQty,
    marketMinQty: filters.marketMinQty,
    maxQty: filters.maxQty,
    marketMaxQty: filters.marketMaxQty,
    minNotional: filters.minNotional
  })) {
    positiveDecimal(value, `${expected.symbol} ${name}`);
  }
  if (typeof filters.minNotionalAppliesToMarket !== "boolean") {
    throw new InstrumentRulesError(`Instrument rules are incomplete for ${expected.symbol}: min-notional market applicability is missing`);
  }
  for (const [name, value] of Object.entries({
    minPrice: filters.minPrice,
    maxPrice: filters.maxPrice,
    maxNotional: filters.maxNotional
  })) {
    if (value !== undefined) positiveDecimal(value, `${expected.symbol} ${name}`);
  }
  if (filters.maxNotional !== undefined && typeof filters.maxNotionalAppliesToMarket !== "boolean") {
    throw new InstrumentRulesError(`Instrument rules are incomplete for ${expected.symbol}: max-notional market applicability is missing`);
  }
  if (filters.fingerprint !== rulesFingerprint(filters)) {
    throw new InstrumentRulesError(`Instrument rules fingerprint mismatch for ${expected.symbol}`);
  }
  return filters;
}

const cache = new Map<string, SymbolFilters>();
const inflight = new Map<string, Promise<SymbolFilters>>();

function cacheKey(exchange: ExchangeId, symbol: string, market: MarketType): string {
  return `${exchange}:${market}:${symbol}`;
}

export function clearFilterCache(): void {
  cache.clear();
  inflight.clear();
}

export async function binanceFilters(symbol: string, market: MarketType): Promise<SymbolFilters> {
  return loadCached("binance", symbol, market, () => fetchBinance(symbol, market));
}

export async function bybitFilters(symbol: string, market: MarketType): Promise<SymbolFilters> {
  return loadCached("bybit", symbol, market, () => fetchBybit(symbol, market));
}

async function loadCached(exchange: Exclude<ExchangeId, "paper">, symbol: string, market: MarketType, loader: () => Promise<SymbolFilters>): Promise<SymbolFilters> {
  const expected = { exchange, symbol, market };
  const key = cacheKey(exchange, symbol, market);
  const cached = cache.get(key);
  if (cached) {
    try {
      return assertFreshSymbolFilters(cached, expected);
    } catch {
      cache.delete(key);
    }
  }
  const pending = inflight.get(key);
  if (pending) return pending;
  const promise = loader()
    .then((filters) => {
      const verified = assertFreshSymbolFilters(filters, expected);
      cache.set(key, verified);
      return verified;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

async function fetchBinance(symbol: string, market: MarketType): Promise<SymbolFilters> {
  const base = market === "futures" ? "https://fapi.binance.com" : "https://api.binance.com";
  const path = market === "futures" ? "/fapi/v1/exchangeInfo" : "/api/v3/exchangeInfo";
  const response = await fetchWithRetry(`${base}${path}?symbol=${encodeURIComponent(symbol)}`);
  if (!response.ok) throw new InstrumentRulesError(`Binance instrument rules HTTP ${response.status} for ${symbol}`);
  const data = (await response.json()) as { symbols?: unknown };
  const rows = array(data.symbols, "Binance symbols").filter((item) => record(item, "Binance symbol").symbol === symbol);
  if (rows.length !== 1) throw new InstrumentRulesError(`Binance returned ${rows.length} exact rows for ${symbol}`);
  const row = record(rows[0], `Binance ${symbol}`);
  if (row.status !== "TRADING") throw new InstrumentRulesError(`Binance ${symbol} is not in TRADING status`);
  const ruleRows = array(row.filters, `Binance ${symbol} filters`).map((item) => record(item, `Binance ${symbol} filter`));
  const lot = exactlyOne(ruleRows, "LOT_SIZE", symbol);
  const price = exactlyOne(ruleRows, "PRICE_FILTER", symbol);
  const marketLots = ruleRows.filter((item) => item.filterType === "MARKET_LOT_SIZE");
  if (marketLots.length > 1) throw new InstrumentRulesError(`Binance returned duplicate MARKET_LOT_SIZE filters for ${symbol}`);
  const marketLot = marketLots[0] ?? lot;
  const notionalRows = ruleRows.filter((item) => item.filterType === "NOTIONAL" || item.filterType === "MIN_NOTIONAL");
  if (notionalRows.length !== 1) throw new InstrumentRulesError(`Binance returned ${notionalRows.length} notional filters for ${symbol}`);
  const notional = notionalRows[0]!;
  const minNotionalAppliesToMarket = market === "futures" ? true : requiredBoolean(notional.filterType === "NOTIONAL" ? notional.applyMinToMarket : notional.applyToMarket, `${symbol} min-notional market applicability`);
  return verifiedFilters("binance", symbol, market, {
    status: "trading",
    stepSize: exactPositive(lot.stepSize, `${symbol} LOT_SIZE.stepSize`),
    marketStepSize: exactPositive(marketLot.stepSize, `${symbol} market stepSize`),
    tickSize: exactPositive(price.tickSize, `${symbol} PRICE_FILTER.tickSize`),
    minQty: exactPositive(lot.minQty, `${symbol} LOT_SIZE.minQty`),
    marketMinQty: exactPositive(marketLot.minQty, `${symbol} market minQty`),
    maxQty: exactPositive(lot.maxQty, `${symbol} LOT_SIZE.maxQty`),
    marketMaxQty: exactPositive(marketLot.maxQty, `${symbol} market maxQty`),
    minNotional: exactPositive(notional.notional ?? notional.minNotional, `${symbol} minNotional`),
    minNotionalAppliesToMarket,
    ...(optionalExactPositive(notional.maxNotional, `${symbol} maxNotional`)
      ? {
          maxNotional: optionalExactPositive(notional.maxNotional, `${symbol} maxNotional`)!,
          maxNotionalAppliesToMarket: market === "futures" ? true : requiredBoolean(notional.applyMaxToMarket, `${symbol} max-notional market applicability`)
        }
      : {}),
    ...(optionalExactPositive(price.minPrice, `${symbol} minPrice`) ? { minPrice: optionalExactPositive(price.minPrice, `${symbol} minPrice`)! } : {}),
    ...(optionalExactPositive(price.maxPrice, `${symbol} maxPrice`) ? { maxPrice: optionalExactPositive(price.maxPrice, `${symbol} maxPrice`)! } : {})
  });
}

async function fetchBybit(symbol: string, market: MarketType): Promise<SymbolFilters> {
  const category = market === "futures" ? "linear" : "spot";
  const response = await fetchWithRetry(`https://api.bybit.com/v5/market/instruments-info?category=${category}&symbol=${encodeURIComponent(symbol)}`);
  if (!response.ok) throw new InstrumentRulesError(`Bybit instrument rules HTTP ${response.status} for ${symbol}`);
  const data = record(await response.json(), "Bybit instrument rules response");
  if (data.retCode !== 0) throw new InstrumentRulesError(`Bybit instrument rules rejected for ${symbol}`);
  const result = record(data.result, "Bybit instrument rules result");
  const rows = array(result.list, "Bybit instrument list").filter((item) => record(item, "Bybit instrument").symbol === symbol);
  if (rows.length !== 1) throw new InstrumentRulesError(`Bybit returned ${rows.length} exact rows for ${symbol}`);
  const row = record(rows[0], `Bybit ${symbol}`);
  if (row.status !== "Trading") throw new InstrumentRulesError(`Bybit ${symbol} is not in Trading status`);
  const lot = record(row.lotSizeFilter, `Bybit ${symbol} lotSizeFilter`);
  const price = record(row.priceFilter, `Bybit ${symbol} priceFilter`);
  const stepSize = exactPositive(market === "futures" ? lot.qtyStep : lot.basePrecision, `${symbol} quantity step`);
  // Bybit spot deprecated minOrderQty/maxOrderQty/maxOrderAmt. Current spot
  // rules use amount plus distinct limit/market quantity caps.
  const minQty = market === "futures" ? exactPositive(lot.minOrderQty, `${symbol} minOrderQty`) : stepSize;
  const maxQty = exactPositive(market === "futures" ? lot.maxOrderQty : lot.maxLimitOrderQty, `${symbol} maxOrderQty`);
  const marketMaxQty = exactPositive(market === "futures" ? lot.maxMktOrderQty : lot.maxMarketOrderQty, `${symbol} market maxOrderQty`);
  return verifiedFilters("bybit", symbol, market, {
    status: "trading",
    stepSize,
    marketStepSize: stepSize,
    tickSize: exactPositive(price.tickSize, `${symbol} tickSize`),
    minQty,
    marketMinQty: minQty,
    maxQty,
    marketMaxQty,
    minNotional: exactPositive(lot.minNotionalValue ?? lot.minOrderAmt, `${symbol} minNotional`),
    minNotionalAppliesToMarket: true,
    ...(optionalExactPositive(price.minPrice, `${symbol} minPrice`) ? { minPrice: optionalExactPositive(price.minPrice, `${symbol} minPrice`)! } : {}),
    ...(optionalExactPositive(price.maxPrice, `${symbol} maxPrice`) ? { maxPrice: optionalExactPositive(price.maxPrice, `${symbol} maxPrice`)! } : {})
  });
}

function verifiedFilters(exchange: Exclude<ExchangeId, "paper">, symbol: string, market: MarketType, rules: Omit<SymbolFilters, "exchange" | "symbol" | "market" | "verifiedAt" | "expiresAt" | "fingerprint">): SymbolFilters {
  const verifiedAt = Date.now();
  const base = { exchange, symbol, market, ...rules };
  return { ...base, fingerprint: rulesFingerprint(base), verifiedAt, expiresAt: verifiedAt + FILTER_TTL_MS };
}

function exactlyOne(rows: Record<string, unknown>[], type: string, symbol: string): Record<string, unknown> {
  const matches = rows.filter((item) => item.filterType === type);
  if (matches.length !== 1) throw new InstrumentRulesError(`Binance returned ${matches.length} ${type} filters for ${symbol}`);
  return matches[0]!;
}

function exactPositive(value: unknown, label: string): string {
  if (typeof value !== "string") throw new InstrumentRulesError(`${label} must be an exact decimal string`);
  return formatDecimal(positiveDecimal(value, label));
}

function optionalExactPositive(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : exactPositive(value, label);
}

function rulesFingerprint(filters: Omit<SymbolFilters, "fingerprint" | "verifiedAt" | "expiresAt">): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        filters.exchange,
        filters.market,
        filters.symbol,
        filters.status,
        filters.stepSize,
        filters.marketStepSize,
        filters.tickSize,
        filters.minQty,
        filters.marketMinQty,
        filters.maxQty,
        filters.marketMaxQty,
        filters.minNotional,
        filters.minNotionalAppliesToMarket,
        filters.maxNotional ?? null,
        filters.maxNotionalAppliesToMarket ?? null,
        filters.minPrice ?? null,
        filters.maxPrice ?? null
      ])
    )
    .digest("hex");
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new InstrumentRulesError(`${label} is missing`);
  return value;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new InstrumentRulesError(`${label} is missing`);
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new InstrumentRulesError(`${label} is invalid`);
  return value as Record<string, unknown>;
}

interface ExactDecimal {
  units: bigint;
  scale: number;
}

const MAX_DECIMAL_SCALE = 30;
const MAX_DECIMAL_DIGITS = 80;

function positiveDecimal(value: string | number, label: string): ExactDecimal {
  const parsed = decimal(value, label);
  if (parsed.units <= 0n) throw new InstrumentRulesError(`${label} must be finite and positive`);
  return parsed;
}

function decimal(value: string | number, label: string): ExactDecimal {
  const text = typeof value === "number" ? (Number.isFinite(value) ? String(value) : "") : value.trim();
  const match = /^(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!match) throw new InstrumentRulesError(`${label} must be a finite unsigned decimal`);
  const whole = match[1]!;
  const fraction = match[2] ?? "";
  const exponent = Number(match[3] ?? 0);
  if (!Number.isSafeInteger(exponent)) throw new InstrumentRulesError(`${label} exponent is invalid`);
  let digits = `${whole}${fraction}`.replace(/^0+(?=\d)/, "");
  let scale = fraction.length - exponent;
  if (digits.length > MAX_DECIMAL_DIGITS || Math.abs(scale) > MAX_DECIMAL_SCALE) {
    throw new InstrumentRulesError(`${label} exceeds the supported decimal precision`);
  }
  if (scale < 0) {
    digits += "0".repeat(-scale);
    scale = 0;
  }
  const result = normalizeDecimal({ units: BigInt(digits || "0"), scale });
  if (result.scale > MAX_DECIMAL_SCALE) throw new InstrumentRulesError(`${label} exceeds the supported decimal scale`);
  return result;
}

function normalizeDecimal(value: ExactDecimal): ExactDecimal {
  let { units, scale } = value;
  while (scale > 0 && units % 10n === 0n) {
    units /= 10n;
    scale -= 1;
  }
  return { units, scale };
}

function rescale(value: ExactDecimal, scale: number): bigint {
  return value.units * 10n ** BigInt(scale - value.scale);
}

function compareDecimal(left: ExactDecimal, right: ExactDecimal): number {
  const scale = Math.max(left.scale, right.scale);
  const a = rescale(left, scale);
  const b = rescale(right, scale);
  return a < b ? -1 : a > b ? 1 : 0;
}

function multiplyDecimal(left: ExactDecimal, right: ExactDecimal): ExactDecimal {
  return normalizeDecimal({ units: left.units * right.units, scale: left.scale + right.scale });
}

function formatDecimal(value: ExactDecimal): string {
  const normalized = normalizeDecimal(value);
  if (normalized.scale === 0) return normalized.units.toString();
  const digits = normalized.units.toString().padStart(normalized.scale + 1, "0");
  const split = digits.length - normalized.scale;
  return `${digits.slice(0, split)}.${digits.slice(split)}`;
}
