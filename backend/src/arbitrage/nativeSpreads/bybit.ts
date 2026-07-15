import type { NativeSpreadBook, NativeSpreadContractType, NativeSpreadInstrument, NativeSpreadLeg, NativeSpreadLegType } from "./types.js";
import { readBoundedText } from "../../http/boundedResponse.js";

const DEFAULT_BASE_URL = "https://api.bybit.com";
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;
const CONTRACT_TYPES = new Set<NativeSpreadContractType>(["FundingRateArb", "CarryTrade", "FutureSpread", "PerpBasis"]);
const LEG_TYPES = new Set<NativeSpreadLegType>(["LinearPerpetual", "LinearFutures", "Spot"]);

export type BybitSpreadErrorKind = "cancelled" | "timeout" | "rate-limit" | "http" | "exchange" | "validation";

export class BybitSpreadError extends Error {
  constructor(
    readonly kind: BybitSpreadErrorKind,
    message: string,
    readonly status?: number
  ) {
    super(`bybit spread: ${message}`);
    this.name = "BybitSpreadError";
  }
}

export interface BybitSpreadAdapterOptions {
  fetch?: typeof fetch;
  now?: () => number;
  baseUrl?: string;
  timeoutMs?: number;
  maxPayloadBytes?: number;
}

export interface NativeInstrumentResult {
  instruments: NativeSpreadInstrument[];
  rejectedRows: string[];
  exchangeTs: number;
}

/** Public/read-only adapter for Bybit's venue-native Spread Trading market. */
export class BybitSpreadAdapter {
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly baseUrl: URL;
  private readonly timeoutMs: number;
  private readonly maxPayloadBytes: number;

  constructor(options: BybitSpreadAdapterOptions = {}) {
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.baseUrl = validatedBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
    this.timeoutMs = positiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs");
    this.maxPayloadBytes = positiveInteger(options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES, "maxPayloadBytes");
  }

  async instruments(signal?: AbortSignal): Promise<NativeInstrumentResult> {
    const instruments: NativeSpreadInstrument[] = [];
    const rejectedRows: string[] = [];
    const seenCursors = new Set<string>();
    const seenSymbols = new Set<string>();
    let cursor: string | undefined;
    let exchangeTs = 0;

    for (let page = 0; page < 20; page += 1) {
      const envelope = await this.request("/v5/spread/instrument", { limit: "500", ...(cursor ? { cursor } : {}) }, signal);
      exchangeTs = Math.max(exchangeTs, envelope.time);
      const result = record(envelope.result, "instrument result");
      const rows = array(result.list, "instrument result.list", 500);
      rows.forEach((raw, index) => {
        try {
          const instrument = normalizeInstrument(raw);
          if (seenSymbols.has(instrument.symbol)) throw validation(`duplicate instrument ${instrument.symbol}`);
          seenSymbols.add(instrument.symbol);
          instruments.push(instrument);
        } catch (error) {
          rejectedRows.push(`page ${page + 1}, row ${index}: ${message(error)}`);
        }
      });
      const next = optionalText(result.nextPageCursor);
      if (!next) break;
      if (seenCursors.has(next)) throw validation("instrument pagination cursor repeated");
      seenCursors.add(next);
      cursor = next;
      if (page === 19) throw validation("instrument pagination exceeded 20 pages");
    }

    if (instruments.length === 0) throw validation("instrument response contains no valid rows");
    return { instruments, rejectedRows, exchangeTs };
  }

  async orderBook(symbol: string, limit = 1, signal?: AbortSignal): Promise<NativeSpreadBook> {
    const instrumentId = normalizedSymbol(symbol);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 25) throw validation("order-book limit must be between 1 and 25");
    const envelope = await this.request("/v5/spread/orderbook", { symbol: instrumentId, limit: String(limit) }, signal);
    const result = record(envelope.result, "order-book result");
    const returnedSymbol = normalizedSymbol(result.s);
    if (returnedSymbol !== instrumentId) throw validation("order-book symbol does not match request");
    const bids = levels(result.b, "bids", "bid");
    const asks = levels(result.a, "asks", "ask");
    if (bids.length === 0 || asks.length === 0) throw validation("order book requires both sides");
    if (bids[0]![0] >= asks[0]![0]) throw validation("order book is crossed or locked");
    return {
      symbol: instrumentId,
      bidPrice: bids[0]![0],
      bidQuantity: bids[0]![1],
      askPrice: asks[0]![0],
      askQuantity: asks[0]![1],
      sequence: nonNegativeInteger(result.seq, "order-book seq"),
      exchangeTs: timestamp(result.ts, "order-book ts"),
      matchingEngineTs: timestamp(result.cts, "order-book cts"),
      receivedAt: this.now()
    };
  }

  private async request(path: string, query: Record<string, string>, signal?: AbortSignal) {
    if (signal?.aborted) throw cancelled();
    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const controller = new AbortController();
    let timedOut = false;
    const cancel = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    try {
      const response = await this.fetcher(url, { method: "GET", signal: controller.signal, headers: { Accept: "application/json" } });
      if (response.status === 429) throw new BybitSpreadError("rate-limit", "HTTP 429", 429);
      if (!response.ok) throw new BybitSpreadError("http", `HTTP ${response.status}`, response.status);
      const body = await readBoundedText(response, this.maxPayloadBytes, () => validation(`response exceeds ${this.maxPayloadBytes} bytes`));
      let raw: unknown;
      try {
        raw = JSON.parse(body);
      } catch {
        throw validation("response is not valid JSON");
      }
      const envelope = record(raw, "response envelope");
      const code = finite(envelope.retCode, "retCode");
      if (code !== 0) throw new BybitSpreadError("exchange", optionalText(envelope.retMsg) ?? `exchange code ${code}`);
      return { result: envelope.result, time: timestamp(envelope.time, "response time") };
    } catch (error) {
      if (error instanceof BybitSpreadError) throw error;
      if (signal?.aborted) throw cancelled();
      if (timedOut) throw new BybitSpreadError("timeout", `request exceeded ${this.timeoutMs}ms`);
      throw new BybitSpreadError("http", `network request failed: ${message(error)}`);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
    }
  }
}

function normalizeInstrument(raw: unknown): NativeSpreadInstrument {
  const row = record(raw, "instrument");
  const contractType = requiredEnum(row.contractType, CONTRACT_TYPES, "contractType");
  const status = requiredEnum(row.status, new Set(["Trading", "Settling"] as const), "status");
  const rawLegs = array(row.legs, "legs", 2);
  if (rawLegs.length !== 2) throw validation("instrument must contain exactly two legs");
  const legs = rawLegs.map(normalizeLeg) as [NativeSpreadLeg, NativeSpreadLeg];
  if (legs[0].symbol === legs[1].symbol && legs[0].contractType === legs[1].contractType) throw validation("instrument legs must be distinct");
  const delivery = nonNegativeTimestamp(row.deliveryTime, "deliveryTime");
  return {
    symbol: normalizedSymbol(row.symbol),
    contractType,
    status,
    baseCoin: asset(row.baseCoin, "baseCoin"),
    quoteCoin: asset(row.quoteCoin, "quoteCoin"),
    settleCoin: asset(row.settleCoin, "settleCoin"),
    tickSize: positive(row.tickSize, "tickSize"),
    minimumPrice: finite(row.minPrice, "minPrice"),
    maximumPrice: finite(row.maxPrice, "maxPrice"),
    quantityStep: positive(row.lotSize, "lotSize"),
    minimumQuantity: positive(row.minSize, "minSize"),
    maximumQuantity: positive(row.maxSize, "maxSize"),
    launchTime: timestamp(row.launchTime, "launchTime"),
    ...(delivery > 0 ? { deliveryTime: delivery } : {}),
    legs
  };
}

function normalizeLeg(raw: unknown): NativeSpreadLeg {
  const row = record(raw, "leg");
  return { symbol: normalizedSymbol(row.symbol), contractType: requiredEnum(row.contractType, LEG_TYPES, "leg.contractType") };
}

function levels(value: unknown, label: string, side: "bid" | "ask"): Array<[number, number]> {
  const rows = array(value, label, 25);
  const output = rows.map((raw, index) => {
    if (!Array.isArray(raw) || raw.length < 2) throw validation(`${label}[${index}] must contain price and quantity`);
    return [finite(raw[0], `${label}[${index}].price`), positive(raw[1], `${label}[${index}].quantity`)] as [number, number];
  });
  for (let index = 1; index < output.length; index += 1) {
    if (side === "bid" ? output[index]![0] > output[index - 1]![0] : output[index]![0] < output[index - 1]![0]) {
      throw validation(`${label} is not sorted`);
    }
  }
  return output;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw validation(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function array(value: unknown, label: string, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) throw validation(`${label} must be an array with at most ${maximum} rows`);
  return value;
}
function requiredEnum<T extends string>(value: unknown, values: ReadonlySet<T>, label: string): T {
  if (typeof value !== "string" || !values.has(value as T)) throw validation(`${label} is unsupported`);
  return value as T;
}
function normalizedSymbol(value: unknown) {
  if (typeof value !== "string") throw validation("symbol must be a string");
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9_\-/]{1,99}$/.test(normalized)) throw validation("symbol contains invalid characters");
  return normalized;
}
function asset(value: unknown, label: string) {
  if (typeof value !== "string" || !/^[A-Z0-9_-]{1,20}$/.test(value)) throw validation(`${label} is invalid`);
  return value;
}
function finite(value: unknown, label: string) {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  if (!Number.isFinite(number)) throw validation(`${label} must be finite`);
  return number;
}
function positive(value: unknown, label: string) {
  const number = finite(value, label);
  if (number <= 0) throw validation(`${label} must be positive`);
  return number;
}
function timestamp(value: unknown, label: string) {
  const number = finite(value, label);
  if (!Number.isSafeInteger(number) || number <= 0) throw validation(`${label} must be a positive timestamp`);
  return number;
}
function nonNegativeTimestamp(value: unknown, label: string) {
  const number = finite(value, label);
  if (!Number.isSafeInteger(number) || number < 0) throw validation(`${label} must be a non-negative timestamp`);
  return number;
}
function nonNegativeInteger(value: unknown, label: string) {
  const number = finite(value, label);
  if (!Number.isSafeInteger(number) || number < 0) throw validation(`${label} must be a non-negative integer`);
  return number;
}
function optionalText(value: unknown) {
  return typeof value === "string" && value ? value : undefined;
}
function positiveInteger(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value <= 0) throw validation(`${label} must be a positive integer`);
  return value;
}
function validatedBaseUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw validation("baseUrl must be an absolute URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw validation("baseUrl must use HTTP or HTTPS");
  if (url.username || url.password || url.search || url.hash) throw validation("baseUrl cannot contain credentials, query or fragment");
  return url;
}
function validation(message: string) {
  return new BybitSpreadError("validation", message);
}
function cancelled() {
  return new BybitSpreadError("cancelled", "request cancelled");
}
function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
