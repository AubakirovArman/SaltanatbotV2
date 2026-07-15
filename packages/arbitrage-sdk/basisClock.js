import { bool, exact, optionalFinite, record, text } from "./validation.js";
const MAX_QUOTE_AGE_MS = 10_000;
const MAX_LEG_SKEW_MS = 3_000;
const MAX_FUTURE_SKEW_MS = 1_000;
export function parseBasisOpportunityTiming(input) {
    if (input.correction === undefined)
        return legacyTiming(input);
    if (input.spotExchangeTs === undefined || input.futuresExchangeTs === undefined)
        throw new Error("basis clock correction requires both verified venue timestamps");
    const row = record(input.correction, "clockCorrection");
    const modelVersion = exact(row.modelVersion, ["venue-clock-v1"], "clockCorrection.modelVersion");
    const spot = parseLeg(row.spot, `${input.spotExchange}:public`, input.spotExchangeTs, input.capturedAt, "clockCorrection.spot");
    const futures = parseLeg(row.futures, `${input.futuresExchange}:public`, input.futuresExchangeTs, input.capturedAt, "clockCorrection.futures");
    const skewEligible = bool(row.skewEligible, "clockCorrection.skewEligible");
    const minimumPossibleSkewMs = optionalFinite(row.minimumPossibleSkewMs, "clockCorrection.minimumPossibleSkewMs");
    const maximumPossibleSkewMs = optionalFinite(row.maximumPossibleSkewMs, "clockCorrection.maximumPossibleSkewMs");
    const skewReason = optionalSkewReason(row.skewReason);
    validateSkew(spot, futures, { skewEligible, minimumPossibleSkewMs, maximumPossibleSkewMs, skewReason });
    const clockCorrection = {
        modelVersion,
        spot,
        futures,
        skewEligible,
        ...(minimumPossibleSkewMs === undefined ? {} : { minimumPossibleSkewMs }),
        ...(maximumPossibleSkewMs === undefined ? {} : { maximumPossibleSkewMs }),
        ...(skewReason === undefined ? {} : { skewReason })
    };
    const quoteAgeMs = Math.ceil(Math.max(receiveAge(input.spotReceivedAt, input.capturedAt), receiveAge(input.futuresReceivedAt, input.capturedAt), 0, spot.ageUpperMs ?? 0, futures.ageUpperMs ?? 0));
    const legSkewMs = Math.ceil(Math.max(Math.abs(input.spotReceivedAt - input.futuresReceivedAt), maximumPossibleSkewMs ?? 0));
    assertTimingFields(input, quoteAgeMs, legSkewMs);
    const received = qualityTimestamp(input.spotReceivedAt, input.capturedAt) && qualityTimestamp(input.futuresReceivedAt, input.capturedAt);
    const verified = received && spot.quality === "verified" && futures.quality === "verified";
    const futureOrClockFailure = !verified || futureReason(spot.reason) || futureReason(futures.reason) || skewReason === "clock-unavailable" || skewReason === "clock-not-calibrated";
    const stale = spot.reason === "timestamp-stale" || futures.reason === "timestamp-stale" || quoteAgeMs > MAX_QUOTE_AGE_MS;
    const measuredQuality = futureOrClockFailure ? "unverified" : stale ? "stale" : !skewEligible || legSkewMs > MAX_LEG_SKEW_MS ? "skewed" : "fresh";
    return { clockCorrection, measuredQuality };
}
function parseLeg(value, expectedSourceId, exchangeTimestamp, capturedAt, label) {
    const row = record(value, label);
    const sourceId = text(row.sourceId, `${label}.sourceId`);
    if (sourceId !== expectedSourceId)
        throw new Error(`${label}.sourceId does not match its venue`);
    const clockStatus = exact(row.clockStatus, ["calibrated", "degraded", "expired", "unavailable"], `${label}.clockStatus`);
    const eligible = bool(row.eligible, `${label}.eligible`);
    const quality = exact(row.quality, ["verified", "degraded", "unavailable"], `${label}.quality`);
    const offsetLowerMs = optionalFinite(row.offsetLowerMs, `${label}.offsetLowerMs`);
    const offsetUpperMs = optionalFinite(row.offsetUpperMs, `${label}.offsetUpperMs`);
    const ageLowerMs = optionalFinite(row.ageLowerMs, `${label}.ageLowerMs`);
    const ageUpperMs = optionalFinite(row.ageUpperMs, `${label}.ageUpperMs`);
    const reason = optionalLegReason(row.reason, label);
    const interval = [offsetLowerMs, offsetUpperMs, ageLowerMs, ageUpperMs];
    if (interval.some((item) => item === undefined) && interval.some((item) => item !== undefined))
        throw new Error(`${label} interval fields must be supplied together`);
    const hasInterval = offsetLowerMs !== undefined && offsetUpperMs !== undefined && ageLowerMs !== undefined && ageUpperMs !== undefined;
    if (clockStatus === "unavailable" ? hasInterval : !hasInterval)
        throw new Error(`${label} interval presence does not match clock status`);
    if (hasInterval) {
        if (offsetLowerMs > offsetUpperMs || ageLowerMs > ageUpperMs)
            throw new Error(`${label} interval bounds are reversed`);
        approximately(ageLowerMs, capturedAt - exchangeTimestamp + offsetLowerMs, `${label}.ageLowerMs`);
        approximately(ageUpperMs, capturedAt - exchangeTimestamp + offsetUpperMs, `${label}.ageUpperMs`);
    }
    const expected = expectedLegState(clockStatus, ageLowerMs, ageUpperMs);
    if (eligible !== expected.eligible || quality !== expected.quality || reason !== expected.reason)
        throw new Error(`${label} status is inconsistent with its calibrated interval`);
    return {
        sourceId,
        clockStatus,
        eligible,
        quality,
        ...(hasInterval ? { offsetLowerMs, offsetUpperMs, ageLowerMs, ageUpperMs } : {}),
        ...(reason === undefined ? {} : { reason })
    };
}
function expectedLegState(clockStatus, ageLowerMs, ageUpperMs) {
    if (clockStatus === "unavailable")
        return { eligible: false, quality: "unavailable", reason: "clock-unavailable" };
    if (clockStatus !== "calibrated")
        return { eligible: false, quality: "degraded", reason: "clock-not-calibrated" };
    if (ageLowerMs === undefined || ageUpperMs === undefined)
        throw new Error("calibrated clock interval is missing");
    if (ageUpperMs < -MAX_FUTURE_SKEW_MS)
        return { eligible: false, quality: "verified", reason: "timestamp-definitely-future" };
    if (ageLowerMs < -MAX_FUTURE_SKEW_MS)
        return { eligible: false, quality: "verified", reason: "timestamp-may-be-future" };
    if (ageUpperMs > MAX_QUOTE_AGE_MS)
        return { eligible: false, quality: "verified", reason: "timestamp-stale" };
    return { eligible: true, quality: "verified", reason: undefined };
}
function validateSkew(spot, futures, wire) {
    if (spot.clockStatus === "unavailable" || futures.clockStatus === "unavailable")
        return assertSkewUnavailable(wire, "clock-unavailable");
    if (spot.clockStatus !== "calibrated" || futures.clockStatus !== "calibrated")
        return assertSkewUnavailable(wire, "clock-not-calibrated");
    const spotInterval = [spot.ageLowerMs, spot.ageUpperMs];
    const futuresInterval = [futures.ageLowerMs, futures.ageUpperMs];
    const minimum = intervalDistance(spotInterval, futuresInterval);
    const maximum = Math.max(Math.abs(spotInterval[0] - futuresInterval[1]), Math.abs(spotInterval[1] - futuresInterval[0]));
    if (wire.minimumPossibleSkewMs === undefined || wire.maximumPossibleSkewMs === undefined)
        throw new Error("clockCorrection skew bounds are required for calibrated clocks");
    approximately(wire.minimumPossibleSkewMs, minimum, "clockCorrection.minimumPossibleSkewMs");
    approximately(wire.maximumPossibleSkewMs, maximum, "clockCorrection.maximumPossibleSkewMs");
    const expectedReason = maximum > MAX_LEG_SKEW_MS ? "skew-exceeded" : undefined;
    const expectedEligible = spot.eligible && futures.eligible && expectedReason === undefined;
    if (wire.skewEligible !== expectedEligible || wire.skewReason !== expectedReason)
        throw new Error("clockCorrection skew status is inconsistent with its bounds");
}
function assertSkewUnavailable(wire, reason) {
    if (wire.skewEligible || wire.minimumPossibleSkewMs !== undefined || wire.maximumPossibleSkewMs !== undefined || wire.skewReason !== reason)
        throw new Error("clockCorrection unavailable skew status is inconsistent");
}
function legacyTiming(input) {
    const spotVenueVerified = qualityTimestamp(input.spotExchangeTs, input.capturedAt);
    const futuresVenueVerified = qualityTimestamp(input.futuresExchangeTs, input.capturedAt);
    const expectedAge = Math.max(receiveAge(input.spotReceivedAt, input.capturedAt), receiveAge(input.futuresReceivedAt, input.capturedAt), spotVenueVerified ? receiveAge(input.spotExchangeTs, input.capturedAt) : 0, futuresVenueVerified ? receiveAge(input.futuresExchangeTs, input.capturedAt) : 0);
    const receiveSkew = qualityTimestamp(input.spotReceivedAt, input.capturedAt) && qualityTimestamp(input.futuresReceivedAt, input.capturedAt) ? Math.abs(input.spotReceivedAt - input.futuresReceivedAt) : 0;
    const venueSkew = spotVenueVerified && futuresVenueVerified ? Math.abs(input.spotExchangeTs - input.futuresExchangeTs) : 0;
    const expectedSkew = Math.max(receiveSkew, venueSkew);
    assertTimingFields(input, expectedAge, expectedSkew);
    const verified = qualityTimestamp(input.spotReceivedAt, input.capturedAt) && qualityTimestamp(input.futuresReceivedAt, input.capturedAt) && spotVenueVerified && futuresVenueVerified;
    return { measuredQuality: !verified ? "unverified" : expectedAge > MAX_QUOTE_AGE_MS ? "stale" : expectedSkew > MAX_LEG_SKEW_MS ? "skewed" : "fresh" };
}
function assertTimingFields(input, expectedAge, expectedSkew) {
    if (input.quoteAgeMs !== expectedAge || input.legSkewMs !== expectedSkew)
        throw new Error("basis opportunity age/skew fields are inconsistent with source timestamps");
}
function optionalLegReason(value, label) {
    return value === undefined ? undefined : exact(value, ["clock-unavailable", "clock-not-calibrated", "timestamp-definitely-future", "timestamp-may-be-future", "timestamp-stale"], `${label}.reason`);
}
function optionalSkewReason(value) {
    return value === undefined ? undefined : exact(value, ["clock-unavailable", "clock-not-calibrated", "skew-exceeded"], "clockCorrection.skewReason");
}
function futureReason(reason) {
    return reason === "timestamp-definitely-future" || reason === "timestamp-may-be-future";
}
function qualityTimestamp(value, evaluatedAt) {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= evaluatedAt + MAX_FUTURE_SKEW_MS;
}
function receiveAge(value, capturedAt) {
    return Math.max(0, capturedAt - value);
}
function intervalDistance(left, right) {
    if (Math.max(left[0], right[0]) <= Math.min(left[1], right[1]))
        return 0;
    return Math.max(left[0], right[0]) - Math.min(left[1], right[1]);
}
function approximately(actual, expected, label) {
    if (Math.abs(actual - expected) > 1e-7 * Math.max(1, Math.abs(expected)))
        throw new Error(`${label} is inconsistent with its venue timestamp and clock offset`);
}
