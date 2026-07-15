import { makeNLegEdge, nLegAssetUnitKey, nLegMarketProblem, normalizeNLegMarket, sameNLegAssetUnit } from "./identity.js";
import { canonicalDirectedCycleSignature } from "./graph.js";
import {
  N_LEG_MIN_LEGS,
  N_LEG_SAFE_MAX_BOOK_LEVELS_PER_SIDE,
  N_LEG_SAFE_MAX_DEPTH_WALK_STEPS,
  N_LEG_SAFE_MAX_LEGS,
  type NLegBookSnapshot,
  type NLegCycle,
  type NLegEvaluationLimits,
  type NLegMarketMetadata,
  type NLegOpportunityTimestamps,
  type NLegRejection
} from "./types.js";

export interface ResolvedNLegEvaluationLimits {
  minNetReturnBps: number;
  maxQuoteAgeMs: number;
  maxLegSkewMs: number;
  maxFutureClockSkewMs: number;
  depthSearchIterations: number;
  maxBookLevelsPerSide: number;
  maxDepthWalkSteps: number;
}

const DEFAULTS: ResolvedNLegEvaluationLimits = {
  minNetReturnBps: 0,
  maxQuoteAgeMs: 2_000,
  maxLegSkewMs: 250,
  maxFutureClockSkewMs: 1_000,
  depthSearchIterations: 48,
  maxBookLevelsPerSide: 1_000,
  maxDepthWalkSteps: 200_000
};

export function resolveNLegEvaluationLimits(input: NLegEvaluationLimits = {}): ResolvedNLegEvaluationLimits {
  const minNetReturnBps = finite(input.minNetReturnBps ?? DEFAULTS.minNetReturnBps, "minNetReturnBps");
  const maxQuoteAgeMs = nonNegative(input.maxQuoteAgeMs ?? DEFAULTS.maxQuoteAgeMs, "maxQuoteAgeMs");
  const maxLegSkewMs = nonNegative(input.maxLegSkewMs ?? DEFAULTS.maxLegSkewMs, "maxLegSkewMs");
  const maxFutureClockSkewMs = nonNegative(input.maxFutureClockSkewMs ?? DEFAULTS.maxFutureClockSkewMs, "maxFutureClockSkewMs");
  const depthSearchIterations = integer(input.depthSearchIterations ?? DEFAULTS.depthSearchIterations, "depthSearchIterations", 1, 64);
  const maxBookLevelsPerSide = integer(input.maxBookLevelsPerSide ?? DEFAULTS.maxBookLevelsPerSide, "maxBookLevelsPerSide", 1, N_LEG_SAFE_MAX_BOOK_LEVELS_PER_SIDE);
  const maxDepthWalkSteps = integer(input.maxDepthWalkSteps ?? DEFAULTS.maxDepthWalkSteps, "maxDepthWalkSteps", 1, N_LEG_SAFE_MAX_DEPTH_WALK_STEPS);
  return { minNetReturnBps, maxQuoteAgeMs, maxLegSkewMs, maxFutureClockSkewMs, depthSearchIterations, maxBookLevelsPerSide, maxDepthWalkSteps };
}

export function validateNLegCycleStructure(cycle: NLegCycle, markets: ReadonlyMap<string, NLegMarketMetadata>): NLegRejection | undefined {
  if (cycle.edges.length < N_LEG_MIN_LEGS || cycle.edges.length > N_LEG_SAFE_MAX_LEGS) {
    return rejection(cycle, "identity-mismatch", `Cycle length must be between ${N_LEG_MIN_LEGS} and ${N_LEG_SAFE_MAX_LEGS}`);
  }
  if (cycle.startKey !== nLegAssetUnitKey(cycle.start)) return rejection(cycle, "identity-mismatch", "Cycle start key does not match its exact asset/unit identity");
  const usedInstruments = new Set<string>();
  const visitedNodes = new Set<string>([cycle.startKey]);
  let expectedFromKey = cycle.startKey;
  for (const [index, edge] of cycle.edges.entries()) {
    const rawMarket = markets.get(edge.instrumentId);
    if (!rawMarket) return rejection(cycle, "missing-market", "Cycle instrument metadata is missing", index, edge.instrumentId);
    const market = normalizeNLegMarket(rawMarket);
    const metadataProblem = nLegMarketProblem(market);
    if (metadataProblem) return rejection(cycle, metadataProblem.code === "fee-conservation" ? "fee-conservation" : "identity-mismatch", metadataProblem.message, index, edge.instrumentId);
    const expected = makeNLegEdge(market, edge.side);
    if (
      edge.edgeId !== expected.edgeId ||
      edge.venue !== expected.venue ||
      edge.symbol !== expected.symbol ||
      edge.fromKey !== expected.fromKey ||
      edge.toKey !== expected.toKey ||
      !sameNLegAssetUnit(edge.fee.asset, expected.fee.asset) ||
      edge.fee.scheduleId !== expected.fee.scheduleId ||
      edge.fee.tierId !== expected.fee.tierId ||
      edge.fee.takerBps !== expected.fee.takerBps ||
      edge.feeDebit !== expected.feeDebit ||
      edge.fromKey !== expectedFromKey
    ) {
      return rejection(cycle, "identity-mismatch", "Cycle edge does not exactly match normalized instrument, unit or fee metadata", index, edge.instrumentId);
    }
    if (usedInstruments.has(edge.instrumentId)) return rejection(cycle, "identity-mismatch", "A simple cycle cannot reuse an instrument", index, edge.instrumentId);
    usedInstruments.add(edge.instrumentId);
    const closing = index === cycle.edges.length - 1;
    if (closing) {
      if (edge.toKey !== cycle.startKey) return rejection(cycle, "identity-mismatch", "Final edge does not close into the exact start unit", index, edge.instrumentId);
    } else {
      if (visitedNodes.has(edge.toKey)) return rejection(cycle, "identity-mismatch", "A simple cycle cannot revisit an accounting node", index, edge.instrumentId);
      visitedNodes.add(edge.toKey);
    }
    expectedFromKey = edge.toKey;
  }
  const signature = canonicalDirectedCycleSignature(cycle.edges);
  if (cycle.canonicalSignature !== signature || cycle.cycleId !== `n-leg:${signature}`) {
    return rejection(cycle, "identity-mismatch", "Cycle canonical identity is inconsistent with its directed edges");
  }
  if (cycle.venue !== cycle.edges[0]!.venue || cycle.edges.some((edge) => edge.venue !== cycle.venue)) {
    return rejection(cycle, "identity-mismatch", "Cycle venue identity is inconsistent across its edges");
  }
  return undefined;
}

export function validateNLegBook(book: NLegBookSnapshot, market: NLegMarketMetadata, evaluatedAt: number, limits: ResolvedNLegEvaluationLimits): Omit<NLegRejection, "cycleId"> | undefined {
  if (book.instrumentId !== market.instrumentId || !sameNLegAssetUnit(book.base, market.base) || !sameNLegAssetUnit(book.quote, market.quote)) {
    return { code: "identity-mismatch", message: "Book instrument or exact base/quote unit identity does not match metadata", instrumentId: market.instrumentId };
  }
  if (!book.complete) return { code: "incomplete-book", message: "Book snapshot is explicitly incomplete", instrumentId: market.instrumentId };
  if (!book.sequenceVerified || !Number.isSafeInteger(book.sequence) || book.sequence <= 0) {
    return { code: "unsequenced-book", message: "A positive sequence-verified snapshot is required", instrumentId: market.instrumentId };
  }
  if (!book.exchangeTimestampVerified || !positive(book.exchangeTs) || !positive(book.receivedAt)) {
    return { code: "invalid-book", message: "Verified positive exchange and receive timestamps are required", instrumentId: market.instrumentId };
  }
  if (!String(book.sourceId ?? "").trim()) return { code: "invalid-book", message: "Book sourceId provenance is required", instrumentId: market.instrumentId };
  if (book.exchangeTs > evaluatedAt + limits.maxFutureClockSkewMs || book.receivedAt > evaluatedAt + limits.maxFutureClockSkewMs) {
    return { code: "invalid-book", message: "Book timestamp exceeds the future-clock safety boundary", instrumentId: market.instrumentId };
  }
  if (book.bids.length === 0 || book.asks.length === 0) return { code: "invalid-book", message: "Both depth sides are required", instrumentId: market.instrumentId };
  if (book.bids.length > limits.maxBookLevelsPerSide || book.asks.length > limits.maxBookLevelsPerSide) {
    return { code: "work-limit", message: `Book exceeds the ${limits.maxBookLevelsPerSide}-level per-side validation bound`, instrumentId: market.instrumentId };
  }
  if (levelsProblem(book.bids, "bids") || levelsProblem(book.asks, "asks")) {
    return { code: "invalid-book", message: "Depth levels must be finite, positive and strictly price-sorted", instrumentId: market.instrumentId };
  }
  if (book.bids[0]![0] >= book.asks[0]![0]) return { code: "invalid-book", message: "Book is crossed or locked", instrumentId: market.instrumentId };
  return undefined;
}

export function validateNLegCycleBooks(
  cycle: NLegCycle,
  markets: ReadonlyMap<string, NLegMarketMetadata>,
  books: ReadonlyMap<string, NLegBookSnapshot>,
  evaluatedAt: number,
  limits: ResolvedNLegEvaluationLimits
): { timestamps: NLegOpportunityTimestamps } | { rejection: NLegRejection } {
  const cycleBooks: NLegBookSnapshot[] = [];
  for (const [index, edge] of cycle.edges.entries()) {
    const market = markets.get(edge.instrumentId);
    if (!market) return { rejection: rejection(cycle, "missing-market", "Cycle instrument metadata is missing", index, edge.instrumentId) };
    const book = books.get(edge.instrumentId);
    if (!book) return { rejection: rejection(cycle, "missing-book", "A required sequence-verified book is missing", index, edge.instrumentId) };
    const problem = validateNLegBook(book, market, evaluatedAt, limits);
    if (problem) return { rejection: { cycleId: cycle.cycleId, legIndex: index, ...problem } };
    cycleBooks.push(book);
  }
  const exchangeTimes = cycleBooks.map((book) => book.exchangeTs);
  const receivedTimes = cycleBooks.map((book) => book.receivedAt);
  const oldestExchangeTs = Math.min(...exchangeTimes);
  const newestExchangeTs = Math.max(...exchangeTimes);
  const oldestReceivedAt = Math.min(...receivedTimes);
  const newestReceivedAt = Math.max(...receivedTimes);
  const quoteAgeMs = Math.max(0, evaluatedAt - oldestExchangeTs, evaluatedAt - oldestReceivedAt);
  const legSkewMs = Math.max(newestExchangeTs - oldestExchangeTs, newestReceivedAt - oldestReceivedAt);
  if (quoteAgeMs > limits.maxQuoteAgeMs) return { rejection: rejection(cycle, "stale-book", `Oldest leg is ${quoteAgeMs} ms old`) };
  if (legSkewMs > limits.maxLegSkewMs) return { rejection: rejection(cycle, "skewed-books", `Leg timestamp skew is ${legSkewMs} ms`) };
  return {
    timestamps: {
      evaluatedAt,
      oldestExchangeTs,
      newestExchangeTs,
      oldestReceivedAt,
      newestReceivedAt,
      quoteAgeMs,
      legSkewMs,
      sequenceVerified: true,
      exchangeTimestampsVerified: true
    }
  };
}

function levelsProblem(levels: readonly (readonly [number, number])[], side: "bids" | "asks"): boolean {
  let previous: number | undefined;
  for (const level of levels) {
    if (!Array.isArray(level) || level.length !== 2) return true;
    const [price, quantity] = level;
    if (!positive(price) || !positive(quantity)) return true;
    if (previous !== undefined && (side === "bids" ? price >= previous : price <= previous)) return true;
    previous = price;
  }
  return false;
}

function rejection(cycle: NLegCycle, code: NLegRejection["code"], message: string, legIndex?: number, instrumentId?: string): NLegRejection {
  return { cycleId: cycle.cycleId, code, message, ...(legIndex === undefined ? {} : { legIndex }), ...(instrumentId === undefined ? {} : { instrumentId }) };
}

function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function finite(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
  return value;
}

function nonNegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be a finite non-negative number`);
  return value;
}

function integer(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new RangeError(`${name} must be a safe integer between ${minimum} and ${maximum}`);
  return value;
}
