import type { ExchangeTimestampAssessment, ScannerCalibratedClockLeg, ScannerClockObservation, ScannerObservationTiming, ScannerPairTiming, VenueClockAssessmentProvider } from "./types.js";

interface ScannerTimingLimits {
  maximumAgeMs: number;
  maximumFutureSkewMs: number;
}

interface ScannerPairTimingLimits extends ScannerTimingLimits {
  maximumSkewMs: number;
  requireCalibrated: boolean;
}

/**
 * Converts one venue timestamp to a conservative local-time interval. A
 * receipt fallback is allowed only when the caller explicitly permits it;
 * calibrated-but-invalid exchange timestamps never downgrade to a fallback.
 */
export function assessScannerObservationTiming(
  provider: VenueClockAssessmentProvider | undefined,
  observation: ScannerClockObservation,
  evaluatedAt: number,
  limits: ScannerTimingLimits,
  options: {
    allowLocalReceiptFallback: boolean;
    sourceDeclaredLocalReceipt?: boolean;
  }
): ScannerObservationTiming {
  validateObservation(observation, evaluatedAt, limits);
  if (options.sourceDeclaredLocalReceipt) {
    return receiptObservation(observation, evaluatedAt, limits, "source-declared-local-receipt");
  }
  if (!provider) {
    return options.allowLocalReceiptFallback ? receiptObservation(observation, evaluatedAt, limits, "clock-provider-unavailable") : { eligible: false, reason: "clock-unavailable", sourceId: observation.sourceId };
  }

  const assessment = provider.assessTimestamp(observation.sourceId, observation.exchangeTs, evaluatedAt, limits);
  if (assessment.eligible) return calibratedObservation(assessment);
  const reason = assessment.reason ?? (assessment.clockStatus === "unavailable" ? "clock-unavailable" : "clock-not-calibrated");
  if (options.allowLocalReceiptFallback && (reason === "clock-unavailable" || reason === "clock-not-calibrated")) {
    return receiptObservation(observation, evaluatedAt, limits, reason);
  }
  return { eligible: false, reason, sourceId: observation.sourceId };
}

/**
 * Pairwise scanner timing. Cross-venue callers set `requireCalibrated`; then
 * missing, degraded or expired clocks and worst-case interval skew all block.
 */
export function assessScannerPairTiming(provider: VenueClockAssessmentProvider | undefined, observations: readonly [ScannerClockObservation, ScannerClockObservation], evaluatedAt: number, limits: ScannerPairTimingLimits): ScannerPairTiming {
  if (!Number.isSafeInteger(limits.maximumSkewMs) || limits.maximumSkewMs < 0) {
    throw new TypeError("maximumSkewMs must be a non-negative safe integer");
  }
  for (const observation of observations) validateObservation(observation, evaluatedAt, limits);
  const receiptProblem = receiptPairProblem(observations, evaluatedAt, limits);
  if (receiptProblem) return receiptProblem;
  if (!provider) {
    return limits.requireCalibrated ? { eligible: false, reason: "clock-unavailable" } : receiptPair(observations, evaluatedAt, "clock-provider-unavailable");
  }
  const assessments = observations.map((observation) => provider.assessTimestamp(observation.sourceId, observation.exchangeTs, evaluatedAt, limits)) as [ExchangeTimestampAssessment, ExchangeTimestampAssessment];
  const invalid = assessments.find((assessment) => !assessment.eligible);
  if (invalid) {
    const reason = invalid.reason ?? (invalid.clockStatus === "unavailable" ? "clock-unavailable" : "clock-not-calibrated");
    if (!limits.requireCalibrated && (reason === "clock-unavailable" || reason === "clock-not-calibrated")) {
      return receiptPair(observations, evaluatedAt, reason === "clock-unavailable" ? "same-venue-clock-unavailable" : "same-venue-clock-not-calibrated");
    }
    return { eligible: false, reason, sourceId: invalid.sourceId };
  }
  const skew = provider.assessSkew(assessments[0], assessments[1], limits.maximumSkewMs);
  if (!skew.eligible) {
    return {
      eligible: false,
      reason: skew.reason ?? "skew-exceeded",
      minimumPossibleLegSkewMs: skew.minimumPossibleSkewMs,
      maximumPossibleLegSkewMs: skew.maximumPossibleSkewMs
    };
  }
  if (skew.minimumPossibleSkewMs === undefined || skew.maximumPossibleSkewMs === undefined) {
    return { eligible: false, reason: "clock-unavailable" };
  }
  const legs = assessments.map(calibratedLeg) as [ScannerCalibratedClockLeg, ScannerCalibratedClockLeg];
  return {
    eligible: true,
    clockBasis: "calibrated-venue-interval",
    crossVenueComparable: true,
    quoteAgeLowerMs: Math.max(...legs.map(({ ageLowerMs }) => ageLowerMs)),
    quoteAgeUpperMs: Math.max(...legs.map(({ ageUpperMs }) => ageUpperMs)),
    minimumPossibleLegSkewMs: skew.minimumPossibleSkewMs,
    maximumPossibleLegSkewMs: skew.maximumPossibleSkewMs,
    legs
  };
}

function calibratedObservation(assessment: ExchangeTimestampAssessment): Extract<ScannerObservationTiming, { clockBasis: "calibrated-venue-interval" }> {
  const leg = calibratedLeg(assessment);
  return {
    eligible: true,
    clockBasis: "calibrated-venue-interval",
    crossVenueComparable: true,
    ageLowerMs: leg.ageLowerMs,
    ageUpperMs: leg.ageUpperMs,
    leg
  };
}

function calibratedLeg(assessment: ExchangeTimestampAssessment): ScannerCalibratedClockLeg {
  if (assessment.clockStatus !== "calibrated" || !assessment.eligible || assessment.ageLowerMs === undefined || assessment.ageUpperMs === undefined || assessment.localEventEarliestAt === undefined || assessment.localEventLatestAt === undefined) {
    throw new Error("Eligible calibrated scanner timing is missing interval evidence");
  }
  return {
    sourceId: assessment.sourceId,
    exchangeTs: assessment.exchangeTimestamp,
    clockStatus: "calibrated",
    ageLowerMs: assessment.ageLowerMs,
    ageUpperMs: assessment.ageUpperMs,
    localEventEarliestAt: assessment.localEventEarliestAt,
    localEventLatestAt: assessment.localEventLatestAt
  };
}

function receiptObservation(observation: ScannerClockObservation, evaluatedAt: number, limits: ScannerTimingLimits, fallbackReason: Extract<ScannerObservationTiming, { clockBasis: "local-receipt-fallback" }>["fallbackReason"]): ScannerObservationTiming {
  const ageMs = evaluatedAt - observation.receivedAt;
  if (ageMs < -limits.maximumFutureSkewMs) return { eligible: false, reason: "timestamp-definitely-future", sourceId: observation.sourceId };
  if (ageMs > limits.maximumAgeMs) return { eligible: false, reason: "timestamp-stale", sourceId: observation.sourceId };
  return {
    eligible: true,
    clockBasis: "local-receipt-fallback",
    crossVenueComparable: false,
    observedAt: observation.receivedAt,
    ageMs: Math.max(0, ageMs),
    fallbackReason
  };
}

function receiptPair(observations: readonly [ScannerClockObservation, ScannerClockObservation], evaluatedAt: number, fallbackReason: Extract<ScannerPairTiming, { clockBasis: "local-receipt-fallback" }>["fallbackReason"]): ScannerPairTiming {
  const received = observations.map(({ receivedAt }) => receivedAt);
  const oldestReceivedAt = Math.min(...received);
  const newestReceivedAt = Math.max(...received);
  return {
    eligible: true,
    clockBasis: "local-receipt-fallback",
    crossVenueComparable: false,
    quoteAgeMs: Math.max(0, evaluatedAt - oldestReceivedAt),
    legSkewMs: newestReceivedAt - oldestReceivedAt,
    oldestReceivedAt,
    newestReceivedAt,
    fallbackReason
  };
}

function receiptPairProblem(observations: readonly [ScannerClockObservation, ScannerClockObservation], evaluatedAt: number, limits: ScannerPairTimingLimits): Extract<ScannerPairTiming, { eligible: false }> | undefined {
  for (const observation of observations) {
    const ageMs = evaluatedAt - observation.receivedAt;
    if (ageMs < -limits.maximumFutureSkewMs) {
      return { eligible: false, reason: "timestamp-definitely-future", sourceId: observation.sourceId };
    }
    if (ageMs > limits.maximumAgeMs) return { eligible: false, reason: "timestamp-stale", sourceId: observation.sourceId };
  }
  const skewMs = Math.abs(observations[0].receivedAt - observations[1].receivedAt);
  if (skewMs > limits.maximumSkewMs) {
    return { eligible: false, reason: "skew-exceeded", minimumPossibleLegSkewMs: skewMs, maximumPossibleLegSkewMs: skewMs };
  }
  return undefined;
}

function validateObservation(observation: ScannerClockObservation, evaluatedAt: number, limits: ScannerTimingLimits) {
  if (!observation.sourceId.trim()) throw new TypeError("Scanner clock sourceId is required");
  for (const [label, value] of [
    ["exchangeTs", observation.exchangeTs],
    ["receivedAt", observation.receivedAt],
    ["evaluatedAt", evaluatedAt]
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive safe timestamp`);
  }
  for (const [label, value] of [
    ["maximumAgeMs", limits.maximumAgeMs],
    ["maximumFutureSkewMs", limits.maximumFutureSkewMs]
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative safe integer`);
  }
}
