import type { AdapterValidationIssue, PublicDepthLevel } from "../publicTypes.js";
import { PublicVenueAdapterError } from "../publicTypes.js";
import type {
  DeribitDepthSnapshot,
  DeribitFundingHistoryRow,
  DeribitFundingPoint,
  DeribitFundingSchedule,
  DeribitInstrument,
  DeribitInstrumentRow,
  DeribitMarketType,
  DeribitOrderBookRow,
  DeribitTickerRow,
  DeribitTopBook
} from "./types.js";

const EIGHT_HOURS_MS = 8 * 60 * 60_000;

export function normalizeDeribitInstruments(rows: unknown[], expectedMarketType: DeribitMarketType) {
  const instruments: DeribitInstrument[] = [];
  const rejectedRows: AdapterValidationIssue[] = [];
  rows.forEach((raw, index) => {
    try {
      instruments.push(normalizeDeribitInstrument(raw, expectedMarketType));
    } catch (error) {
      rejectedRows.push({ index, instrumentId: rawInstrumentName(raw), message: errorMessage(error) });
    }
  });
  return { instruments, rejectedRows };
}

export function normalizeDeribitInstrument(raw: unknown, expectedMarketType: DeribitMarketType): DeribitInstrument {
  const row = record(raw, "instrument") as DeribitInstrumentRow;
  const kind = exactString(row.kind, "instrument.kind");
  if (kind !== "future" && kind !== "option") throw validation("instrument.kind must be future or option");
  const settlementPeriod = exactString(row.settlement_period, "instrument.settlement_period");
  const marketType: DeribitMarketType = kind === "option" ? "option" : settlementPeriod === "perpetual" ? "perpetual" : "future";
  if (marketType !== expectedMarketType) throw validation(`instrument market type ${marketType} does not match ${expectedMarketType}`);

  const venueSymbol = instrumentName(row.instrument_name, "instrument.instrument_name");
  const instrumentType = exactString(row.instrument_type, "instrument.instrument_type");
  if (instrumentType !== "linear" && instrumentType !== "reversed") {
    throw validation("instrument.instrument_type must be linear or reversed");
  }
  const baseAsset = asset(row.base_currency, "instrument.base_currency");
  const apiQuoteAsset = asset(row.quote_currency, "instrument.quote_currency");
  const counterAsset = asset(row.counter_currency, "instrument.counter_currency");
  const settleAsset = asset(row.settlement_currency, "instrument.settlement_currency");
  const priceIndex = identifier(row.price_index, "instrument.price_index");
  const contractSize = positive(row.contract_size, "instrument.contract_size");
  const minimumQuantity = positive(row.min_trade_amount, "instrument.min_trade_amount");
  const rawStep = optionalPositive(row.qty_tick_size, "instrument.qty_tick_size");
  const quantityStep = rawStep ?? minimumQuantity;
  const quantityStepSource = rawStep === undefined ? "min_trade_amount" : "qty_tick_size";
  if (!stepAligned(minimumQuantity, quantityStep)) {
    throw validation("instrument.min_trade_amount must be aligned to the published quantity step");
  }
  const nativeAmountUnit = kind === "option" || instrumentType === "linear" ? "base" : "quote";
  const contractSizeCurrency = kind === "option" || instrumentType === "linear" ? baseAsset : counterAsset;
  const premiumAsset = kind === "option" ? (instrumentType === "reversed" ? settleAsset : counterAsset) : undefined;
  const expiration = marketType === "perpetual" ? undefined : positiveTimestamp(row.expiration_timestamp, "instrument.expiration_timestamp");
  const optionType = kind === "option" ? optionSide(row.option_type) : undefined;
  const strikePrice = kind === "option" ? positive(row.strike, "instrument.strike") : undefined;
  const underlyingType = optionalUnderlyingType(row.underlying_type);
  const isActive = boolean(row.is_active, "instrument.is_active");
  const state = bookState(row.state, "instrument.state");

  return {
    id: `deribit:${marketType}:${venueSymbol}`,
    assetId: baseAsset,
    venue: "deribit",
    venueSymbol,
    baseAsset,
    quoteAsset: counterAsset,
    settleAsset,
    marketType,
    contractDirection: instrumentType === "linear" ? "linear" : "inverse",
    contractMultiplier: contractSize,
    contractValue: contractSize,
    contractValueCurrency: contractSizeCurrency,
    quantityUnit: nativeAmountUnit,
    underlying: priceIndex,
    instrumentFamily: `${baseAsset}-${counterAsset}`,
    tickSize: positive(row.tick_size, "instrument.tick_size"),
    quantityStep,
    minimumQuantity,
    minimumNotional: 0,
    status: normalizedStatus(state, isActive),
    ...(expiration === undefined ? {} : { expiryTime: expiration }),
    ...(strikePrice === undefined ? {} : { strikePrice }),
    ...(optionType === undefined ? {} : { optionType }),
    deribitInstrumentId: positiveInteger(row.instrument_id, "instrument.instrument_id"),
    instrumentType,
    settlementPeriod,
    priceIndex,
    creationTime: positiveTimestamp(row.creation_timestamp, "instrument.creation_timestamp"),
    contractSize,
    contractSizeCurrency,
    nativeAmountUnit,
    quantityStepSource,
    minimumNotionalPublished: false,
    tickSizeSchedule: tickSizeSchedule(row.tick_size_steps),
    makerCommissionRate: finite(row.maker_commission, "instrument.maker_commission"),
    takerCommissionRate: finite(row.taker_commission, "instrument.taker_commission"),
    settlementMode: "cash-economic-equivalent",
    settlementProcess: kind === "option" && instrumentType === "linear" ? "future-then-immediate-cash" : "cash",
    ...(premiumAsset ? { premiumAsset } : {}),
    ...(kind === "option" ? { exerciseStyle: "european" as const, automaticExercise: true as const } : {}),
    ...(underlyingType ? { underlyingType } : {})
  };
}

export function normalizeDeribitTicker(raw: unknown, instrument: DeribitInstrument, receivedAt: number): DeribitTopBook {
  const row = record(raw, "ticker") as DeribitTickerRow;
  matchingInstrument(row.instrument_name, instrument.venueSymbol, "ticker.instrument_name");
  if (bookState(row.state, "ticker.state") !== "open") throw validation("ticker is not in open state");
  const bid = positive(row.best_bid_price, "ticker.best_bid_price");
  const ask = positive(row.best_ask_price, "ticker.best_ask_price");
  if (bid >= ask) throw validation("ticker is crossed or locked");
  const stats = record(row.stats, "ticker.stats");
  return {
    venue: "deribit",
    instrumentId: instrument.venueSymbol,
    marketType: instrument.marketType,
    quantityUnit: instrument.quantityUnit,
    bid,
    bidSize: positive(row.best_bid_amount, "ticker.best_bid_amount"),
    ask,
    askSize: positive(row.best_ask_amount, "ticker.best_ask_amount"),
    ...optionalPositiveField("last", row.last_price),
    volume24h: nonNegative(stats.volume, "ticker.stats.volume"),
    ...optionalNonNegativeField("volumeCurrency24h", stats.volume_usd),
    exchangeTs: positiveTimestamp(row.timestamp, "ticker.timestamp"),
    receivedAt,
    source: "public/ticker",
    executable: true,
    priceUnit: instrument.premiumAsset ?? instrument.quoteAsset,
    amountUnit: instrument.quantityUnit,
    markPrice: positive(row.mark_price, "ticker.mark_price"),
    indexPrice: positive(row.index_price, "ticker.index_price")
  };
}

export function normalizeDeribitDepth(raw: unknown, instrument: DeribitInstrument, receivedAt: number): DeribitDepthSnapshot {
  const row = record(raw, "orderBook") as DeribitOrderBookRow;
  matchingInstrument(row.instrument_name, instrument.venueSymbol, "orderBook.instrument_name");
  if (bookState(row.state, "orderBook.state") !== "open") throw validation("order book is not in open state");
  const bids = depthSide(row.bids, "orderBook.bids", "bid");
  const asks = depthSide(row.asks, "orderBook.asks", "ask");
  if (bids.length === 0 || asks.length === 0) throw validation("order book requires executable liquidity on both sides");
  if (bids[0]![0] >= asks[0]![0]) throw validation("order book is crossed or locked");
  return {
    venue: "deribit",
    instrumentId: instrument.venueSymbol,
    marketType: instrument.marketType,
    quantityUnit: instrument.quantityUnit,
    bids,
    asks,
    sequence: nonNegativeInteger(row.change_id, "orderBook.change_id"),
    exchangeTs: positiveTimestamp(row.timestamp, "orderBook.timestamp"),
    receivedAt,
    complete: true,
    source: "public/get_order_book",
    executable: true,
    priceUnit: instrument.premiumAsset ?? instrument.quoteAsset,
    amountUnit: instrument.quantityUnit,
    markPrice: positive(row.mark_price, "orderBook.mark_price"),
    indexPrice: positive(row.index_price, "orderBook.index_price")
  };
}

export function normalizeDeribitFunding(
  tickerRaw: unknown,
  historyRows: unknown[],
  instrument: DeribitInstrument,
  receivedAt: number,
  historyLimit: number,
  initialErrors: string[] = []
): DeribitFundingSchedule {
  if (instrument.marketType !== "perpetual") throw validation("funding requires a perpetual instrument");
  const ticker = record(tickerRaw, "funding ticker") as DeribitTickerRow;
  matchingInstrument(ticker.instrument_name, instrument.venueSymbol, "funding ticker.instrument_name");
  const exchangeTs = positiveTimestamp(ticker.timestamp, "funding ticker.timestamp");
  const history: DeribitFundingPoint[] = [];
  const sourceErrors = [...initialErrors, "Deribit funding accrues continuously; nextFundingTime is an 8h reference horizon, not a discrete settlement event"];
  historyRows.forEach((raw, index) => {
    try {
      history.push(normalizeFundingPoint(raw, instrument.venueSymbol));
    } catch (error) {
      sourceErrors.push(`history[${index}]: ${errorMessage(error)}`);
    }
  });
  history.sort((left, right) => left.fundingTime - right.fundingTime);
  const deduplicated = history.filter((point, index) => index === 0 || point.fundingTime !== history[index - 1]!.fundingTime).slice(-historyLimit);
  return {
    venue: "deribit",
    instrumentId: instrument.venueSymbol,
    currentEstimateRate: finite(ticker.funding_8h, "funding ticker.funding_8h"),
    currentFunding: finite(ticker.current_funding, "funding ticker.current_funding"),
    fundingTime: exchangeTs,
    nextFundingTime: exchangeTs + EIGHT_HOURS_MS,
    scheduleVerified: false,
    formulaType: "deribit-interest",
    method: "continuous-accrual-8h-reference",
    exchangeTs,
    receivedAt,
    referenceHorizonMinutes: 480,
    accrual: "continuous",
    history: deduplicated,
    sourceErrors
  };
}

function normalizeFundingPoint(raw: unknown, instrumentId: string): DeribitFundingPoint {
  const row = record(raw, "funding history") as DeribitFundingHistoryRow;
  return {
    instrumentId,
    fundingTime: positiveTimestamp(row.timestamp, "funding history.timestamp"),
    fundingRate: finite(row.interest_8h, "funding history.interest_8h"),
    interest1h: finite(row.interest_1h, "funding history.interest_1h"),
    indexPrice: positive(row.index_price, "funding history.index_price"),
    previousIndexPrice: positive(row.prev_index_price, "funding history.prev_index_price"),
    formulaType: "deribit-interest",
    method: "hourly-observation-of-8h-rate"
  };
}

function depthSide(value: unknown, label: string, side: "bid" | "ask"): PublicDepthLevel[] {
  if (!Array.isArray(value)) throw validation(`${label} must be an array`);
  const levels = value.map((raw, index) => {
    if (!Array.isArray(raw) || raw.length !== 2) throw validation(`${label}[${index}] must be a [price, amount] pair`);
    return [positive(raw[0], `${label}[${index}].price`), positive(raw[1], `${label}[${index}].amount`)] as const;
  });
  for (let index = 1; index < levels.length; index += 1) {
    const previous = levels[index - 1]![0];
    const current = levels[index]![0];
    if ((side === "bid" && current >= previous) || (side === "ask" && current <= previous)) {
      throw validation(`${label} must be strictly ${side === "bid" ? "descending" : "ascending"}`);
    }
  }
  return levels;
}

function tickSizeSchedule(value: unknown) {
  if (!Array.isArray(value)) throw validation("instrument.tick_size_steps must be an array");
  let previous = 0;
  return value.map((raw, index) => {
    const row = record(raw, `instrument.tick_size_steps[${index}]`);
    const abovePrice = positive(row.above_price, `instrument.tick_size_steps[${index}].above_price`);
    if (abovePrice <= previous) throw validation("instrument.tick_size_steps must be strictly ascending");
    previous = abovePrice;
    return { abovePrice, tickSize: positive(row.tick_size, `instrument.tick_size_steps[${index}].tick_size`) };
  });
}

function normalizedStatus(state: string, isActive: boolean): DeribitInstrument["status"] {
  if (state === "settlement") return "settling";
  if (state === "open" && isActive) return "trading";
  return "closed";
}

function bookState(value: unknown, label: string) {
  const state = exactString(value, label);
  const allowed = new Set(["open", "settlement", "delivered", "inactive", "locked", "halted", "archivized"]);
  if (!allowed.has(state)) throw validation(`${label} is not a supported Deribit book state`);
  return state;
}

function optionSide(value: unknown) {
  if (value !== "call" && value !== "put") throw validation("instrument.option_type must be call or put");
  return value;
}

function optionalUnderlyingType(value: unknown): DeribitInstrument["underlyingType"] | undefined {
  if (value === undefined) return undefined;
  if (value !== "crypto" && value !== "commodity" && value !== "equity") {
    throw validation("instrument.underlying_type is invalid");
  }
  return value;
}

function stepAligned(value: number, step: number) {
  const units = value / step;
  return Math.abs(units - Math.round(units)) <= Math.max(1e-9, Math.abs(units) * 1e-9);
}

function rawInstrumentName(raw: unknown) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = (raw as DeribitInstrumentRow).instrument_name;
  return typeof value === "string" ? value.toUpperCase() : undefined;
}

function matchingInstrument(value: unknown, expected: string, label: string) {
  if (instrumentName(value, label) !== expected) throw validation(`${label} does not match requested instrument ${expected}`);
}

function instrumentName(value: unknown, label: string) {
  const result = exactString(value, label).toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9_.-]{1,99}$/.test(result)) throw validation(`${label} contains invalid characters`);
  return result;
}

function identifier(value: unknown, label: string) {
  const result = exactString(value, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{1,99}$/.test(result)) throw validation(`${label} contains invalid characters`);
  return result;
}

function asset(value: unknown, label: string) {
  const result = exactString(value, label).toUpperCase();
  if (!/^[A-Z0-9_]{2,20}$/.test(result)) throw validation(`${label} is invalid`);
  return result;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw validation(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactString(value: unknown, label: string) {
  if (typeof value !== "string" || !value.trim()) throw validation(`${label} must be a non-empty string`);
  return value.trim();
}

function boolean(value: unknown, label: string) {
  if (typeof value !== "boolean") throw validation(`${label} must be boolean`);
  return value;
}

function finite(value: unknown, label: string) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw validation(`${label} must be a finite number`);
  return value;
}

function positive(value: unknown, label: string) {
  const result = finite(value, label);
  if (result <= 0) throw validation(`${label} must be positive`);
  return result;
}

function nonNegative(value: unknown, label: string) {
  const result = finite(value, label);
  if (result < 0) throw validation(`${label} must be non-negative`);
  return result;
}

function optionalPositive(value: unknown, label: string) {
  if (value === undefined || value === null) return undefined;
  return positive(value, label);
}

function positiveInteger(value: unknown, label: string) {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw validation(`${label} must be a positive safe integer`);
  return Number(value);
}

function nonNegativeInteger(value: unknown, label: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw validation(`${label} must be a non-negative safe integer`);
  return Number(value);
}

function positiveTimestamp(value: unknown, label: string) {
  return positiveInteger(value, label);
}

function optionalPositiveField<Key extends string>(key: Key, value: unknown): Partial<Record<Key, number>> {
  return value === undefined || value === null ? {} : ({ [key]: positive(value, key) } as Partial<Record<Key, number>>);
}

function optionalNonNegativeField<Key extends string>(key: Key, value: unknown): Partial<Record<Key, number>> {
  return value === undefined || value === null ? {} : ({ [key]: nonNegative(value, key) } as Partial<Record<Key, number>>);
}

function validation(message: string) {
  return new PublicVenueAdapterError("deribit", "validation", message);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error ?? "unknown error");
}
