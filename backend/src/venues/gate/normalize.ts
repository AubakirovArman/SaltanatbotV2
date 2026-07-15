import type { RegistryInstrument, VenueMarketType, VenueQuantityUnit } from "@saltanatbotv2/contracts";
import type { AdapterValidationIssue, PublicDepthLevel, PublicDepthSnapshot, PublicFundingPoint, PublicFundingSchedule, PublicTopBook } from "../publicTypes.js";
import { PublicVenueAdapterError } from "../publicTypes.js";
import type { GateFundingHistoryRow, GateMarketType, GateOrderBookRow, GatePerpetualInstrumentRow, GatePerpetualTickerRow, GateSpotInstrumentRow, GateSpotTickerRow } from "./types.js";

export function gateMarketType(value: VenueMarketType): GateMarketType {
  if (value === "spot" || value === "perpetual") return value;
  throw new PublicVenueAdapterError("gate", "unsupported", `unsupported market type ${value}`);
}

export function normalizeGateInstruments(rows: unknown[], marketType: GateMarketType) {
  const instruments: RegistryInstrument[] = [];
  const rejectedRows: AdapterValidationIssue[] = [];
  rows.forEach((raw, index) => {
    try {
      const row = record(raw, `instrument[${index}]`);
      instruments.push(marketType === "spot" ? normalizeSpotInstrument(row as GateSpotInstrumentRow) : normalizePerpetualInstrument(row as GatePerpetualInstrumentRow));
    } catch (error) {
      rejectedRows.push({ index, instrumentId: rawInstrumentId(raw, marketType), message: errorMessage(error) });
    }
  });
  return { instruments, rejectedRows };
}

export function normalizeGateTicker(raw: unknown, marketType: GateMarketType, receivedAt: number): PublicTopBook {
  const row = record(raw, "ticker") as GateSpotTickerRow & GatePerpetualTickerRow;
  const instrumentId = instrumentIdValue(marketType === "spot" ? row.currency_pair : row.contract, "ticker instrument");
  const bid = positive(row.highest_bid, "ticker.highest_bid");
  const ask = positive(row.lowest_ask, "ticker.lowest_ask");
  if (bid >= ask) throw validation(`ticker ${instrumentId} is crossed or locked`);
  const volume24h = marketType === "spot" ? row.base_volume : row.volume_24h;
  const volumeCurrency24h = marketType === "spot" ? row.quote_volume : row.volume_24h_quote;
  return {
    venue: "gate",
    instrumentId,
    marketType,
    quantityUnit: quantityUnit(marketType),
    bid,
    bidSize: positive(row.highest_size, "ticker.highest_size"),
    ask,
    askSize: positive(row.lowest_size, "ticker.lowest_size"),
    ...optionalPositiveField("last", row.last),
    ...optionalNonNegativeField("volume24h", volume24h),
    ...optionalNonNegativeField("volumeCurrency24h", volumeCurrency24h),
    // Gate ticker rows have no exchange timestamp. Receipt time is the explicit conservative fallback.
    exchangeTs: positiveTimestamp(receivedAt, "receivedAt"),
    receivedAt
  };
}

export function normalizeGateDepth(raw: unknown, request: { instrumentId: string; marketType: GateMarketType; limit: number }, receivedAt: number): PublicDepthSnapshot {
  const row = record(raw, "depth") as GateOrderBookRow;
  const bids = depthLevels(row.bids, "depth.bids", "bids", request.marketType);
  const asks = depthLevels(row.asks, "depth.asks", "asks", request.marketType);
  if (bids.length === 0 || asks.length === 0) throw validation("depth requires both non-empty sides");
  if (bids.length > request.limit || asks.length > request.limit) throw validation("depth response exceeds the requested level bound");
  if (bids[0]![0] >= asks[0]![0]) throw validation("depth is crossed or locked");
  const sequence = nonNegativeSafeInteger(row.id, "depth.id");
  const exchangeTs = request.marketType === "spot" ? positiveTimestamp(row.update, "depth.update") : secondsTimestamp(row.update, "depth.update");
  return {
    venue: "gate",
    instrumentId: instrumentIdValue(request.instrumentId, "instrumentId"),
    marketType: request.marketType,
    quantityUnit: quantityUnit(request.marketType),
    bids,
    asks,
    sequence,
    exchangeTs,
    receivedAt,
    complete: true
  };
}

export function normalizeGateFunding(currentRaw: unknown, historyRows: unknown[], instrumentId: string, receivedAt: number, historyErrors: string[] = []): PublicFundingSchedule {
  const current = record(currentRaw, "funding contract") as GatePerpetualInstrumentRow;
  const normalizedId = instrumentIdValue(instrumentId, "instrumentId");
  if (instrumentIdValue(current.name, "funding.name") !== normalizedId) throw validation("funding contract does not match request");
  requireUsdtDirectContract(current, "funding contract");
  const intervalSeconds = positiveSafeInteger(current.funding_interval, "funding.funding_interval");
  if (intervalSeconds % 60 !== 0 || intervalSeconds > 86_400) throw validation("funding interval must be whole minutes no longer than 24 hours");
  const intervalMinutes = intervalSeconds / 60;
  const fundingTime = secondsTimestamp(current.funding_next_apply, "funding.funding_next_apply");
  const nextFundingTime = fundingTime + intervalSeconds * 1_000;
  if (!Number.isSafeInteger(nextFundingTime)) throw validation("funding next timestamp exceeds safe integer range");
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
    venue: "gate",
    instrumentId: normalizedId,
    currentEstimateRate: finite(current.funding_rate, "funding.funding_rate"),
    fundingTime,
    nextFundingTime,
    intervalMinutes,
    scheduleVerified: true,
    ...optionalFiniteField("nextEstimateRate", current.funding_rate_indicative),
    formulaType: "gate-perpetual",
    method: "contract.funding_rate at funding_next_apply; receipt-time timestamp fallback",
    exchangeTs: positiveTimestamp(receivedAt, "receivedAt"),
    receivedAt,
    history,
    sourceErrors
  };
}

function normalizeSpotInstrument(row: GateSpotInstrumentRow): RegistryInstrument {
  const venueSymbol = instrumentIdValue(row.id, "instrument.id");
  const baseAsset = asset(row.base, "instrument.base");
  const quoteAsset = asset(row.quote, "instrument.quote");
  if (venueSymbol !== `${baseAsset}_${quoteAsset}`) throw validation("instrument.id does not match base and quote assets");
  return {
    id: `gate:spot:${venueSymbol}`,
    assetId: baseAsset,
    venue: "gate",
    venueSymbol,
    baseAsset,
    quoteAsset,
    settleAsset: quoteAsset,
    marketType: "spot",
    contractMultiplier: 1,
    quantityUnit: "base",
    tickSize: precisionStep(row.precision, "instrument.precision"),
    quantityStep: precisionStep(row.amount_precision, "instrument.amount_precision"),
    minimumQuantity: optionalPositiveOrUnknown(row.min_base_amount, "instrument.min_base_amount"),
    minimumNotional: optionalPositiveOrUnknown(row.min_quote_amount, "instrument.min_quote_amount"),
    status: spotStatus(row.trade_status)
  };
}

function normalizePerpetualInstrument(row: GatePerpetualInstrumentRow): RegistryInstrument {
  const venueSymbol = instrumentIdValue(row.name, "instrument.name");
  const [baseAsset, quoteAsset] = perpetualAssets(venueSymbol);
  requireUsdtDirectContract(row, "instrument");
  if (row.enable_decimal !== false) throw validation("decimal contract size has no published quantity increment and is rejected fail-closed");
  const multiplier = positive(row.quanto_multiplier, "instrument.quanto_multiplier");
  const fundingIntervalSeconds = optionalPositiveSafeInteger(row.funding_interval, "instrument.funding_interval");
  const fundingIntervalMinutes = fundingIntervalSeconds !== undefined && fundingIntervalSeconds % 60 === 0 ? fundingIntervalSeconds / 60 : undefined;
  return {
    id: `gate:perpetual:${venueSymbol}`,
    assetId: baseAsset,
    venue: "gate",
    venueSymbol,
    baseAsset,
    quoteAsset,
    settleAsset: "USDT",
    marketType: "perpetual",
    contractDirection: "linear",
    contractMultiplier: multiplier,
    contractValue: multiplier,
    contractValueCurrency: baseAsset,
    quantityUnit: "contract",
    underlying: `${baseAsset}_${quoteAsset}`,
    instrumentFamily: `${baseAsset}_${quoteAsset}`,
    tickSize: positive(row.order_price_round, "instrument.order_price_round"),
    quantityStep: 1,
    minimumQuantity: positive(row.order_size_min, "instrument.order_size_min"),
    minimumNotional: 0,
    status: perpetualStatus(row),
    ...(fundingIntervalMinutes !== undefined ? { fundingIntervalMinutes } : {})
  };
}

function normalizeFundingPoint(raw: unknown, instrumentId: string): PublicFundingPoint {
  const row = record(raw, "funding history") as GateFundingHistoryRow;
  const rate = finite(row.r, "history.r");
  return {
    instrumentId,
    fundingTime: secondsTimestamp(row.t, "history.t"),
    fundingRate: rate,
    realizedRate: rate,
    formulaType: "gate-perpetual",
    method: "settled"
  };
}

function depthLevels(value: unknown, label: string, side: "bids" | "asks", marketType: GateMarketType): PublicDepthLevel[] {
  if (!Array.isArray(value)) throw validation(`${label} must be an array`);
  const levels = value.map((raw, index): PublicDepthLevel => {
    if (marketType === "spot") {
      if (!Array.isArray(raw) || raw.length < 2) throw validation(`${label}[${index}] must contain price and quantity`);
      return [positive(raw[0], `${label}[${index}].price`), positive(raw[1], `${label}[${index}].quantity`)];
    }
    const item = record(raw, `${label}[${index}]`) as { p?: unknown; s?: unknown };
    return [positive(item.p, `${label}[${index}].price`), positive(item.s, `${label}[${index}].quantity`)];
  });
  for (let index = 1; index < levels.length; index += 1) {
    const outOfOrder = side === "bids" ? levels[index]![0] > levels[index - 1]![0] : levels[index]![0] < levels[index - 1]![0];
    if (outOfOrder) throw validation(`${label} is not sorted`);
  }
  return levels;
}

function requireUsdtDirectContract(row: GatePerpetualInstrumentRow, label: string) {
  if (exactString(row.type, `${label}.type`) !== "direct") throw validation(`${label}.type must be direct for USDT perpetuals`);
  if (row.settle_currency !== undefined && row.settle_currency !== null && asset(row.settle_currency, `${label}.settle_currency`) !== "USDT") {
    throw validation(`${label}.settle_currency must be USDT`);
  }
}

function perpetualAssets(value: string): [string, string] {
  const separator = value.lastIndexOf("_");
  if (separator <= 0 || separator === value.length - 1) throw validation("perpetual name must contain base and quote assets");
  const base = asset(value.slice(0, separator), "instrument base");
  const quote = asset(value.slice(separator + 1), "instrument quote");
  if (quote !== "USDT") throw validation("only USDT-settled perpetual contracts are supported");
  return [base, quote];
}

function spotStatus(value: unknown): RegistryInstrument["status"] {
  const status = exactString(value, "instrument.trade_status");
  if (status === "tradable") return "trading";
  if (status === "buyable" || status === "sellable") return "settling";
  if (status === "untradable") return "closed";
  throw validation(`unsupported instrument.trade_status ${status}`);
}

function perpetualStatus(row: GatePerpetualInstrumentRow): RegistryInstrument["status"] {
  if (typeof row.in_delisting !== "boolean") throw validation("instrument.in_delisting must be boolean");
  const status = exactString(row.status, "instrument.status");
  if (row.in_delisting) {
    const positionSize = optionalNonNegative(row.position_size, "instrument.position_size");
    return positionSize === 0 ? "closed" : "settling";
  }
  if (status === "trading") return "trading";
  if (status === "prelaunch") return "prelaunch";
  if (status === "delisting" || status === "circuit_breaker") return "settling";
  if (status === "delisted") return "closed";
  throw validation(`unsupported instrument.status ${status}`);
}

function rawInstrumentId(raw: unknown, marketType: GateMarketType) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const row = raw as GateSpotInstrumentRow & GatePerpetualInstrumentRow;
  const value = marketType === "spot" ? row.id : row.name;
  return typeof value === "string" ? value.toUpperCase() : undefined;
}

function quantityUnit(marketType: GateMarketType): VenueQuantityUnit {
  return marketType === "spot" ? "base" : "contract";
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw validation(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactString(value: unknown, label: string) {
  if (typeof value !== "string" || !value) throw validation(`${label} must be a non-empty string`);
  return value;
}

function instrumentIdValue(value: unknown, label: string) {
  const parsed = exactString(value, label).toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9_-]{1,79}$/.test(parsed)) throw validation(`${label} has invalid characters`);
  return parsed;
}

function asset(value: unknown, label: string) {
  const parsed = exactString(value, label).toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9_]{0,39}$/.test(parsed)) throw validation(`${label} is not a valid asset code`);
  return parsed;
}

function finite(value: unknown, label: string) {
  if (value === "" || value === null || value === undefined) throw validation(`${label} is required`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw validation(`${label} must be finite`);
  return parsed;
}

function positive(value: unknown, label: string) {
  const parsed = finite(value, label);
  if (parsed <= 0) throw validation(`${label} must be positive`);
  return parsed;
}

function optionalNonNegative(value: unknown, label: string) {
  if (value === "" || value === null || value === undefined) return undefined;
  const parsed = finite(value, label);
  if (parsed < 0) throw validation(`${label} must be non-negative`);
  return parsed;
}

function nonNegativeSafeInteger(value: unknown, label: string) {
  const parsed = finite(value, label);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw validation(`${label} must be a non-negative safe integer`);
  return parsed;
}

function positiveSafeInteger(value: unknown, label: string) {
  const parsed = finite(value, label);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw validation(`${label} must be a positive safe integer`);
  return parsed;
}

function optionalPositiveSafeInteger(value: unknown, label: string) {
  if (value === "" || value === null || value === undefined) return undefined;
  return positiveSafeInteger(value, label);
}

function positiveTimestamp(value: unknown, label: string) {
  return positiveSafeInteger(value, label);
}

function secondsTimestamp(value: unknown, label: string) {
  const seconds = positive(value, label);
  const milliseconds = Math.round(seconds * 1_000);
  if (!Number.isSafeInteger(milliseconds)) throw validation(`${label} exceeds safe timestamp range`);
  return milliseconds;
}

function precisionStep(value: unknown, label: string) {
  const precision = finite(value, label);
  if (!Number.isSafeInteger(precision) || precision < 0 || precision > 18) throw validation(`${label} must be an integer between 0 and 18`);
  return 10 ** -precision;
}

function optionalPositiveOrUnknown(value: unknown, label: string) {
  if (value === "" || value === null || value === undefined) return 0;
  return positive(value, label);
}

function optionalPositiveField<Key extends string>(key: Key, value: unknown): Record<Key, number> | Record<string, never> {
  return value === "" || value === null || value === undefined ? {} : ({ [key]: positive(value, key) } as Record<Key, number>);
}

function optionalNonNegativeField<Key extends string>(key: Key, value: unknown): Record<Key, number> | Record<string, never> {
  if (value === "" || value === null || value === undefined) return {};
  const parsed = finite(value, key);
  if (parsed < 0) throw validation(`${key} must be non-negative`);
  return { [key]: parsed } as Record<Key, number>;
}

function optionalFiniteField<Key extends string>(key: Key, value: unknown): Record<Key, number> | Record<string, never> {
  return value === "" || value === null || value === undefined ? {} : ({ [key]: finite(value, key) } as Record<Key, number>);
}

function validation(message: string) {
  return new PublicVenueAdapterError("gate", "validation", message);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
