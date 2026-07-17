import { createHash } from "node:crypto";
import { parsePriceThresholdAlertDefinitionV1, type Candle, type PriceAlertTimeframeV1, type PriceThresholdAlertDefinitionV1 } from "@saltanatbotv2/contracts";
import { timeframeMs } from "../market/timeframes.js";
import { priceMatchesThreshold } from "./priceDecimal.js";

export const PRICE_THRESHOLD_OBSERVATION_SCHEMA_V1 = "price-threshold-observation-v1" as const;

export type ClosedCandleWindowUnavailableReason = "invalid-clock" | "unsupported-timeframe" | "empty-candle-window" | "malformed-candle" | "malformed-candle-sequence" | "non-final-candle" | "candle-not-closed" | "candle-gap" | "stale-candle-window";

export interface PriceThresholdAlertRuntimeStateV1 {
  status: "armed" | "triggered";
  /** Server time at which this revision was armed. */
  armedAt: number;
  /** Whether this revision has consumed its first trustworthy observation. */
  initialized: boolean;
  /** Result of the predicate at the final candle durably consumed. */
  eligible: boolean;
  /** Open time of the final candle durably consumed by this rule revision. */
  lastEvaluatedBarTime?: number;
  triggeredByTransitionKey?: string;
}

export interface PriceThresholdAlertEvaluationInputV1 {
  ruleId: string;
  ruleRevision: number;
  definition: PriceThresholdAlertDefinitionV1;
  state: PriceThresholdAlertRuntimeStateV1;
  candles: readonly Candle[];
  /** Server observation time. Exchange timestamps never replace this clock. */
  now: number;
}

export interface PriceThresholdObservationV1 {
  schemaVersion: typeof PRICE_THRESHOLD_OBSERVATION_SCHEMA_V1;
  subjectKey: string;
  observationKey: string;
  evidenceFingerprint: string;
  candleOpenTime: number;
  candleCloseTime: number;
  evaluatedAt: number;
  close: number;
  researchOnly: true;
  executionPermission: false;
}

/** Repository-neutral input for an atomic armed -> triggered transition. */
export interface PriceThresholdTriggeredTransitionInputV1 {
  kind: "price-threshold-triggered";
  ruleId: string;
  ruleRevision: number;
  from: "armed";
  to: "triggered";
  subjectKey: string;
  transitionKey: string;
  observationKey: string;
  evidenceFingerprint: string;
  occurredAt: number;
  observedPrice: number;
  threshold: string;
  direction: "above" | "below";
  researchOnly: true;
  executionPermission: false;
}

export type PriceThresholdAlertEvaluationResultV1 =
  | {
      status: "evaluated";
      scopeKey: string;
      evaluatedBars: number;
      triggered: boolean;
      observation: PriceThresholdObservationV1;
      transition?: PriceThresholdTriggeredTransitionInputV1;
      nextState: PriceThresholdAlertRuntimeStateV1;
    }
  | {
      status: "idle";
      reason: "rule-disabled" | "already-triggered" | "no-new-closed-candle";
      scopeKey: string;
      nextState: PriceThresholdAlertRuntimeStateV1;
    }
  | {
      status: "unavailable";
      reason: "invalid-definition" | "invalid-evaluation-input" | "cursor-ahead" | "cursor-gap" | "strategy-evaluation-failed" | ClosedCandleWindowUnavailableReason;
      scopeKey?: string;
      nextState: PriceThresholdAlertRuntimeStateV1;
    };

export type ClosedCandleWindowValidation = { ok: true; intervalMs: number; candles: readonly Candle[] } | { ok: false; reason: ClosedCandleWindowUnavailableReason };

export interface ClosedCandleWindowValidationOptions {
  /**
   * A historical tip is accepted only while continuing a durable cursor. Callers
   * must not enable this for an alert revision that has not consumed a bar yet.
   */
  allowHistoricalTip?: boolean;
}

const RULE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX_64 = /^[0-9a-f]{64}$/;

/**
 * Validate the exact closed-candle evidence accepted by alert evaluation.
 * Missing, forming, future, stale and discontinuous data all fail closed.
 */
export function validateClosedCandleWindow(candles: readonly Candle[], timeframe: PriceAlertTimeframeV1, now: number, options: ClosedCandleWindowValidationOptions = {}): ClosedCandleWindowValidation {
  if (!validTimestamp(now)) return { ok: false, reason: "invalid-clock" };
  const intervalMs = intervalFor(timeframe);
  if (intervalMs === undefined) {
    return { ok: false, reason: "unsupported-timeframe" };
  }
  if (!Array.isArray(candles) || candles.length === 0) {
    return { ok: false, reason: "empty-candle-window" };
  }

  let previousTime: number | undefined;
  for (const candle of candles) {
    if (!candleHasFiniteMarketShape(candle)) {
      return { ok: false, reason: "malformed-candle" };
    }
    if (candle.final !== true) {
      return { ok: false, reason: "non-final-candle" };
    }
    if (candle.time + intervalMs > now) {
      return { ok: false, reason: "candle-not-closed" };
    }
    if (previousTime !== undefined) {
      const delta = candle.time - previousTime;
      if (delta <= 0 || delta < intervalMs || delta % intervalMs !== 0) {
        return { ok: false, reason: "malformed-candle-sequence" };
      }
      if (delta !== intervalMs) {
        return { ok: false, reason: "candle-gap" };
      }
    }
    previousTime = candle.time;
  }

  const latest = candles[candles.length - 1]!;
  if (!options.allowHistoricalTip && now - (latest.time + intervalMs) > intervalMs) {
    return { ok: false, reason: "stale-candle-window" };
  }
  return { ok: true, intervalMs, candles };
}

/** Strict finite OHLCV geometry shared with the public reader. */
export function candleHasFiniteMarketShape(candle: Candle): boolean {
  if (!validTimestamp(candle.time)) return false;
  const values = [candle.open, candle.high, candle.low, candle.close, candle.volume];
  if (!values.every((value) => typeof value === "number" && Number.isFinite(value))) {
    return false;
  }
  if (candle.open <= 0 || candle.high <= 0 || candle.low <= 0 || candle.close <= 0 || candle.volume < 0) {
    return false;
  }
  return candle.high >= Math.max(candle.open, candle.close, candle.low) && candle.low <= Math.min(candle.open, candle.close, candle.high);
}

/** Stable market scope used by later durable scheduling and grouping. */
export function priceThresholdAlertScopeKey(definition: Pick<PriceThresholdAlertDefinitionV1, "exchange" | "marketType" | "priceType" | "symbol" | "timeframe">): string {
  return `market:${definition.exchange}:${definition.marketType}:${definition.priceType}:${definition.symbol}:${definition.timeframe}`;
}

/**
 * Evaluate one rule revision over a trusted closed-candle window. The inclusive
 * comparison uses the shared exact-decimal alert comparator so a declared
 * threshold is never rounded onto a market-price double. This function has no
 * persistence or delivery side effects.
 */
export function evaluatePriceThresholdAlert(input: PriceThresholdAlertEvaluationInputV1): PriceThresholdAlertEvaluationResultV1 {
  const unchangedState = copyState(input.state);
  let definition: PriceThresholdAlertDefinitionV1;
  try {
    definition = parsePriceThresholdAlertDefinitionV1(input.definition);
  } catch {
    return {
      status: "unavailable",
      reason: "invalid-definition",
      nextState: unchangedState
    };
  }
  const scopeKey = priceThresholdAlertScopeKey(definition);
  if (!validEvaluationIdentity(input, input.now)) {
    return {
      status: "unavailable",
      reason: "invalid-evaluation-input",
      scopeKey,
      nextState: unchangedState
    };
  }
  if (!definition.enabled) {
    return {
      status: "idle",
      reason: "rule-disabled",
      scopeKey,
      nextState: unchangedState
    };
  }
  if (input.state.status === "triggered") {
    return {
      status: "idle",
      reason: "already-triggered",
      scopeKey,
      nextState: unchangedState
    };
  }

  const cursor = input.state.lastEvaluatedBarTime;
  const window = validateClosedCandleWindow(input.candles, definition.timeframe, input.now, {
    allowHistoricalTip: cursor !== undefined || !input.state.initialized
  });
  if (!window.ok) {
    return {
      status: "unavailable",
      reason: window.reason,
      scopeKey,
      nextState: unchangedState
    };
  }

  const latestTime = window.candles[window.candles.length - 1]!.time;
  if (cursor !== undefined && cursor > latestTime) {
    return {
      status: "unavailable",
      reason: "cursor-ahead",
      scopeKey,
      nextState: unchangedState
    };
  }

  let candidates = window.candles.map((candle, index) => ({ candle, index })).filter(({ candle }) => candle.time > (cursor ?? -1));
  if (cursor === undefined) {
    const firstArmedBar = window.candles.map((candle, index) => ({ candle, index })).find(({ candle }) => candle.time <= input.state.armedAt && input.state.armedAt < candle.time + window.intervalMs);
    if (!firstArmedBar) {
      if (latestTime + window.intervalMs <= input.state.armedAt) {
        return {
          status: "idle",
          reason: "no-new-closed-candle",
          scopeKey,
          nextState: unchangedState
        };
      }
      return {
        status: "unavailable",
        reason: "cursor-gap",
        scopeKey,
        nextState: unchangedState
      };
    }
    candidates = [firstArmedBar];
  }
  if (candidates.length === 0) {
    return {
      status: "idle",
      reason: "no-new-closed-candle",
      scopeKey,
      nextState: unchangedState
    };
  }
  if (cursor !== undefined && candidates[0]!.candle.time !== cursor + window.intervalMs) {
    return {
      status: "unavailable",
      reason: "cursor-gap",
      scopeKey,
      nextState: unchangedState
    };
  }
  // One durable state revision consumes exactly one closed bar. Backlogs are
  // drained by later claims so completion can prove that no cursor was skipped.
  candidates = candidates.slice(0, 1);

  let lastObservation: PriceThresholdObservationV1 | undefined;
  let evaluatedBars = 0;
  let initialized = input.state.initialized;
  let previousEligible = input.state.eligible;
  for (const candidate of candidates) {
    const observation = observationFor(definition, candidate.candle, window.intervalMs, input.now);
    lastObservation = observation;
    evaluatedBars += 1;
    const matched = priceMatchesThreshold(candidate.candle.close, definition.threshold, definition.direction);
    const crossed = initialized && !previousEligible && matched;
    initialized = true;
    previousEligible = matched;
    if (!crossed) continue;

    const transition = transitionFor(input.ruleId, input.ruleRevision, definition, observation);
    return {
      status: "evaluated",
      scopeKey,
      evaluatedBars,
      triggered: true,
      observation,
      transition,
      nextState: {
        status: "triggered",
        armedAt: input.state.armedAt,
        initialized: true,
        eligible: true,
        lastEvaluatedBarTime: candidate.candle.time,
        triggeredByTransitionKey: transition.transitionKey
      }
    };
  }

  return {
    status: "evaluated",
    scopeKey,
    evaluatedBars,
    triggered: false,
    observation: lastObservation!,
    nextState: {
      status: "armed",
      armedAt: input.state.armedAt,
      initialized,
      eligible: previousEligible,
      lastEvaluatedBarTime: candidates[candidates.length - 1]!.candle.time
    }
  };
}

function observationFor(definition: PriceThresholdAlertDefinitionV1, candle: Candle, intervalMs: number, evaluatedAt: number): PriceThresholdObservationV1 {
  const subjectKey = priceThresholdAlertScopeKey(definition);
  const observationKey = `${subjectKey}:bar:${candle.time}`;
  const evidenceFingerprint = digest([PRICE_THRESHOLD_OBSERVATION_SCHEMA_V1, subjectKey, candle.time, candle.open, candle.high, candle.low, candle.close, candle.volume, true]);
  return {
    schemaVersion: PRICE_THRESHOLD_OBSERVATION_SCHEMA_V1,
    subjectKey,
    observationKey,
    evidenceFingerprint,
    candleOpenTime: candle.time,
    candleCloseTime: candle.time + intervalMs,
    evaluatedAt,
    close: candle.close,
    researchOnly: true,
    executionPermission: false
  };
}

function transitionFor(ruleId: string, ruleRevision: number, definition: PriceThresholdAlertDefinitionV1, observation: PriceThresholdObservationV1): PriceThresholdTriggeredTransitionInputV1 {
  const transitionKey = digest(["price-threshold-transition-v1", ruleId, ruleRevision, definition.direction, definition.threshold, observation.observationKey, observation.evidenceFingerprint]);
  return {
    kind: "price-threshold-triggered",
    ruleId,
    ruleRevision,
    from: "armed",
    to: "triggered",
    subjectKey: observation.subjectKey,
    transitionKey,
    observationKey: observation.observationKey,
    evidenceFingerprint: observation.evidenceFingerprint,
    occurredAt: observation.candleCloseTime,
    observedPrice: observation.close,
    threshold: definition.threshold,
    direction: definition.direction,
    researchOnly: true,
    executionPermission: false
  };
}

function validEvaluationIdentity(input: PriceThresholdAlertEvaluationInputV1, now: number): boolean {
  if (typeof input.ruleId !== "string" || !RULE_ID.test(input.ruleId) || !Number.isSafeInteger(input.ruleRevision) || input.ruleRevision < 1 || !validTimestamp(now) || (input.state.status !== "armed" && input.state.status !== "triggered") || !validTimestamp(input.state.armedAt) || input.state.armedAt > now) {
    return false;
  }
  if (typeof input.state.initialized !== "boolean" || typeof input.state.eligible !== "boolean") {
    return false;
  }
  const cursor = input.state.lastEvaluatedBarTime;
  if (cursor !== undefined && !validTimestamp(cursor)) return false;
  if (!input.state.initialized && (input.state.eligible || cursor !== undefined)) {
    return false;
  }
  if (input.state.initialized && cursor === undefined) return false;
  const transitionKey = input.state.triggeredByTransitionKey;
  if (transitionKey !== undefined && !HEX_64.test(transitionKey)) return false;
  if (input.state.status === "armed" && transitionKey !== undefined) return false;
  if (input.state.status === "triggered" && (transitionKey === undefined || !input.state.initialized || !input.state.eligible)) {
    return false;
  }
  return true;
}

function copyState(state: PriceThresholdAlertRuntimeStateV1): PriceThresholdAlertRuntimeStateV1 {
  return {
    status: state.status,
    armedAt: state.armedAt,
    initialized: state.initialized,
    eligible: state.eligible,
    ...(state.lastEvaluatedBarTime === undefined ? {} : { lastEvaluatedBarTime: state.lastEvaluatedBarTime }),
    ...(state.triggeredByTransitionKey === undefined ? {} : { triggeredByTransitionKey: state.triggeredByTransitionKey })
  };
}

function intervalFor(timeframe: PriceAlertTimeframeV1): number | undefined {
  const value = timeframeMs[timeframe];
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function validTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
