import { buildTriangularGraph, type TriangularGraph } from "./graph.js";
import { evaluateTriangularCycle } from "./simulation.js";
import type { TriangularBookUpdate, TriangularCycle, TriangularEngineOptions, TriangularMarketMetadata, TriangularOpportunity, TriangularUpdateResult } from "./types.js";

const DEFAULT_MAX_QUOTE_AGE_MS = 2_000;
const DEFAULT_MAX_LEG_SKEW_MS = 250;
const DEFAULT_MAX_FUTURE_CLOCK_SKEW_MS = 1_000;
const DEFAULT_DEPTH_SEARCH_ITERATIONS = 56;

/**
 * Incremental, transport-free triangular scanner. The market topology is
 * immutable; one book update recalculates only cycles indexed by that market.
 */
export class TriangularArbitrageEngine {
  readonly graph;
  private readonly books = new Map<string, TriangularBookUpdate>();
  private readonly active = new Map<string, TriangularOpportunity>();
  private readonly startQuantities: Readonly<Record<string, number>>;
  private readonly minNetReturnBps: number;
  private readonly maxQuoteAgeMs: number;
  private readonly maxLegSkewMs: number;
  private readonly maxFutureClockSkewMs: number;
  private readonly depthSearchIterations: number;
  private readonly marketDataMode: "sequence-verified-depth" | "rest-top-book-candidate";
  private readonly now: () => number;

  constructor(markets: readonly TriangularMarketMetadata[], options: TriangularEngineOptions, preparedGraph?: TriangularGraph) {
    this.startQuantities = normalizeStartQuantities(options.startQuantities);
    this.minNetReturnBps = finiteOr(options.minNetReturnBps, 0);
    this.maxQuoteAgeMs = positiveOr(options.maxQuoteAgeMs, DEFAULT_MAX_QUOTE_AGE_MS);
    this.maxLegSkewMs = positiveOr(options.maxLegSkewMs, DEFAULT_MAX_LEG_SKEW_MS);
    this.maxFutureClockSkewMs = positiveOr(options.maxFutureClockSkewMs, DEFAULT_MAX_FUTURE_CLOCK_SKEW_MS);
    this.depthSearchIterations = Math.max(8, Math.min(80, Math.floor(positiveOr(options.depthSearchIterations, DEFAULT_DEPTH_SEARCH_ITERATIONS))));
    this.marketDataMode = options.marketDataMode ?? "sequence-verified-depth";
    this.now = options.now ?? Date.now;
    this.graph = preparedGraph ?? buildTriangularGraph(markets, new Set(Object.keys(this.startQuantities)));
  }

  get cycles(): readonly TriangularCycle[] {
    return this.graph.cycles;
  }

  affectedCycles(marketId: string): readonly TriangularCycle[] {
    return this.graph.cyclesByMarket.get(marketId) ?? [];
  }

  updateBook(update: TriangularBookUpdate): TriangularUpdateResult {
    const marketId = String(update.marketId ?? "").trim();
    if (!this.graph.markets.has(marketId)) {
      return {
        marketId,
        evaluatedCycleIds: [],
        upserted: [],
        removedOpportunityIds: [],
        rejections: [{ code: "unknown-market", marketId, message: "Market is absent from the validated triangular graph" }]
      };
    }

    const stored = cloneBook({ ...update, marketId });
    this.books.set(marketId, stored);
    const cycles = this.graph.cyclesByMarket.get(marketId) ?? [];
    const evaluatedAt = this.now();
    const upserted: TriangularOpportunity[] = [];
    const removedOpportunityIds: string[] = [];
    const rejections: TriangularUpdateResult["rejections"] = [];

    for (const cycle of cycles) {
      const result = evaluateTriangularCycle(cycle, this.graph.markets, this.books, {
        requestedStartQuantity: this.startQuantities[cycle.startAsset] ?? 0,
        minNetReturnBps: this.minNetReturnBps,
        maxQuoteAgeMs: this.maxQuoteAgeMs,
        maxLegSkewMs: this.maxLegSkewMs,
        maxFutureClockSkewMs: this.maxFutureClockSkewMs,
        evaluatedAt,
        depthSearchIterations: this.depthSearchIterations,
        marketDataMode: this.marketDataMode
      });
      const opportunityId = `triangular:${cycle.cycleId}`;
      if (result.opportunity) {
        this.active.set(opportunityId, result.opportunity);
        upserted.push(result.opportunity);
      } else {
        rejections.push(result.rejection);
        if (this.active.delete(opportunityId)) removedOpportunityIds.push(opportunityId);
      }
    }

    upserted.sort(opportunityOrder);
    removedOpportunityIds.sort();
    return {
      marketId,
      evaluatedCycleIds: cycles.map((cycle) => cycle.cycleId),
      upserted,
      removedOpportunityIds,
      rejections
    };
  }

  /** Returns only opportunities whose oldest source timestamp is still fresh. */
  opportunities(): TriangularOpportunity[] {
    const now = this.now();
    return [...this.active.values()]
      .filter((opportunity) => {
        const timestamps = opportunity.timestamps;
        return Math.max(timestamps.oldestExchangeTs === undefined ? 0 : now - timestamps.oldestExchangeTs, now - timestamps.oldestReceivedAt) <= this.maxQuoteAgeMs;
      })
      .sort(opportunityOrder);
  }
}

function normalizeStartQuantities(input: Readonly<Record<string, number>>) {
  const output: Record<string, number> = {};
  for (const [rawAsset, quantity] of Object.entries(input)) {
    const asset = rawAsset.trim().toUpperCase();
    if (asset && Number.isFinite(quantity) && quantity > 0) output[asset] = quantity;
  }
  return output;
}

function cloneBook(book: TriangularBookUpdate): TriangularBookUpdate {
  return {
    ...book,
    bids: book.bids.map(([price, quantity]) => [price, quantity] as const),
    asks: book.asks.map(([price, quantity]) => [price, quantity] as const)
  };
}

function opportunityOrder(left: TriangularOpportunity, right: TriangularOpportunity) {
  return right.netReturnBps - left.netReturnBps || right.startQuantity - left.startQuantity || left.id.localeCompare(right.id);
}

function finiteOr(value: number | undefined, fallback: number) {
  return value !== undefined && Number.isFinite(value) ? value : fallback;
}

function positiveOr(value: number | undefined, fallback: number) {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}
