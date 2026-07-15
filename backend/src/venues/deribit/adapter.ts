import type { VenueCapabilityManifest, VenueMarketType } from "@saltanatbotv2/contracts";
import type {
  PublicDepthSnapshot,
  PublicFundingSchedule,
  PublicInstrumentSnapshot,
  PublicTickerSnapshot,
  PublicTopBook,
  PublicVenueAdapter
} from "../publicTypes.js";
import { PublicVenueAdapterError } from "../publicTypes.js";
import { normalizeDeribitDepth, normalizeDeribitFunding, normalizeDeribitInstrument, normalizeDeribitInstruments, normalizeDeribitTicker } from "./normalize.js";
import { DeribitJsonRpcTransport } from "./rpc.js";
import type { DeribitKind, DeribitMarketType } from "./types.js";
import type { DeribitRpcTransportOptions } from "./rpc.js";

export const DERIBIT_PUBLIC_CAPABILITIES: VenueCapabilityManifest = Object.freeze({
  venue: "deribit",
  publicData: true,
  spot: false,
  margin: false,
  perpetual: true,
  datedFuture: true,
  option: true,
  nativeSpread: false,
  topBook: true,
  depth: true,
  publicTrades: false,
  funding: true,
  borrow: false,
  depositWithdrawal: false,
  privateExecution: false,
  demoEnvironment: true
});

export interface DeribitPublicAdapterOptions extends DeribitRpcTransportOptions {
  now?: () => number;
  transport?: DeribitJsonRpcTransport;
}

/** Read-only Deribit adapter. No credentials, private methods, orders or account state are accepted. */
export class DeribitPublicAdapter implements PublicVenueAdapter {
  readonly venue = "deribit";
  private readonly transport: DeribitJsonRpcTransport;
  private readonly now: () => number;

  constructor(options: DeribitPublicAdapterOptions = {}) {
    this.transport = options.transport ?? new DeribitJsonRpcTransport(options);
    this.now = options.now ?? Date.now;
  }

  capabilities(): VenueCapabilityManifest {
    return { ...DERIBIT_PUBLIC_CAPABILITIES };
  }

  async instruments(marketType: VenueMarketType, signal?: AbortSignal): Promise<PublicInstrumentSnapshot> {
    const normalizedMarketType = deribitMarketType(marketType);
    const result = await this.transport.call(
      "public/get_instruments",
      { currency: "any", kind: deribitKind(normalizedMarketType), expired: false },
      signal
    );
    const rows = arrayResult(result, "get_instruments result");
    const normalized = normalizeDeribitInstruments(rows, normalizedMarketType);
    requireAtLeastOneValid(rows, normalized.instruments, `${normalizedMarketType} instruments`);
    return {
      venue: this.venue,
      marketType: normalizedMarketType,
      receivedAt: this.now(),
      instruments: normalized.instruments,
      rejectedRows: normalized.rejectedRows
    };
  }

  async tickers(marketType: VenueMarketType, _signal?: AbortSignal): Promise<PublicTickerSnapshot> {
    deribitMarketType(marketType);
    throw new PublicVenueAdapterError(
      this.venue,
      "unsupported",
      "Deribit has no bounded bulk executable-ticker endpoint; use ticker() for one exact instrument"
    );
  }

  async ticker(instrumentId: string, marketType: VenueMarketType, signal?: AbortSignal): Promise<PublicTopBook> {
    const normalizedId = normalizedInstrumentId(instrumentId);
    const normalizedMarketType = deribitMarketType(marketType);
    const [instrumentRaw, tickerRaw] = await Promise.all([
      this.transport.call("public/get_instrument", { instrument_name: normalizedId }, signal),
      this.transport.call("public/ticker", { instrument_name: normalizedId }, signal)
    ]);
    const instrument = normalizeDeribitInstrument(instrumentRaw, normalizedMarketType);
    return normalizeDeribitTicker(tickerRaw, instrument, this.now());
  }

  async depth(
    request: { instrumentId: string; marketType: VenueMarketType; limit?: number },
    signal?: AbortSignal
  ): Promise<PublicDepthSnapshot> {
    const instrumentId = normalizedInstrumentId(request.instrumentId);
    const marketType = deribitMarketType(request.marketType);
    const limit = deribitDepth(request.limit ?? 50);
    const [instrumentRaw, depthRaw] = await Promise.all([
      this.transport.call("public/get_instrument", { instrument_name: instrumentId }, signal),
      this.transport.call("public/get_order_book", { instrument_name: instrumentId, depth: limit }, signal)
    ]);
    return normalizeDeribitDepth(depthRaw, normalizeDeribitInstrument(instrumentRaw, marketType), this.now());
  }

  async funding(instrumentId: string, options: { historyLimit?: number; signal?: AbortSignal } = {}): Promise<PublicFundingSchedule> {
    const normalizedId = normalizedInstrumentId(instrumentId);
    const historyLimit = boundedInteger(options.historyLimit ?? 100, "historyLimit", 1, 1_000);
    const instrumentRaw = await this.transport.call("public/get_instrument", { instrument_name: normalizedId }, options.signal);
    const instrument = normalizeDeribitInstrument(instrumentRaw, "perpetual");
    const end = positiveTimestamp(this.now(), "current time");
    const start = end - (historyLimit + 2) * 60 * 60_000;
    if (start <= 0) throw validation("current time is too early for the requested funding history window");
    const [tickerResult, historyResult] = await Promise.allSettled([
      this.transport.call("public/ticker", { instrument_name: normalizedId }, options.signal),
      this.transport.call(
        "public/get_funding_rate_history",
        { instrument_name: normalizedId, start_timestamp: start, end_timestamp: end },
        options.signal
      )
    ]);
    if (options.signal?.aborted) throw cancelled();
    if (tickerResult.status === "rejected") throw tickerResult.reason;
    const errors = historyResult.status === "rejected" ? [`funding history: ${errorMessage(historyResult.reason)}`] : [];
    const historyRows = historyResult.status === "fulfilled" ? arrayResult(historyResult.value, "funding history result") : [];
    return normalizeDeribitFunding(tickerResult.value, historyRows, instrument, this.now(), historyLimit, errors);
  }
}

function deribitMarketType(value: VenueMarketType): DeribitMarketType {
  if (value === "perpetual" || value === "future" || value === "option") return value;
  throw new PublicVenueAdapterError("deribit", "unsupported", `unsupported market type ${value}`);
}

function deribitKind(value: DeribitMarketType): DeribitKind {
  return value === "option" ? "option" : "future";
}

function arrayResult(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw validation(`${label} must be an array`);
  return value;
}

function normalizedInstrumentId(value: string) {
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9_.-]{1,99}$/.test(normalized)) throw validation("instrumentId contains invalid characters");
  return normalized;
}

function requireAtLeastOneValid(source: unknown[], normalized: unknown[], label: string) {
  if (source.length === 0) throw validation(`${label} response is empty`);
  if (normalized.length === 0) throw validation(`${label} response contains no valid rows`);
}

function boundedInteger(value: number, label: string, minimum: number, maximum: number) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw validation(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function deribitDepth(value: number) {
  if (![1, 5, 10, 20, 50, 100, 1_000, 10_000].includes(value)) {
    throw validation("depth limit must be one of 1, 5, 10, 20, 50, 100, 1000 or 10000");
  }
  return value;
}

function positiveTimestamp(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value <= 0) throw validation(`${label} must be a positive safe integer`);
  return value;
}

function validation(message: string) {
  return new PublicVenueAdapterError("deribit", "validation", message);
}

function cancelled() {
  return new PublicVenueAdapterError("deribit", "cancelled", "request was cancelled");
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error ?? "unknown error");
}
