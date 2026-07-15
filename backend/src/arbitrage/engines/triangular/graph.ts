import type { TriangularConversionEdge, TriangularCycle, TriangularMarketMetadata, TriangularMetadataRejection } from "./types.js";

export interface TriangularGraph {
  markets: ReadonlyMap<string, TriangularMarketMetadata>;
  cycles: readonly TriangularCycle[];
  cyclesByMarket: ReadonlyMap<string, readonly TriangularCycle[]>;
  metadataRejections: readonly TriangularMetadataRejection[];
}

/** Build the conversion topology once; live updates only revisit indexed cycles. */
export function buildTriangularGraph(input: readonly TriangularMarketMetadata[], startAssets: ReadonlySet<string>): TriangularGraph {
  const metadataRejections: TriangularMetadataRejection[] = [];
  const normalizedInput = input.map(normalizeMetadata);
  const duplicateIds = duplicates(normalizedInput.map((market) => market.marketId));
  const markets = new Map<string, TriangularMarketMetadata>();

  for (const [index, normalized] of normalizedInput.entries()) {
    const problem = metadataProblem(normalized, duplicateIds);
    if (problem) {
      metadataRejections.push({ marketId: normalized.marketId || `invalid-market-${index}`, message: problem });
      continue;
    }
    markets.set(normalized.marketId, normalized);
  }

  const adjacency = new Map<string, TriangularConversionEdge[]>();
  for (const market of markets.values()) {
    addEdge(adjacency, edge(market, "sell"));
    addEdge(adjacency, edge(market, "buy"));
  }

  const cycles: TriangularCycle[] = [];
  const seen = new Set<string>();
  for (const startAsset of [...startAssets].map(asset).sort()) {
    for (const first of adjacency.get(startAsset) ?? []) {
      if (first.toAsset === startAsset) continue;
      for (const second of adjacency.get(first.toAsset) ?? []) {
        if (second.toAsset === startAsset || second.toAsset === first.fromAsset) continue;
        if (second.venue !== first.venue || second.marketId === first.marketId) continue;
        for (const third of adjacency.get(second.toAsset) ?? []) {
          if (third.toAsset !== startAsset || third.venue !== first.venue) continue;
          if (third.marketId === first.marketId || third.marketId === second.marketId) continue;
          const edgeIds = [first.edgeId, second.edgeId, third.edgeId] as const;
          const cycleId = `${first.venue}:${startAsset}:${edgeIds.join(">")}`;
          if (seen.has(cycleId)) continue;
          seen.add(cycleId);
          cycles.push({ cycleId, venue: first.venue, startAsset, edges: [first, second, third] });
        }
      }
    }
  }
  cycles.sort((left, right) => left.cycleId.localeCompare(right.cycleId));

  const mutableIndex = new Map<string, TriangularCycle[]>();
  for (const cycle of cycles) {
    for (const marketId of new Set(cycle.edges.map((candidate) => candidate.marketId))) {
      const indexed = mutableIndex.get(marketId) ?? [];
      indexed.push(cycle);
      mutableIndex.set(marketId, indexed);
    }
  }
  const cyclesByMarket = new Map<string, readonly TriangularCycle[]>();
  for (const [marketId, indexed] of mutableIndex) {
    cyclesByMarket.set(
      marketId,
      indexed.sort((left, right) => left.cycleId.localeCompare(right.cycleId))
    );
  }
  return { markets, cycles, cyclesByMarket, metadataRejections };
}

/**
 * Cooperative equivalent used by the public scanner. Large metadata universes
 * periodically return control to Node so disconnect/abort events can be seen
 * before the remaining topology and cycle work is performed.
 */
export async function buildTriangularGraphCooperative(
  input: readonly TriangularMarketMetadata[],
  startAssets: ReadonlySet<string>,
  signal?: AbortSignal,
  yieldEvery = 256
): Promise<TriangularGraph> {
  if (!Number.isSafeInteger(yieldEvery) || yieldEvery < 1) throw new Error("yieldEvery must be a positive safe integer");
  const checkpoint = cooperativeCheckpoint(signal, yieldEvery);
  const metadataRejections: TriangularMetadataRejection[] = [];
  const normalizedInput: TriangularMarketMetadata[] = [];
  for (const candidate of input) {
    normalizedInput.push(normalizeMetadata(candidate));
    if (checkpoint.due()) await checkpoint.pause();
  }
  const duplicateIds = duplicates(normalizedInput.map((market) => market.marketId));
  const markets = new Map<string, TriangularMarketMetadata>();

  for (const [index, normalized] of normalizedInput.entries()) {
    const problem = metadataProblem(normalized, duplicateIds);
    if (problem) metadataRejections.push({ marketId: normalized.marketId || `invalid-market-${index}`, message: problem });
    else markets.set(normalized.marketId, normalized);
    if (checkpoint.due()) await checkpoint.pause();
  }

  const adjacency = new Map<string, TriangularConversionEdge[]>();
  for (const market of markets.values()) {
    addEdge(adjacency, edge(market, "sell"));
    addEdge(adjacency, edge(market, "buy"));
    if (checkpoint.due()) await checkpoint.pause();
  }

  const cycles: TriangularCycle[] = [];
  const seen = new Set<string>();
  for (const startAsset of [...startAssets].map(asset).sort()) {
    for (const first of adjacency.get(startAsset) ?? []) {
      if (first.toAsset === startAsset) continue;
      for (const second of adjacency.get(first.toAsset) ?? []) {
        if (second.toAsset === startAsset || second.toAsset === first.fromAsset) continue;
        if (second.venue !== first.venue || second.marketId === first.marketId) continue;
        for (const third of adjacency.get(second.toAsset) ?? []) {
          if (third.toAsset === startAsset && third.venue === first.venue && third.marketId !== first.marketId && third.marketId !== second.marketId) {
            const edgeIds = [first.edgeId, second.edgeId, third.edgeId] as const;
            const cycleId = `${first.venue}:${startAsset}:${edgeIds.join(">")}`;
            if (!seen.has(cycleId)) {
              seen.add(cycleId);
              cycles.push({ cycleId, venue: first.venue, startAsset, edges: [first, second, third] });
            }
          }
          if (checkpoint.due()) await checkpoint.pause();
        }
      }
    }
  }
  cycles.sort((left, right) => left.cycleId.localeCompare(right.cycleId));
  if (checkpoint.due(true)) await checkpoint.pause();

  const mutableIndex = new Map<string, TriangularCycle[]>();
  for (const cycle of cycles) {
    for (const marketId of new Set(cycle.edges.map((candidate) => candidate.marketId))) {
      const indexed = mutableIndex.get(marketId) ?? [];
      indexed.push(cycle);
      mutableIndex.set(marketId, indexed);
    }
    if (checkpoint.due()) await checkpoint.pause();
  }
  const cyclesByMarket = new Map<string, readonly TriangularCycle[]>();
  for (const [marketId, indexed] of mutableIndex) {
    cyclesByMarket.set(
      marketId,
      indexed.sort((left, right) => left.cycleId.localeCompare(right.cycleId))
    );
    if (checkpoint.due()) await checkpoint.pause();
  }
  checkpoint.throwIfAborted();
  return { markets, cycles, cyclesByMarket, metadataRejections };
}

function cooperativeCheckpoint(signal: AbortSignal | undefined, interval: number) {
  let steps = 0;
  const throwIfAborted = () => {
    if (signal?.aborted) throw signal.reason ?? abortError();
  };
  return {
    due(force = false) {
      throwIfAborted();
      steps += 1;
      return force || steps >= interval;
    },
    async pause() {
      steps = 0;
      await new Promise<void>((resolve) => setImmediate(resolve));
      throwIfAborted();
    },
    throwIfAborted
  };
}

function abortError() {
  const error = new Error("Triangular graph build aborted");
  error.name = "AbortError";
  return error;
}

function edge(market: TriangularMarketMetadata, side: "buy" | "sell"): TriangularConversionEdge {
  const fromAsset = side === "sell" ? market.baseAsset : market.quoteAsset;
  const toAsset = side === "sell" ? market.quoteAsset : market.baseAsset;
  return {
    edgeId: `${market.marketId}:${side}:${fromAsset}->${toAsset}`,
    marketId: market.marketId,
    venue: market.venue,
    symbol: market.symbol,
    fromAsset,
    toAsset,
    side
  };
}

function addEdge(index: Map<string, TriangularConversionEdge[]>, candidate: TriangularConversionEdge) {
  const current = index.get(candidate.fromAsset) ?? [];
  current.push(candidate);
  current.sort((left, right) => left.edgeId.localeCompare(right.edgeId));
  index.set(candidate.fromAsset, current);
}

function normalizeMetadata(input: TriangularMarketMetadata): TriangularMarketMetadata {
  return {
    ...input,
    marketId: String(input.marketId ?? "").trim(),
    venue: String(input.venue ?? "")
      .trim()
      .toLowerCase(),
    symbol: String(input.symbol ?? "")
      .trim()
      .toUpperCase(),
    baseAsset: asset(input.baseAsset),
    quoteAsset: asset(input.quoteAsset)
  };
}

function metadataProblem(market: TriangularMarketMetadata, duplicateIds: Set<string>): string | undefined {
  if (!market.marketId || duplicateIds.has(market.marketId)) return "marketId must be non-empty and globally unique";
  if (!market.venue || !market.symbol || !market.baseAsset || !market.quoteAsset) return "venue, symbol, baseAsset and quoteAsset are required";
  if (market.baseAsset === market.quoteAsset) return "baseAsset and quoteAsset must differ";
  if (!positive(market.quantityStep)) return "quantityStep must be a finite positive number";
  if (!positive(market.minimumQuantity)) return "minimumQuantity must be a finite positive number";
  if (!positive(market.minimumNotional)) return "minimumNotional must be a finite positive number";
  if (!Number.isFinite(market.takerFeeBps) || market.takerFeeBps < 0 || market.takerFeeBps >= 10_000) {
    return "takerFeeBps must be finite and between 0 (inclusive) and 10000 (exclusive)";
  }
  return undefined;
}

function duplicates(values: string[]) {
  const seen = new Set<string>();
  const duplicateIds = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicateIds.add(value);
    seen.add(value);
  }
  return duplicateIds;
}

function asset(value: unknown) {
  return String(value ?? "")
    .trim()
    .toUpperCase();
}

function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
