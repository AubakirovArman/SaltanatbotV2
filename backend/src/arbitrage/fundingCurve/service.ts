import { processPublicUpstreamGovernor, publicUpstreamSource, type UpstreamResourceGovernor } from "../upstream/resourceGovernor/index.js";
import { publicVenueAdapters } from "../../venues/publicRegistry.js";
import { PublicVenueAdapterError, type PublicFundingPoint, type PublicFundingSchedule, type PublicVenueAdapter } from "../../venues/publicTypes.js";
import { assessScannerObservationTiming, type ScannerObservationTiming, type VenueClockAssessmentProvider } from "../timing/index.js";
import {
  FUNDING_CURVE_ENGINE,
  FUNDING_HORIZON_UNIT,
  FUNDING_RATE_UNIT,
  FUNDING_STRESS_UNIT,
  MAX_FUNDING_CURVE_HISTORY,
  MAX_FUNDING_CURVE_SCENARIOS,
  MAX_FUNDING_CURVE_SELECTIONS,
  MAX_FUNDING_CURVE_SETTLEMENTS,
  MAX_FUNDING_CURVE_SOURCE_ERRORS,
  type FundingCurveHistoryPoint,
  type FundingCurveProjectionRateSource,
  type FundingCurveRejection,
  type FundingCurveRejectionCode,
  type FundingCurveRequest,
  type FundingCurveResponse,
  type FundingCurveResult,
  type FundingCurveScenarioProjection,
  type FundingCurveSelection,
  type FundingCurveSettlementPoint
} from "./types.js";

const MINUTE_MS = 60_000;
const BPS = 10_000;
const MAX_HORIZON_MINUTES = 30 * 24 * 60;
const MAX_AGE_MS = 24 * 60 * 60_000;
const MAX_FUTURE_SKEW_MS = 60_000;
const MAX_ABSOLUTE_RATE = 10;
const MAX_SOURCE_ERROR_ROWS = 1_000;
const MAX_TEXT_LENGTH = 1_000;
const KNOWN_MARKETS = new Set(["spot", "margin", "perpetual", "future", "option", "native-spread"]);

export class FundingCurveRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FundingCurveRequestError";
  }
}

export class FundingCurveCancelledError extends Error {
  constructor() {
    super("Funding curve request was cancelled");
    this.name = "FundingCurveCancelledError";
  }
}

class CurveRejectionError extends Error {
  constructor(
    readonly code: FundingCurveRejectionCode,
    message: string,
    readonly retryable = false
  ) {
    super(message);
    this.name = "CurveRejectionError";
  }
}

export interface FundingCurveServiceOptions {
  now?: () => number;
  /** False is reserved for deterministic tests with hermetic adapters. */
  governor?: UpstreamResourceGovernor | false;
  /** Read-only calibrated state; assessment methods perform no network I/O. */
  clockCalibration?: VenueClockAssessmentProvider;
}

/**
 * Credential-free point-in-time funding research. It never accepts account
 * state, notional, keys or order instructions and therefore cannot execute.
 */
export class FundingCurveService {
  private readonly now: () => number;
  private readonly governor: UpstreamResourceGovernor | undefined;
  private readonly clockCalibration: VenueClockAssessmentProvider | undefined;

  constructor(
    private readonly adapters: ReadonlyMap<string, PublicVenueAdapter> = publicVenueAdapters,
    options: FundingCurveServiceOptions = {}
  ) {
    this.now = options.now ?? Date.now;
    this.governor = options.governor === false ? undefined : (options.governor ?? processPublicUpstreamGovernor);
    this.clockCalibration = options.clockCalibration;
  }

  async evaluate(request: FundingCurveRequest, signal?: AbortSignal): Promise<FundingCurveResponse> {
    validateRequest(request);
    throwIfCancelled(signal);
    const evaluatedAt = timestamp(this.now(), "evaluatedAt");
    const horizonMs = safeMultiply(request.horizon.value, MINUTE_MS, "horizon");
    const horizonEnd = safeAdd(evaluatedAt, horizonMs, "horizonEnd");
    const curves: FundingCurveResult[] = [];
    const rejections: FundingCurveRejection[] = [];

    // Deliberately sequential: a bounded request cannot fan out into an
    // unbounded burst against several public exchange APIs.
    for (const selection of request.selections) {
      throwIfCancelled(signal);
      try {
        curves.push(await this.curve(selection, request, evaluatedAt, horizonEnd, signal));
      } catch (error) {
        if (signal?.aborted || error instanceof FundingCurveCancelledError) throw new FundingCurveCancelledError();
        rejections.push(rejection(selection, error));
      }
    }

    throwIfCancelled(signal);
    return {
      engine: FUNDING_CURVE_ENGINE,
      readOnly: true,
      researchOnly: true,
      executable: false,
      evaluatedAt,
      horizonEnd,
      contract: {
        source: "credential-free-public-venue-adapters",
        rateUnit: FUNDING_RATE_UNIT,
        stressUnit: FUNDING_STRESS_UNIT,
        scheduleRequirement: "adapter-verified-discrete-settlements",
        projection: "point-in-time-estimate-persistence",
        pnl: "not-computed-without-explicit-notional-and-price-path",
        execution: "none"
      },
      crossVenueClock: crossVenueClock(curves, request.maxCrossVenueClockSkewMs),
      curves,
      rejections
    };
  }

  private async curve(selection: FundingCurveSelection, request: FundingCurveRequest, evaluatedAt: number, horizonEnd: number, signal?: AbortSignal): Promise<FundingCurveResult> {
    if (selection.rateUnit !== FUNDING_RATE_UNIT) {
      throw new CurveRejectionError("unsupported-rate-unit", `Only ${FUNDING_RATE_UNIT} is supported`);
    }
    const adapter = this.adapters.get(selection.venue);
    if (!adapter) throw new CurveRejectionError("venue-unavailable", `Public venue adapter '${selection.venue}' is unavailable`);
    const capabilities = adapter.capabilities();
    if (adapter.venue !== selection.venue || capabilities.venue !== selection.venue) {
      throw new CurveRejectionError("identity-mismatch", "Adapter venue identity does not match the requested venue");
    }
    if (!capabilities.publicData || !capabilities.perpetual || !capabilities.funding) {
      throw new CurveRejectionError("funding-unsupported", "Public perpetual funding is not supported by this adapter");
    }

    const nativeInstrumentId = nativeInstrument(selection);
    const schedule = await this.fetchFunding(adapter, nativeInstrumentId, request.historyLimit, signal);
    throwIfCancelled(signal);
    try {
      return normalizeCurve(schedule, selection, nativeInstrumentId, request, evaluatedAt, horizonEnd, this.clockCalibration);
    } catch (error) {
      if (error instanceof CurveRejectionError) throw error;
      throw new CurveRejectionError("invalid-source", error instanceof Error ? error.message : "Funding source is malformed");
    }
  }

  private fetchFunding(adapter: PublicVenueAdapter, instrumentId: string, historyLimit: number, signal?: AbortSignal) {
    const operation = () => adapter.funding(instrumentId, { historyLimit, signal });
    if (!this.governor) return operation();
    const source = publicUpstreamSource(adapter.venue);
    if (!source) throw new CurveRejectionError("venue-unavailable", `No public upstream budget is configured for '${adapter.venue}'`);
    return this.governor.run(source, operation, {
      classifyError: (error) => {
        if (error instanceof PublicVenueAdapterError) {
          if (error.kind === "cancelled") return "aborted";
          if (error.kind === "unsupported" || error.kind === "validation") return "ignored";
        }
        return "failure";
      }
    });
  }
}

function normalizeCurve(schedule: PublicFundingSchedule, selection: FundingCurveSelection, nativeInstrumentId: string, request: FundingCurveRequest, evaluatedAt: number, horizonEnd: number, clockCalibration: VenueClockAssessmentProvider | undefined): FundingCurveResult {
  if (schedule.venue !== selection.venue || schedule.instrumentId !== nativeInstrumentId) {
    throw new CurveRejectionError("identity-mismatch", "Funding response identity does not match the request");
  }
  validateRate(schedule.currentEstimateRate, "currentEstimateRate");
  const nextEstimateRate = optionalRate(schedule.nextEstimateRate, "nextEstimateRate");
  const minimumRate = optionalRate(schedule.minimumRate, "minimumRate");
  const maximumRate = optionalRate(schedule.maximumRate, "maximumRate");
  if (minimumRate !== undefined && maximumRate !== undefined && minimumRate > maximumRate) {
    throw new CurveRejectionError("invalid-source", "Published minimum funding rate exceeds the maximum");
  }
  for (const [label, value] of [
    ["currentEstimateRate", schedule.currentEstimateRate],
    ["nextEstimateRate", nextEstimateRate]
  ] as const) {
    if (value !== undefined && ((minimumRate !== undefined && value < minimumRate) || (maximumRate !== undefined && value > maximumRate))) {
      throw new CurveRejectionError("invalid-source", `${label} is outside the published funding bounds`);
    }
  }

  const exchangeTs = timestamp(schedule.exchangeTs, "exchangeTs");
  const receivedAt = timestamp(schedule.receivedAt, "receivedAt");
  const provenanceExtras = sourceProvenanceExtras(schedule);
  const timing = assessScannerObservationTiming(
    clockCalibration,
    { sourceId: `${selection.venue}:public`, exchangeTs, receivedAt },
    evaluatedAt,
    { maximumAgeMs: request.maxAgeMs, maximumFutureSkewMs: request.maxFutureSkewMs },
    { allowLocalReceiptFallback: true, sourceDeclaredLocalReceipt: provenanceExtras.timestampSource === "local-receive" }
  );
  if (!timing.eligible) {
    if (timing.reason === "timestamp-stale") throw new CurveRejectionError("stale-source", `Funding observation exceeds ${request.maxAgeMs}ms freshness`, true);
    throw new CurveRejectionError("future-source-time", `Funding observation timing is ineligible: ${timing.reason}`);
  }

  if (schedule.scheduleVerified !== true) {
    throw new CurveRejectionError("unverified-schedule", "Adapter does not verify discrete settlement timestamps");
  }
  const interval = schedule.intervalMinutes;
  if (!Number.isSafeInteger(interval) || interval === undefined || interval < 1 || interval > 24 * 60) {
    throw new CurveRejectionError("unsupported-schedule", "Funding interval must be verified whole minutes from 1 to 1440");
  }
  const intervalMs = safeMultiply(interval, MINUTE_MS, "funding interval");
  const fundingTime = timestamp(schedule.fundingTime, "fundingTime");
  const nextFundingTime = timestamp(schedule.nextFundingTime, "nextFundingTime");
  if (safeAdd(fundingTime, intervalMs, "next funding time") !== nextFundingTime) {
    throw new CurveRejectionError("unsupported-schedule", "Funding timestamps are inconsistent with the verified interval");
  }

  const history = normalizeHistory(schedule.history, nativeInstrumentId, request, evaluatedAt);
  const settlements = projectSettlements(fundingTime, nextFundingTime, intervalMs, schedule.currentEstimateRate, nextEstimateRate, evaluatedAt, horizonEnd);
  const scenarios = projectScenarios(settlements, request, minimumRate, maximumRate);
  const sourceErrors = normalizeSourceErrors(schedule.sourceErrors);

  return {
    venue: selection.venue,
    instrumentId: selection.instrumentId,
    marketType: "perpetual",
    rateUnit: FUNDING_RATE_UNIT,
    rateSignConvention: "positive-longs-pay-shorts",
    projectionSemantics: "rate-sum-only-no-notional-or-pnl",
    freshness: fundingFreshness(timing, evaluatedAt, request.maxAgeMs),
    schedule: {
      verified: true,
      interval,
      unit: FUNDING_HORIZON_UNIT,
      fundingTime,
      nextFundingTime
    },
    current: {
      settlementAt: fundingTime,
      estimateRate: schedule.currentEstimateRate,
      estimateRateBps: schedule.currentEstimateRate * BPS,
      rateUnit: FUNDING_RATE_UNIT,
      ...(nextEstimateRate === undefined ? {} : { nextEstimateRate, nextEstimateRateBps: nextEstimateRate * BPS }),
      ...(minimumRate === undefined ? {} : { minimumRate }),
      ...(maximumRate === undefined ? {} : { maximumRate })
    },
    history,
    settlements,
    scenarios,
    source: {
      adapter: "publicVenueAdapters",
      operation: "funding",
      public: true,
      credentialed: false,
      exchangeTs,
      receivedAt,
      ...(schedule.formulaType === undefined ? {} : { formulaType: boundedText(schedule.formulaType, "formulaType") }),
      ...(schedule.method === undefined ? {} : { method: boundedText(schedule.method, "method") }),
      ...provenanceExtras,
      historyComplete: schedule.sourceErrors.length === 0,
      sourceErrors,
      sourceErrorsTruncated: schedule.sourceErrors.length > sourceErrors.length
    }
  };
}

function fundingFreshness(timing: Extract<ScannerObservationTiming, { eligible: true }>, evaluatedAt: number, maxAgeMs: number): FundingCurveResult["freshness"] {
  if (timing.clockBasis === "local-receipt-fallback") {
    return {
      status: "fresh",
      clockBasis: timing.clockBasis,
      crossVenueComparable: false,
      observedAt: timing.observedAt,
      ageMs: timing.ageMs,
      maxAgeMs,
      fallbackReason: timing.fallbackReason
    };
  }
  return {
    status: "fresh",
    clockBasis: timing.clockBasis,
    crossVenueComparable: true,
    observedAt: timing.leg.localEventEarliestAt,
    ageMs: Math.max(0, timing.ageUpperMs),
    maxAgeMs,
    ageLowerMs: timing.ageLowerMs,
    ageUpperMs: timing.ageUpperMs,
    clockLeg: timing.leg
  };
}

function crossVenueClock(curves: readonly FundingCurveResult[], maxSkewMs: number): FundingCurveResponse["crossVenueClock"] {
  const venues = [...new Set(curves.map(({ venue }) => venue))];
  const calibratedVenues = venues.filter((venue) => curves.filter((curve) => curve.venue === venue).every((curve) => curve.freshness.clockBasis === "calibrated-venue-interval"));
  const common = {
    comparedVenueCount: venues.length,
    calibratedVenueCount: calibratedVenues.length,
    maxSkewMs
  };
  if (venues.length < 2) {
    return { status: "not-applicable", eligible: false, reason: "fewer-than-two-successful-venues", ...common };
  }
  if (calibratedVenues.length !== venues.length) {
    return { status: "blocked", eligible: false, reason: "clock-not-calibrated", ...common };
  }
  const calibrated = curves.filter((curve): curve is FundingCurveResult & { freshness: Extract<FundingCurveResult["freshness"], { clockBasis: "calibrated-venue-interval" }> } => curve.freshness.clockBasis === "calibrated-venue-interval");
  let maximumPossibleSkewMs = 0;
  for (let leftIndex = 0; leftIndex < calibrated.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < calibrated.length; rightIndex += 1) {
      const left = calibrated[leftIndex]!;
      const right = calibrated[rightIndex]!;
      if (left.venue === right.venue) continue;
      maximumPossibleSkewMs = Math.max(maximumPossibleSkewMs, Math.abs(left.freshness.clockLeg.localEventEarliestAt - right.freshness.clockLeg.localEventLatestAt), Math.abs(left.freshness.clockLeg.localEventLatestAt - right.freshness.clockLeg.localEventEarliestAt));
    }
  }
  if (maximumPossibleSkewMs > maxSkewMs) {
    return { status: "blocked", eligible: false, reason: "skew-exceeded", ...common, maximumPossibleSkewMs };
  }
  return { status: "eligible", eligible: true, clockBasis: "calibrated-venue-interval", ...common, maximumPossibleSkewMs };
}

function normalizeHistory(points: readonly PublicFundingPoint[], instrumentId: string, request: FundingCurveRequest, evaluatedAt: number): FundingCurveHistoryPoint[] {
  if (!Array.isArray(points) || points.length > request.historyLimit || points.length > MAX_FUNDING_CURVE_HISTORY) {
    throw new CurveRejectionError("invalid-source", "Funding history exceeds the requested bound");
  }
  const normalized = points
    .map((point, index) => {
      if (point.instrumentId !== instrumentId) throw new CurveRejectionError("identity-mismatch", `history[${index}] instrument identity mismatch`);
      const settlementAt = timestamp(point.fundingTime, `history[${index}].fundingTime`);
      if (settlementAt > evaluatedAt + request.maxFutureSkewMs) {
        throw new CurveRejectionError("future-source-time", `history[${index}] is too far in the future`);
      }
      const estimateRate = validateRate(point.fundingRate, `history[${index}].fundingRate`);
      const realizedRate = optionalRate(point.realizedRate, `history[${index}].realizedRate`);
      return {
        settlementAt,
        estimateRate,
        ...(realizedRate === undefined ? {} : { realizedRate }),
        effectiveRate: realizedRate ?? estimateRate,
        rateKind: realizedRate === undefined ? ("estimate" as const) : ("realized" as const),
        rateUnit: FUNDING_RATE_UNIT,
        ...(point.formulaType === undefined ? {} : { formulaType: boundedText(point.formulaType, `history[${index}].formulaType`) }),
        ...(point.method === undefined ? {} : { method: boundedText(point.method, `history[${index}].method`) })
      };
    })
    .sort((left, right) => left.settlementAt - right.settlementAt);
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index - 1]!.settlementAt === normalized[index]!.settlementAt) {
      throw new CurveRejectionError("invalid-source", "Funding history contains duplicate settlement timestamps");
    }
  }
  return normalized;
}

function projectSettlements(fundingTime: number, nextFundingTime: number, intervalMs: number, currentEstimateRate: number, nextEstimateRate: number | undefined, evaluatedAt: number, horizonEnd: number): FundingCurveSettlementPoint[] {
  const elapsed = evaluatedAt <= fundingTime ? 0 : Math.ceil((evaluatedAt - fundingTime) / intervalMs);
  let settlementAt = safeAdd(fundingTime, safeMultiply(elapsed, intervalMs, "settlement offset"), "settlementAt");
  const count = settlementAt >= horizonEnd ? 0 : Math.ceil((horizonEnd - settlementAt) / intervalMs);
  if (count > MAX_FUNDING_CURVE_SETTLEMENTS) {
    throw new CurveRejectionError("projection-too-large", `Projection requires ${count} settlements; maximum is ${MAX_FUNDING_CURVE_SETTLEMENTS}`);
  }
  const result: FundingCurveSettlementPoint[] = [];
  for (let index = 0; index < count; index += 1) {
    const { rate, source } = projectedRate(settlementAt, fundingTime, nextFundingTime, currentEstimateRate, nextEstimateRate);
    result.push({
      settlementAt,
      baseRate: rate,
      baseRateBps: rate * BPS,
      rateUnit: FUNDING_RATE_UNIT,
      rateSource: source
    });
    settlementAt = safeAdd(settlementAt, intervalMs, "settlementAt");
  }
  return result;
}

function projectedRate(settlementAt: number, fundingTime: number, nextFundingTime: number, currentRate: number, nextRate: number | undefined): { rate: number; source: FundingCurveProjectionRateSource } {
  if (settlementAt === fundingTime) return { rate: currentRate, source: "current-estimate" };
  if (settlementAt === nextFundingTime && nextRate !== undefined) return { rate: nextRate, source: "next-estimate" };
  return { rate: nextRate ?? currentRate, source: "latest-estimate-persistence" };
}

function projectScenarios(settlements: readonly FundingCurveSettlementPoint[], request: FundingCurveRequest, minimumRate: number | undefined, maximumRate: number | undefined): FundingCurveScenarioProjection[] {
  return request.stressScenarios.map((scenario) => {
    const bump = scenario.bumpBps / BPS;
    const stressed = settlements.map((point) => validateRate(point.baseRate + bump, `${scenario.id} stressed rate`));
    const cumulativeRate = stressed.reduce((sum, rate) => sum + rate, 0);
    return {
      id: scenario.id,
      bumpBps: scenario.bumpBps,
      unit: FUNDING_STRESS_UNIT,
      settlementCount: stressed.length,
      cumulativeRate,
      averageRatePerSettlement: stressed.length === 0 ? 0 : cumulativeRate / stressed.length,
      outsidePublishedMinimumCount: minimumRate === undefined ? 0 : stressed.filter((rate) => rate < minimumRate).length,
      outsidePublishedMaximumCount: maximumRate === undefined ? 0 : stressed.filter((rate) => rate > maximumRate).length
    };
  });
}

function normalizeSourceErrors(value: readonly string[]) {
  if (!Array.isArray(value) || value.length > MAX_SOURCE_ERROR_ROWS) {
    throw new CurveRejectionError("invalid-source", "Funding source errors exceed the adapter contract bound");
  }
  return value.slice(0, MAX_FUNDING_CURVE_SOURCE_ERRORS).map((message, index) => boundedText(message, `sourceErrors[${index}]`));
}

function sourceProvenanceExtras(schedule: PublicFundingSchedule) {
  const source = schedule as unknown as Record<string, unknown>;
  const network = source.network;
  const currentEstimateSource = source.currentEstimateSource;
  const timestampSource = source.timestampSource;
  if (network !== undefined && network !== "mainnet" && network !== "testnet") {
    throw new CurveRejectionError("invalid-source", "Funding network provenance is unsupported");
  }
  if (timestampSource !== undefined && timestampSource !== "exchange" && timestampSource !== "local-receive") {
    throw new CurveRejectionError("invalid-source", "Funding timestamp provenance is unsupported");
  }
  const normalizedNetwork: "mainnet" | "testnet" | undefined = network === "mainnet" || network === "testnet" ? network : undefined;
  const normalizedTimestampSource: "exchange" | "local-receive" | undefined = timestampSource === "exchange" || timestampSource === "local-receive" ? timestampSource : undefined;
  return {
    ...(normalizedNetwork === undefined ? {} : { network: normalizedNetwork }),
    ...(currentEstimateSource === undefined ? {} : { currentEstimateSource: boundedText(currentEstimateSource as string, "currentEstimateSource") }),
    ...(normalizedTimestampSource === undefined ? {} : { timestampSource: normalizedTimestampSource })
  };
}

function nativeInstrument(selection: FundingCurveSelection) {
  const value = selection.instrumentId;
  if (!value.startsWith(`${selection.venue}:`)) return value;
  const segments = value.split(":");
  const matches = segments.map((market, index) => ({ market, index })).filter((match) => match.index > 0 && match.index < segments.length - 1 && KNOWN_MARKETS.has(match.market));
  if (matches.length !== 1 || matches[0]!.market !== "perpetual") {
    throw new CurveRejectionError("identity-mismatch", "Stable instrument ID must contain exactly one perpetual market scope");
  }
  const native = segments.slice(matches[0]!.index + 1).join(":");
  if (!native) throw new CurveRejectionError("identity-mismatch", "Stable instrument ID has no native venue symbol");
  return native;
}

function rejection(selection: FundingCurveSelection, error: unknown): FundingCurveRejection {
  if (error instanceof CurveRejectionError) {
    return {
      venue: selection.venue,
      instrumentId: selection.instrumentId,
      code: error.code,
      message: boundedErrorMessage(error.message),
      retryable: error.retryable
    };
  }
  if (error instanceof PublicVenueAdapterError) {
    const code = error.kind === "unsupported" ? "funding-unsupported" : error.kind === "validation" ? "invalid-source" : "upstream-unavailable";
    return {
      venue: selection.venue,
      instrumentId: selection.instrumentId,
      code,
      message: boundedErrorMessage(error.message),
      retryable: error.kind === "timeout" || error.kind === "rate-limit" || error.kind === "http" || error.kind === "exchange"
    };
  }
  return {
    venue: selection.venue,
    instrumentId: selection.instrumentId,
    code: "upstream-unavailable",
    message: boundedErrorMessage(error instanceof Error ? error.message : "Public funding source is unavailable"),
    retryable: true
  };
}

function validateRequest(request: FundingCurveRequest) {
  if (!request || typeof request !== "object") throw new FundingCurveRequestError("Request must be an object");
  if (!Array.isArray(request.selections) || request.selections.length < 1 || request.selections.length > MAX_FUNDING_CURVE_SELECTIONS) {
    throw new FundingCurveRequestError(`selections must contain 1 to ${MAX_FUNDING_CURVE_SELECTIONS} rows`);
  }
  const keys = new Set<string>();
  for (const [index, selection] of request.selections.entries()) {
    if (!selection || typeof selection !== "object") throw new FundingCurveRequestError(`selections[${index}] must be an object`);
    if (selection.marketType !== "perpetual") throw new FundingCurveRequestError(`selections[${index}].marketType must be perpetual`);
    if (selection.rateUnit !== FUNDING_RATE_UNIT) throw new FundingCurveRequestError(`selections[${index}].rateUnit is unsupported`);
    if (!/^[a-z0-9_-]{2,30}$/.test(requestText(selection.venue, `selections[${index}].venue`, 30))) throw new FundingCurveRequestError(`selections[${index}].venue is invalid`);
    if (!/^(?:@[0-9]{1,6}|[A-Za-z0-9][A-Za-z0-9:._/@-]*)$/.test(requestText(selection.instrumentId, `selections[${index}].instrumentId`, 200))) throw new FundingCurveRequestError(`selections[${index}].instrumentId is invalid`);
    const key = `${selection.venue}\u0000${selection.instrumentId}`;
    if (keys.has(key)) throw new FundingCurveRequestError("selections must be unique");
    keys.add(key);
  }
  if (request.horizon?.unit !== FUNDING_HORIZON_UNIT || !Number.isSafeInteger(request.horizon.value) || request.horizon.value < 1 || request.horizon.value > MAX_HORIZON_MINUTES) {
    throw new FundingCurveRequestError(`horizon must be 1 to ${MAX_HORIZON_MINUTES} minutes`);
  }
  boundedInteger(request.historyLimit, "historyLimit", 1, MAX_FUNDING_CURVE_HISTORY);
  boundedInteger(request.maxAgeMs, "maxAgeMs", 1, MAX_AGE_MS);
  boundedInteger(request.maxFutureSkewMs, "maxFutureSkewMs", 0, MAX_FUTURE_SKEW_MS);
  boundedInteger(request.maxCrossVenueClockSkewMs, "maxCrossVenueClockSkewMs", 0, MAX_FUTURE_SKEW_MS);
  if (!Array.isArray(request.stressScenarios) || request.stressScenarios.length < 1 || request.stressScenarios.length > MAX_FUNDING_CURVE_SCENARIOS) {
    throw new FundingCurveRequestError(`stressScenarios must contain 1 to ${MAX_FUNDING_CURVE_SCENARIOS} rows`);
  }
  const scenarioIds = new Set<string>();
  for (const [index, scenario] of request.stressScenarios.entries()) {
    if (!scenario || typeof scenario !== "object") throw new FundingCurveRequestError(`stressScenarios[${index}] must be an object`);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(requestText(scenario.id, `stressScenarios[${index}].id`, 40))) throw new FundingCurveRequestError(`stressScenarios[${index}].id is invalid`);
    if (scenarioIds.has(scenario.id)) throw new FundingCurveRequestError("stress scenario IDs must be unique");
    scenarioIds.add(scenario.id);
    if (scenario.unit !== FUNDING_STRESS_UNIT || !Number.isFinite(scenario.bumpBps) || scenario.bumpBps < -10_000 || scenario.bumpBps > 10_000) {
      throw new FundingCurveRequestError(`stressScenarios[${index}] has unsupported unit or bump`);
    }
  }
}

function validateRate(value: number, label: string) {
  if (!Number.isFinite(value) || Math.abs(value) > MAX_ABSOLUTE_RATE) {
    throw new CurveRejectionError("invalid-source", `${label} must be finite and within +/-${MAX_ABSOLUTE_RATE}`);
  }
  return value;
}

function optionalRate(value: number | undefined, label: string) {
  return value === undefined ? undefined : validateRate(value, label);
}

function timestamp(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 1) throw new CurveRejectionError("invalid-source", `${label} must be a positive safe integer`);
  return value;
}

function boundedInteger(value: number, label: string, minimum: number, maximum: number) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new FundingCurveRequestError(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function boundedText(value: string, label: string, maximum = MAX_TEXT_LENGTH) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) {
    throw new CurveRejectionError("invalid-source", `${label} must contain 1 to ${maximum} characters`);
  }
  return value;
}

function requestText(value: string, label: string, maximum: number) {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) {
    throw new FundingCurveRequestError(`${label} must contain 1 to ${maximum} characters`);
  }
  return value;
}

function boundedErrorMessage(value: string) {
  if (!value) return "Public funding source is unavailable";
  return value.length <= MAX_TEXT_LENGTH ? value : `${value.slice(0, MAX_TEXT_LENGTH - 1)}…`;
}

function safeAdd(left: number, right: number, label: string) {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new CurveRejectionError("projection-too-large", `${label} exceeds safe integer range`);
  return result;
}

function safeMultiply(left: number, right: number, label: string) {
  const result = left * right;
  if (!Number.isSafeInteger(result)) throw new CurveRejectionError("projection-too-large", `${label} exceeds safe integer range`);
  return result;
}

function throwIfCancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new FundingCurveCancelledError();
}
