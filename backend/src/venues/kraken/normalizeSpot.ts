import type { RegistryInstrument } from "@saltanatbotv2/contracts";
import type { AdapterValidationIssue, PublicDepthLevel, PublicDepthSnapshot, PublicTopBook } from "../publicTypes.js";
import type { KrakenSpotDepthRow, KrakenSpotInstrumentRow, KrakenSpotTickerRow } from "./types.js";
import { asset, errorMessage, exactString, finite, instrumentId, integer, positive, record, validation } from "./validation.js";

export function normalizeKrakenSpotInstruments(result: Record<string, unknown>) {
  const instruments: RegistryInstrument[] = [];
  const rejectedRows: AdapterValidationIssue[] = [];
  Object.entries(result).forEach(([key, raw], index) => {
    try {
      instruments.push(normalizeInstrument(key, record(raw, `instrument[${index}]`) as KrakenSpotInstrumentRow));
    } catch (error) {
      rejectedRows.push({ index, instrumentId: safeInstrumentId(key), message: errorMessage(error) });
    }
  });
  return { instruments, rejectedRows };
}

export function normalizeKrakenSpotTicker(raw: unknown, nativeId: string, receivedAt: number): PublicTopBook {
  const row = record(raw, "ticker") as KrakenSpotTickerRow;
  const id = instrumentId(nativeId, "ticker instrumentId");
  const ask = tickerTuple(row.a, "ticker.a", 3);
  const bid = tickerTuple(row.b, "ticker.b", 3);
  const last = tickerTuple(row.c, "ticker.c", 2);
  const volume = tickerTuple(row.v, "ticker.v", 2);
  const askPrice = positive(ask[0], "ticker.a.price");
  const bidPrice = positive(bid[0], "ticker.b.price");
  if (bidPrice >= askPrice) throw validation(`ticker ${id} is crossed or locked`);
  return {
    venue: "kraken",
    instrumentId: id,
    marketType: "spot",
    quantityUnit: "base",
    bid: bidPrice,
    bidSize: positive(bid[2], "ticker.b.size"),
    ask: askPrice,
    askSize: positive(ask[2], "ticker.a.size"),
    last: positive(last[0], "ticker.c.price"),
    lastSize: positive(last[1], "ticker.c.size"),
    volume24h: nonNegativeTupleValue(volume[1], "ticker.v.24h"),
    // Spot Ticker has no event time. Receipt time is the explicit conservative fallback.
    exchangeTs: positiveReceiptTime(receivedAt),
    receivedAt
  };
}

export function normalizeKrakenSpotDepth(raw: unknown, request: { instrumentId: string; limit: number }, receivedAt: number): PublicDepthSnapshot {
  const row = record(raw, "depth") as KrakenSpotDepthRow;
  const bids = depthLevels(row.bids, "depth.bids", "bids", request.limit);
  const asks = depthLevels(row.asks, "depth.asks", "asks", request.limit);
  if (bids.levels.length === 0 || asks.levels.length === 0) throw validation("depth requires both non-empty sides");
  if (bids.levels[0]![0] >= asks.levels[0]![0]) throw validation("depth is crossed or locked");
  return {
    venue: "kraken",
    instrumentId: instrumentId(request.instrumentId, "instrumentId"),
    marketType: "spot",
    quantityUnit: "base",
    bids: bids.levels,
    asks: asks.levels,
    // Kraken Spot REST snapshots expose no update sequence. Zero is an explicit unsequenced sentinel.
    sequence: 0,
    exchangeTs: Math.max(bids.exchangeTs, asks.exchangeTs),
    receivedAt,
    complete: true
  };
}

function normalizeInstrument(nativeId: string, row: KrakenSpotInstrumentRow): RegistryInstrument {
  const venueSymbol = instrumentId(nativeId, "instrument key");
  const baseAsset = asset(row.base, "instrument.base");
  const quoteAsset = asset(row.quote, "instrument.quote");
  if (exactString(row.lot, "instrument.lot") !== "unit") throw validation("instrument.lot must be unit");
  const lotDecimals = integer(row.lot_decimals, "instrument.lot_decimals");
  if (lotDecimals < 0 || lotDecimals > 18) throw validation("instrument.lot_decimals must be between 0 and 18");
  const lotMultiplier = positive(row.lot_multiplier, "instrument.lot_multiplier");
  return {
    id: `kraken:spot:${venueSymbol}`,
    assetId: baseAsset,
    venue: "kraken",
    venueSymbol,
    baseAsset,
    quoteAsset,
    settleAsset: quoteAsset,
    marketType: "spot",
    contractMultiplier: 1,
    quantityUnit: "base",
    tickSize: positive(row.tick_size, "instrument.tick_size"),
    quantityStep: 10 ** -lotDecimals * lotMultiplier,
    minimumQuantity: positive(row.ordermin, "instrument.ordermin"),
    minimumNotional: positive(row.costmin, "instrument.costmin"),
    status: spotStatus(row.status)
  };
}

function spotStatus(value: unknown): RegistryInstrument["status"] {
  const status = exactString(value, "instrument.status");
  if (status === "online" || status === "post_only" || status === "limit_only") return "trading";
  if (status === "cancel_only" || status === "maintenance" || status === "reduce_only") return "settling";
  if (status === "delisted") return "closed";
  throw validation(`unsupported instrument.status ${status}`);
}

function tickerTuple(value: unknown, label: string, minimumLength: number): unknown[] {
  if (!Array.isArray(value) || value.length < minimumLength) throw validation(`${label} must contain at least ${minimumLength} values`);
  return value;
}

function depthLevels(value: unknown, label: string, side: "bids" | "asks", limit: number) {
  if (!Array.isArray(value)) throw validation(`${label} must be an array`);
  if (value.length > limit) throw validation(`${label} exceeds requested level bound`);
  let exchangeTs = 0;
  const levels: PublicDepthLevel[] = value.map((raw, index) => {
    if (!Array.isArray(raw) || raw.length < 3) throw validation(`${label}[${index}] must contain price, quantity and timestamp`);
    const price = positive(raw[0], `${label}[${index}].price`);
    const quantity = positive(raw[1], `${label}[${index}].quantity`);
    const seconds = finite(raw[2], `${label}[${index}].timestamp`);
    const milliseconds = Math.trunc(seconds * 1_000);
    if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) throw validation(`${label}[${index}].timestamp is invalid`);
    exchangeTs = Math.max(exchangeTs, milliseconds);
    return [price, quantity];
  });
  for (let index = 1; index < levels.length; index += 1) {
    const invalid = side === "bids" ? levels[index]![0] >= levels[index - 1]![0] : levels[index]![0] <= levels[index - 1]![0];
    if (invalid) throw validation(`${label} is not strictly sorted`);
  }
  return { levels, exchangeTs };
}

function nonNegativeTupleValue(value: unknown, label: string): number {
  const parsed = finite(value, label);
  if (parsed < 0) throw validation(`${label} must be non-negative`);
  return parsed;
}

function positiveReceiptTime(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw validation("receivedAt must be a positive safe integer");
  return value;
}

function safeInstrumentId(value: string): string | undefined {
  try {
    return instrumentId(value, "instrument key");
  } catch {
    return undefined;
  }
}
