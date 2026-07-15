import { makeNLegEdge, nLegAssetUnitKey, nLegMarketProblem, normalizeNLegAssetUnit, normalizeNLegMarket } from "./identity.js";
import {
  N_LEG_MIN_LEGS,
  N_LEG_SAFE_MAX_CYCLES,
  N_LEG_SAFE_MAX_LEGS,
  N_LEG_SAFE_MAX_MARKETS,
  N_LEG_SAFE_MAX_TRAVERSAL_STEPS,
  type NLegConversionEdge,
  type NLegCycle,
  type NLegGraph,
  type NLegGraphOptions,
  type NLegGraphTruncationReason,
  type NLegMarketMetadata,
  type NLegMetadataRejection
} from "./types.js";

const DEFAULT_MAX_LEGS = 6;
const DEFAULT_MAX_CYCLES = 5_000;
const DEFAULT_MAX_TRAVERSAL_STEPS = 250_000;
const DEFAULT_MAX_MARKETS = 5_000;

/**
 * Build bounded simple directed cycles. A path may not revisit an accounting
 * node or instrument before closing, which rejects artificial self-netting and
 * keeps enumeration finite even for dense universes.
 */
export function buildNLegGraph(input: readonly NLegMarketMetadata[], options: NLegGraphOptions): NLegGraph {
  const limits = graphLimits(options, input.length);
  throwIfAborted(options.signal);
  const normalized = input.map(normalizeNLegMarket).sort((left, right) => left.instrumentId.localeCompare(right.instrumentId) || left.symbol.localeCompare(right.symbol));
  const duplicateIds = duplicates(normalized.map((market) => market.instrumentId));
  const markets = new Map<string, NLegMarketMetadata>();
  const metadataRejections: NLegMetadataRejection[] = [];

  for (const [index, market] of normalized.entries()) {
    const fallbackId = market.instrumentId || `invalid-instrument-${index}`;
    if (duplicateIds.has(market.instrumentId)) {
      metadataRejections.push({ instrumentId: fallbackId, code: "duplicate-instrument", message: "instrumentId must be globally unique" });
      continue;
    }
    const problem = nLegMarketProblem(market);
    if (problem) {
      metadataRejections.push({ instrumentId: fallbackId, ...problem });
      continue;
    }
    markets.set(market.instrumentId, market);
  }

  const adjacency = new Map<string, NLegConversionEdge[]>();
  for (const market of markets.values()) {
    addEdge(adjacency, makeNLegEdge(market, "buy"));
    addEdge(adjacency, makeNLegEdge(market, "sell"));
  }

  const startKeys = [...new Set(options.startAssets.map((value) => nLegAssetUnitKey(normalizeNLegAssetUnit(value))))].sort();
  const cycles: NLegCycle[] = [];
  const seen = new Set<string>();
  let traversalSteps = 0;
  let truncationReason: NLegGraphTruncationReason | undefined;

  const spendStep = (): boolean => {
    throwIfAborted(options.signal);
    if (traversalSteps >= limits.maxTraversalSteps) {
      truncationReason = "traversal-work-limit";
      return false;
    }
    traversalSteps += 1;
    return true;
  };

  const visit = (startKey: string, currentKey: string, path: NLegConversionEdge[], visitedNodes: Set<string>, usedInstruments: Set<string>): void => {
    if (truncationReason) return;
    for (const edge of adjacency.get(currentKey) ?? []) {
      if (!spendStep()) return;
      if (usedInstruments.has(edge.instrumentId)) continue;
      const nextLength = path.length + 1;
      if (edge.toKey === startKey) {
        if (nextLength < limits.minLegs || nextLength > limits.maxLegs) continue;
        const edges = [...path, edge];
        const canonicalSignature = canonicalDirectedCycleSignature(edges);
        if (seen.has(canonicalSignature)) continue;
        if (cycles.length >= limits.maxCycles) {
          truncationReason = "cycle-limit";
          return;
        }
        seen.add(canonicalSignature);
        cycles.push({
          cycleId: `n-leg:${canonicalSignature}`,
          canonicalSignature,
          venue: edge.venue,
          start: edges[0]!.from,
          startKey,
          edges
        });
        continue;
      }
      if (nextLength >= limits.maxLegs || visitedNodes.has(edge.toKey)) continue;
      visitedNodes.add(edge.toKey);
      usedInstruments.add(edge.instrumentId);
      path.push(edge);
      visit(startKey, edge.toKey, path, visitedNodes, usedInstruments);
      path.pop();
      usedInstruments.delete(edge.instrumentId);
      visitedNodes.delete(edge.toKey);
      if (truncationReason) return;
    }
  };

  for (const startKey of startKeys) {
    if (truncationReason) break;
    if (!adjacency.has(startKey)) continue;
    visit(startKey, startKey, [], new Set([startKey]), new Set());
  }

  cycles.sort((left, right) => left.cycleId.localeCompare(right.cycleId));
  const mutableIndex = new Map<string, NLegCycle[]>();
  for (const cycle of cycles) {
    for (const instrumentId of cycle.edges.map((edge) => edge.instrumentId)) {
      const indexed = mutableIndex.get(instrumentId) ?? [];
      indexed.push(cycle);
      mutableIndex.set(instrumentId, indexed);
    }
  }
  const cyclesByInstrument = new Map<string, readonly NLegCycle[]>();
  for (const [instrumentId, indexed] of mutableIndex) {
    cyclesByInstrument.set(
      instrumentId,
      indexed.sort((left, right) => left.cycleId.localeCompare(right.cycleId))
    );
  }

  return {
    markets,
    cycles,
    cyclesByInstrument,
    metadataRejections: metadataRejections.sort((left, right) => left.instrumentId.localeCompare(right.instrumentId) || left.message.localeCompare(right.message)),
    work: {
      marketCount: input.length,
      maxMarkets: limits.maxMarkets,
      traversalSteps,
      maxTraversalSteps: limits.maxTraversalSteps,
      maxCycles: limits.maxCycles,
      truncated: truncationReason !== undefined,
      ...(truncationReason ? { truncationReason } : {})
    }
  };
}

/** Rotation-invariant but direction-sensitive identity for a directed cycle. */
export function canonicalDirectedCycleSignature(edges: readonly NLegConversionEdge[]): string {
  if (edges.length === 0) throw new Error("A canonical cycle requires at least one edge");
  const ids = edges.map((edge) => edge.edgeId);
  let winner: string | undefined;
  for (let offset = 0; offset < ids.length; offset += 1) {
    const rotated = [...ids.slice(offset), ...ids.slice(0, offset)];
    const candidate = JSON.stringify(rotated);
    if (winner === undefined || candidate < winner) winner = candidate;
  }
  return winner as string;
}

function graphLimits(options: NLegGraphOptions, marketCount: number) {
  const minLegs = integer(options.minLegs ?? N_LEG_MIN_LEGS, "minLegs", N_LEG_MIN_LEGS, N_LEG_SAFE_MAX_LEGS);
  const maxLegs = integer(options.maxLegs ?? DEFAULT_MAX_LEGS, "maxLegs", N_LEG_MIN_LEGS, N_LEG_SAFE_MAX_LEGS);
  if (minLegs > maxLegs) throw new RangeError("minLegs cannot exceed maxLegs");
  const maxCycles = integer(options.maxCycles ?? DEFAULT_MAX_CYCLES, "maxCycles", 1, N_LEG_SAFE_MAX_CYCLES);
  const maxTraversalSteps = integer(options.maxTraversalSteps ?? DEFAULT_MAX_TRAVERSAL_STEPS, "maxTraversalSteps", 1, N_LEG_SAFE_MAX_TRAVERSAL_STEPS);
  const maxMarkets = integer(options.maxMarkets ?? DEFAULT_MAX_MARKETS, "maxMarkets", 1, N_LEG_SAFE_MAX_MARKETS);
  if (marketCount > maxMarkets) throw new RangeError(`Market universe contains ${marketCount} entries and exceeds maxMarkets=${maxMarkets}`);
  if (!Array.isArray(options.startAssets) || options.startAssets.length === 0) throw new RangeError("startAssets must contain at least one exact asset/unit identity");
  if (options.startAssets.length > maxMarkets) throw new RangeError(`startAssets exceeds the bounded maxMarkets=${maxMarkets} identity count`);
  return { minLegs, maxLegs, maxCycles, maxTraversalSteps, maxMarkets };
}

function addEdge(adjacency: Map<string, NLegConversionEdge[]>, edge: NLegConversionEdge) {
  const current = adjacency.get(edge.fromKey) ?? [];
  current.push(edge);
  current.sort((left, right) => left.edgeId.localeCompare(right.edgeId));
  adjacency.set(edge.fromKey, current);
}

function duplicates(values: readonly string[]) {
  const seen = new Set<string>();
  const duplicate = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicate.add(value);
    seen.add(value);
  }
  return duplicate;
}

function integer(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be a safe integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error("N-leg graph generation aborted");
  error.name = "AbortError";
  throw error;
}
