import { array, bool, exact, integer, record, text } from "./validation.js";

const VENUES = ["okx", "gate", "hyperliquid", "deribit", "kraken", "coinbase", "dydx", "kucoin", "mexc"] as const;
const MARKET_TYPES = ["spot", "perpetual", "future"] as const;
const FEED_STATES = ["connecting", "syncing", "live", "gap", "reconnecting", "stopped", "overloaded", "error"] as const;
const HEALTH_STATES = ["healthy", "degraded", "unhealthy"] as const;
const MAX_SOURCES = 128;

export type ContinuousFeedHealthState = "idle" | (typeof HEALTH_STATES)[number];
export type ContinuousFeedSourceState = (typeof FEED_STATES)[number];
export type ContinuousFeedSourceHealth = (typeof HEALTH_STATES)[number];

interface ContinuityBase {
  receivedAt: number;
  ageMs: number;
  fresh: boolean;
  connectionGeneration: number;
  generationMatches: boolean;
}

export type ContinuousFeedContinuity =
  | (ContinuityBase & {
      kind: "sequence-verified";
      protocol: "okx-seqid" | "gate-update-id" | "deribit-change-id" | "coinbase-advanced-sequence" | "kucoin-obu-range" | "mexc-spot-version" | "mexc-futures-version";
      verified: true;
      sequence: number;
    })
  | (ContinuityBase & { kind: "checksum-verified"; protocol: "kraken-spot-crc32"; verified: true; sequence: number; checksum: number })
  | (ContinuityBase & { kind: "sequence-observed"; protocol: "kraken-futures-seq" | "dydx-indexer-message-id"; verified: false; sequence: number })
  | (ContinuityBase & { kind: "atomic-snapshot"; protocol: "hyperliquid-block-snapshot"; verified: false });

export interface ContinuousFeedHealthSource {
  venue: (typeof VENUES)[number];
  instrumentId: string;
  marketType: (typeof MARKET_TYPES)[number];
  state: ContinuousFeedSourceState;
  health: ContinuousFeedSourceHealth;
  generation: number;
  reconnect: {
    scheduled: boolean;
    observedConnectionRestarts: number;
  };
  lastReceive?: {
    at: number;
    ageMs: number;
    kind: "book" | "top-book" | "funding";
    connectionGeneration: number;
    currentGeneration: boolean;
    fresh: boolean;
  };
  continuity?: ContinuousFeedContinuity;
  hasBook: boolean;
  hasTopBook: boolean;
  hasFunding: boolean;
  bookContinuityReady: boolean;
}

export interface ContinuousFeedHealthResponse {
  schemaVersion: 1;
  engine: "continuous-feed-health-v1";
  readOnly: true;
  dataScope: "public-market-data";
  credentialsRequired: false;
  secretsIncluded: false;
  executionStatus: "not-supported";
  executable: false;
  capturedAt: number;
  maxReceiveAgeMs: number;
  state: ContinuousFeedHealthState;
  counts: {
    streams: number;
    healthy: number;
    reconnecting: number;
    bookContinuityReady: number;
  };
  sources: ContinuousFeedHealthSource[];
}

/** Strict parser for the public, credential-free operator diagnostics endpoint. */
export function parseContinuousFeedHealthResponse(value: unknown): ContinuousFeedHealthResponse {
  const row = strictRecord(value, "continuous feed health", ["schemaVersion", "engine", "readOnly", "dataScope", "credentialsRequired", "secretsIncluded", "executionStatus", "executable", "capturedAt", "maxReceiveAgeMs", "state", "counts", "sources"]);
  if (row.schemaVersion !== 1 || row.engine !== "continuous-feed-health-v1" || row.readOnly !== true || row.dataScope !== "public-market-data" || row.credentialsRequired !== false || row.secretsIncluded !== false || row.executionStatus !== "not-supported" || row.executable !== false) {
    throw new Error("continuous feed health safety envelope is invalid");
  }
  const capturedAt = positiveInteger(row.capturedAt, "capturedAt");
  const maxReceiveAgeMs = integer(row.maxReceiveAgeMs, "maxReceiveAgeMs");
  if (maxReceiveAgeMs < 100 || maxReceiveAgeMs > 300_000) throw new Error("maxReceiveAgeMs is outside the supported boundary");
  const sources = array(row.sources, "sources", MAX_SOURCES).map((source, index) => parseSource(source, index, capturedAt, maxReceiveAgeMs));
  unique(
    sources.map(({ instrumentId }) => instrumentId),
    "source instrument IDs"
  );
  if (sources.some((source, index) => index > 0 && sources[index - 1]!.instrumentId.localeCompare(source.instrumentId) > 0)) throw new Error("continuous feed health sources must be sorted by instrumentId");
  const countsRow = strictRecord(row.counts, "counts", ["streams", "healthy", "reconnecting", "bookContinuityReady"]);
  const counts = {
    streams: boundedCount(countsRow.streams, "counts.streams"),
    healthy: boundedCount(countsRow.healthy, "counts.healthy"),
    reconnecting: boundedCount(countsRow.reconnecting, "counts.reconnecting"),
    bookContinuityReady: boundedCount(countsRow.bookContinuityReady, "counts.bookContinuityReady")
  };
  const expectedCounts = {
    streams: sources.length,
    healthy: sources.filter((source) => source.health === "healthy").length,
    reconnecting: sources.filter((source) => source.reconnect.scheduled).length,
    bookContinuityReady: sources.filter((source) => source.bookContinuityReady).length
  };
  if (JSON.stringify(counts) !== JSON.stringify(expectedCounts)) throw new Error("continuous feed health counts are inconsistent with sources");
  const state = exact(row.state, ["idle", "healthy", "degraded", "unhealthy"] as const, "state");
  const expectedState = aggregateState(sources);
  if (state !== expectedState) throw new Error("continuous feed health aggregate state is inconsistent with sources");
  return {
    schemaVersion: 1,
    engine: "continuous-feed-health-v1",
    readOnly: true,
    dataScope: "public-market-data",
    credentialsRequired: false,
    secretsIncluded: false,
    executionStatus: "not-supported",
    executable: false,
    capturedAt,
    maxReceiveAgeMs,
    state,
    counts,
    sources
  };
}

function parseSource(value: unknown, index: number, capturedAt: number, maxReceiveAgeMs: number): ContinuousFeedHealthSource {
  const label = `sources[${index}]`;
  const row = strictRecord(value, label, ["venue", "instrumentId", "marketType", "state", "health", "generation", "reconnect", "lastReceive", "continuity", "hasBook", "hasTopBook", "hasFunding", "bookContinuityReady"], ["lastReceive", "continuity"]);
  const venue = exact(row.venue, VENUES, `${label}.venue`);
  const instrumentId = identifier(row.instrumentId, `${label}.instrumentId`);
  const marketType = exact(row.marketType, MARKET_TYPES, `${label}.marketType`);
  const state = exact(row.state, FEED_STATES, `${label}.state`);
  const generation = integer(row.generation, `${label}.generation`);
  const reconnectRow = strictRecord(row.reconnect, `${label}.reconnect`, ["scheduled", "observedConnectionRestarts"]);
  const reconnect = {
    scheduled: bool(reconnectRow.scheduled, `${label}.reconnect.scheduled`),
    observedConnectionRestarts: integer(reconnectRow.observedConnectionRestarts, `${label}.reconnect.observedConnectionRestarts`)
  };
  if (reconnect.scheduled !== (state === "reconnecting") || reconnect.observedConnectionRestarts !== Math.max(0, generation - 1)) throw new Error(`${label}.reconnect is inconsistent with feed generation/state`);
  const lastReceive = row.lastReceive === undefined ? undefined : parseLastReceive(row.lastReceive, `${label}.lastReceive`, capturedAt, maxReceiveAgeMs, generation);
  const continuity = row.continuity === undefined ? undefined : parseContinuity(row.continuity, `${label}.continuity`, generation, capturedAt, maxReceiveAgeMs);
  const hasBook = bool(row.hasBook, `${label}.hasBook`);
  const hasTopBook = bool(row.hasTopBook, `${label}.hasTopBook`);
  const hasFunding = bool(row.hasFunding, `${label}.hasFunding`);
  if (hasBook && !continuity) throw new Error(`${label} current book lacks continuity evidence`);
  if ((hasBook || hasTopBook || hasFunding) && !lastReceive) throw new Error(`${label} evidence lacks last-receive provenance`);
  if (continuity && (!lastReceive || continuity.receivedAt > lastReceive.at)) throw new Error(`${label} continuity lacks ordered last-receive provenance`);
  const bookContinuityReady = bool(row.bookContinuityReady, `${label}.bookContinuityReady`);
  const expectedBookContinuityReady = Boolean(state === "live" && hasBook && continuity?.verified && continuity.generationMatches && continuity.fresh);
  if (bookContinuityReady !== expectedBookContinuityReady) throw new Error(`${label}.bookContinuityReady is inconsistent with current book freshness/continuity`);
  const health = exact(row.health, HEALTH_STATES, `${label}.health`);
  if (health !== sourceHealth(state, lastReceive?.fresh === true)) throw new Error(`${label}.health is inconsistent with feed state/freshness`);
  return {
    venue,
    instrumentId,
    marketType,
    state,
    health,
    generation,
    reconnect,
    ...(lastReceive ? { lastReceive } : {}),
    ...(continuity ? { continuity } : {}),
    hasBook,
    hasTopBook,
    hasFunding,
    bookContinuityReady
  };
}

function parseLastReceive(value: unknown, label: string, capturedAt: number, maxReceiveAgeMs: number, generation: number): NonNullable<ContinuousFeedHealthSource["lastReceive"]> {
  const row = strictRecord(value, label, ["at", "ageMs", "kind", "connectionGeneration", "currentGeneration", "fresh"]);
  const at = positiveInteger(row.at, `${label}.at`);
  if (at > capturedAt) throw new Error(`${label}.at cannot follow capturedAt`);
  const ageMs = integer(row.ageMs, `${label}.ageMs`);
  if (ageMs !== capturedAt - at) throw new Error(`${label}.ageMs is inconsistent with capturedAt`);
  const connectionGeneration = integer(row.connectionGeneration, `${label}.connectionGeneration`);
  const currentGeneration = bool(row.currentGeneration, `${label}.currentGeneration`);
  if (currentGeneration !== (connectionGeneration === generation)) throw new Error(`${label}.currentGeneration is inconsistent`);
  const fresh = bool(row.fresh, `${label}.fresh`);
  if (fresh !== (currentGeneration && ageMs <= maxReceiveAgeMs)) throw new Error(`${label}.fresh is inconsistent with age/generation`);
  return { at, ageMs, kind: exact(row.kind, ["book", "top-book", "funding"] as const, `${label}.kind`), connectionGeneration, currentGeneration, fresh };
}

function parseContinuity(value: unknown, label: string, generation: number, capturedAt: number, maxReceiveAgeMs: number): ContinuousFeedContinuity {
  const kind = exact(record(value, label).kind, ["sequence-verified", "checksum-verified", "sequence-observed", "atomic-snapshot"] as const, `${label}.kind`);
  const timingKeys = ["receivedAt", "ageMs", "fresh", "connectionGeneration", "generationMatches"];
  const required = kind === "checksum-verified" ? ["kind", "protocol", "verified", "sequence", "checksum", ...timingKeys] : kind === "atomic-snapshot" ? ["kind", "protocol", "verified", ...timingKeys] : ["kind", "protocol", "verified", "sequence", ...timingKeys];
  const row = strictRecord(value, label, required);
  const connectionGeneration = integer(row.connectionGeneration, `${label}.connectionGeneration`);
  const generationMatches = bool(row.generationMatches, `${label}.generationMatches`);
  if (generationMatches !== (connectionGeneration === generation)) throw new Error(`${label}.generationMatches is inconsistent`);
  const receivedAt = positiveInteger(row.receivedAt, `${label}.receivedAt`);
  if (receivedAt > capturedAt) throw new Error(`${label}.receivedAt cannot follow capturedAt`);
  const ageMs = integer(row.ageMs, `${label}.ageMs`);
  if (ageMs !== capturedAt - receivedAt) throw new Error(`${label}.ageMs is inconsistent with capturedAt`);
  const fresh = bool(row.fresh, `${label}.fresh`);
  if (fresh !== (generationMatches && ageMs <= maxReceiveAgeMs)) throw new Error(`${label}.fresh is inconsistent with age/generation`);
  const timing = { receivedAt, ageMs, fresh, connectionGeneration, generationMatches };
  if (kind === "sequence-verified") {
    if (row.verified !== true) throw new Error(`${label}.verified is invalid`);
    return {
      kind,
      protocol: exact(row.protocol, ["okx-seqid", "gate-update-id", "deribit-change-id", "coinbase-advanced-sequence", "kucoin-obu-range", "mexc-spot-version", "mexc-futures-version"] as const, `${label}.protocol`),
      verified: true,
      sequence: positiveInteger(row.sequence, `${label}.sequence`),
      ...timing
    };
  }
  if (kind === "checksum-verified") {
    if (row.verified !== true || row.protocol !== "kraken-spot-crc32") throw new Error(`${label} checksum proof is invalid`);
    const checksum = integer(row.checksum, `${label}.checksum`);
    if (checksum > 0xffffffff) throw new Error(`${label}.checksum must be uint32`);
    return { kind, protocol: "kraken-spot-crc32", verified: true, sequence: positiveInteger(row.sequence, `${label}.sequence`), checksum, ...timing };
  }
  if (kind === "sequence-observed") {
    if (row.verified !== false) throw new Error(`${label}.verified is invalid`);
    return {
      kind,
      protocol: exact(row.protocol, ["kraken-futures-seq", "dydx-indexer-message-id"] as const, `${label}.protocol`),
      verified: false,
      sequence: positiveInteger(row.sequence, `${label}.sequence`),
      ...timing
    };
  }
  if (row.verified !== false || row.protocol !== "hyperliquid-block-snapshot") throw new Error(`${label} atomic snapshot proof is invalid`);
  return { kind, protocol: "hyperliquid-block-snapshot", verified: false, ...timing };
}

function strictRecord(value: unknown, label: string, keys: readonly string[], optional: readonly string[] = []) {
  const row = record(value, label);
  const allowed = new Set(keys);
  const missing = keys.filter((key) => !optional.includes(key) && !(key in row));
  const unsupported = Object.keys(row).filter((key) => !allowed.has(key));
  if (missing.length > 0 || unsupported.length > 0) throw new Error(`${label} has missing or unsupported fields`);
  return row;
}

function identifier(value: unknown, label: string) {
  const result = text(value, label);
  if (result.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9:._/@-]*$/.test(result)) throw new Error(`${label} is invalid`);
  return result;
}

function positiveInteger(value: unknown, label: string) {
  const result = integer(value, label);
  if (result <= 0) throw new Error(`${label} must be positive`);
  return result;
}

function boundedCount(value: unknown, label: string) {
  const result = integer(value, label);
  if (result > MAX_SOURCES) throw new Error(`${label} exceeds the source boundary`);
  return result;
}

function sourceHealth(state: ContinuousFeedSourceState, fresh: boolean): ContinuousFeedSourceHealth {
  if (state === "live" && fresh) return "healthy";
  if (state === "connecting" || state === "syncing" || state === "reconnecting") return "degraded";
  return "unhealthy";
}

function aggregateState(sources: readonly ContinuousFeedHealthSource[]): ContinuousFeedHealthState {
  if (sources.length === 0) return "idle";
  if (sources.every((source) => source.health === "healthy")) return "healthy";
  if (sources.every((source) => source.health === "unhealthy")) return "unhealthy";
  return "degraded";
}

function unique(values: readonly string[], label: string) {
  if (new Set(values).size !== values.length) throw new Error(`${label} must be unique`);
}
