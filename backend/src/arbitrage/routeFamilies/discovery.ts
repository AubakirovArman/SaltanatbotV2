import { createHash } from "node:crypto";
import { validatePairwiseInstrument, type PairwiseInstrument, type PairwiseRejection } from "../engines/pairwise/index.js";
import { ROUTE_FAMILIES, type RouteFamily, type RouteFamilyCandidate, type RouteFamilyDiscoveryOptions, type RouteFamilyDiscoveryResult } from "./types.js";

const DEFAULT_MAX_CANDIDATES = 200;
const HARD_MAX_CANDIDATES = 500;
const HARD_MAX_INSTRUMENTS = 500;
/** Continuous discovery proves this bound before requesting a complete universe. */
const HARD_MAX_COMPLETE_UNIVERSE_INSTRUMENTS = 24;
const FAMILY_ORDER = new Map<RouteFamily, number>(ROUTE_FAMILIES.map((family, index) => [family, index]));

/** Enumerates only statically compatible ordered two-leg research candidates. */
export function discoverRouteFamilyCandidates(instruments: readonly PairwiseInstrument[], options: RouteFamilyDiscoveryOptions = {}): RouteFamilyDiscoveryResult {
  if (instruments.length > HARD_MAX_INSTRUMENTS) throw new Error(`Route-family discovery accepts at most ${HARD_MAX_INSTRUMENTS} instruments`);
  const enabled = normalizedFamilies(options.families);
  const maxCandidates = boundedInteger(options.maxCandidates, DEFAULT_MAX_CANDIDATES, HARD_MAX_CANDIDATES);
  const universe = enumerateCandidateUniverse(instruments, enabled);
  return {
    totalCompatibleCandidates: universe.candidates.length,
    truncated: universe.candidates.length > maxCandidates,
    candidates: universe.candidates.slice(0, maxCandidates),
    rejectedInstruments: universe.rejectedInstruments
  };
}

/**
 * Enumerates the complete compatible universe for the continuous public-feed bridge.
 *
 * The 24-instrument precondition is part of the work proof: an ordered two-leg
 * universe can contain at most 24 * 23 = 552 candidates. Unlike the public
 * route-family endpoint this function never silently truncates before market
 * economics can rank the rows.
 */
export function discoverCompleteRouteFamilyCandidateUniverse(instruments: readonly PairwiseInstrument[], options: Pick<RouteFamilyDiscoveryOptions, "families"> & { signal?: AbortSignal } = {}): RouteFamilyDiscoveryResult {
  if (instruments.length > HARD_MAX_COMPLETE_UNIVERSE_INSTRUMENTS) {
    throw new Error(`Complete route-family discovery accepts at most ${HARD_MAX_COMPLETE_UNIVERSE_INSTRUMENTS} instruments`);
  }
  const universe = enumerateCandidateUniverse(instruments, normalizedFamilies(options.families), options.signal);
  return {
    totalCompatibleCandidates: universe.candidates.length,
    truncated: false,
    candidates: universe.candidates,
    rejectedInstruments: universe.rejectedInstruments
  };
}

function enumerateCandidateUniverse(instruments: readonly PairwiseInstrument[], enabled: ReadonlySet<RouteFamily>, signal?: AbortSignal) {
  throwIfAborted(signal);
  const unique = new Map<string, PairwiseInstrument>();
  const rejectedInstruments: PairwiseRejection[] = [];
  for (const instrument of [...instruments].sort((left, right) => left.instrumentId.localeCompare(right.instrumentId))) {
    throwIfAborted(signal);
    if (unique.has(instrument.instrumentId)) throw new Error(`Duplicate route-family instrument ${instrument.instrumentId}`);
    const problem = validatePairwiseInstrument(instrument);
    if (problem) {
      rejectedInstruments.push({ instrumentId: instrument.instrumentId, code: "invalid-route", message: problem });
      continue;
    }
    unique.set(instrument.instrumentId, instrument);
  }

  const rows = [...unique.values()];
  const candidates: RouteFamilyCandidate[] = [];
  for (const long of rows) {
    throwIfAborted(signal);
    for (const short of rows) {
      if (long.instrumentId === short.instrumentId || !staticEconomicMatch(long, short)) continue;
      const family = classify(long, short);
      if (!family || !enabled.has(family)) continue;
      candidates.push(candidate(family, long, short));
    }
  }
  candidates.sort(candidateOrder);
  rejectedInstruments.sort((left, right) => (left.instrumentId ?? "").localeCompare(right.instrumentId ?? ""));
  throwIfAborted(signal);
  return { candidates, rejectedInstruments };
}

export function routeFamilyScopeKey(family: RouteFamily, longInstrumentId: string, shortInstrumentId: string): string {
  return JSON.stringify([family, longInstrumentId, shortInstrumentId]);
}

function candidate(family: RouteFamily, long: PairwiseInstrument, short: PairwiseInstrument): RouteFamilyCandidate {
  const routeKey = routeFamilyScopeKey(family, long.instrumentId, short.instrumentId);
  const digest = createHash("sha256").update(routeKey).digest("hex").slice(0, 24);
  return {
    routeKey,
    routeId: `rf:${family}:${digest}`,
    family,
    longInstrumentId: long.instrumentId,
    shortInstrumentId: short.instrumentId,
    longMarketType: long.marketType,
    shortMarketType: short.marketType,
    economicAssetId: long.economicAssetId,
    edgeKind: "research-candidate",
    executable: false
  };
}

function classify(long: PairwiseInstrument, short: PairwiseInstrument): RouteFamily | undefined {
  if (long.marketType === "spot" && short.marketType === "spot" && long.venue !== short.venue) return "cross-venue-spot-spot";
  if (long.marketType === "perpetual" && short.marketType === "spot") return "reverse-cash-and-carry";
  if (long.marketType === "perpetual" && short.marketType === "perpetual" && long.venue !== short.venue) return "perpetual-perpetual-funding";
  if (long.marketType === "spot" && short.marketType === "future") return "spot-dated-future";
  if (long.marketType === "future" && short.marketType === "future" && long.venue === short.venue && long.expiryTime !== short.expiryTime) return "calendar-spread";
  if ((long.marketType === "perpetual" && short.marketType === "future") || (long.marketType === "future" && short.marketType === "perpetual")) return "perpetual-future";
  return undefined;
}

function staticEconomicMatch(long: PairwiseInstrument, short: PairwiseInstrument) {
  if (long.economicAssetId !== short.economicAssetId || long.baseAsset !== short.baseAsset || long.quoteAsset !== short.quoteAsset) return false;
  if (long.settleAsset !== short.settleAsset || long.settleAsset !== long.quoteAsset) return false;
  return ![long, short].some((instrument) => instrument.quantityModel.unit === "contract" && instrument.quantityModel.multiplierAsset === "quote");
}

function normalizedFamilies(value: readonly RouteFamily[] | undefined) {
  const families = value ?? ROUTE_FAMILIES;
  const unique = new Set<RouteFamily>();
  for (const family of families) {
    if (!FAMILY_ORDER.has(family)) throw new Error(`Unknown route family ${String(family)}`);
    unique.add(family);
  }
  return unique;
}

function candidateOrder(left: RouteFamilyCandidate, right: RouteFamilyCandidate) {
  return (FAMILY_ORDER.get(left.family) ?? 999) - (FAMILY_ORDER.get(right.family) ?? 999) || left.longInstrumentId.localeCompare(right.longInstrumentId) || left.shortInstrumentId.localeCompare(right.shortInstrumentId);
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Route-family candidate limit must be a positive integer");
  return Math.min(value, maximum);
}

function throwIfAborted(signal: AbortSignal | undefined) {
  if (!signal?.aborted) return;
  if (signal.reason !== undefined) throw signal.reason;
  const error = new Error("Route-family discovery aborted");
  error.name = "AbortError";
  throw error;
}
