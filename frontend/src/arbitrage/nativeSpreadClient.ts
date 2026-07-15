export type NativeSpreadContractType = "FundingRateArb" | "CarryTrade" | "FutureSpread" | "PerpBasis";
export type NativeSpreadLegType = "LinearPerpetual" | "LinearFutures" | "Spot";
export type NativeSpreadRiskFlag = "read-only" | "top-book-only" | "venue-native-combination" | "revalidate-before-order";

const REQUIRED_RISK_FLAGS = ["read-only", "top-book-only", "venue-native-combination", "revalidate-before-order"] as const satisfies readonly NativeSpreadRiskFlag[];
const MAX_BOOK_AGE_MS = 10_000;
const MAX_FUTURE_SKEW_MS = 2_000;

export interface NativeSpreadLeg {
  symbol: string;
  contractType: NativeSpreadLegType;
}

export interface NativeSpreadOpportunity {
  id: string;
  venue: "bybit";
  symbol: string;
  contractType: NativeSpreadContractType;
  status: "Trading";
  baseCoin: string;
  quoteCoin: string;
  settleCoin: string;
  tickSize: number;
  minimumPrice: number;
  maximumPrice: number;
  quantityStep: number;
  minimumQuantity: number;
  maximumQuantity: number;
  launchTime: number;
  deliveryTime?: number;
  legs: [NativeSpreadLeg, NativeSpreadLeg];
  bidPrice: number;
  bidQuantity: number;
  askPrice: number;
  askQuantity: number;
  bookWidth: number;
  relativeBookWidthBps?: number;
  executableQuantity: number;
  sequence: number;
  exchangeTs: number;
  matchingEngineTs: number;
  receivedAt: number;
  quoteAgeMs: number;
  riskFlags: NativeSpreadRiskFlag[];
}

export interface NativeSpreadScanResponse {
  venue: "bybit";
  marketDataMode: "venue-native-spread-orderbook";
  executionModel: "venue-matched-multi-leg";
  readOnly: true;
  updatedAt: number;
  totalInstruments: number;
  eligibleInstruments: number;
  scannedInstruments: number;
  healthyBooks: number;
  totalOpportunities: number;
  truncated: boolean;
  candidateTruncated: boolean;
  sourceErrors: string[];
  opportunities: NativeSpreadOpportunity[];
}

export async function fetchNativeSpreadScan(options: { contractType?: NativeSpreadContractType; baseCoin?: string; minimumQuantity: number; sort: "capacity" | "tightness" | "freshness"; maxCandidates: number }, signal?: AbortSignal): Promise<NativeSpreadScanResponse> {
  const query = new URLSearchParams({
    minimumQuantity: String(options.minimumQuantity),
    sort: options.sort,
    maxCandidates: String(options.maxCandidates),
    limit: String(options.maxCandidates)
  });
  if (options.contractType) query.set("contractType", options.contractType);
  if (options.baseCoin?.trim()) query.set("baseCoin", options.baseCoin.trim().toUpperCase());
  const response = await fetch(`/api/arbitrage/native-spreads?${query}`, { signal });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Native spread scanner API ${response.status}`);
  }
  return parseNativeSpreadScan(await response.json());
}

export function parseNativeSpreadScan(value: unknown): NativeSpreadScanResponse {
  const row = record(value, "native spread scan");
  if (row.venue !== "bybit") throw new Error("venue is unsupported");
  if (row.marketDataMode !== "venue-native-spread-orderbook") throw new Error("marketDataMode is unsupported");
  if (row.executionModel !== "venue-matched-multi-leg") throw new Error("executionModel is unsupported");
  if (row.readOnly !== true) throw new Error("native spread endpoint must be read-only");

  const updatedAt = positiveInteger(row.updatedAt, "updatedAt");
  const totalInstruments = nonNegativeInteger(row.totalInstruments, "totalInstruments");
  const eligibleInstruments = nonNegativeInteger(row.eligibleInstruments, "eligibleInstruments");
  const scannedInstruments = nonNegativeInteger(row.scannedInstruments, "scannedInstruments");
  const healthyBooks = nonNegativeInteger(row.healthyBooks, "healthyBooks");
  const totalOpportunities = nonNegativeInteger(row.totalOpportunities, "totalOpportunities");
  const truncated = bool(row.truncated, "truncated");
  const candidateTruncated = bool(row.candidateTruncated, "candidateTruncated");
  const sourceErrors = array(row.sourceErrors, "sourceErrors", 100).map((error) => text(error, "source error"));
  const opportunities = array(row.opportunities, "opportunities", 50).map((opportunity, index) => parseOpportunity(opportunity, index, updatedAt));

  validateCounts({
    totalInstruments,
    eligibleInstruments,
    scannedInstruments,
    healthyBooks,
    totalOpportunities,
    returnedOpportunities: opportunities.length,
    truncated,
    candidateTruncated
  });
  const ids = new Set(opportunities.map(({ id }) => id));
  const symbols = new Set(opportunities.map(({ symbol }) => symbol));
  if (ids.size !== opportunities.length) throw new Error("opportunity ids must be unique");
  if (symbols.size !== opportunities.length) throw new Error("opportunity symbols must be unique");

  return {
    venue: "bybit",
    marketDataMode: "venue-native-spread-orderbook",
    executionModel: "venue-matched-multi-leg",
    readOnly: true,
    updatedAt,
    totalInstruments,
    eligibleInstruments,
    scannedInstruments,
    healthyBooks,
    totalOpportunities,
    truncated,
    candidateTruncated,
    sourceErrors,
    opportunities
  };
}

function parseOpportunity(value: unknown, index: number, updatedAt: number): NativeSpreadOpportunity {
  const label = `opportunities[${index}]`;
  const row = record(value, label);
  const symbol = exactSymbol(row.symbol, `${label}.symbol`);
  const id = text(row.id, `${label}.id`);
  if (id !== `bybit:native-spread:${symbol}`) throw new Error(`${label}.id must match its venue and symbol`);
  const status = exact(row.status, ["Trading"] as const, `${label}.status`);
  const tickSize = positive(row.tickSize, `${label}.tickSize`);
  const minimumPrice = finite(row.minimumPrice, `${label}.minimumPrice`);
  const maximumPrice = finite(row.maximumPrice, `${label}.maximumPrice`);
  if (minimumPrice > maximumPrice) throw new Error(`${label} minimumPrice must not exceed maximumPrice`);
  const quantityStep = positive(row.quantityStep, `${label}.quantityStep`);
  const minimumQuantity = positive(row.minimumQuantity, `${label}.minimumQuantity`);
  const maximumQuantity = positive(row.maximumQuantity, `${label}.maximumQuantity`);
  if (minimumQuantity > maximumQuantity) throw new Error(`${label} minimumQuantity must not exceed maximumQuantity`);
  requireStepAligned(minimumQuantity, quantityStep, `${label}.minimumQuantity`);
  requireStepAligned(maximumQuantity, quantityStep, `${label}.maximumQuantity`);

  const legs = array(row.legs, `${label}.legs`, 2);
  if (legs.length !== 2) throw new Error("native spread must have exactly two legs");
  const parsedLegs = legs.map((leg, legIndex) => parseLeg(leg, `${label}.legs[${legIndex}]`)) as [NativeSpreadLeg, NativeSpreadLeg];
  if (parsedLegs[0].symbol === parsedLegs[1].symbol && parsedLegs[0].contractType === parsedLegs[1].contractType) {
    throw new Error(`${label}.legs must be distinct`);
  }

  const bidPrice = finite(row.bidPrice, `${label}.bidPrice`);
  const askPrice = finite(row.askPrice, `${label}.askPrice`);
  if (bidPrice >= askPrice) throw new Error(`${label} must have bidPrice below askPrice`);
  if (bidPrice < minimumPrice || askPrice > maximumPrice) throw new Error(`${label} prices must stay within instrument bounds`);
  requireStepAligned(bidPrice, tickSize, `${label}.bidPrice`);
  requireStepAligned(askPrice, tickSize, `${label}.askPrice`);
  const bookWidth = positive(row.bookWidth, `${label}.bookWidth`);
  const expectedWidth = askPrice - bidPrice;
  if (!approximatelyEqual(bookWidth, expectedWidth, tickSize)) throw new Error(`${label}.bookWidth must equal askPrice - bidPrice`);

  const bidQuantity = positive(row.bidQuantity, `${label}.bidQuantity`);
  const askQuantity = positive(row.askQuantity, `${label}.askQuantity`);
  requireStepAligned(bidQuantity, quantityStep, `${label}.bidQuantity`);
  requireStepAligned(askQuantity, quantityStep, `${label}.askQuantity`);
  const executableQuantity = positive(row.executableQuantity, `${label}.executableQuantity`);
  const expectedExecutableQuantity = floorToStep(Math.min(bidQuantity, askQuantity, maximumQuantity), quantityStep);
  if (!approximatelyEqual(executableQuantity, expectedExecutableQuantity, quantityStep)) {
    throw new Error(`${label}.executableQuantity must be the step-floored executable top-book quantity`);
  }
  requireStepAligned(executableQuantity, quantityStep, `${label}.executableQuantity`);
  if (executableQuantity < minimumQuantity || executableQuantity > maximumQuantity) {
    throw new Error(`${label}.executableQuantity must stay within instrument quantity bounds`);
  }

  const relativeBookWidthBps = optionalFinite(row.relativeBookWidthBps, `${label}.relativeBookWidthBps`);
  if (relativeBookWidthBps !== undefined) {
    const midpoint = (bidPrice + askPrice) / 2;
    if (Math.abs(midpoint) <= tickSize) throw new Error(`${label}.relativeBookWidthBps requires a non-zero midpoint`);
    const expectedRelativeWidth = (expectedWidth / Math.abs(midpoint)) * 10_000;
    if (relativeBookWidthBps < 0 || !approximatelyEqual(relativeBookWidthBps, expectedRelativeWidth, 1e-9)) {
      throw new Error(`${label}.relativeBookWidthBps is inconsistent with its book`);
    }
  }

  const launchTime = positiveInteger(row.launchTime, `${label}.launchTime`);
  if (launchTime > updatedAt) throw new Error(`${label}.launchTime cannot be after updatedAt for a Trading instrument`);
  const deliveryTime = row.deliveryTime === undefined ? undefined : positiveInteger(row.deliveryTime, `${label}.deliveryTime`);
  if (deliveryTime !== undefined && deliveryTime <= launchTime) throw new Error(`${label}.deliveryTime must be after launchTime`);

  const sequence = nonNegativeInteger(row.sequence, `${label}.sequence`);
  const exchangeTs = positiveInteger(row.exchangeTs, `${label}.exchangeTs`);
  const matchingEngineTs = positiveInteger(row.matchingEngineTs, `${label}.matchingEngineTs`);
  const receivedAt = positiveInteger(row.receivedAt, `${label}.receivedAt`);
  const quoteAgeMs = nonNegativeInteger(row.quoteAgeMs, `${label}.quoteAgeMs`);
  if (matchingEngineTs > exchangeTs) throw new Error(`${label}.matchingEngineTs cannot be after exchangeTs`);
  if (exchangeTs > receivedAt + MAX_FUTURE_SKEW_MS) throw new Error(`${label}.exchangeTs exceeds the allowed receive-time skew`);
  if (receivedAt > updatedAt) throw new Error(`${label}.receivedAt cannot be after updatedAt`);
  const ageAtScanCompletion = updatedAt - exchangeTs;
  if (ageAtScanCompletion < -MAX_FUTURE_SKEW_MS) throw new Error(`${label}.exchangeTs exceeds the allowed scan-time skew`);
  const expectedQuoteAgeMs = Math.max(0, ageAtScanCompletion);
  if (quoteAgeMs !== expectedQuoteAgeMs) throw new Error(`${label}.quoteAgeMs is inconsistent with updatedAt and exchangeTs`);
  if (expectedQuoteAgeMs > MAX_BOOK_AGE_MS) throw new Error(`${label}.quoteAgeMs exceeds the native-spread freshness gate`);

  return {
    id,
    venue: exact(row.venue, ["bybit"] as const, `${label}.venue`),
    symbol,
    contractType: exact(row.contractType, ["FundingRateArb", "CarryTrade", "FutureSpread", "PerpBasis"] as const, `${label}.contractType`),
    status,
    baseCoin: asset(row.baseCoin, `${label}.baseCoin`),
    quoteCoin: asset(row.quoteCoin, `${label}.quoteCoin`),
    settleCoin: asset(row.settleCoin, `${label}.settleCoin`),
    tickSize,
    minimumPrice,
    maximumPrice,
    quantityStep,
    minimumQuantity,
    maximumQuantity,
    launchTime,
    ...(deliveryTime === undefined ? {} : { deliveryTime }),
    legs: parsedLegs,
    bidPrice,
    bidQuantity,
    askPrice,
    askQuantity,
    bookWidth,
    ...(relativeBookWidthBps === undefined ? {} : { relativeBookWidthBps }),
    executableQuantity,
    sequence,
    exchangeTs,
    matchingEngineTs,
    receivedAt,
    quoteAgeMs,
    riskFlags: parseRiskFlags(row.riskFlags, `${label}.riskFlags`)
  };
}

function parseLeg(value: unknown, label: string): NativeSpreadLeg {
  const row = record(value, label);
  return {
    symbol: exactSymbol(row.symbol, `${label}.symbol`),
    contractType: exact(row.contractType, ["LinearPerpetual", "LinearFutures", "Spot"] as const, `${label}.contractType`)
  };
}

function parseRiskFlags(value: unknown, label: string): NativeSpreadRiskFlag[] {
  const flags = array(value, label, REQUIRED_RISK_FLAGS.length).map((flag) => exact(flag, REQUIRED_RISK_FLAGS, `${label} entry`));
  if (flags.length !== REQUIRED_RISK_FLAGS.length || new Set(flags).size !== flags.length || REQUIRED_RISK_FLAGS.some((flag) => !flags.includes(flag))) {
    throw new Error(`${label} must contain each required native-spread risk flag exactly once`);
  }
  return flags;
}

function validateCounts(counts: {
  totalInstruments: number;
  eligibleInstruments: number;
  scannedInstruments: number;
  healthyBooks: number;
  totalOpportunities: number;
  returnedOpportunities: number;
  truncated: boolean;
  candidateTruncated: boolean;
}) {
  if (counts.eligibleInstruments > counts.totalInstruments) throw new Error("eligibleInstruments cannot exceed totalInstruments");
  if (counts.scannedInstruments > counts.eligibleInstruments) throw new Error("scannedInstruments cannot exceed eligibleInstruments");
  if (counts.healthyBooks > counts.scannedInstruments) throw new Error("healthyBooks cannot exceed scannedInstruments");
  if (counts.totalOpportunities > counts.healthyBooks) throw new Error("totalOpportunities cannot exceed healthyBooks");
  if (counts.returnedOpportunities > counts.totalOpportunities) throw new Error("returned opportunities cannot exceed totalOpportunities");
  if (counts.candidateTruncated !== counts.eligibleInstruments > counts.scannedInstruments) {
    throw new Error("candidateTruncated is inconsistent with eligible and scanned instrument counts");
  }
  if (counts.truncated !== (counts.candidateTruncated || counts.totalOpportunities > counts.returnedOpportunities)) {
    throw new Error("truncated is inconsistent with candidate and opportunity counts");
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function array(value: unknown, label: string, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) throw new Error(`${label} must be an array with at most ${maximum} rows`);
  return value;
}
function text(value: unknown, label: string) {
  if (typeof value !== "string" || !value) throw new Error(`${label} must be a non-empty string`);
  return value;
}
function exactSymbol(value: unknown, label: string) {
  if (typeof value !== "string" || !/^[A-Z0-9][A-Z0-9_\-/]{1,99}$/.test(value)) throw new Error(`${label} is invalid`);
  return value;
}
function asset(value: unknown, label: string) {
  if (typeof value !== "string" || !/^[A-Z0-9_-]{1,20}$/.test(value)) throw new Error(`${label} is invalid`);
  return value;
}
function finite(value: unknown, label: string) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be finite`);
  return value;
}
function optionalFinite(value: unknown, label: string) {
  return value === undefined ? undefined : finite(value, label);
}
function positive(value: unknown, label: string) {
  const result = finite(value, label);
  if (result <= 0) throw new Error(`${label} must be positive`);
  return result;
}
function nonNegative(value: unknown, label: string) {
  const result = finite(value, label);
  if (result < 0) throw new Error(`${label} must be non-negative`);
  return result;
}
function nonNegativeInteger(value: unknown, label: string) {
  const result = nonNegative(value, label);
  if (!Number.isSafeInteger(result)) throw new Error(`${label} must be an integer`);
  return result;
}
function positiveInteger(value: unknown, label: string) {
  const result = nonNegativeInteger(value, label);
  if (result <= 0) throw new Error(`${label} must be positive`);
  return result;
}
function bool(value: unknown, label: string) {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}
function exact<const T extends readonly string[]>(value: unknown, values: T, label: string): T[number] {
  if (typeof value !== "string" || !values.includes(value)) throw new Error(`${label} is unsupported`);
  return value;
}
function approximatelyEqual(actual: number, expected: number, unit: number) {
  const tolerance = Math.max(1e-12, Math.abs(expected) * 1e-9, Math.abs(unit) * 1e-8);
  return Math.abs(actual - expected) <= tolerance;
}
function requireStepAligned(value: number, step: number, label: string) {
  const units = value / step;
  if (!Number.isSafeInteger(Math.round(units)) || !approximatelyEqual(value, Math.round(units) * step, step)) {
    throw new Error(`${label} must align to its venue step`);
  }
}
function floorToStep(value: number, step: number) {
  const units = Math.floor(value / step + 1e-10);
  return Math.max(0, Number((units * step).toFixed(Math.min(15, decimalPlaces(step)))));
}
function decimalPlaces(value: number) {
  const [coefficient = "", rawExponent] = value.toString().toLowerCase().split("e");
  const fractionDigits = coefficient.split(".")[1]?.length ?? 0;
  const exponent = Number(rawExponent ?? 0);
  return Math.max(0, fractionDigits - exponent);
}
