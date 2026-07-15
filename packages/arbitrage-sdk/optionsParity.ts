import type {
  OptionsParityAssumptionContract,
  OptionsParityCandidate,
  OptionsParityDirection,
  OptionsParityEvaluationResponse,
  OptionsParityLegSimulation,
  OptionsParityRejection,
  OptionsParityRejectionCode,
  OptionsParityStrategyKind,
  OptionsParityTimestamps
} from "./optionsParityTypes.js";
import { array, exact, finite, integer, nonNegative, positive, record, text } from "./validation.js";

const STRATEGIES = ["put-call-parity", "conversion", "reversal", "box", "synthetic-forward"] as const;
const DIRECTIONS = ["call-rich", "put-rich", "long-box", "short-box", "long-synthetic", "short-synthetic"] as const;
const REJECTION_CODES = [
  "missing-leg",
  "identity-mismatch",
  "unsupported-exercise",
  "settlement-mismatch",
  "expired",
  "invalid-book",
  "incomplete-book",
  "stale-book",
  "skewed-books",
  "missing-assumption",
  "stale-assumption",
  "insufficient-depth",
  "step-mismatch",
  "short-capacity"
] as const satisfies readonly OptionsParityRejectionCode[];

const CONTRACT: OptionsParityAssumptionContract = {
  authority: "caller-supplied",
  expiry: "explicit-instrument-timestamp",
  settlement: "european-automatic-hold-to-expiry-cash-equivalent",
  settlementFx: "unsupported-settlement-must-equal-valuation-asset",
  premiumFx: "explicit-per-premium-asset",
  fees: "explicit-per-option-and-underlying",
  execution: "none"
};

/** Strict runtime parser for the credential-free options-parity research surface. */
export function parseOptionsParityEvaluation(value: unknown): OptionsParityEvaluationResponse {
  const row = strictRecord(
    value,
    "options-parity evaluation",
    ["engine", "readOnly", "researchOnly", "executable", "evaluatedAt", "edgeKind", "assumptionContract", "candidates", "rejections"]
  );
  const evaluatedAt = positiveSafeInteger(row.evaluatedAt, "evaluatedAt");
  const candidates = array(row.candidates, "candidates", 16).map((candidate, index) =>
    parseCandidate(candidate, evaluatedAt, `candidates[${index}]`)
  );
  const rejections = array(row.rejections, "rejections", 64).map((rejection, index) =>
    parseRejection(rejection, `rejections[${index}]`)
  );
  assertUnique(candidates.map((candidate) => candidate.id), "candidate IDs");
  assertCandidateOrder(candidates);
  return {
    engine: exact(row.engine, ["options-parity-v1"] as const, "engine"),
    readOnly: exactTrue(row.readOnly, "readOnly"),
    researchOnly: exactTrue(row.researchOnly, "researchOnly"),
    executable: exactFalse(row.executable, "executable"),
    evaluatedAt,
    edgeKind: exact(row.edgeKind, ["research-simulation"] as const, "edgeKind"),
    assumptionContract: parseContract(row.assumptionContract),
    candidates,
    rejections
  };
}

function parseContract(value: unknown): OptionsParityAssumptionContract {
  const row = strictRecord(value, "assumptionContract", Object.keys(CONTRACT));
  for (const [key, expected] of Object.entries(CONTRACT)) {
    if (row[key] !== expected) throw new Error(`assumptionContract.${key} is unsupported`);
  }
  return { ...CONTRACT };
}

function parseCandidate(value: unknown, evaluatedAt: number, label: string): OptionsParityCandidate {
  const row = strictRecord(value, label, [
    "id",
    "strategyKind",
    "direction",
    "edgeKind",
    "executable",
    "simulationBasis",
    "outcomeLabel",
    "underlyingAsset",
    "valuationAsset",
    "settlementAsset",
    "expiryTime",
    "strikes",
    "baseQuantity",
    "grossEdgeValue",
    "feesValue",
    "borrowCostValue",
    "netEdgeValue",
    "edgeBpsOfReferenceNotional",
    "referenceNotional",
    "fixedPayoffAtExpiry",
    "theoreticalForwardPrice",
    "impliedForwardPrice",
    "legs",
    "referenceUnderlying",
    "timestamps",
    "assumptionSources"
  ]);
  const strategyKind = exact(row.strategyKind, STRATEGIES, `${label}.strategyKind`);
  const direction = exact(row.direction, DIRECTIONS, `${label}.direction`);
  const legs = array(row.legs, `${label}.legs`, 4).map((leg, index) => parseLeg(leg, `${label}.legs[${index}]`));
  if (legs.length < 2) throw new Error(`${label}.legs must contain at least two legs`);
  const referenceUnderlying = row.referenceUnderlying === undefined
    ? undefined
    : parseLeg(row.referenceUnderlying, `${label}.referenceUnderlying`);
  const timestamps = parseTimestamps(row.timestamps, `${label}.timestamps`);
  const strikes = array(row.strikes, `${label}.strikes`, 2).map((strike, index) => positive(strike, `${label}.strikes[${index}]`));
  if (strikes.length < 1 || !strictlyIncreasing(strikes)) throw new Error(`${label}.strikes must be non-empty, unique and increasing`);
  const assumptionSources = array(row.assumptionSources, `${label}.assumptionSources`, 32).map((source, index) =>
    boundedText(source, `${label}.assumptionSources[${index}]`)
  );
  if (assumptionSources.length < 1 || !strictlyLexical(assumptionSources)) {
    throw new Error(`${label}.assumptionSources must be non-empty, unique and sorted`);
  }
  const candidate: OptionsParityCandidate = {
    id: boundedText(row.id, `${label}.id`, 600),
    strategyKind,
    direction,
    edgeKind: exact(row.edgeKind, ["research-simulation"] as const, `${label}.edgeKind`),
    executable: exactFalse(row.executable, `${label}.executable`),
    simulationBasis: exact(row.simulationBasis, ["visible-depth-taker"] as const, `${label}.simulationBasis`),
    outcomeLabel: exact(
      row.outcomeLabel,
      [
        "fixed-valuation-payoff-at-expiry-under-stated-assumptions",
        "parity-deviation-research-only-no-fixed-profit-without-hedge"
      ] as const,
      `${label}.outcomeLabel`
    ),
    underlyingAsset: boundedText(row.underlyingAsset, `${label}.underlyingAsset`),
    valuationAsset: boundedText(row.valuationAsset, `${label}.valuationAsset`),
    settlementAsset: boundedText(row.settlementAsset, `${label}.settlementAsset`),
    expiryTime: positiveSafeInteger(row.expiryTime, `${label}.expiryTime`),
    strikes,
    baseQuantity: positive(row.baseQuantity, `${label}.baseQuantity`),
    grossEdgeValue: finite(row.grossEdgeValue, `${label}.grossEdgeValue`),
    feesValue: nonNegative(row.feesValue, `${label}.feesValue`),
    borrowCostValue: nonNegative(row.borrowCostValue, `${label}.borrowCostValue`),
    netEdgeValue: finite(row.netEdgeValue, `${label}.netEdgeValue`),
    edgeBpsOfReferenceNotional: finite(row.edgeBpsOfReferenceNotional, `${label}.edgeBpsOfReferenceNotional`),
    referenceNotional: positive(row.referenceNotional, `${label}.referenceNotional`),
    ...(row.fixedPayoffAtExpiry === undefined ? {} : { fixedPayoffAtExpiry: finite(row.fixedPayoffAtExpiry, `${label}.fixedPayoffAtExpiry`) }),
    ...(row.theoreticalForwardPrice === undefined ? {} : { theoreticalForwardPrice: positive(row.theoreticalForwardPrice, `${label}.theoreticalForwardPrice`) }),
    ...(row.impliedForwardPrice === undefined ? {} : { impliedForwardPrice: finite(row.impliedForwardPrice, `${label}.impliedForwardPrice`) }),
    legs,
    ...(referenceUnderlying ? { referenceUnderlying } : {}),
    timestamps,
    assumptionSources
  };
  validateCandidate(candidate, evaluatedAt, label);
  return candidate;
}

function parseLeg(value: unknown, label: string): OptionsParityLegSimulation {
  const row = strictRecord(value, label, [
    "role",
    "instrumentId",
    "side",
    "bookSide",
    "nativeQuantity",
    "baseQuantity",
    "averagePrice",
    "worstPrice",
    "valuationCashAmount",
    "feeValuation",
    "levelsUsed",
    "exchangeTs",
    "receivedAt"
  ]);
  const side = exact(row.side, ["buy", "sell"] as const, `${label}.side`);
  const bookSide = exact(row.bookSide, ["asks", "bids"] as const, `${label}.bookSide`);
  if ((side === "buy" && bookSide !== "asks") || (side === "sell" && bookSide !== "bids")) {
    throw new Error(`${label} side does not match its consumed book side`);
  }
  const averagePrice = positive(row.averagePrice, `${label}.averagePrice`);
  const worstPrice = positive(row.worstPrice, `${label}.worstPrice`);
  if ((side === "buy" && worstPrice < averagePrice) || (side === "sell" && worstPrice > averagePrice)) {
    throw new Error(`${label}.worstPrice is inconsistent with side`);
  }
  const levelsUsed = integer(row.levelsUsed, `${label}.levelsUsed`);
  if (levelsUsed < 1 || levelsUsed > 400) throw new Error(`${label}.levelsUsed is outside the bounded book depth`);
  return {
    role: exact(row.role, ["call", "put", "underlying"] as const, `${label}.role`),
    instrumentId: boundedText(row.instrumentId, `${label}.instrumentId`),
    side,
    bookSide,
    nativeQuantity: positive(row.nativeQuantity, `${label}.nativeQuantity`),
    baseQuantity: positive(row.baseQuantity, `${label}.baseQuantity`),
    averagePrice,
    worstPrice,
    valuationCashAmount: positive(row.valuationCashAmount, `${label}.valuationCashAmount`),
    feeValuation: nonNegative(row.feeValuation, `${label}.feeValuation`),
    levelsUsed,
    exchangeTs: positiveSafeInteger(row.exchangeTs, `${label}.exchangeTs`),
    receivedAt: positiveSafeInteger(row.receivedAt, `${label}.receivedAt`)
  };
}

function parseTimestamps(value: unknown, label: string): OptionsParityTimestamps {
  const row = strictRecord(value, label, [
    "evaluatedAt",
    "oldestExchangeTs",
    "newestExchangeTs",
    "oldestReceivedAt",
    "newestReceivedAt",
    "quoteAgeMs",
    "legSkewMs",
    "oldestAssumptionAsOf",
    "assumptionAgeMs"
  ]);
  return {
    evaluatedAt: positiveSafeInteger(row.evaluatedAt, `${label}.evaluatedAt`),
    oldestExchangeTs: positiveSafeInteger(row.oldestExchangeTs, `${label}.oldestExchangeTs`),
    newestExchangeTs: positiveSafeInteger(row.newestExchangeTs, `${label}.newestExchangeTs`),
    oldestReceivedAt: positiveSafeInteger(row.oldestReceivedAt, `${label}.oldestReceivedAt`),
    newestReceivedAt: positiveSafeInteger(row.newestReceivedAt, `${label}.newestReceivedAt`),
    quoteAgeMs: nonNegativeSafeInteger(row.quoteAgeMs, `${label}.quoteAgeMs`),
    legSkewMs: nonNegativeSafeInteger(row.legSkewMs, `${label}.legSkewMs`),
    oldestAssumptionAsOf: positiveSafeInteger(row.oldestAssumptionAsOf, `${label}.oldestAssumptionAsOf`),
    assumptionAgeMs: nonNegativeSafeInteger(row.assumptionAgeMs, `${label}.assumptionAgeMs`)
  };
}

function parseRejection(value: unknown, label: string): OptionsParityRejection {
  const row = strictRecord(value, label, ["strategyKind", "seriesId", "instrumentId", "code", "message"]);
  return {
    ...(row.strategyKind === undefined ? {} : { strategyKind: exact(row.strategyKind, STRATEGIES, `${label}.strategyKind`) }),
    ...(row.seriesId === undefined ? {} : { seriesId: boundedText(row.seriesId, `${label}.seriesId`) }),
    ...(row.instrumentId === undefined ? {} : { instrumentId: boundedText(row.instrumentId, `${label}.instrumentId`) }),
    code: exact(row.code, REJECTION_CODES, `${label}.code`),
    message: boundedText(row.message, `${label}.message`, 1_000)
  };
}

function validateCandidate(candidate: OptionsParityCandidate, evaluatedAt: number, label: string) {
  if (candidate.timestamps.evaluatedAt !== evaluatedAt) throw new Error(`${label}.timestamps.evaluatedAt does not match the envelope`);
  if (candidate.expiryTime <= evaluatedAt) throw new Error(`${label}.expiryTime is not in the future`);
  if (candidate.settlementAsset !== candidate.valuationAsset) throw new Error(`${label} requires an unmodelled settlement FX conversion`);
  assertApproximately(candidate.netEdgeValue, candidate.grossEdgeValue - candidate.feesValue - candidate.borrowCostValue, `${label}.netEdgeValue`);
  assertApproximately(candidate.edgeBpsOfReferenceNotional, (candidate.netEdgeValue / candidate.referenceNotional) * 10_000, `${label}.edgeBpsOfReferenceNotional`);
  assertApproximately(candidate.feesValue, candidate.legs.reduce((sum, leg) => sum + leg.feeValuation, 0), `${label}.feesValue`);
  for (const leg of candidate.legs) assertApproximately(leg.baseQuantity, candidate.baseQuantity, `${label} leg baseQuantity`);
  validateStrategyShape(candidate, label);
  validateTimestamps(candidate, evaluatedAt, label);
}

function validateStrategyShape(candidate: OptionsParityCandidate, label: string) {
  const specs: Record<OptionsParityStrategyKind, { directions: OptionsParityDirection[]; legs: number; fixed: boolean; reference: boolean; prefix: string }> = {
    "put-call-parity": { directions: ["call-rich", "put-rich"], legs: 2, fixed: false, reference: true, prefix: "options-parity:" },
    conversion: { directions: ["call-rich"], legs: 3, fixed: true, reference: false, prefix: "options-conversion:" },
    reversal: { directions: ["put-rich"], legs: 3, fixed: true, reference: false, prefix: "options-reversal:" },
    box: { directions: ["long-box", "short-box"], legs: 4, fixed: true, reference: false, prefix: "options-box:" },
    "synthetic-forward": { directions: ["long-synthetic", "short-synthetic"], legs: 2, fixed: false, reference: true, prefix: "options-synthetic:" }
  };
  const spec = specs[candidate.strategyKind];
  if (!spec.directions.includes(candidate.direction) || candidate.legs.length !== spec.legs || !candidate.id.startsWith(spec.prefix)) {
    throw new Error(`${label} strategy shape is inconsistent`);
  }
  const fixed = candidate.fixedPayoffAtExpiry !== undefined;
  const reference = candidate.referenceUnderlying !== undefined;
  if (fixed !== spec.fixed || reference !== spec.reference) throw new Error(`${label} payoff/reference shape is inconsistent`);
  const expectedOutcome = spec.fixed
    ? "fixed-valuation-payoff-at-expiry-under-stated-assumptions"
    : "parity-deviation-research-only-no-fixed-profit-without-hedge";
  if (candidate.outcomeLabel !== expectedOutcome) throw new Error(`${label}.outcomeLabel is inconsistent with strategy`);
  const forwardFields = candidate.theoreticalForwardPrice !== undefined && candidate.impliedForwardPrice !== undefined;
  if (forwardFields !== spec.reference) throw new Error(`${label} forward-price fields are inconsistent with strategy`);
  if (candidate.referenceUnderlying && candidate.referenceUnderlying.role !== "underlying") throw new Error(`${label}.referenceUnderlying has an invalid role`);
  if (candidate.strategyKind !== "reversal" && candidate.borrowCostValue !== 0) throw new Error(`${label}.borrowCostValue is only valid for reversal`);
  const roles = candidate.legs.map((leg) => leg.role).sort();
  const expectedRoles = spec.legs === 2 ? ["call", "put"] : spec.legs === 3 ? ["call", "put", "underlying"] : ["call", "call", "put", "put"];
  if (roles.join("|") !== expectedRoles.join("|")) throw new Error(`${label} leg roles are inconsistent with strategy`);
}

function validateTimestamps(candidate: OptionsParityCandidate, evaluatedAt: number, label: string) {
  const legs = [...candidate.legs, ...(candidate.referenceUnderlying ? [candidate.referenceUnderlying] : [])];
  const exchange = legs.map((leg) => leg.exchangeTs);
  const received = legs.map((leg) => leg.receivedAt);
  const timestamps = candidate.timestamps;
  if (
    timestamps.oldestExchangeTs !== Math.min(...exchange) ||
    timestamps.newestExchangeTs !== Math.max(...exchange) ||
    timestamps.oldestReceivedAt !== Math.min(...received) ||
    timestamps.newestReceivedAt !== Math.max(...received)
  ) throw new Error(`${label}.timestamps do not match leg provenance`);
  const expectedAge = Math.max(0, evaluatedAt - timestamps.oldestExchangeTs, evaluatedAt - timestamps.oldestReceivedAt);
  const expectedSkew = Math.max(timestamps.newestExchangeTs - timestamps.oldestExchangeTs, timestamps.newestReceivedAt - timestamps.oldestReceivedAt);
  if (timestamps.quoteAgeMs !== expectedAge || timestamps.legSkewMs !== expectedSkew) throw new Error(`${label} quote age/skew is inconsistent`);
  if (timestamps.assumptionAgeMs !== Math.max(0, evaluatedAt - timestamps.oldestAssumptionAsOf)) {
    throw new Error(`${label}.timestamps.assumptionAgeMs is inconsistent`);
  }
}

function strictRecord(value: unknown, label: string, allowedKeys: readonly string[]) {
  const row = record(value, label);
  const allowed = new Set(allowedKeys);
  const unexpected = Object.keys(row).filter((key) => !allowed.has(key));
  if (unexpected.length) throw new Error(`${label} contains unsupported fields: ${unexpected.sort().join(", ")}`);
  return row;
}

function boundedText(value: unknown, label: string, maximum = 200) {
  const parsed = text(value, label);
  if (parsed.length > maximum || parsed.trim() !== parsed) throw new Error(`${label} must be trimmed and at most ${maximum} characters`);
  return parsed;
}

function positiveSafeInteger(value: unknown, label: string) {
  const parsed = finite(value, label);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive safe integer`);
  return parsed;
}

function nonNegativeSafeInteger(value: unknown, label: string) {
  const parsed = finite(value, label);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} must be a non-negative safe integer`);
  return parsed;
}

function exactTrue(value: unknown, label: string): true {
  if (value !== true) throw new Error(`${label} must be true`);
  return true;
}

function exactFalse(value: unknown, label: string): false {
  if (value !== false) throw new Error(`${label} must be false`);
  return false;
}

function assertApproximately(actual: number, expected: number, label: string) {
  const tolerance = Math.max(1e-9, Math.abs(expected) * 1e-9);
  if (Math.abs(actual - expected) > tolerance) throw new Error(`${label} is inconsistent`);
}

function strictlyIncreasing(values: number[]) {
  return values.every((value, index) => index === 0 || value > values[index - 1]!);
}

function strictlyLexical(values: string[]) {
  return values.every((value, index) => index === 0 || value.localeCompare(values[index - 1]!) > 0);
}

function assertUnique(values: string[], label: string) {
  if (new Set(values).size !== values.length) throw new Error(`${label} must be unique`);
}

function assertCandidateOrder(candidates: OptionsParityCandidate[]) {
  for (let index = 1; index < candidates.length; index += 1) {
    const previous = candidates[index - 1]!;
    const current = candidates[index]!;
    if (
      current.netEdgeValue > previous.netEdgeValue ||
      (current.netEdgeValue === previous.netEdgeValue && current.edgeBpsOfReferenceNotional > previous.edgeBpsOfReferenceNotional)
    ) throw new Error("candidates are not sorted by descending edge");
  }
}
