import { MARKET_OPPORTUNITY_SCHEMA_VERSION, type MarketOpportunityBlockStage, type MarketOpportunityEnvelope, type MarketOpportunityFamily, type MarketOpportunityLeg } from "@saltanatbotv2/arbitrage-sdk";
import { assertAutomationOpportunityBoundary } from "./marketOpportunityAdapters";
import { MARKET_OPPORTUNITY_HANDOFF_EVENT } from "./marketOpportunityHandoffEvent";

export { MARKET_OPPORTUNITY_HANDOFF_EVENT } from "./marketOpportunityHandoffEvent";

export const MARKET_OPPORTUNITY_HANDOFF_STORAGE_KEY = "sbv2:automation:market-opportunity-v1";
export const MARKET_OPPORTUNITY_HANDOFF_DEFAULT_TTL_MS = 15 * 60_000;
export const MARKET_OPPORTUNITY_HANDOFF_MAX_TTL_MS = 60 * 60_000;
export const MARKET_OPPORTUNITY_HANDOFF_MAX_BYTES = 48 * 1024;

const HANDOFF_TRANSPORT_VERSION = 1 as const;
const MAX_CLOCK_SKEW_MS = 5_000;
const MAX_LEGS = 16;
const MAX_BLOCKERS = 64;
const MAX_IDS = 64;

export interface MarketOpportunityHandoffRecord {
  transportVersion: typeof HANDOFF_TRANSPORT_VERSION;
  destination: "automation";
  storedAt: number;
  expiresAt: number;
  opportunity: MarketOpportunityEnvelope;
}

export type MarketOpportunityHandoffEvent = CustomEvent<MarketOpportunityHandoffRecord>;

interface HandoffOptions {
  storage?: Storage;
  eventTarget?: EventTarget;
  now?: number;
  ttlMs?: number;
}

interface ReadOptions {
  storage?: Storage;
  now?: number;
}

export function handoffMarketOpportunity(opportunity: MarketOpportunityEnvelope, options: HandoffOptions = {}): MarketOpportunityHandoffRecord {
  const storage = resolveStorage(options.storage);
  try {
    const safe = assertAutomationOpportunityBoundary(opportunity);
    const now = positiveSafeInteger(options.now ?? Date.now(), "now");
    const ttlMs = positiveSafeInteger(options.ttlMs ?? MARKET_OPPORTUNITY_HANDOFF_DEFAULT_TTL_MS, "ttlMs");
    if (ttlMs > MARKET_OPPORTUNITY_HANDOFF_MAX_TTL_MS) throw new Error("Opportunity handoff TTL exceeds the one-hour limit");
    const expiresAt = now + ttlMs;
    if (!Number.isSafeInteger(expiresAt)) throw new Error("Opportunity handoff expiry is outside the safe integer range");

    const record: MarketOpportunityHandoffRecord = {
      transportVersion: HANDOFF_TRANSPORT_VERSION,
      destination: "automation",
      storedAt: now,
      expiresAt,
      opportunity: safe
    };
    const serialized = JSON.stringify(record);
    if (exceedsSerializedLimit(serialized)) throw new Error("Opportunity handoff exceeds the storage size limit");

    storage.setItem(MARKET_OPPORTUNITY_HANDOFF_STORAGE_KEY, serialized);
    dispatchHandoff(record, options.eventTarget);
    return record;
  } catch (error) {
    clearMarketOpportunityHandoff(storage);
    throw error;
  }
}

export function readMarketOpportunityHandoff(options: ReadOptions = {}): MarketOpportunityHandoffRecord | null {
  let storage: Storage;
  try {
    storage = resolveStorage(options.storage);
  } catch {
    return null;
  }
  let serialized: string | null;
  try {
    serialized = storage.getItem(MARKET_OPPORTUNITY_HANDOFF_STORAGE_KEY);
  } catch {
    return null;
  }
  if (serialized === null) return null;
  if (exceedsSerializedLimit(serialized)) return removeInvalid(storage);

  try {
    const parsed = parseHandoffRecord(JSON.parse(serialized));
    const now = positiveSafeInteger(options.now ?? Date.now(), "now");
    if (parsed.storedAt > now + MAX_CLOCK_SKEW_MS || parsed.expiresAt <= now) return removeInvalid(storage);
    return parsed;
  } catch {
    return removeInvalid(storage);
  }
}

export function consumeMarketOpportunityHandoff(options: ReadOptions = {}): MarketOpportunityHandoffRecord | null {
  const record = readMarketOpportunityHandoff(options);
  if (record) clearMarketOpportunityHandoff(options.storage);
  return record;
}

export function clearMarketOpportunityHandoff(storage?: Storage): void {
  try {
    resolveStorage(storage).removeItem(MARKET_OPPORTUNITY_HANDOFF_STORAGE_KEY);
  } catch {
    // A denied storage cleanup must not turn into an execution fallback.
  }
}

function parseHandoffRecord(value: unknown): MarketOpportunityHandoffRecord {
  const row = object(value, "handoff");
  if (row.transportVersion !== HANDOFF_TRANSPORT_VERSION) throw new Error("Unsupported opportunity handoff transport version");
  if (row.destination !== "automation") throw new Error("Unsupported opportunity handoff destination");
  const storedAt = positiveSafeInteger(row.storedAt, "storedAt");
  const expiresAt = positiveSafeInteger(row.expiresAt, "expiresAt");
  if (expiresAt <= storedAt || expiresAt - storedAt > MARKET_OPPORTUNITY_HANDOFF_MAX_TTL_MS) throw new Error("Opportunity handoff expiry is invalid");
  const opportunity = parseMarketOpportunityEnvelope(row.opportunity);
  return { transportVersion: HANDOFF_TRANSPORT_VERSION, destination: "automation", storedAt, expiresAt, opportunity };
}

function parseMarketOpportunityEnvelope(value: unknown): MarketOpportunityEnvelope {
  const envelope = object(value, "opportunity");
  if (envelope.schemaVersion !== MARKET_OPPORTUNITY_SCHEMA_VERSION) throw new Error("Unsupported market opportunity schema");
  boundedText(envelope.id, "opportunity.id", 512);
  oneOf(envelope.family, MARKET_FAMILIES, "opportunity.family");
  oneOf(envelope.kind, ["spread", "cycle", "microstructure"] as const, "opportunity.kind");

  const source = object(envelope.source, "opportunity.source");
  boundedText(source.engine, "opportunity.source.engine", 128);
  boundedText(source.opportunityId, "opportunity.source.opportunityId", 512);
  positiveSafeInteger(source.evaluatedAt, "opportunity.source.evaluatedAt");

  const legs = boundedArray(envelope.legs, "opportunity.legs", 2, MAX_LEGS);
  for (const [index, rawLeg] of legs.entries()) parseLeg(rawLeg, index);

  const economics = object(envelope.economics, "opportunity.economics");
  oneOf(economics.outcome, ["projected", "research-simulation", "two-sided-quote"] as const, "opportunity.economics.outcome");
  optionalFinite(economics.grossEdgeBps, "opportunity.economics.grossEdgeBps");
  optionalFinite(economics.netEdgeBps, "opportunity.economics.netEdgeBps");
  optionalMoney(economics.expectedNetProfit, "opportunity.economics.expectedNetProfit");
  oneOf(economics.costCoverage, ["unknown", "aggregate-estimate", "entry-public-fees-only", "visible-depth-and-declared-fees"] as const, "opportunity.economics.costCoverage");
  optionalFinite(economics.aggregateEstimatedCostBps, "opportunity.economics.aggregateEstimatedCostBps");
  optionalMoney(economics.entryFees, "opportunity.economics.entryFees");
  oneOf(economics.funding, ["included", "excluded", "unknown"] as const, "opportunity.economics.funding");
  oneOf(economics.borrow, ["included", "excluded", "unknown"] as const, "opportunity.economics.borrow");
  oneOf(economics.slippage, ["visible-depth", "estimate", "excluded", "unknown"] as const, "opportunity.economics.slippage");
  if (economics.twoSidedQuote !== undefined) {
    const quote = object(economics.twoSidedQuote, "opportunity.economics.twoSidedQuote");
    optionalFinite(quote.bidPrice, "opportunity.economics.twoSidedQuote.bidPrice");
    optionalFinite(quote.askPrice, "opportunity.economics.twoSidedQuote.askPrice");
    optionalPositive(quote.absoluteWidth, "opportunity.economics.twoSidedQuote.absoluteWidth");
    boundedText(quote.priceUnit, "opportunity.economics.twoSidedQuote.priceUnit", 64);
  }
  if (economics.basisScenario !== undefined) parseBasisScenario(economics.basisScenario);

  const capacity = object(envelope.capacity, "opportunity.capacity");
  optionalPositive(capacity.quantity, "opportunity.capacity.quantity");
  if (capacity.quantityUnit !== undefined) oneOf(capacity.quantityUnit, QUANTITY_UNITS, "opportunity.capacity.quantityUnit");
  if (capacity.quantityAsset !== undefined) boundedText(capacity.quantityAsset, "opportunity.capacity.quantityAsset", 64);
  optionalMoney(capacity.notional, "opportunity.capacity.notional");
  if (capacity.depthLimited !== undefined && typeof capacity.depthLimited !== "boolean") throw new Error("opportunity.capacity.depthLimited must be boolean");

  const evidence = object(envelope.evidence, "opportunity.evidence");
  positiveSafeInteger(evidence.evaluatedAt, "opportunity.evidence.evaluatedAt");
  nonNegativeFinite(evidence.quoteAgeMs, "opportunity.evidence.quoteAgeMs");
  nonNegativeFinite(evidence.legSkewMs, "opportunity.evidence.legSkewMs");
  oneOf(evidence.sequenceContinuity, ["verified", "unverified"] as const, "opportunity.evidence.sequenceContinuity");
  oneOf(evidence.exchangeTimestamps, ["verified", "unverified"] as const, "opportunity.evidence.exchangeTimestamps");
  oneOf(evidence.dataQuality, ["fresh", "stale", "skewed", "unverified"] as const, "opportunity.evidence.dataQuality");
  stringArray(evidence.sourceIds, "opportunity.evidence.sourceIds", MAX_IDS);
  stringArray(evidence.provenanceIds, "opportunity.evidence.provenanceIds", MAX_IDS);

  const execution = object(envelope.execution, "opportunity.execution");
  if (execution.research !== "available") throw new Error("opportunity.execution.research is unsupported");
  oneOf(execution.paperPlan, ["ready", "blocked", "unsupported"] as const, "opportunity.execution.paperPlan");
  if (execution.live !== "blocked") throw new Error("opportunity.execution.live must remain blocked");
  oneOf(execution.atomicity, ["none", "venue-native"] as const, "opportunity.execution.atomicity");
  stringArray(execution.paperBlockers, "opportunity.execution.paperBlockers", MAX_BLOCKERS, 2_000);
  stringArray(execution.liveBlockers, "opportunity.execution.liveBlockers", MAX_BLOCKERS, 2_000);

  const blockers = boundedArray(envelope.blockers, "opportunity.blockers", 0, MAX_BLOCKERS);
  for (const [index, rawBlocker] of blockers.entries()) {
    const blocker = object(rawBlocker, `opportunity.blockers[${index}]`);
    boundedText(blocker.code, `opportunity.blockers[${index}].code`, 128);
    oneOf(blocker.stage, BLOCK_STAGES, `opportunity.blockers[${index}].stage`);
    boundedText(blocker.message, `opportunity.blockers[${index}].message`, 2_000);
    if (blocker.subject !== undefined) boundedText(blocker.subject, `opportunity.blockers[${index}].subject`, 512);
  }

  return assertAutomationOpportunityBoundary(envelope as unknown as MarketOpportunityEnvelope);
}

function parseLeg(value: unknown, index: number): void {
  const leg = object(value, `opportunity.legs[${index}]`);
  boundedText(leg.id, `opportunity.legs[${index}].id`, 512);
  boundedText(leg.venue, `opportunity.legs[${index}].venue`, 128);
  boundedText(leg.instrumentId, `opportunity.legs[${index}].instrumentId`, 512);
  boundedText(leg.symbol, `opportunity.legs[${index}].symbol`, 128);
  oneOf(leg.marketType, ["spot", "perpetual", "future", "native-spread"] as const, `opportunity.legs[${index}].marketType`);
  oneOf(leg.side, ["buy", "sell", "derived"] as const, `opportunity.legs[${index}].side`);
  oneOf(leg.role, ["long", "short", "cycle", "component"] as const, `opportunity.legs[${index}].role`);
  oneOf(leg.identityScope, ["canonical-instrument", "venue-native-symbol"] as const, `opportunity.legs[${index}].identityScope`);
  optionalPositive(leg.quantity, `opportunity.legs[${index}].quantity`);
  oneOf(leg.quantityUnit, QUANTITY_UNITS, `opportunity.legs[${index}].quantityUnit`);
  if (leg.quantityAsset !== undefined) boundedText(leg.quantityAsset, `opportunity.legs[${index}].quantityAsset`, 64);
  optionalPositive(leg.referencePrice, `opportunity.legs[${index}].referencePrice`);
  optionalPositive(leg.visibleCapacity, `opportunity.legs[${index}].visibleCapacity`);
  if (leg.evidenceId !== undefined) boundedText(leg.evidenceId, `opportunity.legs[${index}].evidenceId`, 512);
}

function parseBasisScenario(value: unknown): void {
  const scenario = object(value, "opportunity.economics.basisScenario");
  if (scenario.model !== "browser-basis-cost-v1") throw new Error("opportunity.economics.basisScenario.model is unsupported");
  positiveSafeInteger(scenario.computedAt, "opportunity.economics.basisScenario.computedAt");
  optionalPositive(scenario.requestedNotionalUsd, "opportunity.economics.basisScenario.requestedNotionalUsd");
  nonNegativeFinite(scenario.executableNotionalUsd, "opportunity.economics.basisScenario.executableNotionalUsd");
  const assumptions = object(scenario.assumptions, "opportunity.economics.basisScenario.assumptions");
  for (const key of ["spotTakerBps", "perpetualTakerBps", "roundTripSlippageReserveBps", "expectedHoldingHours", "annualBorrowRatePct", "transferCostUsd"] as const) {
    nonNegativeFinite(assumptions[key], `opportunity.economics.basisScenario.assumptions.${key}`);
  }
  const costs = object(scenario.costBreakdownBps, "opportunity.economics.basisScenario.costBreakdownBps");
  for (const key of ["tradingFees", "slippage", "borrow", "transfer", "funding", "total"] as const) {
    optionalFinite(costs[key], `opportunity.economics.basisScenario.costBreakdownBps.${key}`);
  }
  nonNegativeSafeInteger(costs.fundingSettlementCount, "opportunity.economics.basisScenario.costBreakdownBps.fundingSettlementCount");
  if (typeof costs.fundingScheduleVerified !== "boolean") throw new Error("opportunity.economics.basisScenario.costBreakdownBps.fundingScheduleVerified must be boolean");
}

function dispatchHandoff(record: MarketOpportunityHandoffRecord, target?: EventTarget): void {
  const destination = target ?? (typeof window === "undefined" ? undefined : window);
  if (!destination) return;
  const Constructor = typeof CustomEvent === "function" ? CustomEvent : typeof window !== "undefined" ? window.CustomEvent : undefined;
  if (!Constructor) return;
  destination.dispatchEvent(new Constructor<MarketOpportunityHandoffRecord>(MARKET_OPPORTUNITY_HANDOFF_EVENT, { detail: record }));
}

function resolveStorage(storage?: Storage): Storage {
  if (storage) return storage;
  if (typeof window !== "undefined") return window.sessionStorage;
  throw new Error("Session storage is unavailable for the opportunity handoff");
}

function removeInvalid(storage: Storage): null {
  clearMarketOpportunityHandoff(storage);
  return null;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function boundedArray(value: unknown, label: string, minimum: number, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) throw new Error(`${label} must contain ${minimum}–${maximum} entries`);
  return value;
}

function stringArray(value: unknown, label: string, maximum: number, maxLength = 512): void {
  for (const [index, entry] of boundedArray(value, label, 0, maximum).entries()) boundedText(entry, `${label}[${index}]`, maxLength);
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) throw new Error(`${label} must be a bounded non-empty string`);
  return value;
}

function positiveSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer`);
  return value;
}

function nonNegativeSafeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer`);
  return value;
}

function nonNegativeFinite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${label} must be non-negative and finite`);
  return value;
}

function optionalFinite(value: unknown, label: string): void {
  if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) throw new Error(`${label} must be finite`);
}

function optionalPositive(value: unknown, label: string): void {
  if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value <= 0)) throw new Error(`${label} must be positive and finite`);
}

function optionalMoney(value: unknown, label: string): void {
  if (value === undefined) return;
  const money = object(value, label);
  if (typeof money.value !== "number" || !Number.isFinite(money.value)) throw new Error(`${label}.value must be finite`);
  boundedText(money.currency, `${label}.currency`, 32);
}

function oneOf<const T extends readonly unknown[]>(value: unknown, allowed: T, label: string): T[number] {
  if (!allowed.includes(value)) throw new Error(`${label} is unsupported`);
  return value as T[number];
}

function serializedBytes(value: string): number {
  return typeof TextEncoder === "function" ? new TextEncoder().encode(value).byteLength : value.length * 2;
}

function exceedsSerializedLimit(value: string): boolean {
  return value.length > MARKET_OPPORTUNITY_HANDOFF_MAX_BYTES || serializedBytes(value) > MARKET_OPPORTUNITY_HANDOFF_MAX_BYTES;
}

const MARKET_FAMILIES = ["cash-and-carry", "reverse-cash-and-carry", "spot-spot", "perpetual-perpetual", "spot-dated-future", "perpetual-future", "calendar-spread", "dated-futures-spread", "venue-native-spread", "n-leg-cycle", "order-book-signal"] as const satisfies readonly MarketOpportunityFamily[];
const BLOCK_STAGES = ["market-data", "economics", "strategy-evidence", "paper-execution", "live-execution"] as const satisfies readonly MarketOpportunityBlockStage[];
const QUANTITY_UNITS = ["base", "quote", "contract", "native"] as const satisfies readonly MarketOpportunityLeg["quantityUnit"][];
