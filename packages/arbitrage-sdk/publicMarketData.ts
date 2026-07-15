import type { PublicAdapterValidationIssue, PublicVenueDepthResponse, PublicVenueFundingPoint, PublicVenueFundingResponse, PublicVenueInstrumentResponse, PublicVenueTickerResponse, PublicVenueTopBook } from "./types.js";
import { parseRegistryInstrument } from "./registry.js";
import { array, bool, exact, finite, integer, nonNegative, optionalFinite, optionalText, positive, record, text } from "./validation.js";

export function parsePublicVenueTopBook(value: unknown, requireReadOnly = true): PublicVenueTopBook {
  const row = record(value, "public venue top book");
  if (requireReadOnly && row.readOnly !== true) throw new Error("public venue top book must be read-only");
  const bid = positive(row.bid, "bid");
  const ask = positive(row.ask, "ask");
  if (bid >= ask) throw new Error("public venue top book must have bid below ask");
  const source = optionalText(row.source, "source");
  const executable = optionalBoolean(row.executable, "executable");
  const sequenceAvailable = optionalBoolean(row.sequenceAvailable, "sequenceAvailable");
  const last = optionalPositive(row.last, "last");
  const lastSize = optionalNonNegative(row.lastSize, "lastSize");
  const volume24h = optionalNonNegative(row.volume24h, "volume24h");
  const volumeCurrency24h = optionalNonNegative(row.volumeCurrency24h, "volumeCurrency24h");
  return {
    ...(row.readOnly === true ? { readOnly: true as const } : {}),
    venue: text(row.venue, "venue"),
    instrumentId: text(row.instrumentId, "instrumentId"),
    marketType: marketType(row.marketType),
    quantityUnit: quantityUnit(row.quantityUnit),
    bid,
    bidSize: positive(row.bidSize, "bidSize"),
    ask,
    askSize: positive(row.askSize, "askSize"),
    ...(last === undefined ? {} : { last }),
    ...(lastSize === undefined ? {} : { lastSize }),
    ...(volume24h === undefined ? {} : { volume24h }),
    ...(volumeCurrency24h === undefined ? {} : { volumeCurrency24h }),
    ...(source === undefined ? {} : { source }),
    ...(executable === undefined ? {} : { executable }),
    ...(sequenceAvailable === undefined ? {} : { sequenceAvailable }),
    exchangeTs: positive(row.exchangeTs, "exchangeTs"),
    receivedAt: positive(row.receivedAt, "receivedAt")
  };
}

export function parsePublicVenueInstruments(value: unknown): PublicVenueInstrumentResponse {
  const row = readOnlyRecord(value, "public venue instruments");
  return {
    readOnly: true,
    venue: text(row.venue, "venue"),
    marketType: marketType(row.marketType),
    receivedAt: positive(row.receivedAt, "receivedAt"),
    total: integer(row.total, "total"),
    truncated: bool(row.truncated, "truncated"),
    instruments: array(row.instruments, "instruments", 5_000).map(parseRegistryInstrument),
    rejectedRows: array(row.rejectedRows, "rejectedRows", 5_000).map(parseValidationIssue)
  };
}

export function parsePublicVenueTickers(value: unknown): PublicVenueTickerResponse {
  const row = readOnlyRecord(value, "public venue tickers");
  return {
    readOnly: true,
    venue: text(row.venue, "venue"),
    marketType: marketType(row.marketType),
    receivedAt: positive(row.receivedAt, "receivedAt"),
    total: integer(row.total, "total"),
    truncated: bool(row.truncated, "truncated"),
    tickers: array(row.tickers, "tickers", 5_000).map((ticker) => parsePublicVenueTopBook(ticker, false)),
    rejectedRows: array(row.rejectedRows, "rejectedRows", 5_000).map(parseValidationIssue)
  };
}

export function parsePublicVenueDepth(value: unknown): PublicVenueDepthResponse {
  const row = record(value, "public venue depth");
  if (row.readOnly !== true) throw new Error("public venue depth must be read-only");
  if (row.complete !== true) throw new Error("public venue depth must be complete");
  const bids = levels(row.bids, "bid", true);
  const asks = levels(row.asks, "ask", false);
  if (bids[0]![0] >= asks[0]![0]) throw new Error("public venue depth must not be crossed or locked");
  const sequence = integer(row.sequence, "sequence");
  const sequenceVerified = optionalBoolean(row.sequenceVerified, "sequenceVerified");
  if (sequenceVerified === true && sequence === 0) throw new Error("verified sequence must be positive");
  const source = optionalText(row.source, "source");
  return {
    readOnly: true,
    venue: text(row.venue, "venue"),
    instrumentId: text(row.instrumentId, "instrumentId"),
    marketType: marketType(row.marketType),
    quantityUnit: quantityUnit(row.quantityUnit),
    bids,
    asks,
    sequence,
    ...(sequenceVerified === undefined ? {} : { sequenceVerified }),
    ...(source === undefined ? {} : { source }),
    exchangeTs: positive(row.exchangeTs, "exchangeTs"),
    receivedAt: positive(row.receivedAt, "receivedAt"),
    complete: true
  };
}

export function parsePublicVenueFunding(value: unknown): PublicVenueFundingResponse {
  const row = readOnlyRecord(value, "public venue funding");
  const intervalMinutes = optionalPositive(row.intervalMinutes, "intervalMinutes");
  const nextEstimateRate = optionalFinite(row.nextEstimateRate, "nextEstimateRate");
  const settledRate = optionalFinite(row.settledRate, "settledRate");
  const minimumRate = optionalFinite(row.minimumRate, "minimumRate");
  const maximumRate = optionalFinite(row.maximumRate, "maximumRate");
  const formulaType = optionalText(row.formulaType, "formulaType");
  const method = optionalText(row.method, "method");
  const network = row.network === undefined ? undefined : exact(row.network, ["mainnet", "testnet"] as const, "network");
  const currentEstimateSource = optionalText(row.currentEstimateSource, "currentEstimateSource");
  const timestampSource = row.timestampSource === undefined ? undefined : exact(row.timestampSource, ["exchange", "local-receive"] as const, "timestampSource");
  return {
    readOnly: true,
    venue: text(row.venue, "venue"),
    marketType: exact(row.marketType, ["perpetual"] as const, "marketType"),
    instrumentId: text(row.instrumentId, "instrumentId"),
    currentEstimateRate: finite(row.currentEstimateRate, "currentEstimateRate"),
    fundingTime: positive(row.fundingTime, "fundingTime"),
    nextFundingTime: positive(row.nextFundingTime, "nextFundingTime"),
    ...(intervalMinutes === undefined ? {} : { intervalMinutes }),
    scheduleVerified: bool(row.scheduleVerified, "scheduleVerified"),
    ...(nextEstimateRate === undefined ? {} : { nextEstimateRate }),
    ...(settledRate === undefined ? {} : { settledRate }),
    ...(minimumRate === undefined ? {} : { minimumRate }),
    ...(maximumRate === undefined ? {} : { maximumRate }),
    ...(formulaType === undefined ? {} : { formulaType }),
    ...(method === undefined ? {} : { method }),
    ...(network === undefined ? {} : { network }),
    ...(currentEstimateSource === undefined ? {} : { currentEstimateSource }),
    ...(timestampSource === undefined ? {} : { timestampSource }),
    exchangeTs: positive(row.exchangeTs, "exchangeTs"),
    receivedAt: positive(row.receivedAt, "receivedAt"),
    history: array(row.history, "history", 1_000).map(parseFundingPoint),
    sourceErrors: array(row.sourceErrors, "sourceErrors", 1_000).map((error) => text(error, "sourceError"))
  };
}

function levels(value: unknown, label: "bid" | "ask", descending: boolean) {
  const parsed = array(value, `${label}s`, 400).map((level) => parseLevel(level, label));
  if (parsed.length === 0) throw new Error(`public venue depth requires at least one ${label}`);
  for (let index = 1; index < parsed.length; index += 1) {
    const ordered = descending ? parsed[index - 1]![0] > parsed[index]![0] : parsed[index - 1]![0] < parsed[index]![0];
    if (!ordered) throw new Error(`public venue ${label}s must be strictly price sorted`);
  }
  return parsed;
}

function parseLevel(value: unknown, label: string): readonly [number, number, number?] {
  const level = array(value, `${label} level`, 3);
  if (level.length < 2) throw new Error(`${label} level requires price and quantity`);
  const orderCount = level[2] === undefined ? undefined : integer(level[2], `${label} orderCount`);
  const result = [positive(level[0], `${label} price`), positive(level[1], `${label} quantity`)] as const;
  return orderCount === undefined ? result : [result[0], result[1], orderCount];
}

function parseFundingPoint(value: unknown): PublicVenueFundingPoint {
  const row = record(value, "funding point");
  const realizedRate = optionalFinite(row.realizedRate, "realizedRate");
  const formulaType = optionalText(row.formulaType, "formulaType");
  const method = optionalText(row.method, "method");
  return {
    instrumentId: text(row.instrumentId, "instrumentId"),
    fundingTime: positive(row.fundingTime, "fundingTime"),
    fundingRate: finite(row.fundingRate, "fundingRate"),
    ...(realizedRate === undefined ? {} : { realizedRate }),
    ...(formulaType === undefined ? {} : { formulaType }),
    ...(method === undefined ? {} : { method })
  };
}

function parseValidationIssue(value: unknown): PublicAdapterValidationIssue {
  const row = record(value, "adapter validation issue");
  const instrumentId = optionalText(row.instrumentId, "instrumentId");
  return { index: integer(row.index, "index"), ...(instrumentId ? { instrumentId } : {}), message: text(row.message, "message") };
}

function readOnlyRecord(value: unknown, label: string) {
  const row = record(value, label);
  if (row.readOnly !== true) throw new Error(`${label} must be read-only`);
  return row;
}

function optionalBoolean(value: unknown, label: string) {
  return value === undefined ? undefined : bool(value, label);
}
function optionalPositive(value: unknown, label: string) {
  return value === undefined ? undefined : positive(value, label);
}
function optionalNonNegative(value: unknown, label: string) {
  return value === undefined ? undefined : nonNegative(value, label);
}
function marketType(value: unknown) {
  return exact(value, ["spot", "margin", "perpetual", "future", "option", "native-spread"] as const, "marketType");
}
function quantityUnit(value: unknown) {
  return exact(value, ["base", "quote", "contract"] as const, "quantityUnit");
}
