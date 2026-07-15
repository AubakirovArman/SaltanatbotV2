import type { TriangularBookUpdate, TriangularConversionEdge, TriangularCycle, TriangularDepthLevel, TriangularLegExecution, TriangularMarketMetadata, TriangularOpportunity, TriangularRejection, TriangularRiskFlag } from "./types.js";

const RETURN_EPSILON_BPS = 1e-7;

export interface TriangularEvaluationOptions {
  requestedStartQuantity: number;
  minNetReturnBps: number;
  maxQuoteAgeMs: number;
  maxLegSkewMs: number;
  maxFutureClockSkewMs: number;
  evaluatedAt: number;
  depthSearchIterations: number;
  marketDataMode: "sequence-verified-depth" | "rest-top-book-candidate";
}

export type TriangularEvaluationResult = { opportunity: TriangularOpportunity; rejection?: never } | { opportunity?: never; rejection: TriangularRejection };

/**
 * Pure executable simulation for one prebuilt cycle. It does not fetch data or
 * mutate caches and therefore works with recorded books in tests and replay.
 */
export function evaluateTriangularCycle(cycle: TriangularCycle, markets: ReadonlyMap<string, TriangularMarketMetadata>, books: ReadonlyMap<string, TriangularBookUpdate>, options: TriangularEvaluationOptions): TriangularEvaluationResult {
  const quality = validateCycleData(cycle, books, options);
  if ("rejection" in quality) return quality;

  const requested = simulate(cycle, markets, books, options.requestedStartQuantity);
  let execution: SuccessfulSimulation;
  let limitingLegIndex: 0 | 1 | 2 | undefined;
  let limitingMarketId: string | undefined;
  let depthLimited = false;

  if ("legs" in requested) {
    execution = requested;
  } else {
    if (requested.code !== "insufficient-depth") return { rejection: simulationRejection(cycle, requested) };
    depthLimited = true;
    limitingLegIndex = requested.legIndex;
    limitingMarketId = requested.marketId;
    const bounded = searchDepthCapacity(cycle, markets, books, options);
    if (!bounded) return { rejection: simulationRejection(cycle, requested) };
    execution = bounded;
  }

  const startQuantity = execution.startQuantity;
  const endQuantity = execution.endQuantity;
  // Strip each output fee while preserving the actually walked prices and all
  // lot-rounding dust. This avoids a second optimistic depth walk for gross PnL.
  const grossEndQuantity = execution.legs.reduce((quantity, leg) => quantity * (leg.grossOutputQuantity / leg.inputQuantity), startQuantity);
  const grossReturnBps = returnBps(startQuantity, grossEndQuantity);
  const netReturnBps = returnBps(startQuantity, endQuantity);
  if (!(netReturnBps > options.minNetReturnBps + RETURN_EPSILON_BPS)) {
    return {
      rejection: {
        cycleId: cycle.cycleId,
        code: "non-profitable",
        message: `Net return ${netReturnBps.toFixed(8)} bps does not exceed ${options.minNetReturnBps.toFixed(8)} bps`
      }
    };
  }

  const dustByAsset: Record<string, number> = {};
  for (const leg of execution.legs) {
    if (leg.inputDustQuantity <= tolerance(leg.inputQuantity)) continue;
    dustByAsset[leg.fromAsset] = (dustByAsset[leg.fromAsset] ?? 0) + leg.inputDustQuantity;
  }
  const riskFlags: TriangularRiskFlag[] = ["sequential-leg-risk", "output-fee-assumption"];
  if (options.marketDataMode === "rest-top-book-candidate") riskFlags.push("top-book-only", "rest-snapshot", "unsequenced", "non-executable-candidate");
  if (!quality.timestamps.exchangeTimestampsVerified) riskFlags.push("unverified-exchange-time");
  if (Object.keys(dustByAsset).length > 0) riskFlags.push("rounding-dust");
  if (depthLimited) riskFlags.push("depth-limited");
  if (execution.legs.some((leg) => leg.quoteNotional <= (markets.get(leg.marketId)?.minimumNotional ?? 0) * 1.25)) {
    riskFlags.push("near-minimum-notional");
  }

  const executableStartQuantity = startQuantity;
  return {
    opportunity: {
      id: `triangular:${cycle.cycleId}`,
      strategyKind: "triangular",
      edgeKind: options.marketDataMode === "rest-top-book-candidate" ? "non-executable-candidate" : "executable-sequential",
      executionStatus: options.marketDataMode === "rest-top-book-candidate" ? "non-executable-candidate" : "executable",
      marketDataMode: options.marketDataMode === "rest-top-book-candidate" ? "rest-top-book" : "sequence-verified-depth",
      sequenceVerified: options.marketDataMode === "sequence-verified-depth",
      venue: cycle.venue,
      cycleId: cycle.cycleId,
      startAsset: cycle.startAsset,
      endAsset: cycle.startAsset,
      requestedStartQuantity: options.requestedStartQuantity,
      startQuantity,
      grossEndQuantity,
      endQuantity,
      grossReturnBps,
      netReturnBps,
      limitingCapacity: {
        requestedStartQuantity: options.requestedStartQuantity,
        executableStartQuantity,
        utilizationPct: options.requestedStartQuantity > 0 ? (executableStartQuantity / options.requestedStartQuantity) * 100 : 0,
        limitingLegIndex,
        limitingMarketId
      },
      legs: execution.legs,
      dustByAsset,
      timestamps: quality.timestamps,
      riskFlags
    }
  };
}

export function validateBookUpdate(book: TriangularBookUpdate, now: number, maxFutureClockSkewMs: number, marketDataMode: TriangularEvaluationOptions["marketDataMode"] = "sequence-verified-depth"): string | undefined {
  if (!book.complete) return "book source payload is incomplete";
  if (!Number.isFinite(book.receivedAt) || book.receivedAt <= 0) return "receivedAt must be a finite positive timestamp";
  const venueTimestampPresent = typeof book.exchangeTs === "number" && Number.isFinite(book.exchangeTs) && book.exchangeTs > 0;
  if (book.exchangeTimestampVerified !== venueTimestampPresent) return "exchange timestamp provenance is inconsistent";
  if (marketDataMode === "sequence-verified-depth" && !venueTimestampPresent) return "sequence-verified depth requires a venue timestamp";
  const sequencePresent = typeof book.sequence === "number" && Number.isSafeInteger(book.sequence) && book.sequence > 0;
  if (book.sequenceVerified !== sequencePresent) return "book sequence provenance is inconsistent";
  if (marketDataMode === "sequence-verified-depth" && !book.sequenceVerified) return "book is not a sequence-verified snapshot";
  if ((venueTimestampPresent && (book.exchangeTs as number) > now + maxFutureClockSkewMs) || book.receivedAt > now + maxFutureClockSkewMs) {
    return "book timestamp exceeds the future-clock safety boundary";
  }
  if (book.bids.length === 0 || book.asks.length === 0) return "both book sides are required";
  if (levelsProblem(book.bids, "bids") || levelsProblem(book.asks, "asks")) return "book levels are invalid or not strictly sorted";
  if ((book.bids[0]?.[0] ?? 0) >= (book.asks[0]?.[0] ?? Number.POSITIVE_INFINITY)) return "book is crossed or locked";
  return undefined;
}

function validateCycleData(cycle: TriangularCycle, books: ReadonlyMap<string, TriangularBookUpdate>, options: TriangularEvaluationOptions) {
  const cycleBooks: TriangularBookUpdate[] = [];
  for (const [index, edge] of cycle.edges.entries()) {
    const book = books.get(edge.marketId);
    if (!book) return rejected(cycle, "missing-book", "A required market book is missing", index, edge.marketId);
    const problem = validateBookUpdate(book, options.evaluatedAt, options.maxFutureClockSkewMs, options.marketDataMode);
    if (problem) {
      const code = !book.complete ? "incomplete-book" : "invalid-book";
      return rejected(cycle, code, problem, index, edge.marketId);
    }
    cycleBooks.push(book);
  }

  const exchangeTimes = cycleBooks.filter((book) => book.exchangeTimestampVerified && book.exchangeTs !== undefined).map((book) => book.exchangeTs as number);
  const receivedTimes = cycleBooks.map((book) => book.receivedAt);
  const exchangeTimestampsVerified = exchangeTimes.length === cycleBooks.length;
  const oldestExchangeTs = exchangeTimes.length > 0 ? Math.min(...exchangeTimes) : undefined;
  const newestExchangeTs = exchangeTimes.length > 0 ? Math.max(...exchangeTimes) : undefined;
  const oldestReceivedAt = Math.min(...receivedTimes);
  const newestReceivedAt = Math.max(...receivedTimes);
  const quoteAgeMs = Math.max(0, options.evaluatedAt - oldestReceivedAt, oldestExchangeTs === undefined ? 0 : options.evaluatedAt - oldestExchangeTs);
  const legSkewMs = Math.max(newestReceivedAt - oldestReceivedAt, exchangeTimestampsVerified && oldestExchangeTs !== undefined && newestExchangeTs !== undefined ? newestExchangeTs - oldestExchangeTs : 0);
  if (quoteAgeMs > options.maxQuoteAgeMs) {
    return rejected(cycle, "stale-book", `Oldest leg is ${quoteAgeMs} ms old`);
  }
  if (legSkewMs > options.maxLegSkewMs) {
    return rejected(cycle, "skewed-books", `Leg timestamp skew is ${legSkewMs} ms`);
  }
  return {
    timestamps: {
      evaluatedAt: options.evaluatedAt,
      ...(oldestExchangeTs === undefined ? {} : { oldestExchangeTs }),
      ...(newestExchangeTs === undefined ? {} : { newestExchangeTs }),
      oldestReceivedAt,
      newestReceivedAt,
      quoteAgeMs,
      legSkewMs,
      exchangeTimestampsVerified
    }
  };
}

interface SuccessfulSimulation {
  startQuantity: number;
  endQuantity: number;
  legs: [TriangularLegExecution, TriangularLegExecution, TriangularLegExecution];
}

interface FailedSimulation {
  code: "minimum-quantity" | "minimum-notional" | "insufficient-depth";
  message: string;
  legIndex: 0 | 1 | 2;
  marketId: string;
}

function simulate(cycle: TriangularCycle, markets: ReadonlyMap<string, TriangularMarketMetadata>, books: ReadonlyMap<string, TriangularBookUpdate>, startQuantity: number): SuccessfulSimulation | FailedSimulation {
  let quantity = startQuantity;
  const legs: TriangularLegExecution[] = [];
  for (const [rawIndex, edge] of cycle.edges.entries()) {
    const index = rawIndex as 0 | 1 | 2;
    const market = markets.get(edge.marketId);
    const book = books.get(edge.marketId);
    if (!market || !book) {
      return { code: "insufficient-depth", message: "Required market data is unavailable", legIndex: index, marketId: edge.marketId };
    }
    const leg = executeLeg(edge, market, book, quantity, index);
    if (!("outputQuantity" in leg)) return leg;
    legs.push(leg);
    quantity = leg.outputQuantity;
  }
  return {
    startQuantity,
    endQuantity: quantity,
    legs: legs as [TriangularLegExecution, TriangularLegExecution, TriangularLegExecution]
  };
}

function executeLeg(edge: TriangularConversionEdge, market: TriangularMarketMetadata, book: TriangularBookUpdate, inputQuantity: number, index: 0 | 1 | 2): TriangularLegExecution | FailedSimulation {
  if (edge.side === "sell") return executeSell(edge, market, book, inputQuantity, index);
  return executeBuy(edge, market, book, inputQuantity, index);
}

function executeSell(edge: TriangularConversionEdge, market: TriangularMarketMetadata, book: TriangularBookUpdate, inputQuantity: number, index: 0 | 1 | 2): TriangularLegExecution | FailedSimulation {
  const orderBaseQuantity = floorToStep(inputQuantity, market.quantityStep);
  if (orderBaseQuantity + tolerance(orderBaseQuantity) < market.minimumQuantity) {
    return failed("minimum-quantity", "Rounded sell quantity is below the venue minimum", index, market.marketId);
  }
  const available = sumBase(book.bids);
  if (orderBaseQuantity > available + tolerance(orderBaseQuantity)) {
    return failed("insufficient-depth", "Bid depth cannot fill the rounded sell quantity", index, market.marketId);
  }
  const walked = walkBase(book.bids, orderBaseQuantity);
  if (!walked || walked.quoteNotional + tolerance(walked?.quoteNotional ?? 0) < market.minimumNotional) {
    return failed("minimum-notional", "Sell notional is below the venue minimum", index, market.marketId);
  }
  return legExecution(edge, market, book, index, inputQuantity, orderBaseQuantity, orderBaseQuantity, walked, walked.quoteNotional);
}

function executeBuy(edge: TriangularConversionEdge, market: TriangularMarketMetadata, book: TriangularBookUpdate, inputQuantity: number, index: 0 | 1 | 2): TriangularLegExecution | FailedSimulation {
  const totalDepthNotional = book.asks.reduce((sum, [price, quantity]) => sum + price * quantity, 0);
  if (inputQuantity > totalDepthNotional + tolerance(inputQuantity)) {
    return failed("insufficient-depth", "Ask depth cannot spend the input quote quantity", index, market.marketId);
  }
  const affordableBase = baseForBudget(book.asks, inputQuantity);
  const orderBaseQuantity = floorToStep(affordableBase, market.quantityStep);
  if (orderBaseQuantity + tolerance(orderBaseQuantity) < market.minimumQuantity) {
    return failed("minimum-quantity", "Rounded buy quantity is below the venue minimum", index, market.marketId);
  }
  const walked = walkBase(book.asks, orderBaseQuantity);
  if (!walked || walked.quoteNotional + tolerance(walked?.quoteNotional ?? 0) < market.minimumNotional) {
    return failed("minimum-notional", "Buy notional is below the venue minimum", index, market.marketId);
  }
  return legExecution(edge, market, book, index, inputQuantity, walked.quoteNotional, orderBaseQuantity, walked, orderBaseQuantity);
}

function legExecution(edge: TriangularConversionEdge, market: TriangularMarketMetadata, book: TriangularBookUpdate, index: 0 | 1 | 2, inputQuantity: number, inputConsumedQuantity: number, orderBaseQuantity: number, walked: WalkedDepth, grossOutputQuantity: number): TriangularLegExecution {
  const feeQuantity = (grossOutputQuantity * market.takerFeeBps) / 10_000;
  return {
    index,
    marketId: edge.marketId,
    symbol: edge.symbol,
    side: edge.side,
    fromAsset: edge.fromAsset,
    toAsset: edge.toAsset,
    inputQuantity,
    inputConsumedQuantity,
    inputDustQuantity: Math.max(0, inputQuantity - inputConsumedQuantity),
    orderBaseQuantity,
    averagePrice: walked.quoteNotional / walked.baseQuantity,
    worstPrice: walked.worstPrice,
    quoteNotional: walked.quoteNotional,
    grossOutputQuantity,
    feeBps: market.takerFeeBps,
    feeQuantity,
    feeAsset: edge.toAsset,
    outputQuantity: grossOutputQuantity - feeQuantity,
    levelsUsed: walked.levelsUsed,
    ...(book.exchangeTs === undefined ? {} : { exchangeTs: book.exchangeTs }),
    exchangeTimestampVerified: book.exchangeTimestampVerified,
    receivedAt: book.receivedAt
  };
}

function searchDepthCapacity(cycle: TriangularCycle, markets: ReadonlyMap<string, TriangularMarketMetadata>, books: ReadonlyMap<string, TriangularBookUpdate>, options: TriangularEvaluationOptions) {
  let lower = 0;
  let upper = options.requestedStartQuantity;
  let best: SuccessfulSimulation | undefined;
  for (let iteration = 0; iteration < options.depthSearchIterations; iteration += 1) {
    const candidate = lower + (upper - lower) / 2;
    if (candidate <= 0 || upper - lower <= tolerance(options.requestedStartQuantity)) break;
    const result = simulate(cycle, markets, books, candidate);
    if ("legs" in result) {
      best = result;
      lower = candidate;
    } else if (result.code === "minimum-quantity" || result.code === "minimum-notional") {
      lower = candidate;
    } else {
      upper = candidate;
    }
  }
  return best;
}

interface WalkedDepth {
  baseQuantity: number;
  quoteNotional: number;
  worstPrice: number;
  levelsUsed: number;
}

function walkBase(levels: readonly TriangularDepthLevel[], requestedBase: number): WalkedDepth | undefined {
  let remaining = requestedBase;
  let baseQuantity = 0;
  let quoteNotional = 0;
  let worstPrice = 0;
  let levelsUsed = 0;
  for (const [price, availableBase] of levels) {
    if (remaining <= tolerance(requestedBase)) break;
    const take = Math.min(remaining, availableBase);
    baseQuantity += take;
    quoteNotional += take * price;
    remaining -= take;
    worstPrice = price;
    levelsUsed += 1;
  }
  if (remaining > tolerance(requestedBase) || baseQuantity <= 0) return undefined;
  return { baseQuantity, quoteNotional, worstPrice, levelsUsed };
}

function baseForBudget(asks: readonly TriangularDepthLevel[], budget: number) {
  let remaining = budget;
  let base = 0;
  for (const [price, availableBase] of asks) {
    if (remaining <= tolerance(budget)) break;
    const take = Math.min(availableBase, remaining / price);
    base += take;
    remaining -= take * price;
  }
  return base;
}

function levelsProblem(levels: readonly TriangularDepthLevel[], side: "bids" | "asks") {
  let previous: number | undefined;
  for (const level of levels) {
    if (!Array.isArray(level) || level.length !== 2) return true;
    const [price, quantity] = level;
    if (!Number.isFinite(price) || !Number.isFinite(quantity) || price <= 0 || quantity <= 0) return true;
    if (previous !== undefined && (side === "bids" ? price >= previous : price <= previous)) return true;
    previous = price;
  }
  return false;
}

function floorToStep(value: number, step: number) {
  const units = Math.floor(value / step + 1e-10);
  return Math.max(0, units * step);
}

function sumBase(levels: readonly TriangularDepthLevel[]) {
  return levels.reduce((sum, [, quantity]) => sum + quantity, 0);
}

function returnBps(start: number, end: number) {
  return start > 0 ? (end / start - 1) * 10_000 : Number.NEGATIVE_INFINITY;
}

function tolerance(value: number) {
  return Math.max(1e-12, Math.abs(value) * 1e-10);
}

function failed(code: FailedSimulation["code"], message: string, legIndex: 0 | 1 | 2, marketId: string): FailedSimulation {
  return { code, message, legIndex, marketId };
}

function rejected(cycle: TriangularCycle, code: TriangularRejection["code"], message: string, rawIndex?: number, marketId?: string) {
  const legIndex = rawIndex === undefined ? undefined : (rawIndex as 0 | 1 | 2);
  return { rejection: { cycleId: cycle.cycleId, code, message, legIndex, marketId } };
}

function simulationRejection(cycle: TriangularCycle, result: FailedSimulation): TriangularRejection {
  return {
    cycleId: cycle.cycleId,
    code: result.code,
    message: result.message,
    legIndex: result.legIndex,
    marketId: result.marketId
  };
}
