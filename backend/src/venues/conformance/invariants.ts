import type { RegistryInstrument, VenueMarketType } from "@saltanatbotv2/contracts";
import type { PublicDepthLevel, PublicDepthSnapshot, PublicFundingSchedule, PublicInstrumentSnapshot, PublicTickerSnapshot, PublicTopBook } from "../publicTypes.js";
import { PublicVenuePluginError, type PublicVenueOperation } from "./types.js";

export function validatePublicOperationResult(operation: PublicVenueOperation, result: unknown, expected: { venue: string; marketType: VenueMarketType; instrumentId?: string; maxItems: number }): void {
  requireJsonSafe(result);
  if (operation === "instruments") validateInstruments(result as PublicInstrumentSnapshot, expected);
  else if (operation === "tickers") validateTickers(result as PublicTickerSnapshot, expected);
  else if (operation === "ticker") validateTopBook(result as PublicTopBook, expected);
  else if (operation === "depth") validateDepth(result as PublicDepthSnapshot, expected);
  else validateFunding(result as PublicFundingSchedule, expected);
}

function validateInstruments(value: PublicInstrumentSnapshot, expected: { venue: string; marketType: VenueMarketType; maxItems: number }) {
  validateEnvelope(value, expected.venue, expected.marketType);
  arrayWithin(value.instruments, "instruments", 1, expected.maxItems);
  validateRejectedRows(value.rejectedRows, expected.maxItems);
  const ids = new Set<string>();
  for (const instrument of value.instruments) {
    validateInstrument(instrument, expected.venue, expected.marketType);
    if (ids.has(instrument.id)) fail(`duplicate normalized instrument id ${instrument.id}`);
    ids.add(instrument.id);
  }
}

function validateTickers(value: PublicTickerSnapshot, expected: { venue: string; marketType: VenueMarketType; maxItems: number }) {
  validateEnvelope(value, expected.venue, expected.marketType);
  arrayWithin(value.tickers, "tickers", 1, expected.maxItems);
  validateRejectedRows(value.rejectedRows, expected.maxItems);
  const ids = new Set<string>();
  for (const ticker of value.tickers) {
    validateTopBook(ticker, expected);
    if (ids.has(ticker.instrumentId)) fail(`duplicate ticker instrumentId ${ticker.instrumentId}`);
    ids.add(ticker.instrumentId);
  }
}

function validateTopBook(value: PublicTopBook, expected: { venue: string; marketType: VenueMarketType; instrumentId?: string }) {
  object(value, "top book");
  equality(value.venue, expected.venue, "top book venue");
  equality(value.marketType, expected.marketType, "top book marketType");
  nonEmpty(value.instrumentId, "top book instrumentId", 160);
  if (expected.instrumentId) equality(value.instrumentId, expected.instrumentId, "top book instrumentId");
  quantityUnit(value.quantityUnit);
  positive(value.bid, "bid");
  positive(value.ask, "ask");
  positive(value.bidSize, "bidSize");
  positive(value.askSize, "askSize");
  if (value.bid > value.ask) fail("top book is crossed");
  optionalPositive(value.last, "last");
  optionalPositive(value.lastSize, "lastSize");
  optionalNonNegative(value.volume24h, "volume24h");
  optionalNonNegative(value.volumeCurrency24h, "volumeCurrency24h");
  timestamp(value.exchangeTs, "exchangeTs");
  timestamp(value.receivedAt, "receivedAt");
}

function validateDepth(value: PublicDepthSnapshot, expected: { venue: string; marketType: VenueMarketType; instrumentId?: string; maxItems: number }) {
  object(value, "depth");
  equality(value.venue, expected.venue, "depth venue");
  equality(value.marketType, expected.marketType, "depth marketType");
  if (value.complete !== true) fail("depth snapshot must be complete");
  nonEmpty(value.instrumentId, "depth instrumentId", 160);
  if (expected.instrumentId) equality(value.instrumentId, expected.instrumentId, "depth instrumentId");
  quantityUnit(value.quantityUnit);
  arrayWithin(value.bids, "bids", 1, expected.maxItems);
  arrayWithin(value.asks, "asks", 1, expected.maxItems);
  validateLevels(value.bids, "bids", "descending");
  validateLevels(value.asks, "asks", "ascending");
  if (value.bids[0]![0] > value.asks[0]![0]) fail("depth snapshot is crossed");
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 0) fail("depth sequence must be a non-negative safe integer");
  timestamp(value.exchangeTs, "exchangeTs");
  timestamp(value.receivedAt, "receivedAt");
}

function validateFunding(value: PublicFundingSchedule, expected: { venue: string; marketType: VenueMarketType; instrumentId?: string; maxItems: number }) {
  object(value, "funding");
  equality(expected.marketType, "perpetual", "funding marketType");
  equality(value.venue, expected.venue, "funding venue");
  nonEmpty(value.instrumentId, "funding instrumentId", 160);
  if (expected.instrumentId) equality(value.instrumentId, expected.instrumentId, "funding instrumentId");
  finite(value.currentEstimateRate, "currentEstimateRate");
  timestamp(value.fundingTime, "fundingTime");
  timestamp(value.nextFundingTime, "nextFundingTime");
  if (value.nextFundingTime < value.fundingTime) fail("nextFundingTime cannot precede fundingTime");
  if (value.intervalMinutes !== undefined) positive(value.intervalMinutes, "intervalMinutes");
  if (typeof value.scheduleVerified !== "boolean") fail("scheduleVerified must be boolean");
  optionalFinite(value.nextEstimateRate, "nextEstimateRate");
  optionalFinite(value.settledRate, "settledRate");
  optionalFinite(value.minimumRate, "minimumRate");
  optionalFinite(value.maximumRate, "maximumRate");
  timestamp(value.exchangeTs, "exchangeTs");
  timestamp(value.receivedAt, "receivedAt");
  arrayWithin(value.history, "funding history", 0, expected.maxItems);
  const times = new Set<number>();
  for (const point of value.history) {
    nonEmpty(point.instrumentId, "funding history instrumentId", 160);
    equality(point.instrumentId, value.instrumentId, "funding history instrumentId");
    timestamp(point.fundingTime, "funding history time");
    finite(point.fundingRate, "fundingRate");
    optionalFinite(point.realizedRate, "realizedRate");
    if (times.has(point.fundingTime)) fail(`duplicate funding history time ${point.fundingTime}`);
    times.add(point.fundingTime);
  }
  arrayWithin(value.sourceErrors, "sourceErrors", 0, 32);
  for (const error of value.sourceErrors) nonEmpty(error, "source error", 500);
}

function validateInstrument(instrument: RegistryInstrument, venue: string, marketType: VenueMarketType) {
  object(instrument, "instrument");
  equality(instrument.venue, venue, "instrument venue");
  equality(instrument.marketType, marketType, "instrument marketType");
  nonEmpty(instrument.id, "instrument id", 200);
  const stablePrefix = `${venue}:${marketType}:`;
  if (!instrument.id.startsWith(stablePrefix) || instrument.id.length === stablePrefix.length) fail(`instrument id must start with ${stablePrefix}`);
  for (const [label, value] of [
    ["assetId", instrument.assetId],
    ["venueSymbol", instrument.venueSymbol],
    ["baseAsset", instrument.baseAsset],
    ["quoteAsset", instrument.quoteAsset],
    ["settleAsset", instrument.settleAsset]
  ] as const)
    nonEmpty(value, label, 160);
  positive(instrument.contractMultiplier, "contractMultiplier");
  if (instrument.tickSize === 0) {
    if (!instrument.priceRules || instrument.priceRules.staticTickSize !== false) fail("zero tickSize requires dynamic priceRules");
  } else positive(instrument.tickSize, "tickSize");
  positive(instrument.quantityStep, "quantityStep");
  nonNegative(instrument.minimumQuantity, "minimumQuantity");
  nonNegative(instrument.minimumNotional, "minimumNotional");
  if (!["trading", "prelaunch", "settling", "closed"].includes(instrument.status)) fail("instrument status is invalid");
  if (instrument.quantityUnit !== undefined) quantityUnit(instrument.quantityUnit);
  optionalPositive(instrument.fundingIntervalMinutes, "fundingIntervalMinutes");
  optionalPositive(instrument.expiryTime, "expiryTime");
  optionalPositive(instrument.strikePrice, "strikePrice");
}

function validateEnvelope(value: { venue: string; marketType: VenueMarketType; receivedAt: number }, venue: string, marketType: VenueMarketType) {
  object(value, "snapshot");
  equality(value.venue, venue, "snapshot venue");
  equality(value.marketType, marketType, "snapshot marketType");
  timestamp(value.receivedAt, "receivedAt");
}

function validateRejectedRows(value: unknown, maximum: number) {
  arrayWithin(value, "rejectedRows", 0, maximum);
  for (const issue of value as Array<{ index: number; instrumentId?: string; message: string }>) {
    object(issue, "rejected row");
    if (!Number.isSafeInteger(issue.index) || issue.index < 0) fail("rejected row index must be a non-negative safe integer");
    if (issue.instrumentId !== undefined) nonEmpty(issue.instrumentId, "rejected instrumentId", 160);
    nonEmpty(issue.message, "rejected row message", 500);
  }
}

function validateLevels(levels: readonly PublicDepthLevel[], label: string, order: "ascending" | "descending") {
  let prior: number | undefined;
  for (const level of levels) {
    if (!Array.isArray(level) || level.length < 2 || level.length > 3) fail(`${label} level must contain price, quantity and optional order count`);
    positive(level[0], `${label} price`);
    positive(level[1], `${label} quantity`);
    if (level[2] !== undefined && (!Number.isSafeInteger(level[2]) || level[2] < 0)) fail(`${label} order count is invalid`);
    if (prior !== undefined && (order === "ascending" ? level[0] <= prior : level[0] >= prior)) fail(`${label} prices must be strictly ${order}`);
    prior = level[0];
  }
}

function requireJsonSafe(value: unknown) {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined || encoded.length > 4 * 1024 * 1024) fail("normalized result must be bounded JSON");
  } catch {
    fail("normalized result must be JSON-safe");
  }
  rejectCredentialKeys(value, new WeakSet<object>(), 0);
}

function rejectCredentialKeys(value: unknown, seen: WeakSet<object>, depth: number) {
  if (!value || typeof value !== "object") return;
  if (depth > 32) fail("normalized result nesting exceeds 32 levels");
  if (seen.has(value)) fail("normalized result must not contain cycles");
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key.replaceAll(/[-_ ]/g, "").toLowerCase();
    if (["apikey", "authorization", "credentials", "passphrase", "privatekey", "secret", "signature"].includes(normalizedKey)) {
      fail(`normalized result contains forbidden credential field ${key}`);
    }
    rejectCredentialKeys(child, seen, depth + 1);
  }
  seen.delete(value);
}

function object(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
}

function arrayWithin(value: unknown, label: string, minimum: number, maximum: number): asserts value is unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) fail(`${label} must contain ${minimum}-${maximum} items`);
}

function quantityUnit(value: unknown) {
  if (value !== "base" && value !== "quote" && value !== "contract") fail("quantityUnit is invalid");
}

function equality(actual: unknown, expected: unknown, label: string) {
  if (actual !== expected) fail(`${label} must equal ${String(expected)}`);
}

function nonEmpty(value: unknown, label: string, maximum: number): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) fail(`${label} must be a non-empty bounded string`);
}

function finite(value: number, label: string) {
  if (!Number.isFinite(value)) fail(`${label} must be finite`);
}

function positive(value: number, label: string) {
  if (!Number.isFinite(value) || value <= 0) fail(`${label} must be finite and positive`);
}

function nonNegative(value: number, label: string) {
  if (!Number.isFinite(value) || value < 0) fail(`${label} must be finite and non-negative`);
}

function optionalFinite(value: number | undefined, label: string) {
  if (value !== undefined) finite(value, label);
}

function optionalPositive(value: number | undefined, label: string) {
  if (value !== undefined) positive(value, label);
}

function optionalNonNegative(value: number | undefined, label: string) {
  if (value !== undefined) nonNegative(value, label);
}

function timestamp(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value <= 0) fail(`${label} must be a positive safe-integer timestamp`);
}

function fail(message: string): never {
  throw new PublicVenuePluginError(message);
}
