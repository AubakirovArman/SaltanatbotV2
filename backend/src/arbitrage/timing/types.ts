export interface VenueClockProbe {
  sourceId: string;
  localSentAt: number;
  localReceivedAt: number;
  serverTime: number;
  /** Quantisation/error declared for the server timestamp. */
  serverResolutionMs: number;
}

export interface VenueClockSample {
  localSentAt: number;
  localReceivedAt: number;
  serverTime: number;
  serverResolutionMs: number;
  roundTripMs: number;
  offsetLowerMs: number;
  offsetUpperMs: number;
  offsetMidpointMs: number;
  uncertaintyMs: number;
}

export interface VenueClockSourceState {
  samples: VenueClockSample[];
  rejectedProbes: number;
  lastRejectedAt?: number;
  lastRejection?: "round-trip-too-high";
}

export interface VenueClockState {
  schemaVersion: 1;
  sources: Record<string, VenueClockSourceState>;
}

export interface VenueClockPolicy {
  maximumSamples: number;
  minimumConsistentSamples: number;
  sampleTtlMs: number;
  maximumProbeRoundTripMs: number;
  maximumCalibratedUncertaintyMs: number;
  maximumClockDriftPpm: number;
}

export interface VenueClockEstimate {
  sourceId: string;
  status: "calibrated" | "degraded" | "expired" | "unavailable";
  evaluatedAt: number;
  sampleCount: number;
  consistentSampleCount: number;
  sampledAt?: number;
  expiresAt?: number;
  roundTripMs?: number;
  minimumObservedRoundTripMs?: number;
  offsetLowerMs?: number;
  offsetUpperMs?: number;
  offsetMidpointMs?: number;
  uncertaintyMs?: number;
  rejectedProbes: number;
  reason?: "no-samples" | "sample-expired" | "insufficient-consistent-samples" | "uncertainty-too-high";
}

export interface VenueClockProbeResult {
  state: VenueClockState;
  accepted: boolean;
  rejection?: "round-trip-too-high";
  estimate: VenueClockEstimate;
}

export interface ExchangeTimestampAssessment {
  sourceId: string;
  exchangeTimestamp: number;
  evaluatedAt: number;
  clockStatus: VenueClockEstimate["status"];
  eligible: boolean;
  quality: "verified" | "degraded" | "unavailable";
  ageLowerMs?: number;
  ageUpperMs?: number;
  localEventEarliestAt?: number;
  localEventLatestAt?: number;
  reason?: "clock-unavailable" | "clock-not-calibrated" | "timestamp-definitely-future" | "timestamp-may-be-future" | "timestamp-stale";
}

export interface CrossVenueSkewAssessment {
  eligible: boolean;
  minimumPossibleSkewMs?: number;
  maximumPossibleSkewMs?: number;
  reason?: "clock-unavailable" | "clock-not-calibrated" | "skew-exceeded";
}

/**
 * Structural read-only boundary consumed by scanner engines. Implementations
 * must not perform I/O here: assessments are derived from already accepted,
 * bounded calibration state at one explicit `evaluatedAt`.
 */
export interface VenueClockAssessmentProvider {
  assessTimestamp(sourceId: string, exchangeTimestamp: number, evaluatedAt: number, limits: { maximumAgeMs: number; maximumFutureSkewMs: number }): ExchangeTimestampAssessment;
  assessSkew(left: ExchangeTimestampAssessment, right: ExchangeTimestampAssessment, maximumSkewMs: number): CrossVenueSkewAssessment;
}

export interface ScannerClockObservation {
  sourceId: string;
  exchangeTs: number;
  receivedAt: number;
}

export interface ScannerCalibratedClockLeg {
  sourceId: string;
  exchangeTs: number;
  clockStatus: "calibrated";
  ageLowerMs: number;
  ageUpperMs: number;
  localEventEarliestAt: number;
  localEventLatestAt: number;
}

export type ScannerClockBlockReason = "clock-unavailable" | "clock-not-calibrated" | "timestamp-definitely-future" | "timestamp-may-be-future" | "timestamp-stale" | "skew-exceeded";

export type ScannerObservationTiming =
  | {
      eligible: true;
      clockBasis: "calibrated-venue-interval";
      crossVenueComparable: true;
      ageLowerMs: number;
      ageUpperMs: number;
      leg: ScannerCalibratedClockLeg;
    }
  | {
      eligible: true;
      clockBasis: "local-receipt-fallback";
      crossVenueComparable: false;
      observedAt: number;
      ageMs: number;
      fallbackReason: "clock-provider-unavailable" | "clock-unavailable" | "clock-not-calibrated" | "source-declared-local-receipt";
    }
  | {
      eligible: false;
      reason: ScannerClockBlockReason;
      sourceId: string;
    };

export type ScannerPairTiming =
  | {
      eligible: true;
      clockBasis: "calibrated-venue-interval";
      crossVenueComparable: true;
      quoteAgeLowerMs: number;
      quoteAgeUpperMs: number;
      minimumPossibleLegSkewMs: number;
      maximumPossibleLegSkewMs: number;
      legs: readonly [ScannerCalibratedClockLeg, ScannerCalibratedClockLeg];
    }
  | {
      eligible: true;
      clockBasis: "local-receipt-fallback";
      crossVenueComparable: false;
      quoteAgeMs: number;
      legSkewMs: number;
      oldestReceivedAt: number;
      newestReceivedAt: number;
      fallbackReason: "same-venue-clock-unavailable" | "same-venue-clock-not-calibrated" | "clock-provider-unavailable";
    }
  | {
      eligible: false;
      reason: ScannerClockBlockReason;
      sourceId?: string;
      minimumPossibleLegSkewMs?: number;
      maximumPossibleLegSkewMs?: number;
    };
