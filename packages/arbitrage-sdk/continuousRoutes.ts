import { parseContinuousMarketEconomics } from "./continuousMarketEconomics.js";
import type { ContinuousMarketEconomicsSummary, ContinuousMarketEvaluation } from "./continuousMarketEconomicsTypes.js";
import { array, bool, exact, finite, integer, optionalFinite, optionalText, positive, record, text } from "./validation.js";

export type * from "./continuousMarketEconomicsTypes.js";

const ROUTE_FAMILIES = ["cross-venue-spot-spot", "reverse-cash-and-carry", "perpetual-perpetual-funding", "spot-dated-future", "calendar-spread", "perpetual-future"] as const;
const MARKET_TYPES = ["spot", "perpetual", "future"] as const;
const FEED_STATES = ["connecting", "syncing", "live", "gap", "reconnecting", "stopped", "overloaded", "error"] as const;

export type ContinuousRouteRuntimeState = "disabled" | "starting" | "live" | "degraded" | "error";
export type ContinuousRouteFamily = (typeof ROUTE_FAMILIES)[number];

export interface ContinuousRouteRuntimeCoverage {
  complete: boolean;
  current: boolean;
  retainedPriorDiscovery: boolean;
  reason: "complete" | "configuration-disabled" | "configuration-invalid" | "refresh-pending" | "refresh-failed" | "partial-instruments";
}

export interface ContinuousRouteCandidate {
  routeKey: string;
  routeId: string;
  family: ContinuousRouteFamily;
  longInstrumentId: string;
  shortInstrumentId: string;
  longMarketType: (typeof MARKET_TYPES)[number];
  shortMarketType: (typeof MARKET_TYPES)[number];
  economicAssetId: string;
  edgeKind: "research-candidate";
  executable: false;
}

export interface ContinuousRouteTopBook {
  venue: string;
  instrumentId: string;
  marketType: (typeof MARKET_TYPES)[number];
  bid: number;
  bidSize: number;
  ask: number;
  askSize: number;
  exchangeTs: number;
  receivedAt: number;
  continuity: "sequence-verified" | "checksum-verified" | "sequence-observed" | "atomic-snapshot";
}

export interface ContinuousRouteFunding {
  venue: string;
  instrumentId: string;
  currentEstimateRate: number;
  nextEstimateRate?: number;
  nextFundingTime?: number;
  intervalMinutes?: number;
  scheduleVerified: boolean;
  exchangeTs?: number;
  exchangeTimestampVerified: boolean;
  receivedAt: number;
}

export interface ContinuousRouteSource {
  venue: string;
  instrumentId: string;
  marketType: (typeof MARKET_TYPES)[number];
  state: (typeof FEED_STATES)[number];
  message: string;
  generation: number;
  hasBook: boolean;
  hasTopBook: boolean;
  hasFunding: boolean;
}

export interface ContinuousRouteLiveResponse {
  schemaVersion: 1;
  engine: "continuous-route-runtime-v1";
  readOnly: true;
  executionStatus: "research-only";
  executable: false;
  configurationSource: "operator-environment";
  state: ContinuousRouteRuntimeState;
  /** Absent only on an older compatible server. New runtimes always publish this fail-closed coverage state. */
  coverage?: ContinuousRouteRuntimeCoverage;
  evaluatedAt: number;
  refreshedAt?: number;
  configuredInstrumentIds: string[];
  activeInstrumentIds: string[];
  unavailable: Array<{ instrumentId: string; reason: string }>;
  message?: string;
  discovery: {
    engine: "continuous-route-discovery-v1";
    capturedAt: number;
    totalCompatibleCandidates: number;
    truncated: boolean;
    candidates: ContinuousRouteCandidate[];
    marketEconomics?: ContinuousMarketEconomicsSummary;
    marketEvaluations?: ContinuousMarketEvaluation[];
    routeReadyBookCount: number;
    topBooks: ContinuousRouteTopBook[];
    fundingObservations: ContinuousRouteFunding[];
    excludedBooks: Array<{ instrumentId: string; reason: string }>;
    rejectedInstruments: Array<{ instrumentId?: string; code: string; message: string }>;
    sources: ContinuousRouteSource[];
  };
}

/**
 * Parses the read-only live discovery response and deliberately returns a bounded
 * observation view. Full depth remains server-side; the SDK exposes only health,
 * top books, funding and candidate identity and never exposes an execution path.
 */
export function parseContinuousRouteLiveResponse(value: unknown): ContinuousRouteLiveResponse {
  const row = record(value, "continuous route response");
  if (row.schemaVersion !== 1 || row.engine !== "continuous-route-runtime-v1" || row.readOnly !== true || row.executionStatus !== "research-only" || row.executable !== false || row.configurationSource !== "operator-environment") {
    throw new Error("continuous route response safety envelope is invalid");
  }
  const state = exact(row.state, ["disabled", "starting", "live", "degraded", "error"] as const, "state");
  const evaluatedAt = timestamp(row.evaluatedAt, "evaluatedAt");
  const refreshedAt = optionalTimestamp(row.refreshedAt, "refreshedAt");
  if (refreshedAt !== undefined && refreshedAt > evaluatedAt) throw new Error("refreshedAt cannot follow evaluatedAt");
  const coverage = row.coverage === undefined ? undefined : parseRuntimeCoverage(row.coverage, state, refreshedAt);
  const configuredInstrumentIds = identifiers(row.configuredInstrumentIds, "configuredInstrumentIds", 24);
  const activeInstrumentIds = identifiers(row.activeInstrumentIds, "activeInstrumentIds", 24);
  const configured = new Set(configuredInstrumentIds);
  if (activeInstrumentIds.some((id) => !configured.has(id))) throw new Error("active instrument is absent from the operator allowlist");
  const unavailable = array(row.unavailable, "unavailable", 48).map((item, index) => {
    const entry = record(item, `unavailable[${index}]`);
    const instrumentId = identifier(entry.instrumentId, `unavailable[${index}].instrumentId`);
    if (!configured.has(instrumentId)) throw new Error("unavailable instrument is absent from the operator allowlist");
    return { instrumentId, reason: boundedText(entry.reason, `unavailable[${index}].reason`, 500) };
  });
  const message = optionalBoundedText(row.message, "message", 500);
  const discovery = parseDiscovery(row.discovery, new Set(activeInstrumentIds));
  if (state === "disabled" && (configuredInstrumentIds.length > 0 || activeInstrumentIds.length > 0 || discovery.sources.length > 0)) throw new Error("disabled continuous route state contains active configuration");
  if (state === "live" && unavailable.length > 0) throw new Error("live continuous route state cannot contain unavailable instruments");
  return {
    schemaVersion: 1,
    engine: "continuous-route-runtime-v1",
    readOnly: true,
    executionStatus: "research-only",
    executable: false,
    configurationSource: "operator-environment",
    state,
    ...(coverage === undefined ? {} : { coverage }),
    evaluatedAt,
    ...(refreshedAt === undefined ? {} : { refreshedAt }),
    configuredInstrumentIds,
    activeInstrumentIds,
    unavailable,
    ...(message === undefined ? {} : { message }),
    discovery
  };
}

function parseRuntimeCoverage(value: unknown, state: ContinuousRouteRuntimeState, refreshedAt: number | undefined): ContinuousRouteRuntimeCoverage {
  const row = record(value, "coverage");
  const keys = ["complete", "current", "retainedPriorDiscovery", "reason"];
  if (Object.keys(row).some((key) => !keys.includes(key))) throw new Error("continuous route coverage contains unsupported fields");
  const coverage: ContinuousRouteRuntimeCoverage = {
    complete: bool(row.complete, "coverage.complete"),
    current: bool(row.current, "coverage.current"),
    retainedPriorDiscovery: bool(row.retainedPriorDiscovery, "coverage.retainedPriorDiscovery"),
    reason: exact(row.reason, ["complete", "configuration-disabled", "configuration-invalid", "refresh-pending", "refresh-failed", "partial-instruments"] as const, "coverage.reason")
  };
  const expected: ContinuousRouteRuntimeCoverage =
    state === "live"
      ? { complete: true, current: true, retainedPriorDiscovery: false, reason: "complete" }
      : state === "degraded"
        ? { complete: false, current: true, retainedPriorDiscovery: false, reason: "partial-instruments" }
        : state === "disabled"
          ? { complete: false, current: false, retainedPriorDiscovery: false, reason: "configuration-disabled" }
          : state === "starting"
            ? { complete: false, current: false, retainedPriorDiscovery: false, reason: "refresh-pending" }
            : coverage.reason === "configuration-invalid"
              ? { complete: false, current: false, retainedPriorDiscovery: false, reason: "configuration-invalid" }
            : { complete: false, current: false, retainedPriorDiscovery: coverage.retainedPriorDiscovery, reason: "refresh-failed" };
  if (JSON.stringify(coverage) !== JSON.stringify(expected) || (state === "error" && coverage.reason === "configuration-invalid" && refreshedAt !== undefined)) throw new Error("continuous route coverage is inconsistent with runtime state");
  if (coverage.complete && !coverage.current) throw new Error("complete continuous route coverage must be current");
  if (coverage.retainedPriorDiscovery && (coverage.current || refreshedAt === undefined)) throw new Error("retained continuous route discovery lacks stale-refresh provenance");
  return coverage;
}

function parseDiscovery(value: unknown, activeIds: ReadonlySet<string>): ContinuousRouteLiveResponse["discovery"] {
  const row = record(value, "discovery");
  if (row.engine !== "continuous-route-discovery-v1" || row.executionStatus !== "research-only" || row.executable !== false) throw new Error("continuous discovery safety envelope is invalid");
  const candidates = array(row.candidates, "discovery.candidates", 500).map(parseCandidate);
  unique(
    candidates.map(({ routeKey }) => routeKey),
    "candidate route keys"
  );
  unique(
    candidates.map(({ routeId }) => routeId),
    "candidate route IDs"
  );
  const instrumentRows = array(row.instruments, "discovery.instruments", 64);
  const instrumentIds = new Set(instrumentRows.map((item, index) => identifier(record(item, `discovery.instruments[${index}]`).instrumentId, `discovery.instruments[${index}].instrumentId`)));
  for (const candidate of candidates) {
    if (!instrumentIds.has(candidate.longInstrumentId) || !instrumentIds.has(candidate.shortInstrumentId)) throw new Error("candidate references an absent discovery instrument");
  }
  const readyBooks = array(row.routeReadyBooks, "discovery.routeReadyBooks", 64);
  for (const [index, item] of readyBooks.entries()) parseRouteReadyBook(item, `discovery.routeReadyBooks[${index}]`, activeIds);
  const topBooks = array(row.topBooks, "discovery.topBooks", 64).map((item, index) => parseTopBook(item, `discovery.topBooks[${index}]`, activeIds));
  const fundingObservations = array(row.fundingObservations, "discovery.fundingObservations", 64).map((item, index) => parseFunding(item, `discovery.fundingObservations[${index}]`, activeIds));
  const excludedBooks = parseProblems(row.excludedBooks, "discovery.excludedBooks", 128, false);
  const rejectedInstruments = parseProblems(row.rejectedInstruments, "discovery.rejectedInstruments", 256, true);
  const sources = array(row.sources, "discovery.sources", 64).map((item, index) => parseSource(item, `discovery.sources[${index}]`, activeIds));
  unique(
    sources.map(({ instrumentId }) => instrumentId),
    "continuous source instrument IDs"
  );
  const capturedAt = timestamp(row.capturedAt, "discovery.capturedAt");
  const totalCompatibleCandidates = integer(row.totalCompatibleCandidates, "discovery.totalCompatibleCandidates");
  const truncated = bool(row.truncated, "discovery.truncated");
  const hasMarketEconomics = row.marketEconomics !== undefined;
  const hasMarketEvaluations = row.marketEvaluations !== undefined;
  if (hasMarketEconomics !== hasMarketEvaluations) throw new Error("continuous market economics siblings must be present together");
  const market = hasMarketEconomics
    ? parseContinuousMarketEconomics(row.marketEconomics, row.marketEvaluations, {
        capturedAt,
        totalCompatibleCandidates,
        discoveryTruncated: truncated,
        candidates,
        instruments: row.instruments,
        topBooks: row.topBooks,
        sources: row.sources
      })
    : undefined;
  return {
    engine: "continuous-route-discovery-v1",
    capturedAt,
    totalCompatibleCandidates,
    truncated,
    candidates,
    ...(market ?? {}),
    routeReadyBookCount: readyBooks.length,
    topBooks,
    fundingObservations,
    excludedBooks,
    rejectedInstruments,
    sources
  };
}

function parseCandidate(value: unknown, index: number): ContinuousRouteCandidate {
  const row = record(value, `discovery.candidates[${index}]`);
  if (row.edgeKind !== "research-candidate" || row.executable !== false) throw new Error("continuous candidate safety envelope is invalid");
  const routeKey = identifier(row.routeKey, "candidate.routeKey");
  const routeId = identifier(row.routeId, "candidate.routeId");
  const family = exact(row.family, ROUTE_FAMILIES, "candidate.family");
  const longInstrumentId = identifier(row.longInstrumentId, "candidate.longInstrumentId");
  const shortInstrumentId = identifier(row.shortInstrumentId, "candidate.shortInstrumentId");
  let key: unknown;
  try {
    key = JSON.parse(routeKey);
  } catch {
    throw new Error("candidate.routeKey must be canonical JSON");
  }
  if (!Array.isArray(key) || key.length !== 3 || key[0] !== family || key[1] !== longInstrumentId || key[2] !== shortInstrumentId || JSON.stringify(key) !== routeKey) throw new Error("candidate.routeKey does not match its ordered route");
  if (!new RegExp(`^rf:${family}:[a-f0-9]{24}$`).test(routeId)) throw new Error("candidate.routeId is inconsistent with its family");
  return {
    routeKey,
    routeId,
    family,
    longInstrumentId,
    shortInstrumentId,
    longMarketType: exact(row.longMarketType, MARKET_TYPES, "candidate.longMarketType"),
    shortMarketType: exact(row.shortMarketType, MARKET_TYPES, "candidate.shortMarketType"),
    economicAssetId: identifier(row.economicAssetId, "candidate.economicAssetId"),
    edgeKind: "research-candidate",
    executable: false
  };
}

function parseTopBook(value: unknown, label: string, activeIds: ReadonlySet<string>): ContinuousRouteTopBook {
  const row = record(value, label);
  const instrumentId = activeIdentifier(row.instrumentId, `${label}.instrumentId`, activeIds);
  const bid = positive(row.bid, `${label}.bid`);
  const ask = positive(row.ask, `${label}.ask`);
  if (bid >= ask) throw new Error(`${label} must not be crossed`);
  return {
    venue: identifier(row.venue, `${label}.venue`),
    instrumentId,
    marketType: exact(row.marketType, MARKET_TYPES, `${label}.marketType`),
    bid,
    bidSize: positive(row.bidSize, `${label}.bidSize`),
    ask,
    askSize: positive(row.askSize, `${label}.askSize`),
    exchangeTs: timestamp(row.exchangeTs, `${label}.exchangeTs`),
    receivedAt: timestamp(row.receivedAt, `${label}.receivedAt`),
    continuity: continuity(row.continuity, `${label}.continuity`)
  };
}

function parseFunding(value: unknown, label: string, activeIds: ReadonlySet<string>): ContinuousRouteFunding {
  const row = record(value, label);
  const exchangeTs = optionalTimestamp(row.exchangeTs, `${label}.exchangeTs`);
  const exchangeTimestampVerified = bool(row.exchangeTimestampVerified, `${label}.exchangeTimestampVerified`);
  if ((exchangeTs !== undefined) !== exchangeTimestampVerified) throw new Error(`${label} exchange timestamp proof is inconsistent`);
  return {
    venue: identifier(row.venue, `${label}.venue`),
    instrumentId: activeIdentifier(row.instrumentId, `${label}.instrumentId`, activeIds),
    currentEstimateRate: finite(row.currentEstimateRate, `${label}.currentEstimateRate`),
    ...(optionalFinite(row.nextEstimateRate, `${label}.nextEstimateRate`) === undefined ? {} : { nextEstimateRate: optionalFinite(row.nextEstimateRate, `${label}.nextEstimateRate`) }),
    ...(optionalTimestamp(row.nextFundingTime, `${label}.nextFundingTime`) === undefined ? {} : { nextFundingTime: optionalTimestamp(row.nextFundingTime, `${label}.nextFundingTime`) }),
    ...(optionalFinite(row.intervalMinutes, `${label}.intervalMinutes`) === undefined ? {} : { intervalMinutes: optionalFinite(row.intervalMinutes, `${label}.intervalMinutes`) }),
    scheduleVerified: bool(row.scheduleVerified, `${label}.scheduleVerified`),
    ...(exchangeTs === undefined ? {} : { exchangeTs }),
    exchangeTimestampVerified,
    receivedAt: timestamp(row.receivedAt, `${label}.receivedAt`)
  };
}

function parseSource(value: unknown, label: string, activeIds: ReadonlySet<string>): ContinuousRouteSource {
  const row = record(value, label);
  const instrument = record(row.instrument, `${label}.instrument`);
  const status = record(row.status, `${label}.status`);
  const instrumentId = activeIdentifier(instrument.instrumentId, `${label}.instrument.instrumentId`, activeIds);
  if (status.instrumentId !== instrumentId || status.venue !== instrument.venue) throw new Error(`${label} status identity is inconsistent`);
  if (row.book !== undefined) validateRawBook(row.book, `${label}.book`, instrumentId);
  if (row.topBook !== undefined && record(row.topBook, `${label}.topBook`).instrumentId !== instrumentId) throw new Error(`${label}.topBook identity is inconsistent`);
  if (row.funding !== undefined && record(row.funding, `${label}.funding`).instrumentId !== instrumentId) throw new Error(`${label}.funding identity is inconsistent`);
  return {
    venue: identifier(instrument.venue, `${label}.instrument.venue`),
    instrumentId,
    marketType: exact(instrument.marketType, MARKET_TYPES, `${label}.instrument.marketType`),
    state: exact(status.state, FEED_STATES, `${label}.status.state`),
    message: boundedText(status.message, `${label}.status.message`, 500),
    generation: integer(status.generation, `${label}.status.generation`),
    hasBook: row.book !== undefined,
    hasTopBook: row.topBook !== undefined,
    hasFunding: row.funding !== undefined
  };
}

function parseRouteReadyBook(value: unknown, label: string, activeIds: ReadonlySet<string>) {
  const row = record(value, label);
  activeIdentifier(row.instrumentId, `${label}.instrumentId`, activeIds);
  if (row.complete !== true || row.source !== "websocket") throw new Error(`${label} lacks sequence-ready WebSocket provenance`);
  positive(row.sequence, `${label}.sequence`);
  validateLevels(row.bids, `${label}.bids`);
  validateLevels(row.asks, `${label}.asks`);
  timestamp(row.exchangeTs, `${label}.exchangeTs`);
  timestamp(row.receivedAt, `${label}.receivedAt`);
  identifier(row.sourceId, `${label}.sourceId`);
}

function validateRawBook(value: unknown, label: string, instrumentId: string) {
  const row = record(value, label);
  if (row.instrumentId !== instrumentId || row.complete !== true || row.source !== "public-websocket") throw new Error(`${label} provenance is inconsistent`);
  validateLevels(row.bids, `${label}.bids`);
  validateLevels(row.asks, `${label}.asks`);
  continuity(row.continuity, `${label}.continuity`);
}

function validateLevels(value: unknown, label: string) {
  for (const [index, item] of array(value, label, 500).entries()) {
    if (!Array.isArray(item) || item.length !== 2) throw new Error(`${label}[${index}] must be a price/quantity pair`);
    positive(item[0], `${label}[${index}].price`);
    positive(item[1], `${label}[${index}].quantity`);
  }
}

function continuity(value: unknown, label: string): ContinuousRouteTopBook["continuity"] {
  const row = record(value, label);
  const kind = exact(row.kind, ["sequence-verified", "checksum-verified", "sequence-observed", "atomic-snapshot"] as const, `${label}.kind`);
  if (kind === "sequence-verified") positive(row.sequence, `${label}.sequence`);
  else if (kind === "checksum-verified") {
    positive(row.sequence, `${label}.sequence`);
    const checksum = integer(row.checksum, `${label}.checksum`);
    if (checksum < 0 || checksum > 0xffffffff || row.protocol !== "kraken-spot-crc32") throw new Error(`${label} checksum proof is invalid`);
  } else if (kind === "sequence-observed") {
    positive(row.sequence, `${label}.sequence`);
    if (row.sequenceVerified !== false || (row.protocol !== "kraken-futures-seq" && row.protocol !== "dydx-indexer-message-id")) {
      throw new Error(`${label} observed sequence cannot claim route-ready proof`);
    }
  } else if (row.sequenceVerified !== false) throw new Error(`${label} atomic snapshot cannot claim sequence proof`);
  return kind;
}

function parseProblems(value: unknown, label: string, maximum: number, withCode: boolean) {
  return array(value, label, maximum).map((item, index) => {
    const row = record(item, `${label}[${index}]`);
    const instrumentId = optionalText(row.instrumentId, `${label}[${index}].instrumentId`);
    const message = boundedText(row.message ?? row.reason, `${label}[${index}].message`, 500);
    return withCode ? { ...(instrumentId ? { instrumentId } : {}), code: identifier(row.code, `${label}[${index}].code`), message } : { instrumentId: identifier(row.instrumentId, `${label}[${index}].instrumentId`), reason: message };
  }) as ContinuousRouteLiveResponse["discovery"]["rejectedInstruments"] & ContinuousRouteLiveResponse["discovery"]["excludedBooks"];
}

function identifiers(value: unknown, label: string, maximum: number) {
  const values = array(value, label, maximum).map((item, index) => identifier(item, `${label}[${index}]`));
  unique(values, label);
  return values;
}

function activeIdentifier(value: unknown, label: string, activeIds: ReadonlySet<string>) {
  const result = identifier(value, label);
  if (!activeIds.has(result)) throw new Error(`${label} is absent from active instruments`);
  return result;
}

function identifier(value: unknown, label: string) {
  const result = text(value, label);
  if (result.length > 300 || [...result].some((character) => character.charCodeAt(0) < 32)) throw new Error(`${label} is invalid`);
  return result;
}

function boundedText(value: unknown, label: string, maximum: number) {
  const result = text(value, label);
  if (result.length > maximum) throw new Error(`${label} is too long`);
  return result;
}

function optionalBoundedText(value: unknown, label: string, maximum: number) {
  return value === undefined ? undefined : boundedText(value, label, maximum);
}

function timestamp(value: unknown, label: string) {
  return positive(integer(value, label), label);
}

function optionalTimestamp(value: unknown, label: string) {
  return value === undefined ? undefined : timestamp(value, label);
}

function unique(values: readonly string[], label: string) {
  if (new Set(values).size !== values.length) throw new Error(`${label} must be unique`);
}
