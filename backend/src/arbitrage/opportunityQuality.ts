import type { ArbitrageOpportunity } from "./types.js";
import type { CrossVenueSkewAssessment, ExchangeTimestampAssessment } from "./timing/types.js";

export const MAX_ARBITRAGE_QUOTE_AGE_MS = 10_000;
export const MAX_ARBITRAGE_LEG_SKEW_MS = 3_000;
export const MAX_ARBITRAGE_FUTURE_CLOCK_SKEW_MS = 1_000;

export interface ArbitrageClockCalibration {
  snapshot(signal?: AbortSignal): Promise<unknown>;
  assessTimestamp(sourceId: string, exchangeTimestamp: number, evaluatedAt: number, limits: { maximumAgeMs: number; maximumFutureSkewMs: number }): ExchangeTimestampAssessment;
  assessSkew(left: ExchangeTimestampAssessment, right: ExchangeTimestampAssessment, maximumSkewMs: number): CrossVenueSkewAssessment;
}

export function refreshOpportunityQuality(opportunity: ArbitrageOpportunity, now = Date.now(), clockCalibration?: Pick<ArbitrageClockCalibration, "assessTimestamp" | "assessSkew">): ArbitrageOpportunity {
  const spotReceivedAtVerified = validSourceTimestamp(opportunity.spotReceivedAt, now);
  const futuresReceivedAtVerified = validSourceTimestamp(opportunity.futuresReceivedAt, now);
  const spotExchangeTimestampPresent = opportunity.spotExchangeTimestampVerified && validMillisecondTimestamp(opportunity.spotExchangeTs);
  const futuresExchangeTimestampPresent = opportunity.futuresExchangeTimestampVerified && validMillisecondTimestamp(opportunity.futuresExchangeTs);
  if (clockCalibration && spotExchangeTimestampPresent && futuresExchangeTimestampPresent) {
    return refreshClockCorrectedQuality(opportunity, now, clockCalibration, spotReceivedAtVerified, futuresReceivedAtVerified);
  }
  const spotExchangeTsVerified = opportunity.spotExchangeTimestampVerified && validSourceTimestamp(opportunity.spotExchangeTs, now);
  const futuresExchangeTsVerified = opportunity.futuresExchangeTimestampVerified && validSourceTimestamp(opportunity.futuresExchangeTs, now);
  const spotAge = Math.max(timestampAge(opportunity.spotReceivedAt, now), spotExchangeTsVerified ? timestampAge(opportunity.spotExchangeTs, now) : 0);
  const futuresAge = Math.max(timestampAge(opportunity.futuresReceivedAt, now), futuresExchangeTsVerified ? timestampAge(opportunity.futuresExchangeTs, now) : 0);
  const quoteAgeMs = Math.max(spotAge, futuresAge);
  const receiveSkewMs = spotReceivedAtVerified && futuresReceivedAtVerified ? Math.abs(opportunity.spotReceivedAt - opportunity.futuresReceivedAt) : 0;
  const exchangeSkewMs = spotExchangeTsVerified && futuresExchangeTsVerified ? Math.abs((opportunity.spotExchangeTs as number) - (opportunity.futuresExchangeTs as number)) : 0;
  const legSkewMs = Math.max(receiveSkewMs, exchangeSkewMs);
  const timestampsVerified = spotReceivedAtVerified && futuresReceivedAtVerified && spotExchangeTsVerified && futuresExchangeTsVerified;
  const dataQuality = !timestampsVerified ? "unverified" : quoteAgeMs > MAX_ARBITRAGE_QUOTE_AGE_MS ? "stale" : legSkewMs > MAX_ARBITRAGE_LEG_SKEW_MS ? "skewed" : "fresh";
  return { ...opportunity, quoteAgeMs, legSkewMs, dataQuality, capturedAt: now };
}

function refreshClockCorrectedQuality(opportunity: ArbitrageOpportunity, now: number, clockCalibration: Pick<ArbitrageClockCalibration, "assessTimestamp" | "assessSkew">, spotReceivedAtVerified: boolean, futuresReceivedAtVerified: boolean): ArbitrageOpportunity {
  const limits = { maximumAgeMs: MAX_ARBITRAGE_QUOTE_AGE_MS, maximumFutureSkewMs: MAX_ARBITRAGE_FUTURE_CLOCK_SKEW_MS };
  const spotExchangeTs = opportunity.spotExchangeTs as number;
  const futuresExchangeTs = opportunity.futuresExchangeTs as number;
  const spot = clockCalibration.assessTimestamp(`${opportunity.spotExchange}:public`, spotExchangeTs, now, limits);
  const futures = clockCalibration.assessTimestamp(`${opportunity.futuresExchange}:public`, futuresExchangeTs, now, limits);
  const skew = clockCalibration.assessSkew(spot, futures, MAX_ARBITRAGE_LEG_SKEW_MS);
  const receiveAgeMs = Math.max(timestampAge(opportunity.spotReceivedAt, now), timestampAge(opportunity.futuresReceivedAt, now));
  const correctedAgeMs = Math.max(0, spot.ageUpperMs ?? 0, futures.ageUpperMs ?? 0);
  const quoteAgeMs = Math.ceil(Math.max(receiveAgeMs, correctedAgeMs));
  const receiveSkewMs = spotReceivedAtVerified && futuresReceivedAtVerified ? Math.abs(opportunity.spotReceivedAt - opportunity.futuresReceivedAt) : 0;
  const legSkewMs = Math.ceil(Math.max(receiveSkewMs, skew.maximumPossibleSkewMs ?? 0));
  const clockCorrection = {
    modelVersion: "venue-clock-v1" as const,
    spot: clockLeg(spot, spotExchangeTs, now),
    futures: clockLeg(futures, futuresExchangeTs, now),
    skewEligible: skew.eligible,
    ...(skew.minimumPossibleSkewMs === undefined ? {} : { minimumPossibleSkewMs: skew.minimumPossibleSkewMs }),
    ...(skew.maximumPossibleSkewMs === undefined ? {} : { maximumPossibleSkewMs: skew.maximumPossibleSkewMs }),
    ...(skew.reason === undefined ? {} : { skewReason: skew.reason })
  };
  const timestampsVerified = spotReceivedAtVerified && futuresReceivedAtVerified && spot.quality === "verified" && futures.quality === "verified";
  const timestampStale = spot.reason === "timestamp-stale" || futures.reason === "timestamp-stale" || quoteAgeMs > MAX_ARBITRAGE_QUOTE_AGE_MS;
  const futureOrClockFailure =
    !timestampsVerified || spot.reason === "timestamp-definitely-future" || spot.reason === "timestamp-may-be-future" || futures.reason === "timestamp-definitely-future" || futures.reason === "timestamp-may-be-future" || skew.reason === "clock-unavailable" || skew.reason === "clock-not-calibrated";
  const dataQuality = futureOrClockFailure ? "unverified" : timestampStale ? "stale" : !skew.eligible || legSkewMs > MAX_ARBITRAGE_LEG_SKEW_MS ? "skewed" : "fresh";
  return { ...opportunity, quoteAgeMs, legSkewMs, dataQuality, clockCorrection, capturedAt: now };
}

function clockLeg(assessment: ExchangeTimestampAssessment, exchangeTimestamp: number, evaluatedAt: number) {
  const rawAgeMs = evaluatedAt - exchangeTimestamp;
  return {
    sourceId: assessment.sourceId,
    clockStatus: assessment.clockStatus,
    eligible: assessment.eligible,
    quality: assessment.quality,
    ...(assessment.ageLowerMs === undefined ? {} : { offsetLowerMs: assessment.ageLowerMs - rawAgeMs, ageLowerMs: assessment.ageLowerMs }),
    ...(assessment.ageUpperMs === undefined ? {} : { offsetUpperMs: assessment.ageUpperMs - rawAgeMs, ageUpperMs: assessment.ageUpperMs }),
    ...(assessment.reason === undefined ? {} : { reason: assessment.reason })
  };
}

function validSourceTimestamp(value: number | undefined, evaluatedAt: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && Number.isSafeInteger(evaluatedAt) && evaluatedAt > 0 && value <= evaluatedAt + MAX_ARBITRAGE_FUTURE_CLOCK_SKEW_MS;
}

function validMillisecondTimestamp(value: number | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function timestampAge(value: number | undefined, evaluatedAt: number) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, evaluatedAt - value) : 0;
}
