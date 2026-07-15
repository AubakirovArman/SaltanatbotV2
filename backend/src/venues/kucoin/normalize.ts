import type { RegistryInstrument, VenueMarketType, VenueQuantityUnit } from "@saltanatbotv2/contracts";
import type { AdapterValidationIssue, PublicDepthLevel, PublicDepthSnapshot, PublicFundingPoint, PublicFundingSchedule, PublicTopBook } from "../publicTypes.js";
import { PublicVenueAdapterError } from "../publicTypes.js";
import type { KucoinCurrentFundingRow, KucoinDepthRow, KucoinFundingHistoryRow, KucoinMarketType, KucoinPerpetualInstrumentRow, KucoinPerpetualTickerRow, KucoinSpotInstrumentRow, KucoinSpotTickerRow } from "./types.js";
import { asset, boolean, errorMessage, exactString, finite, nanosToMillis, nonNegative, optionalFinite, optionalNonNegative, positive, positiveMillis, rawAsset, record, safeInteger, validation, venueSymbol } from "./validation.js";

const MAX_SOURCE_LEVELS = 2_000;

export function kucoinMarketType(value: VenueMarketType): KucoinMarketType {
  if (value === "spot" || value === "perpetual") return value;
  throw new PublicVenueAdapterError("kucoin", "unsupported", `unsupported market type ${value}`);
}

export function normalizeKucoinInstruments(rows: unknown[], marketType: KucoinMarketType) {
  const instruments: RegistryInstrument[] = [];
  const rejectedRows: AdapterValidationIssue[] = [];
  rows.forEach((raw, index) => {
    try {
      const row = record(raw, `instrument[${index}]`);
      instruments.push(marketType === "spot" ? normalizeSpotInstrument(row as KucoinSpotInstrumentRow) : normalizePerpetualInstrument(row as KucoinPerpetualInstrumentRow));
    } catch (error) {
      rejectedRows.push({ index, instrumentId: rawInstrumentId(raw), message: errorMessage(error) });
    }
  });
  return { instruments, rejectedRows };
}

export function normalizeKucoinTicker(raw: unknown, marketType: KucoinMarketType, receivedAt: number, fallbackExchangeTs?: number): PublicTopBook {
  return marketType === "spot" ? normalizeSpotTicker(record(raw, "ticker") as KucoinSpotTickerRow, receivedAt, fallbackExchangeTs) : normalizePerpetualTicker(record(raw, "ticker") as KucoinPerpetualTickerRow, receivedAt);
}

export function normalizeKucoinDepth(raw: unknown, request: { instrumentId: string; marketType: KucoinMarketType; limit: number }, receivedAt: number): PublicDepthSnapshot {
  const row = record(raw, "depth") as KucoinDepthRow;
  if (row.symbol !== undefined && venueSymbol(row.symbol, "depth.symbol") !== request.instrumentId) throw validation("depth symbol does not match request");
  const bids = depthLevels(row.bids, "depth.bids", "bids", request.limit);
  const asks = depthLevels(row.asks, "depth.asks", "asks", request.limit);
  if (bids.length === 0 || asks.length === 0) throw validation("depth requires both non-empty sides");
  if (bids[0]![0] >= asks[0]![0]) throw validation("depth is crossed or locked");
  return {
    venue: "kucoin",
    instrumentId: venueSymbol(request.instrumentId, "instrumentId"),
    marketType: request.marketType,
    quantityUnit: quantityUnit(request.marketType),
    bids,
    asks,
    sequence: safeInteger(row.sequence, "depth.sequence"),
    exchangeTs: request.marketType === "spot" ? positiveMillis(row.time, "depth.time") : nanosToMillis(row.ts, "depth.ts"),
    receivedAt,
    complete: true
  };
}

export function normalizeKucoinFunding(currentRaw: unknown, historyRows: unknown[], instrumentId: string, receivedAt: number, historyErrors: string[] = []): PublicFundingSchedule {
  const current = record(currentRaw, "current funding") as KucoinCurrentFundingRow;
  const normalizedId = venueSymbol(instrumentId, "instrumentId");
  const granularity = safeInteger(current.granularity, "funding.granularity", 1);
  if (granularity % 60_000 !== 0 || granularity > 86_400_000) throw validation("funding granularity must be whole minutes no longer than 24 hours");
  const fundingTime = positiveMillis(current.fundingTime, "funding.fundingTime");
  const nextFundingTime = fundingTime + granularity;
  if (!Number.isSafeInteger(nextFundingTime)) throw validation("next funding timestamp exceeds safe integer range");
  const sourceErrors = [...historyErrors];
  const history: PublicFundingPoint[] = [];
  historyRows.forEach((raw, index) => {
    try {
      history.push(normalizeFundingPoint(raw, normalizedId));
    } catch (error) {
      sourceErrors.push(`history[${index}]: ${errorMessage(error)}`);
    }
  });
  history.sort((left, right) => left.fundingTime - right.fundingTime);
  return {
    venue: "kucoin",
    instrumentId: normalizedId,
    currentEstimateRate: finite(current.value, "funding.value"),
    fundingTime,
    nextFundingTime,
    intervalMinutes: granularity / 60_000,
    scheduleVerified: true,
    ...optionalFiniteField("nextEstimateRate", current.predictedValue),
    ...optionalFiniteField("minimumRate", current.fundingRateFloor),
    ...optionalFiniteField("maximumRate", current.fundingRateCap),
    formulaType: "kucoin-perpetual",
    method: "public current funding value at fundingTime; predictedValue is the next estimate",
    exchangeTs: positiveMillis(current.timePoint, "funding.timePoint"),
    receivedAt,
    history,
    sourceErrors
  };
}

function normalizeSpotInstrument(row: KucoinSpotInstrumentRow): RegistryInstrument {
  const venueSymbolValue = venueSymbol(row.symbol, "instrument.symbol");
  const rawBase = rawAsset(row.baseCurrency, "instrument.baseCurrency");
  const rawQuote = rawAsset(row.quoteCurrency, "instrument.quoteCurrency");
  if (venueSymbolValue !== `${rawBase}-${rawQuote}`) throw validation("instrument.symbol does not match base and quote currencies");
  const enabled = boolean(row.enableTrading, "instrument.enableTrading");
  const callAuction = row.callauctionIsEnabled === undefined ? false : boolean(row.callauctionIsEnabled, "instrument.callauctionIsEnabled");
  const baseAsset = asset(rawBase, "instrument.baseCurrency");
  const quoteAsset = asset(rawQuote, "instrument.quoteCurrency");
  return {
    id: `kucoin:spot:${venueSymbolValue}`,
    assetId: baseAsset,
    venue: "kucoin",
    venueSymbol: venueSymbolValue,
    baseAsset,
    quoteAsset,
    settleAsset: quoteAsset,
    marketType: "spot",
    contractMultiplier: 1,
    quantityUnit: "base",
    tickSize: positive(row.priceIncrement, "instrument.priceIncrement"),
    quantityStep: positive(row.baseIncrement, "instrument.baseIncrement"),
    minimumQuantity: positive(row.baseMinSize, "instrument.baseMinSize"),
    minimumNotional: positive(row.minFunds, "instrument.minFunds"),
    status: enabled && !callAuction ? "trading" : "settling"
  };
}

function normalizePerpetualInstrument(row: KucoinPerpetualInstrumentRow): RegistryInstrument {
  const venueSymbolValue = venueSymbol(row.symbol, "instrument.symbol");
  const baseAsset = asset(row.baseCurrency, "instrument.baseCurrency");
  const quoteAsset = asset(row.quoteCurrency, "instrument.quoteCurrency");
  const settleAsset = asset(row.settleCurrency, "instrument.settleCurrency");
  if (row.expireDate !== null) throw validation("only non-expiring perpetual contracts are supported");
  if (boolean(row.isInverse, "instrument.isInverse")) throw validation("inverse contracts are quarantined until quote-value units are certified");
  if (quoteAsset !== "USDT" || settleAsset !== "USDT") throw validation("only linear USDT-settled perpetual contracts are supported");
  const multiplier = positive(row.multiplier, "instrument.multiplier");
  const lotSize = positive(row.lotSize, "instrument.lotSize");
  const intervalMs = optionalNonNegative(row.currentFundingRateGranularity, "instrument.currentFundingRateGranularity");
  const fundingIntervalMinutes = intervalMs !== undefined && intervalMs > 0 && intervalMs % 60_000 === 0 ? intervalMs / 60_000 : undefined;
  return {
    id: `kucoin:perpetual:${venueSymbolValue}`,
    assetId: baseAsset,
    venue: "kucoin",
    venueSymbol: venueSymbolValue,
    baseAsset,
    quoteAsset,
    settleAsset,
    marketType: "perpetual",
    contractDirection: "linear",
    contractMultiplier: multiplier,
    contractValue: multiplier,
    contractValueCurrency: baseAsset,
    quantityUnit: "contract",
    underlying: `${baseAsset}_${quoteAsset}`,
    instrumentFamily: `${baseAsset}_${quoteAsset}`,
    tickSize: positive(row.tickSize, "instrument.tickSize"),
    quantityStep: lotSize,
    minimumQuantity: lotSize,
    minimumNotional: 0,
    status: perpetualStatus(row.status),
    ...(fundingIntervalMinutes === undefined ? {} : { fundingIntervalMinutes })
  };
}

function normalizeSpotTicker(row: KucoinSpotTickerRow, receivedAt: number, fallbackExchangeTs?: number): PublicTopBook {
  const instrumentId = venueSymbol(row.symbol, "ticker.symbol");
  const bid = positive(row.bestBid ?? row.buy, "ticker.bestBid");
  const ask = positive(row.bestAsk ?? row.sell, "ticker.bestAsk");
  if (bid >= ask) throw validation(`ticker ${instrumentId} is crossed or locked`);
  return {
    venue: "kucoin",
    instrumentId,
    marketType: "spot",
    quantityUnit: "base",
    bid,
    bidSize: positive(row.bestBidSize, "ticker.bestBidSize"),
    ask,
    askSize: positive(row.bestAskSize, "ticker.bestAskSize"),
    ...optionalPositiveField("last", row.price ?? row.last),
    ...optionalPositiveField("lastSize", row.size),
    ...optionalNonNegativeField("volume24h", row.vol),
    ...optionalNonNegativeField("volumeCurrency24h", row.volValue),
    exchangeTs: row.time === undefined ? positiveMillis(fallbackExchangeTs ?? receivedAt, "ticker exchange time") : positiveMillis(row.time, "ticker.time"),
    receivedAt
  };
}

function normalizePerpetualTicker(row: KucoinPerpetualTickerRow, receivedAt: number): PublicTopBook {
  const instrumentId = venueSymbol(row.symbol, "ticker.symbol");
  const bid = positive(row.bestBidPrice, "ticker.bestBidPrice");
  const ask = positive(row.bestAskPrice, "ticker.bestAskPrice");
  if (bid >= ask) throw validation(`ticker ${instrumentId} is crossed or locked`);
  return {
    venue: "kucoin",
    instrumentId,
    marketType: "perpetual",
    quantityUnit: "contract",
    bid,
    bidSize: positive(row.bestBidSize, "ticker.bestBidSize"),
    ask,
    askSize: positive(row.bestAskSize, "ticker.bestAskSize"),
    ...optionalPositiveField("last", row.price),
    ...optionalPositiveField("lastSize", row.size),
    exchangeTs: nanosToMillis(row.ts, "ticker.ts"),
    receivedAt
  };
}

function normalizeFundingPoint(raw: unknown, instrumentId: string): PublicFundingPoint {
  const row = record(raw, "funding history") as KucoinFundingHistoryRow;
  if (venueSymbol(row.symbol, "history.symbol") !== instrumentId) throw validation("funding history symbol does not match request");
  const rate = finite(row.fundingRate, "history.fundingRate");
  return {
    instrumentId,
    fundingTime: positiveMillis(row.timepoint, "history.timepoint"),
    fundingRate: rate,
    realizedRate: rate,
    formulaType: "kucoin-perpetual",
    method: "settled"
  };
}

function depthLevels(value: unknown, label: string, side: "bids" | "asks", limit: number): PublicDepthLevel[] {
  if (!Array.isArray(value)) throw validation(`${label} must be an array`);
  if (value.length > MAX_SOURCE_LEVELS) throw validation(`${label} exceeds ${MAX_SOURCE_LEVELS} source levels`);
  const levels = value.map((raw, index): PublicDepthLevel => {
    if (!Array.isArray(raw) || raw.length < 2) throw validation(`${label}[${index}] must contain price and quantity`);
    return [positive(raw[0], `${label}[${index}].price`), positive(raw[1], `${label}[${index}].quantity`)];
  });
  for (let index = 1; index < levels.length; index += 1) {
    const invalid = side === "bids" ? levels[index]![0] >= levels[index - 1]![0] : levels[index]![0] <= levels[index - 1]![0];
    if (invalid) throw validation(`${label} is not strictly sorted`);
  }
  return levels.slice(0, limit);
}

function perpetualStatus(value: unknown): RegistryInstrument["status"] {
  const status = exactString(value, "instrument.status");
  if (status === "Open") return "trading";
  if (status === "PreOpen") return "prelaunch";
  if (status === "Settling") return "settling";
  if (status === "Closed") return "closed";
  throw validation(`unsupported instrument.status ${status}`);
}

function rawInstrumentId(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = (raw as { symbol?: unknown }).symbol;
  return typeof value === "string" ? value.toUpperCase() : undefined;
}

function quantityUnit(marketType: KucoinMarketType): VenueQuantityUnit {
  return marketType === "spot" ? "base" : "contract";
}

function optionalPositiveField<Key extends string>(key: Key, value: unknown): Record<Key, number> | Record<string, never> {
  return value === "" || value === null || value === undefined ? {} : ({ [key]: positive(value, key) } as Record<Key, number>);
}

function optionalNonNegativeField<Key extends string>(key: Key, value: unknown): Record<Key, number> | Record<string, never> {
  const parsed = optionalNonNegative(value, key);
  return parsed === undefined ? {} : ({ [key]: parsed } as Record<Key, number>);
}

function optionalFiniteField<Key extends string>(key: Key, value: unknown): Record<Key, number> | Record<string, never> {
  const parsed = optionalFinite(value, key);
  return parsed === undefined ? {} : ({ [key]: parsed } as Record<Key, number>);
}
