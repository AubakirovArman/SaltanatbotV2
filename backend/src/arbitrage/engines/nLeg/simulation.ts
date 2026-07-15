import { nLegAssetUnitKey, sameNLegAssetUnit } from "./identity.js";
import type {
  NLegBookSnapshot,
  NLegConversionEdge,
  NLegCycle,
  NLegDepthLevel,
  NLegEvaluationRequest,
  NLegEvaluationResult,
  NLegLegSimulation,
  NLegMarketMetadata,
  NLegOpportunity,
  NLegRejection
} from "./types.js";
import { resolveNLegEvaluationLimits, validateNLegCycleBooks, validateNLegCycleStructure, type ResolvedNLegEvaluationLimits } from "./validation.js";

const RETURN_EPSILON_BPS = 1e-7;

interface SuccessfulSimulation {
  startQuantity: number;
  endQuantity: number;
  legs: NLegLegSimulation[];
}

interface FailedSimulation {
  code: "fee-conservation" | "minimum-quantity" | "minimum-notional" | "insufficient-depth" | "work-limit";
  message: string;
  legIndex: number;
  instrumentId: string;
}

/**
 * Pure, deterministic sequential simulation. It consumes no credentials,
 * performs no I/O and can never place orders; sequence-verified depth only
 * makes the recorded calculation internally auditable.
 */
export function evaluateNLegCycle(request: NLegEvaluationRequest): NLegEvaluationResult {
  if (!positive(request.requestedStartQuantity)) throw new RangeError("requestedStartQuantity must be a finite positive number");
  if (!positive(request.evaluatedAt)) throw new RangeError("evaluatedAt must be a finite positive timestamp");
  throwIfAborted(request.signal);
  const limits = resolveNLegEvaluationLimits(request.limits);
  const structureProblem = validateNLegCycleStructure(request.cycle, request.markets);
  if (structureProblem) return { rejection: structureProblem };
  const quality = validateNLegCycleBooks(request.cycle, request.markets, request.books, request.evaluatedAt, limits);
  if ("rejection" in quality) return quality;

  const work = new DepthWorkBudget(limits.maxDepthWalkSteps, request.signal);
  const requested = simulate(request.cycle, request.markets, request.books, request.requestedStartQuantity, work);
  let execution: SuccessfulSimulation;
  let depthLimited = false;
  let limitingLegIndex: number | undefined;
  let limitingInstrumentId: string | undefined;
  if ("legs" in requested) {
    execution = requested;
  } else {
    if (requested.code !== "insufficient-depth") return { rejection: simulationRejection(request.cycle, requested) };
    depthLimited = true;
    limitingLegIndex = requested.legIndex;
    limitingInstrumentId = requested.instrumentId;
    const bounded = searchDepthCapacity(request.cycle, request.markets, request.books, request.requestedStartQuantity, limits, work);
    if (bounded.failure) return { rejection: simulationRejection(request.cycle, bounded.failure) };
    if (!bounded.execution) return { rejection: simulationRejection(request.cycle, requested) };
    execution = bounded.execution;
  }

  const netReturnBps = returnBps(execution.startQuantity, execution.endQuantity);
  if (!(netReturnBps > limits.minNetReturnBps + RETURN_EPSILON_BPS)) {
    return {
      rejection: {
        cycleId: request.cycle.cycleId,
        code: "non-profitable",
        message: `Net return ${netReturnBps.toFixed(8)} bps does not exceed ${limits.minNetReturnBps.toFixed(8)} bps`
      }
    };
  }

  const residuals: NLegOpportunity["residuals"] = execution.legs
    .filter((leg) => leg.inputDustQuantity > tolerance(leg.inputQuantity))
    .map((leg) => ({ legIndex: leg.index, asset: leg.from, assetKey: leg.fromKey, quantity: leg.inputDustQuantity, reason: "lot-rounding" }));
  const dustByAssetUnit: Record<string, number> = {};
  const feesByAssetUnit: Record<string, number> = {};
  for (const residual of residuals) dustByAssetUnit[residual.assetKey] = (dustByAssetUnit[residual.assetKey] ?? 0) + residual.quantity;
  for (const leg of execution.legs) {
    if (leg.feeQuantity <= tolerance(leg.feeQuantity)) continue;
    feesByAssetUnit[leg.feeAssetKey] = (feesByAssetUnit[leg.feeAssetKey] ?? 0) + leg.feeQuantity;
  }

  return {
    opportunity: {
      id: `n-leg-opportunity:${request.cycle.cycleId}`,
      strategyKind: "n-leg-cycle",
      edgeKind: "research-simulation",
      executable: false,
      executionModel: "sequential-visible-depth",
      cycleId: request.cycle.cycleId,
      venue: request.cycle.venue,
      legCount: request.cycle.edges.length,
      start: request.cycle.start,
      startKey: request.cycle.startKey,
      requestedStartQuantity: request.requestedStartQuantity,
      startQuantity: execution.startQuantity,
      endQuantity: execution.endQuantity,
      netReturnBps,
      capacityUtilizationPct: (execution.startQuantity / request.requestedStartQuantity) * 100,
      depthLimited,
      ...(limitingLegIndex === undefined ? {} : { limitingLegIndex }),
      ...(limitingInstrumentId === undefined ? {} : { limitingInstrumentId }),
      legs: execution.legs,
      residuals,
      dustByAssetUnit,
      feesByAssetUnit,
      timestamps: quality.timestamps,
      provenance: {
        engine: "n-leg-v1",
        canonicalSignature: request.cycle.canonicalSignature,
        instrumentIds: request.cycle.edges.map((edge) => edge.instrumentId),
        feeScheduleIds: request.cycle.edges.map((edge) => edge.fee.scheduleId),
        bookSourceIds: request.cycle.edges.map((edge) => request.books.get(edge.instrumentId)!.sourceId)
      }
    }
  };
}

function simulate(
  cycle: NLegCycle,
  markets: ReadonlyMap<string, NLegMarketMetadata>,
  books: ReadonlyMap<string, NLegBookSnapshot>,
  startQuantity: number,
  work: DepthWorkBudget
): SuccessfulSimulation | FailedSimulation {
  let quantity = startQuantity;
  const legs: NLegLegSimulation[] = [];
  for (const [index, edge] of cycle.edges.entries()) {
    throwIfAborted(work.signal);
    const market = markets.get(edge.instrumentId);
    const book = books.get(edge.instrumentId);
    if (!market || !book) return failed("insufficient-depth", "Required market data is unavailable", index, edge.instrumentId);
    const leg = executeLeg(edge, market, book, quantity, index, work);
    if (!("outputQuantity" in leg)) return leg;
    if (index > 0 && !sameNLegAssetUnit(legs[index - 1]!.to, leg.from)) return failed("fee-conservation", "Adjacent leg units do not conserve quantity", index, edge.instrumentId);
    legs.push(leg);
    quantity = leg.outputQuantity;
  }
  return { startQuantity, endQuantity: quantity, legs };
}

function executeLeg(edge: NLegConversionEdge, market: NLegMarketMetadata, book: NLegBookSnapshot, inputQuantity: number, index: number, work: DepthWorkBudget): NLegLegSimulation | FailedSimulation {
  const feeAssetKey = nLegAssetUnitKey(edge.fee.asset);
  if (feeAssetKey !== edge.fromKey && feeAssetKey !== edge.toKey) {
    return failed("fee-conservation", "External fee inventory/FX cannot be conserved by this engine", index, edge.instrumentId);
  }
  return edge.side === "sell" ? executeSell(edge, market, book, inputQuantity, index, work) : executeBuy(edge, market, book, inputQuantity, index, work);
}

function executeSell(edge: NLegConversionEdge, market: NLegMarketMetadata, book: NLegBookSnapshot, inputQuantity: number, index: number, work: DepthWorkBudget): NLegLegSimulation | FailedSimulation {
  const feeRate = edge.fee.takerBps / 10_000;
  const baseBudget = edge.feeDebit === "input" ? inputQuantity / (1 + feeRate) : inputQuantity;
  const orderBaseQuantity = floorToStep(baseBudget, market.quantityStep);
  if (orderBaseQuantity + tolerance(orderBaseQuantity) < market.minimumQuantity) {
    return failed("minimum-quantity", "Rounded sell quantity is below the venue minimum", index, edge.instrumentId);
  }
  const walked = walkBase(book.bids, orderBaseQuantity, work);
  if ("code" in walked) return failed(walked.code, walked.message, index, edge.instrumentId);
  if (walked.quoteNotional + tolerance(walked.quoteNotional) < market.minimumNotional) {
    return failed("minimum-notional", "Sell quote notional is below the venue minimum", index, edge.instrumentId);
  }
  return makeLeg(edge, market, book, inputQuantity, orderBaseQuantity, walked, index);
}

function executeBuy(edge: NLegConversionEdge, market: NLegMarketMetadata, book: NLegBookSnapshot, inputQuantity: number, index: number, work: DepthWorkBudget): NLegLegSimulation | FailedSimulation {
  const feeRate = edge.fee.takerBps / 10_000;
  const tradeBudget = edge.feeDebit === "input" ? inputQuantity / (1 + feeRate) : inputQuantity;
  const affordable = baseForBudget(book.asks, tradeBudget, work);
  if ("code" in affordable) return failed(affordable.code, affordable.message, index, edge.instrumentId);
  if (!affordable.fullyFunded) return failed("insufficient-depth", "Ask depth cannot spend the conserved input quantity", index, edge.instrumentId);
  const orderBaseQuantity = floorToStep(affordable.baseQuantity, market.quantityStep);
  if (orderBaseQuantity + tolerance(orderBaseQuantity) < market.minimumQuantity) {
    return failed("minimum-quantity", "Rounded buy quantity is below the venue minimum", index, edge.instrumentId);
  }
  const walked = walkBase(book.asks, orderBaseQuantity, work);
  if ("code" in walked) return failed(walked.code, walked.message, index, edge.instrumentId);
  if (walked.quoteNotional + tolerance(walked.quoteNotional) < market.minimumNotional) {
    return failed("minimum-notional", "Buy quote notional is below the venue minimum", index, edge.instrumentId);
  }
  return makeLeg(edge, market, book, inputQuantity, orderBaseQuantity, walked, index);
}

function makeLeg(
  edge: NLegConversionEdge,
  market: NLegMarketMetadata,
  book: NLegBookSnapshot,
  inputQuantity: number,
  orderBaseQuantity: number,
  walked: WalkedDepth,
  index: number
): NLegLegSimulation {
  const feeRate = edge.fee.takerBps / 10_000;
  const tradeInputQuantity = edge.side === "sell" ? orderBaseQuantity : walked.quoteNotional;
  const grossOutputQuantity = edge.side === "sell" ? walked.quoteNotional : orderBaseQuantity;
  const feeQuantity = (edge.feeDebit === "input" ? tradeInputQuantity : grossOutputQuantity) * feeRate;
  const totalInputDebitedQuantity = tradeInputQuantity + (edge.feeDebit === "input" ? feeQuantity : 0);
  const outputQuantity = grossOutputQuantity - (edge.feeDebit === "output" ? feeQuantity : 0);
  const inputDustQuantity = Math.max(0, inputQuantity - totalInputDebitedQuantity);
  return {
    index,
    instrumentId: edge.instrumentId,
    venue: edge.venue,
    symbol: edge.symbol,
    side: edge.side,
    from: edge.from,
    to: edge.to,
    fromKey: edge.fromKey,
    toKey: edge.toKey,
    inputQuantity,
    tradeInputQuantity,
    totalInputDebitedQuantity,
    inputDustQuantity,
    orderBaseQuantity,
    averagePrice: walked.quoteNotional / walked.baseQuantity,
    worstPrice: walked.worstPrice,
    quoteNotional: walked.quoteNotional,
    grossOutputQuantity,
    feeScheduleId: edge.fee.scheduleId,
    feeTierId: edge.fee.tierId,
    feeBps: edge.fee.takerBps,
    feeAsset: edge.fee.asset,
    feeAssetKey: nLegAssetUnitKey(edge.fee.asset),
    feeDebit: edge.feeDebit,
    feeQuantity,
    outputQuantity,
    levelsUsed: walked.levelsUsed,
    exchangeTs: book.exchangeTs,
    receivedAt: book.receivedAt,
    sequence: book.sequence
  };
}

function searchDepthCapacity(
  cycle: NLegCycle,
  markets: ReadonlyMap<string, NLegMarketMetadata>,
  books: ReadonlyMap<string, NLegBookSnapshot>,
  requestedStartQuantity: number,
  limits: ResolvedNLegEvaluationLimits,
  work: DepthWorkBudget
): { execution?: SuccessfulSimulation; failure?: FailedSimulation } {
  let lower = 0;
  let upper = requestedStartQuantity;
  let best: SuccessfulSimulation | undefined;
  for (let iteration = 0; iteration < limits.depthSearchIterations; iteration += 1) {
    throwIfAborted(work.signal);
    if (upper - lower <= tolerance(requestedStartQuantity)) break;
    const candidate = lower + (upper - lower) / 2;
    const result = simulate(cycle, markets, books, candidate, work);
    if ("legs" in result) {
      best = result;
      lower = candidate;
    } else if (result.code === "minimum-quantity" || result.code === "minimum-notional") {
      lower = candidate;
    } else if (result.code === "insufficient-depth") {
      upper = candidate;
    } else {
      return { failure: result };
    }
  }
  return best ? { execution: best } : {};
}

interface WalkedDepth {
  baseQuantity: number;
  quoteNotional: number;
  worstPrice: number;
  levelsUsed: number;
}

interface DepthFailure {
  code: "insufficient-depth" | "work-limit";
  message: string;
}

function walkBase(levels: readonly NLegDepthLevel[], requestedBase: number, work: DepthWorkBudget): WalkedDepth | DepthFailure {
  let remaining = requestedBase;
  let baseQuantity = 0;
  let quoteNotional = 0;
  let worstPrice = 0;
  let levelsUsed = 0;
  for (const [price, availableBase] of levels) {
    if (remaining <= tolerance(requestedBase)) break;
    if (!work.spend()) return { code: "work-limit", message: "Depth-walk work budget was exhausted" };
    const take = Math.min(remaining, availableBase);
    baseQuantity += take;
    quoteNotional += take * price;
    remaining -= take;
    worstPrice = price;
    levelsUsed += 1;
  }
  if (remaining > tolerance(requestedBase) || baseQuantity <= 0) return { code: "insufficient-depth", message: "Visible depth cannot fill the conserved base quantity" };
  return { baseQuantity, quoteNotional, worstPrice, levelsUsed };
}

function baseForBudget(levels: readonly NLegDepthLevel[], budget: number, work: DepthWorkBudget): ({ baseQuantity: number; fullyFunded: boolean } & Pick<WalkedDepth, "quoteNotional" | "worstPrice" | "levelsUsed">) | DepthFailure {
  let remaining = budget;
  let baseQuantity = 0;
  let quoteNotional = 0;
  let worstPrice = 0;
  let levelsUsed = 0;
  for (const [price, availableBase] of levels) {
    if (remaining <= tolerance(budget)) break;
    if (!work.spend()) return { code: "work-limit", message: "Depth-walk work budget was exhausted" };
    const take = Math.min(availableBase, remaining / price);
    baseQuantity += take;
    const spent = take * price;
    quoteNotional += spent;
    remaining -= spent;
    worstPrice = price;
    levelsUsed += 1;
  }
  return { baseQuantity, quoteNotional, worstPrice, levelsUsed, fullyFunded: remaining <= tolerance(budget) };
}

class DepthWorkBudget {
  private steps = 0;

  constructor(
    private readonly maximum: number,
    readonly signal?: AbortSignal
  ) {}

  spend(): boolean {
    throwIfAborted(this.signal);
    if (this.steps >= this.maximum) return false;
    this.steps += 1;
    return true;
  }
}

function floorToStep(value: number, step: number): number {
  const units = Math.floor(value / step + 1e-10);
  return Math.max(0, units * step);
}

function failed(code: FailedSimulation["code"], message: string, legIndex: number, instrumentId: string): FailedSimulation {
  return { code, message, legIndex, instrumentId };
}

function simulationRejection(cycle: NLegCycle, result: FailedSimulation): NLegRejection {
  return { cycleId: cycle.cycleId, code: result.code, message: result.message, legIndex: result.legIndex, instrumentId: result.instrumentId };
}

function returnBps(start: number, end: number): number {
  return start > 0 ? (end / start - 1) * 10_000 : Number.NEGATIVE_INFINITY;
}

function tolerance(value: number): number {
  return Math.max(1e-12, Math.abs(value) * 1e-10);
}

function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error("N-leg simulation aborted");
  error.name = "AbortError";
  throw error;
}
