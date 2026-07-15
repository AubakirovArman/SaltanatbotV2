import type { FundingCurveCalibratedClockLeg, FundingCurveHistoryPoint, FundingCurveRejection, FundingCurveRejectionCode, FundingCurveResponse, FundingCurveResult, FundingCurveScenarioProjection, FundingCurveSettlementPoint, FundingCurveUniverseResponse } from "./fundingCurveTypes.js";
import { parseRegistryInstrument } from "./registry.js";
import { array, bool, exact, finite, integer, record, text } from "./validation.js";

const RATE_UNIT = "decimal-per-settlement" as const;
const STRESS_UNIT = "basis-points-additive-per-settlement" as const;
const BPS = 10_000;
const MAX_RATE = 10;
const MAX_SETTLEMENTS = 512;
const MAX_UNIVERSE_INSTRUMENTS = 5_000;
const REJECTION_CODES = [
  "venue-unavailable",
  "funding-unsupported",
  "unsupported-rate-unit",
  "identity-mismatch",
  "stale-source",
  "future-source-time",
  "unverified-schedule",
  "unsupported-schedule",
  "invalid-source",
  "projection-too-large",
  "upstream-unavailable"
] as const satisfies readonly FundingCurveRejectionCode[];

/** Strict runtime parser for the server-owned, read-only funding universe. */
export function parseFundingCurveUniverseResponse(value: unknown): FundingCurveUniverseResponse {
  const row = strictRecord(value, "funding curve universe", ["engine", "readOnly", "researchOnly", "executable", "updatedAt", "stale", "contract", "economicIdentityCatalog", "supportedVenues", "total", "truncated", "instruments", "sourceErrors"]);
  const updatedAt = positiveInteger(row.updatedAt, "updatedAt");
  const economicIdentityCatalog = parseEconomicIdentityCatalog(row.economicIdentityCatalog, updatedAt);
  const supportedVenues = array(row.supportedVenues, "supportedVenues", 100).map((item, index) => venueText(item, `supportedVenues[${index}]`));
  if (new Set(supportedVenues).size !== supportedVenues.length) {
    throw new Error("supportedVenues must be unique");
  }
  const instruments = array(row.instruments, "instruments", MAX_UNIVERSE_INSTRUMENTS).map((item, index) => parseFundingUniverseInstrument(item, index, supportedVenues));
  if (new Set(instruments.map(({ id }) => id)).size !== instruments.length) {
    throw new Error("funding universe instrument IDs must be unique");
  }
  const total = boundedInteger(row.total, "total", 0, Number.MAX_SAFE_INTEGER);
  const truncated = bool(row.truncated, "truncated");
  if (total < instruments.length || truncated !== total > instruments.length) {
    throw new Error("funding universe counts are inconsistent");
  }
  const sourceErrors = array(row.sourceErrors, "sourceErrors", 32).map((message, index) => boundedNonBlankText(message, `sourceErrors[${index}]`, 1_000));
  if (new Set(sourceErrors).size !== sourceErrors.length) {
    throw new Error("funding universe sourceErrors must be unique");
  }
  const stale = bool(row.stale, "stale");
  if (stale !== sourceErrors.length > 0) throw new Error("funding universe stale flag is inconsistent");
  return {
    engine: exact(row.engine, ["funding-curve-universe-v1"] as const, "engine"),
    readOnly: trueValue(row.readOnly, "readOnly"),
    researchOnly: trueValue(row.researchOnly, "researchOnly"),
    executable: falseValue(row.executable, "executable"),
    updatedAt,
    stale,
    contract: parseUniverseContract(row.contract),
    economicIdentityCatalog,
    supportedVenues,
    total,
    truncated,
    instruments,
    sourceErrors
  };
}

function parseEconomicIdentityCatalog(value: unknown, updatedAt: number): FundingCurveUniverseResponse["economicIdentityCatalog"] {
  const row = strictRecord(value, "economicIdentityCatalog", ["schemaVersion", "source", "version", "asOf", "validUntil"]);
  const asOf = positiveInteger(row.asOf, "economicIdentityCatalog.asOf");
  const validUntil = positiveInteger(row.validUntil, "economicIdentityCatalog.validUntil");
  if (asOf > updatedAt || validUntil < updatedAt) {
    throw new Error("economicIdentityCatalog is not valid at updatedAt");
  }
  if (row.schemaVersion !== 1) throw new Error("economicIdentityCatalog.schemaVersion is unsupported");
  return {
    schemaVersion: 1,
    source: boundedNonBlankText(row.source, "economicIdentityCatalog.source", 1_000),
    version: boundedNonBlankText(row.version, "economicIdentityCatalog.version", 1_000),
    asOf,
    validUntil
  };
}

function parseUniverseContract(value: unknown): FundingCurveUniverseResponse["contract"] {
  const row = strictRecord(value, "contract", ["owner", "adapterRegistry", "instruments", "execution"]);
  return {
    owner: exact(row.owner, ["server"] as const, "contract.owner"),
    adapterRegistry: exact(row.adapterRegistry, ["publicVenueAdapters"] as const, "contract.adapterRegistry"),
    instruments: exact(row.instruments, ["fresh-verified-trading-perpetuals"] as const, "contract.instruments"),
    execution: exact(row.execution, ["none"] as const, "contract.execution")
  };
}

function parseFundingUniverseInstrument(value: unknown, index: number, supportedVenues: readonly string[]) {
  const label = `instruments[${index}]`;
  strictRecord(
    value,
    label,
    [
      "id",
      "assetId",
      "economicAssetId",
      "venue",
      "venueSymbol",
      "baseAsset",
      "quoteAsset",
      "settleAsset",
      "marketType",
      "contractDirection",
      "contractMultiplier",
      "contractValue",
      "contractValueCurrency",
      "quantityUnit",
      "underlying",
      "instrumentFamily",
      "tickSize",
      "priceRules",
      "quantityStep",
      "minimumQuantity",
      "minimumNotional",
      "status",
      "fundingIntervalMinutes",
      "expiryTime",
      "strikePrice",
      "optionType"
    ],
    ["economicAssetId", "contractDirection", "contractValue", "contractValueCurrency", "quantityUnit", "underlying", "instrumentFamily", "priceRules", "fundingIntervalMinutes", "expiryTime", "strikePrice", "optionType"]
  );
  const instrument = parseRegistryInstrument(value);
  if (instrument.marketType !== "perpetual" || instrument.status !== "trading") {
    throw new Error(`${label} must be a trading perpetual`);
  }
  if (!supportedVenues.includes(instrument.venue)) {
    throw new Error(`${label}.venue is not supported by the funding service`);
  }
  const markets = instrument.id.split(":").filter((segment) => ["spot", "margin", "perpetual", "future", "option", "native-spread"].includes(segment));
  if (!instrument.id.startsWith(`${instrument.venue}:`) || markets.length !== 1 || markets[0] !== "perpetual") {
    throw new Error(`${label}.id is not a stable perpetual identity for its venue`);
  }
  return instrument;
}

/** Strict runtime parser for the public, non-executable funding-curve surface. */
export function parseFundingCurveResponse(value: unknown): FundingCurveResponse {
  const row = strictRecord(value, "funding curve", ["engine", "readOnly", "researchOnly", "executable", "evaluatedAt", "horizonEnd", "contract", "crossVenueClock", "curves", "rejections"]);
  const evaluatedAt = positiveInteger(row.evaluatedAt, "evaluatedAt");
  const horizonEnd = positiveInteger(row.horizonEnd, "horizonEnd");
  if (horizonEnd <= evaluatedAt) throw new Error("horizonEnd must follow evaluatedAt");
  const curves = array(row.curves, "curves", 8).map((item, index) => parseCurve(item, index, evaluatedAt, horizonEnd));
  const rejections = array(row.rejections, "rejections", 8).map((item, index) => parseRejection(item, index));
  const identities = [...curves.map((curve) => identity(curve.venue, curve.instrumentId)), ...rejections.map((item) => identity(item.venue, item.instrumentId))];
  if (identities.length < 1 || identities.length > 8 || new Set(identities).size !== identities.length) {
    throw new Error("funding curve outcomes must have unique selection identities");
  }
  const crossVenueClock = parseCrossVenueClock(row.crossVenueClock, curves);
  return {
    engine: exact(row.engine, ["funding-curve-v1"] as const, "engine"),
    readOnly: trueValue(row.readOnly, "readOnly"),
    researchOnly: trueValue(row.researchOnly, "researchOnly"),
    executable: falseValue(row.executable, "executable"),
    evaluatedAt,
    horizonEnd,
    contract: parseContract(row.contract),
    crossVenueClock,
    curves,
    rejections
  };
}

function parseContract(value: unknown): FundingCurveResponse["contract"] {
  const row = strictRecord(value, "contract", ["source", "rateUnit", "stressUnit", "scheduleRequirement", "projection", "pnl", "execution"]);
  return {
    source: exact(row.source, ["credential-free-public-venue-adapters"] as const, "contract.source"),
    rateUnit: exact(row.rateUnit, [RATE_UNIT] as const, "contract.rateUnit"),
    stressUnit: exact(row.stressUnit, [STRESS_UNIT] as const, "contract.stressUnit"),
    scheduleRequirement: exact(row.scheduleRequirement, ["adapter-verified-discrete-settlements"] as const, "contract.scheduleRequirement"),
    projection: exact(row.projection, ["point-in-time-estimate-persistence"] as const, "contract.projection"),
    pnl: exact(row.pnl, ["not-computed-without-explicit-notional-and-price-path"] as const, "contract.pnl"),
    execution: exact(row.execution, ["none"] as const, "contract.execution")
  };
}

function parseCrossVenueClock(value: unknown, curves: readonly FundingCurveResult[]): FundingCurveResponse["crossVenueClock"] {
  const label = "crossVenueClock";
  const row = record(value, label);
  const comparedVenueCount = new Set(curves.map(({ venue }) => venue)).size;
  const calibratedVenueCount = new Set(curves.filter(({ venue }) => curves.filter((curve) => curve.venue === venue).every((curve) => curve.freshness.clockBasis === "calibrated-venue-interval")).map(({ venue }) => venue)).size;
  const parsedCompared = boundedInteger(row.comparedVenueCount, `${label}.comparedVenueCount`, 0, 8);
  const parsedCalibrated = boundedInteger(row.calibratedVenueCount, `${label}.calibratedVenueCount`, 0, 8);
  const maxSkewMs = boundedInteger(row.maxSkewMs, `${label}.maxSkewMs`, 0, 60_000);
  if (parsedCompared !== comparedVenueCount || parsedCalibrated !== calibratedVenueCount || parsedCalibrated > parsedCompared) {
    throw new Error(`${label} venue counts are inconsistent`);
  }
  if (comparedVenueCount < 2) {
    strictRecord(value, label, ["status", "eligible", "reason", "comparedVenueCount", "calibratedVenueCount", "maxSkewMs"]);
    if (row.status !== "not-applicable" || row.eligible !== false || row.reason !== "fewer-than-two-successful-venues") throw new Error(`${label} not-applicable state is inconsistent`);
    return { status: "not-applicable", eligible: false, reason: "fewer-than-two-successful-venues", comparedVenueCount, calibratedVenueCount, maxSkewMs };
  }
  if (calibratedVenueCount !== comparedVenueCount) {
    strictRecord(value, label, ["status", "eligible", "reason", "comparedVenueCount", "calibratedVenueCount", "maxSkewMs"]);
    if (row.status !== "blocked" || row.eligible !== false || row.reason !== "clock-not-calibrated") throw new Error(`${label} uncalibrated state is inconsistent`);
    return { status: "blocked", eligible: false, reason: "clock-not-calibrated", comparedVenueCount, calibratedVenueCount, maxSkewMs };
  }
  const calibrated = curves.filter((curve): curve is FundingCurveResult & { freshness: Extract<FundingCurveResult["freshness"], { clockBasis: "calibrated-venue-interval" }> } => curve.freshness.clockBasis === "calibrated-venue-interval");
  let expectedMaximumSkew = 0;
  for (let leftIndex = 0; leftIndex < calibrated.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < calibrated.length; rightIndex += 1) {
      const left = calibrated[leftIndex]!;
      const right = calibrated[rightIndex]!;
      if (left.venue === right.venue) continue;
      expectedMaximumSkew = Math.max(expectedMaximumSkew, Math.abs(left.freshness.clockLeg.localEventEarliestAt - right.freshness.clockLeg.localEventLatestAt), Math.abs(left.freshness.clockLeg.localEventLatestAt - right.freshness.clockLeg.localEventEarliestAt));
    }
  }
  const maximumPossibleSkewMs = boundedFinite(row.maximumPossibleSkewMs, `${label}.maximumPossibleSkewMs`, 0, 86_400_000);
  if (!closeTiming(maximumPossibleSkewMs, expectedMaximumSkew)) throw new Error(`${label} worst-case skew is inconsistent`);
  if (expectedMaximumSkew > maxSkewMs) {
    strictRecord(value, label, ["status", "eligible", "reason", "comparedVenueCount", "calibratedVenueCount", "maxSkewMs", "maximumPossibleSkewMs"]);
    if (row.status !== "blocked" || row.eligible !== false || row.reason !== "skew-exceeded") throw new Error(`${label} skew-blocked state is inconsistent`);
    return { status: "blocked", eligible: false, reason: "skew-exceeded", comparedVenueCount, calibratedVenueCount, maxSkewMs, maximumPossibleSkewMs };
  }
  strictRecord(value, label, ["status", "eligible", "clockBasis", "comparedVenueCount", "calibratedVenueCount", "maxSkewMs", "maximumPossibleSkewMs"]);
  if (row.status !== "eligible" || row.eligible !== true || row.clockBasis !== "calibrated-venue-interval") throw new Error(`${label} eligible state is inconsistent`);
  return { status: "eligible", eligible: true, clockBasis: "calibrated-venue-interval", comparedVenueCount, calibratedVenueCount, maxSkewMs, maximumPossibleSkewMs };
}

function parseCurve(value: unknown, index: number, evaluatedAt: number, horizonEnd: number): FundingCurveResult {
  const label = `curves[${index}]`;
  const row = strictRecord(value, label, ["venue", "instrumentId", "marketType", "rateUnit", "rateSignConvention", "projectionSemantics", "freshness", "schedule", "current", "history", "settlements", "scenarios", "source"]);
  const venue = venueText(row.venue, `${label}.venue`);
  const instrumentId = identifier(row.instrumentId, `${label}.instrumentId`);
  const freshness = parseFreshness(row.freshness, label, evaluatedAt);
  const schedule = parseSchedule(row.schedule, label);
  const current = parseCurrent(row.current, label, schedule.fundingTime);
  const history = array(row.history, `${label}.history`, 500).map((point, pointIndex) => parseHistory(point, `${label}.history[${pointIndex}]`));
  assertStrictlyIncreasing(
    history.map(({ settlementAt }) => settlementAt),
    `${label}.history`
  );
  if (history.some(({ settlementAt }) => settlementAt > evaluatedAt + 60_000)) throw new Error(`${label}.history contains a future point`);
  const settlements = array(row.settlements, `${label}.settlements`, MAX_SETTLEMENTS).map((point, pointIndex) => parseSettlement(point, `${label}.settlements[${pointIndex}]`));
  validateSettlements(settlements, current, schedule, evaluatedAt, horizonEnd, label);
  const scenarios = array(row.scenarios, `${label}.scenarios`, 9).map((scenario, scenarioIndex) => parseScenario(scenario, `${label}.scenarios[${scenarioIndex}]`, settlements, current.minimumRate, current.maximumRate));
  if (scenarios.length < 1 || new Set(scenarios.map(({ id }) => id)).size !== scenarios.length) {
    throw new Error(`${label}.scenarios must be non-empty with unique IDs`);
  }
  const source = parseSource(row.source, label, venue, freshness, evaluatedAt);
  return {
    venue,
    instrumentId,
    marketType: exact(row.marketType, ["perpetual"] as const, `${label}.marketType`),
    rateUnit: exact(row.rateUnit, [RATE_UNIT] as const, `${label}.rateUnit`),
    rateSignConvention: exact(row.rateSignConvention, ["positive-longs-pay-shorts"] as const, `${label}.rateSignConvention`),
    projectionSemantics: exact(row.projectionSemantics, ["rate-sum-only-no-notional-or-pnl"] as const, `${label}.projectionSemantics`),
    freshness,
    schedule,
    current,
    history,
    settlements,
    scenarios,
    source
  };
}

function parseFreshness(value: unknown, parent: string, evaluatedAt: number): FundingCurveResult["freshness"] {
  const label = `${parent}.freshness`;
  const row = record(value, label);
  const observedAt = positiveFinite(row.observedAt, `${label}.observedAt`);
  const ageMs = boundedFinite(row.ageMs, `${label}.ageMs`, 0, 86_400_000);
  const maxAgeMs = boundedInteger(row.maxAgeMs, `${label}.maxAgeMs`, 1, 86_400_000);
  const common = { status: exact(row.status, ["fresh"] as const, `${label}.status`), observedAt, ageMs, maxAgeMs };
  if (row.clockBasis === "local-receipt-fallback") {
    strictRecord(value, label, ["status", "clockBasis", "crossVenueComparable", "observedAt", "ageMs", "maxAgeMs", "fallbackReason"]);
    if (row.crossVenueComparable !== false || observedAt > evaluatedAt + 60_000 || ageMs !== Math.max(0, evaluatedAt - observedAt) || ageMs > maxAgeMs) {
      throw new Error(`${label} receipt fallback arithmetic is inconsistent`);
    }
    return {
      ...common,
      clockBasis: "local-receipt-fallback",
      crossVenueComparable: false,
      fallbackReason: exact(row.fallbackReason, ["clock-provider-unavailable", "clock-unavailable", "clock-not-calibrated", "source-declared-local-receipt"] as const, `${label}.fallbackReason`)
    };
  }
  if (row.clockBasis !== "calibrated-venue-interval") throw new Error(`${label}.clockBasis is unsupported`);
  strictRecord(value, label, ["status", "clockBasis", "crossVenueComparable", "observedAt", "ageMs", "maxAgeMs", "ageLowerMs", "ageUpperMs", "clockLeg"]);
  if (row.crossVenueComparable !== true) throw new Error(`${label} calibrated interval must be cross-venue comparable`);
  const clockLeg = parseFundingClockLeg(row.clockLeg, `${label}.clockLeg`, evaluatedAt);
  const ageLowerMs = finite(row.ageLowerMs, `${label}.ageLowerMs`);
  const ageUpperMs = finite(row.ageUpperMs, `${label}.ageUpperMs`);
  if (!closeTiming(ageLowerMs, clockLeg.ageLowerMs) || !closeTiming(ageUpperMs, clockLeg.ageUpperMs) || !closeTiming(observedAt, clockLeg.localEventEarliestAt) || !closeTiming(ageMs, Math.max(0, ageUpperMs)) || ageLowerMs > ageUpperMs || ageUpperMs > maxAgeMs) {
    throw new Error(`${label} calibrated interval arithmetic is inconsistent`);
  }
  return { ...common, clockBasis: "calibrated-venue-interval", crossVenueComparable: true, ageLowerMs, ageUpperMs, clockLeg };
}

function parseFundingClockLeg(value: unknown, label: string, evaluatedAt: number): FundingCurveCalibratedClockLeg {
  const row = strictRecord(value, label, ["sourceId", "exchangeTs", "clockStatus", "ageLowerMs", "ageUpperMs", "localEventEarliestAt", "localEventLatestAt"]);
  const ageLowerMs = finite(row.ageLowerMs, `${label}.ageLowerMs`);
  const ageUpperMs = finite(row.ageUpperMs, `${label}.ageUpperMs`);
  const localEventEarliestAt = positiveFinite(row.localEventEarliestAt, `${label}.localEventEarliestAt`);
  const localEventLatestAt = positiveFinite(row.localEventLatestAt, `${label}.localEventLatestAt`);
  if (localEventEarliestAt > localEventLatestAt || !closeTiming(ageLowerMs, evaluatedAt - localEventLatestAt) || !closeTiming(ageUpperMs, evaluatedAt - localEventEarliestAt) || ageLowerMs > ageUpperMs) {
    throw new Error(`${label} interval provenance is inconsistent`);
  }
  return {
    sourceId: boundedNonBlankText(row.sourceId, `${label}.sourceId`, 200),
    exchangeTs: positiveInteger(row.exchangeTs, `${label}.exchangeTs`),
    clockStatus: exact(row.clockStatus, ["calibrated"] as const, `${label}.clockStatus`),
    ageLowerMs,
    ageUpperMs,
    localEventEarliestAt,
    localEventLatestAt
  };
}

function parseSchedule(value: unknown, parent: string): FundingCurveResult["schedule"] {
  const label = `${parent}.schedule`;
  const row = strictRecord(value, label, ["verified", "interval", "unit", "fundingTime", "nextFundingTime"]);
  const interval = boundedInteger(row.interval, `${label}.interval`, 1, 1_440);
  const fundingTime = positiveInteger(row.fundingTime, `${label}.fundingTime`);
  const nextFundingTime = positiveInteger(row.nextFundingTime, `${label}.nextFundingTime`);
  if (fundingTime + interval * 60_000 !== nextFundingTime) throw new Error(`${label} timestamps are inconsistent`);
  return {
    verified: trueValue(row.verified, `${label}.verified`),
    interval,
    unit: exact(row.unit, ["minutes"] as const, `${label}.unit`),
    fundingTime,
    nextFundingTime
  };
}

function parseCurrent(value: unknown, parent: string, fundingTime: number): FundingCurveResult["current"] {
  const label = `${parent}.current`;
  const row = strictRecord(value, label, ["settlementAt", "estimateRate", "estimateRateBps", "rateUnit", "nextEstimateRate", "nextEstimateRateBps", "minimumRate", "maximumRate"], ["nextEstimateRate", "nextEstimateRateBps", "minimumRate", "maximumRate"]);
  const settlementAt = positiveInteger(row.settlementAt, `${label}.settlementAt`);
  const estimateRate = rate(row.estimateRate, `${label}.estimateRate`);
  const estimateRateBps = finite(row.estimateRateBps, `${label}.estimateRateBps`);
  const nextEstimateRate = optionalRate(row.nextEstimateRate, `${label}.nextEstimateRate`);
  const nextEstimateRateBps = optionalFinite(row.nextEstimateRateBps, `${label}.nextEstimateRateBps`);
  const minimumRate = optionalRate(row.minimumRate, `${label}.minimumRate`);
  const maximumRate = optionalRate(row.maximumRate, `${label}.maximumRate`);
  if (settlementAt !== fundingTime || !close(estimateRateBps, estimateRate * BPS)) throw new Error(`${label} estimate provenance is inconsistent`);
  if ((nextEstimateRate === undefined) !== (nextEstimateRateBps === undefined) || (nextEstimateRate !== undefined && !close(nextEstimateRateBps!, nextEstimateRate * BPS))) {
    throw new Error(`${label} next estimate provenance is inconsistent`);
  }
  if (minimumRate !== undefined && maximumRate !== undefined && minimumRate > maximumRate) throw new Error(`${label} bounds are inconsistent`);
  return {
    settlementAt,
    estimateRate,
    estimateRateBps,
    rateUnit: exact(row.rateUnit, [RATE_UNIT] as const, `${label}.rateUnit`),
    ...(nextEstimateRate === undefined ? {} : { nextEstimateRate, nextEstimateRateBps: nextEstimateRateBps! }),
    ...(minimumRate === undefined ? {} : { minimumRate }),
    ...(maximumRate === undefined ? {} : { maximumRate })
  };
}

function parseHistory(value: unknown, label: string): FundingCurveHistoryPoint {
  const row = strictRecord(value, label, ["settlementAt", "estimateRate", "realizedRate", "effectiveRate", "rateKind", "rateUnit", "formulaType", "method"], ["realizedRate", "formulaType", "method"]);
  const estimateRate = rate(row.estimateRate, `${label}.estimateRate`);
  const realizedRate = optionalRate(row.realizedRate, `${label}.realizedRate`);
  const effectiveRate = rate(row.effectiveRate, `${label}.effectiveRate`);
  const rateKind = exact(row.rateKind, ["estimate", "realized"] as const, `${label}.rateKind`);
  if (!close(effectiveRate, realizedRate ?? estimateRate) || rateKind !== (realizedRate === undefined ? "estimate" : "realized")) {
    throw new Error(`${label} effective-rate provenance is inconsistent`);
  }
  const formulaType = optionalBoundedText(row.formulaType, `${label}.formulaType`);
  const method = optionalBoundedText(row.method, `${label}.method`);
  return {
    settlementAt: positiveInteger(row.settlementAt, `${label}.settlementAt`),
    estimateRate,
    ...(realizedRate === undefined ? {} : { realizedRate }),
    effectiveRate,
    rateKind,
    rateUnit: exact(row.rateUnit, [RATE_UNIT] as const, `${label}.rateUnit`),
    ...(formulaType === undefined ? {} : { formulaType }),
    ...(method === undefined ? {} : { method })
  };
}

function parseSettlement(value: unknown, label: string): FundingCurveSettlementPoint {
  const row = strictRecord(value, label, ["settlementAt", "baseRate", "baseRateBps", "rateUnit", "rateSource"]);
  const baseRate = rate(row.baseRate, `${label}.baseRate`);
  const baseRateBps = finite(row.baseRateBps, `${label}.baseRateBps`);
  if (!close(baseRateBps, baseRate * BPS)) throw new Error(`${label} basis-point conversion is inconsistent`);
  return {
    settlementAt: positiveInteger(row.settlementAt, `${label}.settlementAt`),
    baseRate,
    baseRateBps,
    rateUnit: exact(row.rateUnit, [RATE_UNIT] as const, `${label}.rateUnit`),
    rateSource: exact(row.rateSource, ["current-estimate", "next-estimate", "latest-estimate-persistence"] as const, `${label}.rateSource`)
  };
}

function validateSettlements(points: readonly FundingCurveSettlementPoint[], current: FundingCurveResult["current"], schedule: FundingCurveResult["schedule"], evaluatedAt: number, horizonEnd: number, label: string) {
  assertStrictlyIncreasing(
    points.map(({ settlementAt }) => settlementAt),
    `${label}.settlements`
  );
  const intervalMs = schedule.interval * 60_000;
  const elapsed = evaluatedAt <= schedule.fundingTime ? 0 : Math.ceil((evaluatedAt - schedule.fundingTime) / intervalMs);
  const firstSettlement = schedule.fundingTime + elapsed * intervalMs;
  const expectedCount = firstSettlement >= horizonEnd ? 0 : Math.ceil((horizonEnd - firstSettlement) / intervalMs);
  if (expectedCount > MAX_SETTLEMENTS || points.length !== expectedCount) throw new Error(`${label}.settlements do not cover the bounded horizon`);
  for (const [index, point] of points.entries()) {
    if (point.settlementAt !== firstSettlement + index * intervalMs || point.settlementAt < evaluatedAt || point.settlementAt >= horizonEnd) {
      throw new Error(`${label}.settlements[${index}] is outside the requested schedule`);
    }
    const expected =
      point.settlementAt === schedule.fundingTime
        ? { rate: current.estimateRate, source: "current-estimate" }
        : point.settlementAt === schedule.nextFundingTime && current.nextEstimateRate !== undefined
          ? { rate: current.nextEstimateRate, source: "next-estimate" }
          : { rate: current.nextEstimateRate ?? current.estimateRate, source: "latest-estimate-persistence" };
    if (!close(point.baseRate, expected.rate) || point.rateSource !== expected.source) throw new Error(`${label}.settlements[${index}] estimate provenance is inconsistent`);
    if (index > 0 && point.settlementAt - points[index - 1]!.settlementAt !== intervalMs) throw new Error(`${label}.settlements are not contiguous`);
  }
}

function parseScenario(value: unknown, label: string, settlements: readonly FundingCurveSettlementPoint[], minimumRate: number | undefined, maximumRate: number | undefined): FundingCurveScenarioProjection {
  const row = strictRecord(value, label, ["id", "bumpBps", "unit", "settlementCount", "cumulativeRate", "averageRatePerSettlement", "outsidePublishedMinimumCount", "outsidePublishedMaximumCount"]);
  const id = scenarioIdentifier(row.id, `${label}.id`);
  const bumpBps = boundedFinite(row.bumpBps, `${label}.bumpBps`, -10_000, 10_000);
  const settlementCount = boundedInteger(row.settlementCount, `${label}.settlementCount`, 0, MAX_SETTLEMENTS);
  const cumulativeRate = boundedFinite(row.cumulativeRate, `${label}.cumulativeRate`, -MAX_RATE * MAX_SETTLEMENTS, MAX_RATE * MAX_SETTLEMENTS);
  const averageRatePerSettlement = rate(row.averageRatePerSettlement, `${label}.averageRatePerSettlement`);
  const outsidePublishedMinimumCount = boundedInteger(row.outsidePublishedMinimumCount, `${label}.outsidePublishedMinimumCount`, 0, MAX_SETTLEMENTS);
  const outsidePublishedMaximumCount = boundedInteger(row.outsidePublishedMaximumCount, `${label}.outsidePublishedMaximumCount`, 0, MAX_SETTLEMENTS);
  const stressed = settlements.map(({ baseRate }, index) => rate(baseRate + bumpBps / BPS, `${label}.stressed[${index}]`));
  const expectedTotal = stressed.reduce((sum, value) => sum + value, 0);
  if (settlementCount !== settlements.length || !close(cumulativeRate, expectedTotal) || !close(averageRatePerSettlement, stressed.length === 0 ? 0 : expectedTotal / stressed.length)) {
    throw new Error(`${label} stress arithmetic is inconsistent`);
  }
  if (outsidePublishedMinimumCount !== (minimumRate === undefined ? 0 : stressed.filter((rate) => rate < minimumRate).length) || outsidePublishedMaximumCount !== (maximumRate === undefined ? 0 : stressed.filter((rate) => rate > maximumRate).length)) {
    throw new Error(`${label} published-bound counts are inconsistent`);
  }
  return {
    id,
    bumpBps,
    unit: exact(row.unit, [STRESS_UNIT] as const, `${label}.unit`),
    settlementCount,
    cumulativeRate,
    averageRatePerSettlement,
    outsidePublishedMinimumCount,
    outsidePublishedMaximumCount
  };
}

function parseSource(value: unknown, parent: string, venue: string, freshness: FundingCurveResult["freshness"], evaluatedAt: number): FundingCurveResult["source"] {
  const label = `${parent}.source`;
  const row = strictRecord(
    value,
    label,
    ["adapter", "operation", "public", "credentialed", "exchangeTs", "receivedAt", "formulaType", "method", "network", "currentEstimateSource", "timestampSource", "historyComplete", "sourceErrors", "sourceErrorsTruncated"],
    ["formulaType", "method", "network", "currentEstimateSource", "timestampSource"]
  );
  const exchangeTs = positiveInteger(row.exchangeTs, `${label}.exchangeTs`);
  const receivedAt = positiveInteger(row.receivedAt, `${label}.receivedAt`);
  if (receivedAt > evaluatedAt + 60_000) throw new Error(`${label} receive timestamp is too far in the future`);
  if (freshness.clockBasis === "local-receipt-fallback") {
    if (receivedAt !== freshness.observedAt) throw new Error(`${label} receipt fallback provenance is inconsistent`);
  } else if (freshness.clockLeg.sourceId !== `${venue}:public` || freshness.clockLeg.exchangeTs !== exchangeTs) {
    throw new Error(`${label} calibrated clock provenance is inconsistent`);
  }
  const formulaType = optionalBoundedText(row.formulaType, `${label}.formulaType`);
  const method = optionalBoundedText(row.method, `${label}.method`);
  const network = row.network === undefined ? undefined : exact(row.network, ["mainnet", "testnet"] as const, `${label}.network`);
  const currentEstimateSource = optionalBoundedText(row.currentEstimateSource, `${label}.currentEstimateSource`);
  const timestampSource = row.timestampSource === undefined ? undefined : exact(row.timestampSource, ["exchange", "local-receive"] as const, `${label}.timestampSource`);
  const sourceErrors = array(row.sourceErrors, `${label}.sourceErrors`, 32).map((message, index) => boundedText(message, `${label}.sourceErrors[${index}]`, 1_000));
  const historyComplete = bool(row.historyComplete, `${label}.historyComplete`);
  const sourceErrorsTruncated = bool(row.sourceErrorsTruncated, `${label}.sourceErrorsTruncated`);
  if (historyComplete !== (sourceErrors.length === 0) || (sourceErrorsTruncated && sourceErrors.length !== 32)) throw new Error(`${label} history completeness is inconsistent`);
  return {
    adapter: exact(row.adapter, ["publicVenueAdapters"] as const, `${label}.adapter`),
    operation: exact(row.operation, ["funding"] as const, `${label}.operation`),
    public: trueValue(row.public, `${label}.public`),
    credentialed: falseValue(row.credentialed, `${label}.credentialed`),
    exchangeTs,
    receivedAt,
    ...(formulaType === undefined ? {} : { formulaType }),
    ...(method === undefined ? {} : { method }),
    ...(network === undefined ? {} : { network }),
    ...(currentEstimateSource === undefined ? {} : { currentEstimateSource }),
    ...(timestampSource === undefined ? {} : { timestampSource }),
    historyComplete,
    sourceErrors,
    sourceErrorsTruncated
  };
}

function parseRejection(value: unknown, index: number): FundingCurveRejection {
  const label = `rejections[${index}]`;
  const row = strictRecord(value, label, ["venue", "instrumentId", "code", "message", "retryable"]);
  return {
    venue: venueText(row.venue, `${label}.venue`),
    instrumentId: identifier(row.instrumentId, `${label}.instrumentId`),
    code: exact(row.code, REJECTION_CODES, `${label}.code`),
    message: boundedText(row.message, `${label}.message`, 1_000),
    retryable: bool(row.retryable, `${label}.retryable`)
  };
}

function strictRecord(value: unknown, label: string, keys: readonly string[], optional: readonly string[] = []) {
  const row = record(value, label);
  const allowed = new Set(keys);
  for (const key of Object.keys(row)) if (!allowed.has(key)) throw new Error(`${label}.${key} is unsupported`);
  const optionalSet = new Set(optional);
  for (const key of keys) if (!optionalSet.has(key) && row[key] === undefined) throw new Error(`${label}.${key} is required`);
  return row;
}

function positiveInteger(value: unknown, label: string) {
  const result = integer(value, label);
  if (result < 1) throw new Error(`${label} must be positive`);
  return result;
}

function positiveFinite(value: unknown, label: string) {
  const result = finite(value, label);
  if (result <= 0) throw new Error(`${label} must be positive`);
  return result;
}

function boundedInteger(value: unknown, label: string, minimum: number, maximum: number) {
  const result = integer(value, label);
  if (result < minimum || result > maximum) throw new Error(`${label} is outside its bound`);
  return result;
}

function rate(value: unknown, label: string) {
  return boundedFinite(value, label, -MAX_RATE, MAX_RATE);
}
function optionalRate(value: unknown, label: string) {
  return value === undefined ? undefined : rate(value, label);
}
function optionalFinite(value: unknown, label: string) {
  return value === undefined ? undefined : finite(value, label);
}
function boundedFinite(value: unknown, label: string, minimum: number, maximum: number) {
  const result = finite(value, label);
  if (result < minimum || result > maximum) throw new Error(`${label} is outside its bound`);
  return result;
}
function trueValue(value: unknown, label: string) {
  if (value !== true) throw new Error(`${label} must be true`);
  return true as const;
}
function falseValue(value: unknown, label: string) {
  if (value !== false) throw new Error(`${label} must be false`);
  return false as const;
}
function boundedText(value: unknown, label: string, maximum: number) {
  const result = text(value, label);
  if (result.length > maximum) throw new Error(`${label} is too long`);
  return result;
}
function boundedNonBlankText(value: unknown, label: string, maximum: number) {
  const result = boundedText(value, label, maximum);
  if (!result.trim()) throw new Error(`${label} must be non-empty`);
  return result;
}
function optionalBoundedText(value: unknown, label: string) {
  return value === undefined ? undefined : boundedText(value, label, 1_000);
}
function venueText(value: unknown, label: string) {
  const result = boundedText(value, label, 30);
  if (!/^[a-z0-9_-]{2,30}$/.test(result)) throw new Error(`${label} is invalid`);
  return result;
}
function identifier(value: unknown, label: string) {
  const result = boundedText(value, label, 200);
  if (!/^(?:@[0-9]{1,6}|[A-Za-z0-9][A-Za-z0-9:._/@-]*)$/.test(result)) throw new Error(`${label} is invalid`);
  return result;
}
function scenarioIdentifier(value: unknown, label: string) {
  const result = boundedText(value, label, 40);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(result)) throw new Error(`${label} is invalid`);
  return result;
}
function identity(venue: string, instrumentId: string) {
  return `${venue}\u0000${instrumentId}`;
}
function assertStrictlyIncreasing(values: readonly number[], label: string) {
  for (let index = 1; index < values.length; index += 1) if (values[index - 1]! >= values[index]!) throw new Error(`${label} must be strictly increasing`);
}
function close(left: number, right: number) {
  return Math.abs(left - right) <= Math.max(1e-12, Math.abs(left) * 1e-9, Math.abs(right) * 1e-9);
}

function closeTiming(left: number, right: number) {
  return Math.abs(left - right) <= 1e-6;
}
