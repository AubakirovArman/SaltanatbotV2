import type { RegistryInstrument, VenueMarketType, VenueQuantityUnit } from "@saltanatbotv2/contracts";
import type { AdapterValidationIssue, PublicDepthLevel, PublicDepthSnapshot, PublicFundingPoint, PublicFundingSchedule, PublicTopBook } from "../publicTypes.js";
import type { KrakenDerivativeType, KrakenFundingRateRow, KrakenFuturesInstrumentRow, KrakenFuturesOrderBookRow, KrakenFuturesTickerRow } from "./types.js";
import { asset, boolean, errorMessage, exactString, finite, instrumentId, integer, isoTimestamp, optionalNonNegativeField, optionalPositiveField, positive, record, validation } from "./validation.js";

const FUNDING_INTERVAL_MS = 60 * 60 * 1_000;
const MAX_SOURCE_DEPTH_LEVELS = 10_000;

export function normalizeKrakenFuturesInstruments(rows: unknown[], expectedMarketType: VenueMarketType) {
  requireDerivativeMarketType(expectedMarketType);
  const instruments: RegistryInstrument[] = [];
  const rejectedRows: AdapterValidationIssue[] = [];
  rows.forEach((raw, index) => {
    try {
      const instrument = normalizeInstrument(record(raw, `instrument[${index}]`) as KrakenFuturesInstrumentRow);
      if (instrument.marketType === expectedMarketType) instruments.push(instrument);
    } catch (error) {
      rejectedRows.push({ index, instrumentId: rawSymbol(raw), message: errorMessage(error) });
    }
  });
  return { instruments, rejectedRows };
}

export function normalizeKrakenFuturesTicker(raw: unknown, expectedMarketType: VenueMarketType, exchangeTs: number, receivedAt: number): PublicTopBook {
  requireDerivativeMarketType(expectedMarketType);
  const row = record(raw, "ticker") as KrakenFuturesTickerRow;
  const symbol = instrumentId(row.symbol, "ticker.symbol");
  const marketType = derivativeMarketType(symbol, row.tag, undefined);
  if (marketType !== expectedMarketType) throw validation(`ticker ${symbol} is ${marketType}, expected ${expectedMarketType}`);
  const bid = positive(row.bid, "ticker.bid");
  const ask = positive(row.ask, "ticker.ask");
  if (bid >= ask) throw validation(`ticker ${symbol} is crossed or locked`);
  return {
    venue: "kraken",
    instrumentId: symbol,
    marketType,
    quantityUnit: derivativeQuantityUnit(symbol),
    bid,
    bidSize: positive(row.bidSize, "ticker.bidSize"),
    ask,
    askSize: positive(row.askSize, "ticker.askSize"),
    ...optionalPositiveField("last", row.last),
    ...optionalPositiveField("lastSize", row.lastSize),
    ...optionalNonNegativeField("volume24h", row.vol24h),
    ...optionalNonNegativeField("volumeCurrency24h", row.volumeQuote),
    exchangeTs: positiveTimestamp(exchangeTs, "ticker serverTime"),
    receivedAt
  };
}

export function normalizeKrakenFuturesDepth(raw: unknown, request: { instrumentId: string; marketType: VenueMarketType; limit: number }, exchangeTs: number, receivedAt: number): PublicDepthSnapshot {
  requireDerivativeMarketType(request.marketType);
  const symbol = instrumentId(request.instrumentId, "instrumentId");
  if (derivativeMarketType(symbol, undefined, undefined) !== request.marketType) {
    throw validation(`instrumentId ${symbol} does not match ${request.marketType}`);
  }
  const row = record(raw, "orderBook") as KrakenFuturesOrderBookRow;
  const bids = derivativeDepthLevels(row.bids, "orderBook.bids", "bids", request.limit);
  const asks = derivativeDepthLevels(row.asks, "orderBook.asks", "asks", request.limit);
  if (bids.length === 0 || asks.length === 0) throw validation("depth requires both non-empty sides");
  if (bids[0]![0] >= asks[0]![0]) throw validation("depth is crossed or locked");
  return {
    venue: "kraken",
    instrumentId: symbol,
    marketType: request.marketType,
    quantityUnit: derivativeQuantityUnit(symbol),
    bids,
    asks,
    // Kraken Futures REST snapshots expose no update sequence. Zero is an explicit sentinel.
    sequence: 0,
    exchangeTs: positiveTimestamp(exchangeTs, "orderbook serverTime"),
    receivedAt,
    complete: true
  };
}

export function normalizeKrakenInverseFunding(currentRaw: unknown, historyRows: unknown[], instrument: string, exchangeTs: number, receivedAt: number, historyLimit: number, sourceErrors: string[] = []): PublicFundingSchedule {
  const symbol = instrumentId(instrument, "instrumentId");
  if (!symbol.startsWith("PI_")) throw validation("funding normalization currently requires a Kraken inverse PI_ perpetual");
  const current = record(currentRaw, "funding ticker") as KrakenFuturesTickerRow;
  if (instrumentId(current.symbol, "funding.symbol") !== symbol) throw validation("funding ticker does not match request");
  if (derivativeMarketType(symbol, current.tag, undefined) !== "perpetual") throw validation("funding requires a perpetual instrument");
  const indexPrice = positive(current.indexPrice, "funding.indexPrice");
  const currentEstimateRate = boundedFundingRate(finite(current.fundingRate, "funding.fundingRate") * indexPrice, "current relative funding rate");
  const nextEstimateRate = current.fundingRatePrediction === undefined || current.fundingRatePrediction === null ? undefined : boundedFundingRate(finite(current.fundingRatePrediction, "funding.fundingRatePrediction") * indexPrice, "predicted relative funding rate");
  const history = normalizeFundingHistory(historyRows, symbol, historyLimit, sourceErrors);
  const fundingTime = nextHour(exchangeTs);
  return {
    venue: "kraken",
    instrumentId: symbol,
    currentEstimateRate,
    fundingTime,
    nextFundingTime: fundingTime + FUNDING_INTERVAL_MS,
    intervalMinutes: 60,
    scheduleVerified: true,
    ...(nextEstimateRate === undefined ? {} : { nextEstimateRate }),
    ...(history.length === 0 ? {} : { settledRate: history.at(-1)!.fundingRate }),
    formulaType: "inverse-absolute-times-index",
    method: "continuous-hourly",
    exchangeTs: positiveTimestamp(exchangeTs, "funding serverTime"),
    receivedAt,
    history,
    sourceErrors
  };
}

export function derivativeMarketType(symbolValue: unknown, tagValue?: unknown, expiryValue?: unknown): "perpetual" | "future" {
  const symbol = instrumentId(symbolValue, "derivative symbol");
  if (symbol.startsWith("PI_") || symbol.startsWith("PF_")) {
    if (expiryValue !== undefined && expiryValue !== null && expiryValue !== "") throw validation(`perpetual ${symbol} cannot have lastTradingTime`);
    if (tagValue !== undefined && tagValue !== null && tagValue !== "" && exactString(tagValue, "ticker.tag") !== "perpetual") {
      throw validation(`perpetual ${symbol} has inconsistent tag`);
    }
    return "perpetual";
  }
  if (symbol.startsWith("FI_") || symbol.startsWith("FF_")) return "future";
  throw validation(`unsupported Kraken derivative symbol family ${symbol}`);
}

function normalizeInstrument(row: KrakenFuturesInstrumentRow): RegistryInstrument {
  const symbol = instrumentId(row.symbol, "instrument.symbol");
  const type = derivativeType(row.type);
  if (type === "futures_vanilla") {
    throw validation("futures_vanilla quantity currency is not explicit enough for normalization");
  }
  const marketType = derivativeMarketType(symbol, undefined, row.lastTradingTime);
  const baseAsset = asset(row.base, "instrument.base");
  const quoteAsset = asset(row.quote, "instrument.quote");
  const contractSize = positive(row.contractSize, "instrument.contractSize");
  const precision = integer(row.contractValueTradePrecision, "instrument.contractValueTradePrecision");
  if (precision < 0 || precision > 12) throw validation("instrument.contractValueTradePrecision must be between 0 and 12");
  const inverse = type === "futures_inverse";
  const quantityStep = inverse ? 1 : 10 ** -precision;
  const pair = normalizedPair(row.pair, baseAsset, quoteAsset);
  const expiryTime = marketType === "future" ? isoTimestamp(row.lastTradingTime, "instrument.lastTradingTime") : undefined;
  const expired = boolean(row.isExpired, "instrument.isExpired");
  const tradeable = boolean(row.tradeable, "instrument.tradeable");
  const postOnly = row.postOnly === undefined ? false : boolean(row.postOnly, "instrument.postOnly");
  return {
    id: `kraken:${marketType}:${symbol}`,
    assetId: baseAsset,
    venue: "kraken",
    venueSymbol: symbol,
    baseAsset,
    quoteAsset,
    settleAsset: inverse ? baseAsset : quoteAsset,
    marketType,
    contractDirection: inverse ? "inverse" : "linear",
    contractMultiplier: contractSize,
    contractValue: contractSize,
    contractValueCurrency: inverse ? quoteAsset : baseAsset,
    quantityUnit: inverse ? "contract" : "base",
    underlying: optionalUnderlying(row.underlying, pair),
    instrumentFamily: pair,
    tickSize: positive(row.tickSize, "instrument.tickSize"),
    quantityStep,
    minimumQuantity: quantityStep,
    minimumNotional: 0,
    status: expired ? "closed" : tradeable || postOnly ? "trading" : "settling",
    ...(marketType === "perpetual" ? { fundingIntervalMinutes: 60 } : {}),
    ...(expiryTime === undefined ? {} : { expiryTime })
  };
}

function normalizeFundingHistory(rows: unknown[], instrument: string, limit: number, sourceErrors: string[]): PublicFundingPoint[] {
  const points: PublicFundingPoint[] = [];
  const seen = new Set<number>();
  rows.forEach((raw, index) => {
    try {
      const row = record(raw, `funding history[${index}]`) as KrakenFundingRateRow;
      const fundingTime = isoTimestamp(row.timestamp, `funding history[${index}].timestamp`);
      if (seen.has(fundingTime)) throw validation(`duplicate funding timestamp ${fundingTime}`);
      seen.add(fundingTime);
      const relativeRate = boundedFundingRate(finite(row.relativeFundingRate, `funding history[${index}].relativeFundingRate`), "historical relative funding rate");
      finite(row.fundingRate, `funding history[${index}].fundingRate`);
      points.push({
        instrumentId: instrument,
        fundingTime,
        fundingRate: relativeRate,
        realizedRate: relativeRate,
        formulaType: "venue-relative",
        method: "settled"
      });
    } catch (error) {
      sourceErrors.push(`history[${index}]: ${errorMessage(error)}`);
    }
  });
  points.sort((left, right) => left.fundingTime - right.fundingTime);
  return points.slice(-limit);
}

function derivativeDepthLevels(value: unknown, label: string, side: "bids" | "asks", outputLimit: number): PublicDepthLevel[] {
  if (!Array.isArray(value)) throw validation(`${label} must be an array`);
  if (value.length > MAX_SOURCE_DEPTH_LEVELS) throw validation(`${label} exceeds ${MAX_SOURCE_DEPTH_LEVELS} source levels`);
  const levels: PublicDepthLevel[] = value.map((raw, index) => {
    if (!Array.isArray(raw) || raw.length < 2) throw validation(`${label}[${index}] must contain price and quantity`);
    return [positive(raw[0], `${label}[${index}].price`), positive(raw[1], `${label}[${index}].quantity`)];
  });
  for (let index = 1; index < levels.length; index += 1) {
    const invalid = side === "bids" ? levels[index]![0] >= levels[index - 1]![0] : levels[index]![0] <= levels[index - 1]![0];
    if (invalid) throw validation(`${label} is not strictly sorted`);
  }
  return levels.slice(0, outputLimit);
}

function derivativeType(value: unknown): KrakenDerivativeType {
  const parsed = exactString(value, "instrument.type");
  if (parsed === "futures_inverse" || parsed === "futures_vanilla" || parsed === "flexible_futures") return parsed;
  throw validation(`unsupported instrument.type ${parsed}`);
}

function derivativeQuantityUnit(symbol: string): VenueQuantityUnit {
  if (symbol.startsWith("PI_") || symbol.startsWith("FI_")) return "contract";
  if (symbol.startsWith("PF_") || symbol.startsWith("FF_")) return "base";
  throw validation(`unsupported derivative quantity unit for ${symbol}`);
}

function normalizedPair(value: unknown, baseAsset: string, quoteAsset: string): string {
  const pair = instrumentId(value, "instrument.pair").replace(":", "-");
  const expected = `${baseAsset}-${quoteAsset}`;
  const canonical = pair.replace(/^XBT-/, "BTC-");
  if (canonical !== expected) throw validation(`instrument.pair ${pair} does not match ${expected}`);
  return expected;
}

function optionalUnderlying(value: unknown, fallback: string): string {
  if (value === undefined || value === null || value === "") return fallback;
  return instrumentId(value, "instrument.underlying");
}

function rawSymbol(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const symbol = (value as KrakenFuturesInstrumentRow).symbol;
  return typeof symbol === "string" ? symbol.toUpperCase() : undefined;
}

function requireDerivativeMarketType(value: VenueMarketType): asserts value is "perpetual" | "future" {
  if (value !== "perpetual" && value !== "future") throw validation(`unsupported derivative market type ${value}`);
}

function boundedFundingRate(value: number, label: string): number {
  if (!Number.isFinite(value) || Math.abs(value) > 1) throw validation(`${label} must be a finite fraction between -1 and 1`);
  return value;
}

function nextHour(timestamp: number): number {
  const validated = positiveTimestamp(timestamp, "funding serverTime");
  return Math.floor(validated / FUNDING_INTERVAL_MS) * FUNDING_INTERVAL_MS + FUNDING_INTERVAL_MS;
}

function positiveTimestamp(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw validation(`${label} must be a positive safe integer`);
  return value;
}
