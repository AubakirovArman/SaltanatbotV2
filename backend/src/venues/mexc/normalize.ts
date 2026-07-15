import type { RegistryInstrument, VenueMarketType, VenueQuantityUnit } from "@saltanatbotv2/contracts";
import type { AdapterValidationIssue, PublicDepthLevel, PublicDepthSnapshot, PublicFundingPoint, PublicFundingSchedule, PublicTopBook } from "../publicTypes.js";
import { PublicVenueAdapterError } from "../publicTypes.js";
import type { MexcFundingHistoryRow, MexcFundingRow, MexcMarketType, MexcPerpetualDepthRow, MexcPerpetualInstrumentRow, MexcSpotDepthRow, MexcSpotInstrumentRow, MexcSpotTickerRow } from "./types.js";
import { asset, boolean, errorMessage, exactString, finite, instrumentId, nonNegative, positive, positiveMillis, record, safeInteger, validation } from "./validation.js";

const MAX_SOURCE_LEVELS = 5_000;

export function mexcMarketType(value: VenueMarketType): MexcMarketType {
  if (value === "spot" || value === "perpetual") return value;
  throw new PublicVenueAdapterError("mexc", "unsupported", `unsupported market type ${value}`);
}

export function normalizeMexcInstruments(rows: unknown[], marketType: MexcMarketType) {
  const instruments: RegistryInstrument[] = [];
  const rejectedRows: AdapterValidationIssue[] = [];
  rows.forEach((raw, index) => {
    try {
      const row = record(raw, `instrument[${index}]`);
      instruments.push(marketType === "spot" ? normalizeSpotInstrument(row as MexcSpotInstrumentRow) : normalizePerpetualInstrument(row as MexcPerpetualInstrumentRow));
    } catch (error) {
      rejectedRows.push({ index, instrumentId: rawInstrumentId(raw), message: errorMessage(error) });
    }
  });
  return { instruments, rejectedRows };
}

export function normalizeMexcSpotTicker(raw: unknown, receivedAt: number): PublicTopBook {
  const row = record(raw, "ticker") as MexcSpotTickerRow;
  const id = instrumentId(row.symbol, "ticker.symbol");
  const bid = positive(row.bidPrice, "ticker.bidPrice");
  const ask = positive(row.askPrice, "ticker.askPrice");
  if (bid >= ask) throw validation(`ticker ${id} is crossed or locked`);
  return {
    venue: "mexc",
    instrumentId: id,
    marketType: "spot",
    quantityUnit: "base",
    bid,
    bidSize: positive(row.bidQty, "ticker.bidQty"),
    ask,
    askSize: positive(row.askQty, "ticker.askQty"),
    // The REST book-ticker response has no exchange timestamp.
    exchangeTs: positiveMillis(receivedAt, "receivedAt"),
    receivedAt
  };
}

export function normalizeMexcDepth(raw: unknown, request: { instrumentId: string; marketType: MexcMarketType; limit: number }, receivedAt: number): PublicDepthSnapshot {
  const row = record(raw, "depth") as MexcSpotDepthRow & MexcPerpetualDepthRow;
  const bids = depthLevels(row.bids, "depth.bids", "bids", request.limit, request.marketType);
  const asks = depthLevels(row.asks, "depth.asks", "asks", request.limit, request.marketType);
  if (bids.length === 0 || asks.length === 0) throw validation("depth requires both non-empty sides");
  if (bids[0]![0] >= asks[0]![0]) throw validation("depth is crossed or locked");
  return {
    venue: "mexc",
    instrumentId: instrumentId(request.instrumentId, "instrumentId"),
    marketType: request.marketType,
    quantityUnit: quantityUnit(request.marketType),
    bids,
    asks,
    sequence: safeInteger(request.marketType === "spot" ? row.lastUpdateId : row.version, "depth sequence"),
    exchangeTs: request.marketType === "spot" ? positiveMillis(receivedAt, "receivedAt") : positiveMillis(row.timestamp, "depth.timestamp"),
    receivedAt,
    complete: true
  };
}

export function topBookFromMexcDepth(depth: PublicDepthSnapshot): PublicTopBook {
  const bid = depth.bids[0];
  const ask = depth.asks[0];
  if (!bid || !ask) throw validation("depth requires both sides for top book");
  return {
    venue: depth.venue,
    instrumentId: depth.instrumentId,
    marketType: depth.marketType,
    quantityUnit: depth.quantityUnit,
    bid: bid[0],
    bidSize: bid[1],
    ask: ask[0],
    askSize: ask[1],
    exchangeTs: depth.exchangeTs,
    receivedAt: depth.receivedAt
  };
}

export function normalizeMexcFunding(currentRaw: unknown, historyRows: unknown[], instrumentIdValue: string, receivedAt: number, historyErrors: string[] = []): PublicFundingSchedule {
  const current = record(currentRaw, "current funding") as MexcFundingRow;
  const id = instrumentId(instrumentIdValue, "instrumentId");
  if (instrumentId(current.symbol, "funding.symbol") !== id) throw validation("funding symbol does not match request");
  const cycleHours = safeInteger(current.collectCycle, "funding.collectCycle", 1, 24);
  const fundingTime = positiveMillis(current.nextSettleTime, "funding.nextSettleTime");
  const nextFundingTime = fundingTime + cycleHours * 3_600_000;
  if (!Number.isSafeInteger(nextFundingTime)) throw validation("next funding timestamp exceeds safe integer range");
  const sourceErrors = [...historyErrors];
  const history: PublicFundingPoint[] = [];
  historyRows.forEach((raw, index) => {
    try {
      history.push(normalizeFundingPoint(raw, id));
    } catch (error) {
      sourceErrors.push(`history[${index}]: ${errorMessage(error)}`);
    }
  });
  history.sort((left, right) => left.fundingTime - right.fundingTime);
  return {
    venue: "mexc",
    instrumentId: id,
    currentEstimateRate: finite(current.fundingRate, "funding.fundingRate"),
    fundingTime,
    nextFundingTime,
    intervalMinutes: cycleHours * 60,
    scheduleVerified: true,
    minimumRate: finite(current.minFundingRate, "funding.minFundingRate"),
    maximumRate: finite(current.maxFundingRate, "funding.maxFundingRate"),
    formulaType: "mexc-perpetual",
    method: "public fundingRate at nextSettleTime; collectCycle is documented in hours",
    exchangeTs: positiveMillis(current.timestamp, "funding.timestamp"),
    receivedAt,
    history,
    sourceErrors
  };
}

function normalizeSpotInstrument(row: MexcSpotInstrumentRow): RegistryInstrument {
  const id = instrumentId(row.symbol, "instrument.symbol");
  const baseAsset = asset(row.baseAsset, "instrument.baseAsset");
  const quoteAsset = asset(row.quoteAsset, "instrument.quoteAsset");
  if (id !== `${baseAsset}${quoteAsset}`) throw validation("instrument.symbol does not match base and quote assets");
  const basePrecision = safeInteger(row.baseAssetPrecision, "instrument.baseAssetPrecision", 0, 18);
  const quotePrecision = safeInteger(row.quotePrecision, "instrument.quotePrecision", 0, 18);
  const spotAllowed = boolean(row.isSpotTradingAllowed, "instrument.isSpotTradingAllowed");
  const side = tradeSideType(row.tradeSideType);
  const status = spotStatus(row.status, spotAllowed, side);
  return {
    id: `mexc:spot:${id}`,
    assetId: baseAsset,
    venue: "mexc",
    venueSymbol: id,
    baseAsset,
    quoteAsset,
    settleAsset: quoteAsset,
    marketType: "spot",
    contractMultiplier: 1,
    quantityUnit: "base",
    tickSize: 10 ** -quotePrecision,
    quantityStep: 10 ** -basePrecision,
    // MEXC publishes zero for many enabled products. Shared registry value 0 means unknown,
    // not proof that the venue imposes no minimum.
    minimumQuantity: nonNegative(row.baseSizePrecision, "instrument.baseSizePrecision"),
    minimumNotional: nonNegative(row.quoteAmountPrecision, "instrument.quoteAmountPrecision"),
    status
  };
}

function normalizePerpetualInstrument(row: MexcPerpetualInstrumentRow): RegistryInstrument {
  const id = instrumentId(row.symbol, "instrument.symbol");
  const baseAsset = asset(row.baseCoin, "instrument.baseCoin");
  const quoteAsset = asset(row.quoteCoin, "instrument.quoteCoin");
  const settleAsset = asset(row.settleCoin, "instrument.settleCoin");
  if (id !== `${baseAsset}_${quoteAsset}`) throw validation("instrument.symbol does not match base and quote coins");
  if (quoteAsset !== "USDT" || settleAsset !== "USDT") throw validation("only linear USDT-settled perpetual contracts are supported");
  const contractSize = positive(row.contractSize, "instrument.contractSize");
  const state = safeInteger(row.state, "instrument.state", 0, 4);
  const apiAllowed = boolean(row.apiAllowed, "instrument.apiAllowed");
  return {
    id: `mexc:perpetual:${id}`,
    assetId: baseAsset,
    venue: "mexc",
    venueSymbol: id,
    baseAsset,
    quoteAsset,
    settleAsset,
    marketType: "perpetual",
    contractDirection: "linear",
    contractMultiplier: contractSize,
    contractValue: contractSize,
    contractValueCurrency: baseAsset,
    quantityUnit: "contract",
    underlying: `${baseAsset}_${quoteAsset}`,
    instrumentFamily: `${baseAsset}_${quoteAsset}`,
    tickSize: positive(row.priceUnit, "instrument.priceUnit"),
    quantityStep: positive(row.volUnit, "instrument.volUnit"),
    minimumQuantity: positive(row.minVol, "instrument.minVol"),
    minimumNotional: 0,
    status: perpetualStatus(state, apiAllowed)
  };
}

function normalizeFundingPoint(raw: unknown, id: string): PublicFundingPoint {
  const row = record(raw, "funding history") as MexcFundingHistoryRow;
  if (instrumentId(row.symbol, "history.symbol") !== id) throw validation("funding history symbol does not match request");
  const rate = finite(row.fundingRate, "history.fundingRate");
  return {
    instrumentId: id,
    fundingTime: positiveMillis(row.settleTime, "history.settleTime"),
    fundingRate: rate,
    realizedRate: rate,
    formulaType: "mexc-perpetual",
    method: "settled"
  };
}

function depthLevels(value: unknown, label: string, side: "bids" | "asks", limit: number, marketType: MexcMarketType): PublicDepthLevel[] {
  if (!Array.isArray(value)) throw validation(`${label} must be an array`);
  if (value.length > MAX_SOURCE_LEVELS) throw validation(`${label} exceeds ${MAX_SOURCE_LEVELS} source levels`);
  const levels = value.map((raw, index): PublicDepthLevel => {
    if (!Array.isArray(raw) || raw.length < 2 || raw.length > 3) throw validation(`${label}[${index}] must contain price, quantity and optional order count`);
    const price = positive(raw[0], `${label}[${index}].price`);
    const quantity = positive(raw[1], `${label}[${index}].quantity`);
    if (marketType === "spot" || raw[2] === undefined) return [price, quantity];
    return [price, quantity, safeInteger(raw[2], `${label}[${index}].orderCount`)];
  });
  for (let index = 1; index < levels.length; index += 1) {
    const invalid = side === "bids" ? levels[index]![0] >= levels[index - 1]![0] : levels[index]![0] <= levels[index - 1]![0];
    if (invalid) throw validation(`${label} is not strictly sorted`);
  }
  return levels.slice(0, limit);
}

function spotStatus(value: unknown, spotAllowed: boolean, tradeSideType: string): RegistryInstrument["status"] {
  const status = String(value).toUpperCase();
  if ((status === "1" || status === "ENABLED") && spotAllowed && tradeSideType === "1") return "trading";
  if (status === "2" || status === "PAUSE" || status === "PAUSED" || ((status === "1" || status === "ENABLED") && (!spotAllowed || tradeSideType !== "1"))) return "settling";
  if (status === "3" || status === "OFFLINE" || status === "DISABLED") return "closed";
  throw validation(`unsupported instrument.status ${String(value)}`);
}

function tradeSideType(value: unknown): string {
  const parsed = typeof value === "number" ? String(safeInteger(value, "instrument.tradeSideType", 1, 4)) : exactString(value, "instrument.tradeSideType");
  if (!/^[1-4]$/.test(parsed)) throw validation(`unsupported instrument.tradeSideType ${parsed}`);
  return parsed;
}

function perpetualStatus(state: number, apiAllowed: boolean): RegistryInstrument["status"] {
  if (state === 0) return apiAllowed ? "trading" : "settling";
  if (state === 1 || state === 4) return "settling";
  if (state === 2 || state === 3) return "closed";
  throw validation(`unsupported instrument.state ${state}`);
}

function rawInstrumentId(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = (raw as { symbol?: unknown }).symbol;
  return typeof value === "string" ? value.toUpperCase() : undefined;
}

function quantityUnit(marketType: MexcMarketType): VenueQuantityUnit {
  return marketType === "spot" ? "base" : "contract";
}
