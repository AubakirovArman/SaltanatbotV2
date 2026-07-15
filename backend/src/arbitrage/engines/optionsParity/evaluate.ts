import { planParityLegs } from "./depth.js";
import type { ParityLegPlanSpec } from "./depth.js";
import {
  crossSeriesProblem,
  feeAssumptionProblem,
  firstBookProblem,
  fxAssumptionProblem,
  normalizedLimits,
  resolvePair,
  resolveUnderlying,
  sourcedProblem,
  timestampMetrics,
  validateCommonAssumptions
} from "./validation.js";
import type { OptionsParityPair } from "./validation.js";
import type {
  OptionsParityBook,
  OptionsParityCandidate,
  OptionsParityEvaluation,
  OptionsParityEvaluationLimits,
  OptionsParityEvaluationRequest,
  OptionsParityFeeAssumption,
  OptionsParityInstrument,
  OptionsParityLegSimulation,
  OptionsParityRejection,
  OptionsParitySeriesSnapshot,
  OptionsParityStrategyKind,
  OptionsParityUnderlyingInstrument
} from "./types.js";

const YEAR_MS = 365 * 24 * 60 * 60_000;

interface Context {
  request: OptionsParityEvaluationRequest;
  limits: Required<OptionsParityEvaluationLimits>;
  primary: OptionsParityPair;
  underlying: { instrument: OptionsParityUnderlyingInstrument; book: OptionsParityBook };
  years: number;
  rate: number;
  dividendYield: number;
  commonAssumptions: { source: string; asOf: number }[];
  candidates: OptionsParityCandidate[];
  rejections: OptionsParityRejection[];
}

export function evaluateOptionsParity(request: OptionsParityEvaluationRequest): OptionsParityEvaluation {
  const result: OptionsParityEvaluation = {
    evaluatedAt: request.evaluatedAt,
    edgeKind: "research-simulation",
    executable: false,
    candidates: [],
    rejections: []
  };
  const limits = normalizedLimits(request.limits);
  if (!positive(request.targetBaseQuantity) || !positiveTimestamp(request.evaluatedAt)) {
    result.rejections.push(rejection("missing-assumption", "targetBaseQuantity and evaluatedAt must be positive"));
    return result;
  }
  const primary = resolvePair(request.primary, request.evaluatedAt);
  if ("rejection" in primary) {
    result.rejections.push(primary.rejection);
    return result;
  }
  const underlying = resolveUnderlying(request, primary.pair);
  if ("rejection" in underlying) {
    result.rejections.push(underlying.rejection);
    return result;
  }
  const bookProblem = firstBookProblem(
    [primary.pair.call.book, primary.pair.put.book, underlying.value.book],
    request.evaluatedAt,
    limits
  );
  if (bookProblem) {
    result.rejections.push(bookProblem);
    return result;
  }
  const assumptions = validateCommonAssumptions(request.assumptions, primary.pair, underlying.value.instrument, request.evaluatedAt, limits);
  if ("rejection" in assumptions) {
    result.rejections.push(assumptions.rejection);
    return result;
  }
  const years = (primary.pair.call.instrument.expiryTime - request.evaluatedAt) / YEAR_MS;
  const context: Context = {
    request,
    limits,
    primary: primary.pair,
    underlying: underlying.value,
    years,
    rate: request.assumptions.riskFreeRate.annualRate,
    dividendYield: request.assumptions.dividendYield.annualRate,
    commonAssumptions: assumptions.values,
    candidates: result.candidates,
    rejections: result.rejections
  };
  evaluateCallRich(context);
  evaluatePutRich(context);
  if (request.secondary) evaluateBox(context, request.secondary);
  result.candidates.sort(candidateOrder);
  result.rejections.sort(rejectionOrder);
  return result;
}

function evaluateCallRich(context: Context) {
  const { call, put } = context.primary;
  const capacity = shortCapacity(context, call.instrument, "conversion");
  if (!capacity) return;
  const assumptions = optionLegAssumptions(context, [call.instrument, put.instrument]);
  if (!assumptions) return;
  const plan = planParityLegs(
    [
      optionSpec(call, "call", "sell", assumptions),
      optionSpec(put, "put", "buy", assumptions),
      underlyingSpec(context, "buy")
    ],
    Math.min(context.request.targetBaseQuantity, capacity.value.availableBaseQuantity),
    context.limits.pairingIterations
  );
  if ("failure" in plan) {
    context.rejections.push({ strategyKind: "conversion", code: plan.failure.code, instrumentId: plan.failure.instrumentId, message: plan.failure.message });
    return;
  }
  const callLeg = leg(plan.legs, "call");
  const putLeg = leg(plan.legs, "put");
  const spotLeg = leg(plan.legs, "underlying");
  const strikePv = context.primary.call.instrument.strikePrice * plan.baseQuantity * Math.exp(-context.rate * context.years);
  const carryAdjustedSpot = spotLeg.valuationCashAmount * Math.exp(-context.dividendYield * context.years);
  const grossEdge = callLeg.valuationCashAmount - putLeg.valuationCashAmount - (carryAdjustedSpot - strikePv);
  const optionFees = callLeg.feeValuation + putLeg.feeValuation;
  const allFees = optionFees + spotLeg.feeValuation;
  const referenceNotional = Math.max(strikePv, spotLeg.valuationCashAmount);
  const impliedForward = callPutImpliedForward(callLeg, putLeg, context, plan.baseQuantity);
  const theoreticalForward = (spotLeg.valuationCashAmount / plan.baseQuantity) * Math.exp((context.rate - context.dividendYield) * context.years);
  const values = [...context.commonAssumptions, ...assumptions.values, capacity.value];

  pushCandidate(context, {
    id: `options-parity:${context.primary.seriesId}:call-rich`,
    strategyKind: "put-call-parity",
    direction: "call-rich",
    grossEdge,
    fees: optionFees,
    borrow: 0,
    referenceNotional,
    legs: [callLeg, putLeg],
    referenceUnderlying: spotLeg,
    assumptions: values,
    impliedForward,
    theoreticalForward,
    outcome: "parity-deviation-research-only-no-fixed-profit-without-hedge"
  });
  pushCandidate(context, {
    id: `options-synthetic:${context.primary.seriesId}:short`,
    strategyKind: "synthetic-forward",
    direction: "short-synthetic",
    grossEdge,
    fees: optionFees,
    borrow: 0,
    referenceNotional,
    legs: [callLeg, putLeg],
    referenceUnderlying: spotLeg,
    assumptions: values,
    impliedForward,
    theoreticalForward,
    outcome: "parity-deviation-research-only-no-fixed-profit-without-hedge"
  });
  pushCandidate(context, {
    id: `options-conversion:${context.primary.seriesId}`,
    strategyKind: "conversion",
    direction: "call-rich",
    grossEdge,
    fees: allFees,
    borrow: 0,
    referenceNotional,
    fixedPayoff: context.primary.call.instrument.strikePrice * plan.baseQuantity,
    legs: plan.legs,
    assumptions: values,
    outcome: "fixed-valuation-payoff-at-expiry-under-stated-assumptions"
  });
}

function evaluatePutRich(context: Context) {
  const { call, put } = context.primary;
  const capacity = shortCapacity(context, put.instrument, "reversal");
  const shortUnderlying = underlyingShort(context);
  if (!capacity) return;
  const assumptions = optionLegAssumptions(context, [call.instrument, put.instrument]);
  if (!assumptions) return;
  const target = Math.min(
    context.request.targetBaseQuantity,
    capacity.value.availableBaseQuantity,
    shortUnderlying?.value.availableBaseQuantity ?? Number.POSITIVE_INFINITY
  );
  const plan = planParityLegs(
    [optionSpec(call, "call", "buy", assumptions), optionSpec(put, "put", "sell", assumptions), underlyingSpec(context, "sell")],
    target,
    context.limits.pairingIterations
  );
  if ("failure" in plan) {
    context.rejections.push({ strategyKind: "reversal", code: plan.failure.code, instrumentId: plan.failure.instrumentId, message: plan.failure.message });
    return;
  }
  const callLeg = leg(plan.legs, "call");
  const putLeg = leg(plan.legs, "put");
  const spotLeg = leg(plan.legs, "underlying");
  const strikePv = context.primary.call.instrument.strikePrice * plan.baseQuantity * Math.exp(-context.rate * context.years);
  const carryAdjustedSpot = spotLeg.valuationCashAmount * Math.exp(-context.dividendYield * context.years);
  const grossEdge = carryAdjustedSpot - strikePv - (callLeg.valuationCashAmount - putLeg.valuationCashAmount);
  const optionFees = callLeg.feeValuation + putLeg.feeValuation;
  const allFees = optionFees + spotLeg.feeValuation;
  const referenceNotional = Math.max(strikePv, spotLeg.valuationCashAmount);
  const impliedForward = callPutImpliedForward(callLeg, putLeg, context, plan.baseQuantity);
  const theoreticalForward = (spotLeg.valuationCashAmount / plan.baseQuantity) * Math.exp((context.rate - context.dividendYield) * context.years);
  const values = [...context.commonAssumptions, ...assumptions.values, capacity.value];

  pushCandidate(context, {
    id: `options-parity:${context.primary.seriesId}:put-rich`,
    strategyKind: "put-call-parity",
    direction: "put-rich",
    grossEdge,
    fees: optionFees,
    borrow: 0,
    referenceNotional,
    legs: [callLeg, putLeg],
    referenceUnderlying: spotLeg,
    assumptions: values,
    impliedForward,
    theoreticalForward,
    outcome: "parity-deviation-research-only-no-fixed-profit-without-hedge"
  });
  pushCandidate(context, {
    id: `options-synthetic:${context.primary.seriesId}:long`,
    strategyKind: "synthetic-forward",
    direction: "long-synthetic",
    grossEdge,
    fees: optionFees,
    borrow: 0,
    referenceNotional,
    legs: [callLeg, putLeg],
    referenceUnderlying: spotLeg,
    assumptions: values,
    impliedForward,
    theoreticalForward,
    outcome: "parity-deviation-research-only-no-fixed-profit-without-hedge"
  });
  if (!shortUnderlying) return;
  const borrow = spotLeg.valuationCashAmount * Math.expm1(shortUnderlying.value.annualBorrowRate * context.years);
  pushCandidate(context, {
    id: `options-reversal:${context.primary.seriesId}`,
    strategyKind: "reversal",
    direction: "put-rich",
    grossEdge,
    fees: allFees,
    borrow,
    referenceNotional,
    fixedPayoff: -context.primary.call.instrument.strikePrice * plan.baseQuantity,
    legs: plan.legs,
    assumptions: [...values, shortUnderlying.value],
    outcome: "fixed-valuation-payoff-at-expiry-under-stated-assumptions"
  });
}

function evaluateBox(context: Context, snapshot: OptionsParitySeriesSnapshot) {
  const resolved = resolvePair(snapshot, context.request.evaluatedAt);
  if ("rejection" in resolved) {
    context.rejections.push({ ...resolved.rejection, strategyKind: "box" });
    return;
  }
  const secondary = resolved.pair;
  const identityProblem = crossSeriesProblem(context.primary, secondary);
  if (identityProblem) {
    context.rejections.push({ strategyKind: "box", seriesId: secondary.seriesId, code: "identity-mismatch", message: identityProblem });
    return;
  }
  const bookProblem = firstBookProblem([secondary.call.book, secondary.put.book], context.request.evaluatedAt, context.limits);
  if (bookProblem) {
    context.rejections.push({ ...bookProblem, strategyKind: "box", seriesId: secondary.seriesId });
    return;
  }
  const lower = context.primary.call.instrument.strikePrice < secondary.call.instrument.strikePrice ? context.primary : secondary;
  const upper = lower === context.primary ? secondary : context.primary;
  const assumptions = optionLegAssumptions(context, [lower.call.instrument, lower.put.instrument, upper.call.instrument, upper.put.instrument]);
  if (!assumptions) return;
  evaluateBoxDirection(context, lower, upper, assumptions, "long-box");
  evaluateBoxDirection(context, lower, upper, assumptions, "short-box");
}

function evaluateBoxDirection(
  context: Context,
  lower: OptionsParityPair,
  upper: OptionsParityPair,
  assumptions: ReturnType<typeof optionLegAssumptions> & {},
  direction: "long-box" | "short-box"
) {
  if (!assumptions) return;
  const shortInstruments = direction === "long-box" ? [lower.put.instrument, upper.call.instrument] : [lower.call.instrument, upper.put.instrument];
  const capacities = shortInstruments.map((instrument) => shortCapacity(context, instrument, "box"));
  if (capacities.some((value) => !value)) return;
  const target = Math.min(context.request.targetBaseQuantity, ...capacities.map((value) => value!.value.availableBaseQuantity));
  const long = direction === "long-box";
  const plan = planParityLegs(
    [
      optionSpec(lower.call, "call", long ? "buy" : "sell", assumptions),
      optionSpec(lower.put, "put", long ? "sell" : "buy", assumptions),
      optionSpec(upper.call, "call", long ? "sell" : "buy", assumptions),
      optionSpec(upper.put, "put", long ? "buy" : "sell", assumptions)
    ],
    target,
    context.limits.pairingIterations
  );
  if ("failure" in plan) {
    context.rejections.push({ strategyKind: "box", code: plan.failure.code, instrumentId: plan.failure.instrumentId, message: plan.failure.message });
    return;
  }
  const buys = plan.legs.filter((value) => value.side === "buy").reduce((sum, value) => sum + value.valuationCashAmount, 0);
  const sells = plan.legs.filter((value) => value.side === "sell").reduce((sum, value) => sum + value.valuationCashAmount, 0);
  const fixedPayoff = (upper.call.instrument.strikePrice - lower.call.instrument.strikePrice) * plan.baseQuantity;
  const payoffPv = fixedPayoff * Math.exp(-context.rate * context.years);
  const grossEdge = long ? payoffPv - (buys - sells) : sells - buys - payoffPv;
  const fees = plan.legs.reduce((sum, value) => sum + value.feeValuation, 0);
  pushCandidate(context, {
    id: `options-box:${lower.seriesId}:${upper.seriesId}:${direction}`,
    strategyKind: "box",
    direction,
    grossEdge,
    fees,
    borrow: 0,
    referenceNotional: payoffPv,
    fixedPayoff: long ? fixedPayoff : -fixedPayoff,
    legs: plan.legs,
    assumptions: [...context.commonAssumptions, ...assumptions.values, ...capacities.map((value) => value!.value)],
    outcome: "fixed-valuation-payoff-at-expiry-under-stated-assumptions"
  });
}

interface CandidateInput {
  id: string;
  strategyKind: OptionsParityStrategyKind;
  direction: OptionsParityCandidate["direction"];
  grossEdge: number;
  fees: number;
  borrow: number;
  referenceNotional: number;
  fixedPayoff?: number;
  impliedForward?: number;
  theoreticalForward?: number;
  legs: OptionsParityLegSimulation[];
  referenceUnderlying?: OptionsParityLegSimulation;
  assumptions: { source: string; asOf: number }[];
  outcome: OptionsParityCandidate["outcomeLabel"];
}

function pushCandidate(context: Context, value: CandidateInput) {
  const net = value.grossEdge - value.fees - value.borrow;
  if (!Number.isFinite(net) || net <= context.limits.minimumNetEdgeValue) return;
  const books = [...value.legs, ...(value.referenceUnderlying ? [value.referenceUnderlying] : [])];
  const timestamps = timestampMetrics(books, value.assumptions, context.request.evaluatedAt);
  if (timestamps.legSkewMs > context.limits.maxLegSkewMs) {
    context.rejections.push({ strategyKind: value.strategyKind, code: "skewed-books", message: `Leg timestamp skew is ${timestamps.legSkewMs} ms` });
    return;
  }
  context.candidates.push({
    id: value.id,
    strategyKind: value.strategyKind,
    direction: value.direction,
    edgeKind: "research-simulation",
    executable: false,
    simulationBasis: "visible-depth-taker",
    outcomeLabel: value.outcome,
    underlyingAsset: context.primary.call.instrument.underlyingAsset,
    valuationAsset: context.request.assumptions.valuationAsset,
    settlementAsset: context.primary.call.instrument.settlementAsset,
    expiryTime: context.primary.call.instrument.expiryTime,
    strikes: [...new Set(value.legs.filter((leg) => leg.role !== "underlying").map((leg) => strikeForLeg(context, leg.instrumentId)))].sort(
      (left, right) => left - right
    ),
    baseQuantity: value.legs[0]!.baseQuantity,
    grossEdgeValue: value.grossEdge,
    feesValue: value.fees,
    borrowCostValue: value.borrow,
    netEdgeValue: net,
    edgeBpsOfReferenceNotional: (net / value.referenceNotional) * 10_000,
    referenceNotional: value.referenceNotional,
    ...(value.fixedPayoff === undefined ? {} : { fixedPayoffAtExpiry: value.fixedPayoff }),
    ...(value.theoreticalForward === undefined ? {} : { theoreticalForwardPrice: value.theoreticalForward }),
    ...(value.impliedForward === undefined ? {} : { impliedForwardPrice: value.impliedForward }),
    legs: value.legs,
    ...(value.referenceUnderlying ? { referenceUnderlying: value.referenceUnderlying } : {}),
    timestamps,
    assumptionSources: [...new Set(value.assumptions.map((assumption) => assumption.source))].sort()
  });
}

function optionLegAssumptions(context: Context, instruments: OptionsParityInstrument[]) {
  const fees = new Map<string, OptionsParityFeeAssumption>();
  const fx = new Map<string, { rate: number; source: string; asOf: number }>();
  const values: { source: string; asOf: number }[] = [];
  for (const instrument of instruments) {
    const fee = context.request.assumptions.optionFees[instrument.instrumentId];
    const feeProblem = feeAssumptionProblem(fee, context.request.evaluatedAt, context.limits);
    if (feeProblem) {
      context.rejections.push({ instrumentId: instrument.instrumentId, code: feeProblem.code, message: feeProblem.message });
      return undefined;
    }
    const conversion = context.request.assumptions.premiumFx[instrument.premiumAsset];
    const fxProblem = fxAssumptionProblem(conversion, instrument.premiumAsset, context.request.assumptions.valuationAsset, context.request.evaluatedAt, context.limits);
    if (fxProblem) {
      context.rejections.push({ instrumentId: instrument.instrumentId, code: fxProblem.code, message: fxProblem.message });
      return undefined;
    }
    fees.set(instrument.instrumentId, fee!);
    fx.set(instrument.instrumentId, conversion!);
    values.push(fee!, conversion!);
  }
  return { fees, fx, values };
}

function optionSpec(
  snapshot: OptionsParityPair["call"],
  role: "call" | "put",
  side: "buy" | "sell",
  assumptions: NonNullable<ReturnType<typeof optionLegAssumptions>>
): ParityLegPlanSpec {
  return {
    role,
    instrument: snapshot.instrument,
    book: snapshot.book,
    side,
    priceToValuationRate: assumptions.fx.get(snapshot.instrument.instrumentId)!.rate,
    feeModel: assumptions.fees.get(snapshot.instrument.instrumentId)!.model
  };
}

function underlyingSpec(context: Context, side: "buy" | "sell"): ParityLegPlanSpec {
  return {
    role: "underlying",
    instrument: context.underlying.instrument,
    book: context.underlying.book,
    side,
    priceToValuationRate: 1,
    feeModel: context.request.assumptions.underlyingFee.model
  };
}

function shortCapacity(context: Context, instrument: OptionsParityInstrument, strategyKind: OptionsParityStrategyKind) {
  const value = context.request.assumptions.shortOptionCapacity[instrument.instrumentId];
  const problem = sourcedProblem(value, context.request.evaluatedAt, context.limits);
  if (problem || value?.availabilityVerified !== true || value.marginVerified !== true || !positive(value.availableBaseQuantity)) {
    context.rejections.push({
      strategyKind,
      instrumentId: instrument.instrumentId,
      code: "short-capacity",
      message: problem?.message ?? "Short option availability and margin capacity must be explicitly verified"
    });
    return undefined;
  }
  return { value };
}

function underlyingShort(context: Context) {
  const value = context.request.assumptions.underlyingShort;
  const problem = sourcedProblem(value, context.request.evaluatedAt, context.limits);
  if (problem || value?.borrowVerified !== true || value.marginVerified !== true || !positive(value.availableBaseQuantity) || !nonNegative(value.annualBorrowRate)) {
    context.rejections.push({
      strategyKind: "reversal",
      instrumentId: context.underlying.instrument.instrumentId,
      code: "short-capacity",
      message: problem?.message ?? "Reversal requires verified underlying borrow, margin, capacity and rate"
    });
    return undefined;
  }
  return { value };
}

function callPutImpliedForward(call: OptionsParityLegSimulation, put: OptionsParityLegSimulation, context: Context, baseQuantity: number) {
  const spread = call.valuationCashAmount - put.valuationCashAmount;
  return context.primary.call.instrument.strikePrice + (spread / baseQuantity) * Math.exp(context.rate * context.years);
}

function strikeForLeg(context: Context, instrumentId: string) {
  const instruments = [
    context.primary.call.instrument,
    context.primary.put.instrument,
    context.request.secondary?.call?.instrument,
    context.request.secondary?.put?.instrument
  ];
  return instruments.find((instrument) => instrument?.instrumentId === instrumentId)?.strikePrice ?? context.primary.call.instrument.strikePrice;
}

function leg(legs: OptionsParityLegSimulation[], role: OptionsParityLegSimulation["role"]) {
  const found = legs.find((value) => value.role === role);
  if (!found) throw new Error(`Missing planned ${role} leg`);
  return found;
}

function candidateOrder(left: OptionsParityCandidate, right: OptionsParityCandidate) {
  return right.netEdgeValue - left.netEdgeValue || right.edgeBpsOfReferenceNotional - left.edgeBpsOfReferenceNotional || left.id.localeCompare(right.id);
}

function rejectionOrder(left: OptionsParityRejection, right: OptionsParityRejection) {
  return (left.strategyKind ?? "").localeCompare(right.strategyKind ?? "") || (left.instrumentId ?? "").localeCompare(right.instrumentId ?? "") || left.code.localeCompare(right.code);
}

function rejection(code: OptionsParityRejection["code"], message: string): OptionsParityRejection {
  return { code, message };
}

function positive(value: number) {
  return Number.isFinite(value) && value > 0;
}

function nonNegative(value: number) {
  return Number.isFinite(value) && value >= 0;
}

function positiveTimestamp(value: number) {
  return Number.isSafeInteger(value) && value > 0;
}
