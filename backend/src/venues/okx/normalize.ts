import type { RegistryInstrument, VenueMarketType, VenueQuantityUnit } from "@saltanatbotv2/contracts";
import type { AdapterValidationIssue, PublicDepthLevel, PublicDepthSnapshot, PublicFundingPoint, PublicFundingSchedule, PublicTopBook } from "../publicTypes.js";
import { PublicVenueAdapterError } from "../publicTypes.js";
import type { OkxDepthRow, OkxFundingHistoryRow, OkxFundingRow, OkxInstrumentRow, OkxInstrumentType, OkxTickerRow } from "./types.js";

export function okxMarketType(value: OkxInstrumentType): VenueMarketType {
  if (value === "SPOT") return "spot";
  if (value === "SWAP") return "perpetual";
  return "future";
}

export function okxInstrumentType(value: VenueMarketType): OkxInstrumentType {
  if (value === "spot") return "SPOT";
  if (value === "perpetual") return "SWAP";
  if (value === "future") return "FUTURES";
  throw new PublicVenueAdapterError("okx", "unsupported", `unsupported market type ${value}`);
}

export function normalizeOkxInstruments(rows: unknown[], expectedType: OkxInstrumentType) {
  const instruments: RegistryInstrument[] = [];
  const rejectedRows: AdapterValidationIssue[] = [];
  rows.forEach((raw, index) => {
    try {
      instruments.push(normalizeInstrument(record(raw, `instrument[${index}]`) as OkxInstrumentRow, expectedType));
    } catch (error) {
      const row = raw && typeof raw === "object" ? (raw as OkxInstrumentRow) : undefined;
      rejectedRows.push({ index, instrumentId: optionalId(row?.instId), message: errorMessage(error) });
    }
  });
  return { instruments, rejectedRows };
}

export function normalizeOkxTicker(raw: unknown, expectedType: OkxInstrumentType, receivedAt: number): PublicTopBook {
  const row = record(raw, "ticker") as OkxTickerRow;
  const instType = exactString(row.instType, "ticker.instType") as OkxInstrumentType;
  if (instType !== expectedType) throw validation(`ticker.instType ${instType} does not match ${expectedType}`);
  const instrumentId = instrumentIdValue(row.instId, "ticker.instId");
  const bid = positive(row.bidPx, "ticker.bidPx");
  const ask = positive(row.askPx, "ticker.askPx");
  if (bid >= ask) throw validation(`ticker ${instrumentId} is crossed or locked`);
  const marketType = okxMarketType(expectedType);
  return {
    venue: "okx",
    instrumentId,
    marketType,
    quantityUnit: quantityUnit(marketType),
    bid,
    bidSize: positive(row.bidSz, "ticker.bidSz"),
    ask,
    askSize: positive(row.askSz, "ticker.askSz"),
    ...optionalPositiveField("last", row.last),
    ...optionalPositiveField("lastSize", row.lastSz),
    ...optionalNonNegativeField("volume24h", row.vol24h),
    ...optionalNonNegativeField("volumeCurrency24h", row.volCcy24h),
    exchangeTs: positiveTimestamp(row.ts, "ticker.ts"),
    receivedAt
  };
}

export function normalizeOkxDepth(raw: unknown, request: { instrumentId: string; marketType: VenueMarketType }, receivedAt: number): PublicDepthSnapshot {
  const row = record(raw, "depth") as OkxDepthRow;
  const bids = depthLevels(row.bids, "depth.bids", "bids");
  const asks = depthLevels(row.asks, "depth.asks", "asks");
  if (bids.length === 0 || asks.length === 0) throw validation("depth requires both non-empty sides");
  if (bids[0]![0] >= asks[0]![0]) throw validation("depth is crossed or locked");
  const sequence = integer(row.seqId, "depth.seqId");
  if (sequence < 0) throw validation("depth.seqId must be non-negative");
  return {
    venue: "okx",
    instrumentId: instrumentIdValue(request.instrumentId, "instrumentId"),
    marketType: request.marketType,
    quantityUnit: quantityUnit(request.marketType),
    bids,
    asks,
    sequence,
    exchangeTs: positiveTimestamp(row.ts, "depth.ts"),
    receivedAt,
    complete: true
  };
}

export function normalizeOkxFunding(currentRaw: unknown, historyRows: unknown[], instrumentId: string, receivedAt: number, historyErrors: string[] = []): PublicFundingSchedule {
  const current = record(currentRaw, "funding") as OkxFundingRow;
  const normalizedId = instrumentIdValue(instrumentId, "instrumentId");
  if (!normalizedId.endsWith("-SWAP")) throw validation("funding requires an OKX SWAP instrument");
  if (exactString(current.instType, "funding.instType") !== "SWAP") throw validation("funding.instType must be SWAP");
  if (instrumentIdValue(current.instId, "funding.instId") !== normalizedId) throw validation("funding instrument does not match request");
  const fundingTime = positiveTimestamp(current.fundingTime, "funding.fundingTime");
  const nextFundingTime = positiveTimestamp(current.nextFundingTime, "funding.nextFundingTime");
  const interval = (nextFundingTime - fundingTime) / 60_000;
  const scheduleVerified = Number.isInteger(interval) && interval > 0 && interval <= 24 * 60;
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
    venue: "okx",
    instrumentId: normalizedId,
    currentEstimateRate: finite(current.fundingRate, "funding.fundingRate"),
    fundingTime,
    nextFundingTime,
    ...(scheduleVerified ? { intervalMinutes: interval } : {}),
    scheduleVerified,
    ...optionalFiniteField("nextEstimateRate", current.nextFundingRate),
    ...optionalFiniteField("settledRate", current.settFundingRate),
    ...optionalFiniteField("minimumRate", current.minFundingRate),
    ...optionalFiniteField("maximumRate", current.maxFundingRate),
    ...optionalTextField("formulaType", current.formulaType),
    ...optionalTextField("method", current.method),
    exchangeTs: positiveTimestamp(current.ts, "funding.ts"),
    receivedAt,
    history,
    sourceErrors
  };
}

function normalizeInstrument(row: OkxInstrumentRow, expectedType: OkxInstrumentType): RegistryInstrument {
  const instType = exactString(row.instType, "instrument.instType") as OkxInstrumentType;
  if (instType !== expectedType) throw validation(`instrument type ${instType} does not match ${expectedType}`);
  const venueSymbol = instrumentIdValue(row.instId, "instrument.instId");
  const marketType = okxMarketType(expectedType);
  const status = instrumentStatus(row.state);
  const tickSize = positive(row.tickSz, "instrument.tickSz");
  const quantityStep = positive(row.lotSz, "instrument.lotSz");
  const minimumQuantity = positive(row.minSz, "instrument.minSz");
  if (marketType === "spot") {
    const baseAsset = asset(row.baseCcy, "instrument.baseCcy");
    const quoteAsset = asset(row.quoteCcy, "instrument.quoteCcy");
    return {
      id: `okx:spot:${venueSymbol}`,
      assetId: baseAsset,
      venue: "okx",
      venueSymbol,
      baseAsset,
      quoteAsset,
      settleAsset: quoteAsset,
      marketType,
      contractMultiplier: 1,
      quantityUnit: "base",
      tickSize,
      quantityStep,
      minimumQuantity,
      minimumNotional: 0,
      status
    };
  }

  const underlying = instrumentIdValue(row.uly, "instrument.uly");
  const underlyingAssets = underlying.split("-");
  if (underlyingAssets.length !== 2) throw validation("instrument.uly must contain exactly base and quote currencies");
  const [baseToken, quoteToken] = underlyingAssets;
  if (!baseToken || !quoteToken) throw validation("instrument.uly must contain base and quote currencies");
  const baseAsset = asset(baseToken, "instrument.uly base");
  const quoteAsset = asset(quoteToken, "instrument.uly quote");
  const settleAsset = asset(row.settleCcy, "instrument.settleCcy");
  const direction = exactString(row.ctType, "instrument.ctType");
  if (direction !== "linear" && direction !== "inverse") throw validation("instrument.ctType must be linear or inverse");
  const contractValue = positive(row.ctVal, "instrument.ctVal");
  const rawMultiplier = optionalPositive(row.ctMult, "instrument.ctMult") ?? 1;
  const instrumentFamily = optionalId(row.instFamily);
  const expiryTime = marketType === "future" ? positiveTimestamp(row.expTime, "instrument.expTime") : undefined;
  return {
    id: `okx:${marketType}:${venueSymbol}`,
    assetId: baseAsset,
    venue: "okx",
    venueSymbol,
    baseAsset,
    quoteAsset,
    settleAsset,
    marketType,
    contractDirection: direction,
    contractMultiplier: contractValue * rawMultiplier,
    contractValue,
    contractValueCurrency: asset(row.ctValCcy, "instrument.ctValCcy"),
    quantityUnit: "contract",
    underlying,
    ...(instrumentFamily ? { instrumentFamily } : {}),
    tickSize,
    quantityStep,
    minimumQuantity,
    minimumNotional: 0,
    status,
    ...(expiryTime ? { expiryTime } : {})
  };
}

function normalizeFundingPoint(raw: unknown, expectedId: string): PublicFundingPoint {
  const row = record(raw, "funding history") as OkxFundingHistoryRow;
  if (exactString(row.instType, "history.instType") !== "SWAP") throw validation("history.instType must be SWAP");
  if (instrumentIdValue(row.instId, "history.instId") !== expectedId) throw validation("history instrument does not match request");
  return {
    instrumentId: expectedId,
    fundingTime: positiveTimestamp(row.fundingTime, "history.fundingTime"),
    fundingRate: finite(row.fundingRate, "history.fundingRate"),
    ...optionalFiniteField("realizedRate", row.realizedRate),
    ...optionalTextField("formulaType", row.formulaType),
    ...optionalTextField("method", row.method)
  };
}

function depthLevels(value: unknown, label: string, side: "bids" | "asks"): PublicDepthLevel[] {
  if (!Array.isArray(value)) throw validation(`${label} must be an array`);
  const levels: PublicDepthLevel[] = value.map((raw, index) => {
    if (!Array.isArray(raw) || raw.length < 2) throw validation(`${label}[${index}] must contain price and quantity`);
    const price = positive(raw[0], `${label}[${index}].price`);
    const quantity = positive(raw[1], `${label}[${index}].quantity`);
    const orderCount = raw[3] === undefined ? undefined : integer(raw[3], `${label}[${index}].orderCount`);
    if (orderCount !== undefined && orderCount < 0) throw validation(`${label}[${index}].orderCount must be non-negative`);
    return orderCount === undefined ? [price, quantity] : [price, quantity, orderCount];
  });
  for (let index = 1; index < levels.length; index += 1) {
    if (side === "bids" ? levels[index]![0] > levels[index - 1]![0] : levels[index]![0] < levels[index - 1]![0]) {
      throw validation(`${label} is not sorted`);
    }
  }
  return levels;
}

function quantityUnit(marketType: VenueMarketType): VenueQuantityUnit {
  if (marketType === "spot" || marketType === "margin") return "base";
  return "contract";
}

function instrumentStatus(value: unknown): RegistryInstrument["status"] {
  const state = exactString(value, "instrument.state");
  if (state === "live") return "trading";
  if (state === "preopen") return "prelaunch";
  if (state === "suspend" || state === "settlement") return "settling";
  if (state === "expired") return "closed";
  throw validation(`unsupported instrument.state ${state}`);
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

function optionalId(value: unknown) {
  if (value === undefined || value === null || value === "") return undefined;
  return instrumentIdValue(value, "identifier");
}

function asset(value: unknown, label: string) {
  const parsed = exactString(value, label).toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9_]{0,29}$/.test(parsed)) throw validation(`${label} is not a valid asset code`);
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

function optionalPositive(value: unknown, label: string) {
  if (value === "" || value === null || value === undefined) return undefined;
  return positive(value, label);
}

function integer(value: unknown, label: string) {
  const parsed = finite(value, label);
  if (!Number.isSafeInteger(parsed)) throw validation(`${label} must be a safe integer`);
  return parsed;
}

function positiveTimestamp(value: unknown, label: string) {
  const parsed = integer(value, label);
  if (parsed <= 0) throw validation(`${label} must be positive`);
  return parsed;
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

function optionalTextField<Key extends string>(key: Key, value: unknown): Record<Key, string> | Record<string, never> {
  return value === "" || value === null || value === undefined ? {} : ({ [key]: exactString(value, key) } as Record<Key, string>);
}

function validation(message: string) {
  return new PublicVenueAdapterError("okx", "validation", message);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
