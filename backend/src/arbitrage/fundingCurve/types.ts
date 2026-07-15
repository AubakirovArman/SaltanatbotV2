import type { RegistryInstrument } from "@saltanatbotv2/contracts";
import type { ScannerCalibratedClockLeg } from "../timing/index.js";
import type { PublicFundingSchedule } from "../../venues/publicTypes.js";

export const FUNDING_CURVE_ENGINE = "funding-curve-v1" as const;
export const FUNDING_CURVE_UNIVERSE_ENGINE = "funding-curve-universe-v1" as const;
export const FUNDING_RATE_UNIT = "decimal-per-settlement" as const;
export const FUNDING_STRESS_UNIT = "basis-points-additive-per-settlement" as const;
export const FUNDING_HORIZON_UNIT = "minutes" as const;

export const MAX_FUNDING_CURVE_SELECTIONS = 8;
export const MAX_FUNDING_CURVE_HISTORY = 500;
export const MAX_FUNDING_CURVE_SCENARIOS = 9;
export const MAX_FUNDING_CURVE_SETTLEMENTS = 512;
export const MAX_FUNDING_CURVE_SOURCE_ERRORS = 32;
export const MAX_FUNDING_CURVE_UNIVERSE_INSTRUMENTS = 5_000;

export interface FundingCurveUniverseResponse {
  engine: typeof FUNDING_CURVE_UNIVERSE_ENGINE;
  readOnly: true;
  researchOnly: true;
  executable: false;
  updatedAt: number;
  stale: boolean;
  contract: {
    owner: "server";
    adapterRegistry: "publicVenueAdapters";
    instruments: "fresh-verified-trading-perpetuals";
    execution: "none";
  };
  economicIdentityCatalog: {
    schemaVersion: 1;
    source: string;
    version: string;
    asOf: number;
    validUntil: number;
  };
  /** Every venue this server can pass to FundingCurveService. */
  supportedVenues: string[];
  total: number;
  truncated: boolean;
  instruments: RegistryInstrument[];
  sourceErrors: string[];
}

export type FundingCurveRateUnit = typeof FUNDING_RATE_UNIT;
export type FundingCurveStressUnit = typeof FUNDING_STRESS_UNIT;
export type FundingCurveHorizonUnit = typeof FUNDING_HORIZON_UNIT;

export interface FundingCurveSelection {
  venue: string;
  instrumentId: string;
  marketType: "perpetual";
  rateUnit: FundingCurveRateUnit;
}

export interface FundingCurveStressScenario {
  id: string;
  bumpBps: number;
  unit: FundingCurveStressUnit;
}

export interface FundingCurveRequest {
  selections: readonly FundingCurveSelection[];
  horizon: {
    value: number;
    unit: FundingCurveHorizonUnit;
  };
  historyLimit: number;
  maxAgeMs: number;
  maxFutureSkewMs: number;
  maxCrossVenueClockSkewMs: number;
  stressScenarios: readonly FundingCurveStressScenario[];
}

export type FundingCurveProjectionRateSource = "current-estimate" | "next-estimate" | "latest-estimate-persistence";

export interface FundingCurveHistoryPoint {
  settlementAt: number;
  estimateRate: number;
  realizedRate?: number;
  effectiveRate: number;
  rateKind: "estimate" | "realized";
  rateUnit: FundingCurveRateUnit;
  formulaType?: string;
  method?: string;
}

export interface FundingCurveSettlementPoint {
  settlementAt: number;
  baseRate: number;
  baseRateBps: number;
  rateUnit: FundingCurveRateUnit;
  rateSource: FundingCurveProjectionRateSource;
}

export interface FundingCurveScenarioProjection {
  id: string;
  bumpBps: number;
  unit: FundingCurveStressUnit;
  settlementCount: number;
  cumulativeRate: number;
  averageRatePerSettlement: number;
  outsidePublishedMinimumCount: number;
  outsidePublishedMaximumCount: number;
}

export interface FundingCurveSourceProvenance {
  adapter: "publicVenueAdapters";
  operation: "funding";
  public: true;
  credentialed: false;
  exchangeTs: number;
  receivedAt: number;
  formulaType?: string;
  method?: string;
  network?: "mainnet" | "testnet";
  currentEstimateSource?: string;
  timestampSource?: "exchange" | "local-receive";
  historyComplete: boolean;
  sourceErrors: string[];
  sourceErrorsTruncated: boolean;
}

export interface FundingCurveResult {
  venue: string;
  instrumentId: string;
  marketType: "perpetual";
  rateUnit: FundingCurveRateUnit;
  rateSignConvention: "positive-longs-pay-shorts";
  projectionSemantics: "rate-sum-only-no-notional-or-pnl";
  freshness: {
    status: "fresh";
    observedAt: number;
    ageMs: number;
    maxAgeMs: number;
  } & (
    | {
        clockBasis: "calibrated-venue-interval";
        crossVenueComparable: true;
        ageLowerMs: number;
        ageUpperMs: number;
        clockLeg: ScannerCalibratedClockLeg;
      }
    | {
        clockBasis: "local-receipt-fallback";
        crossVenueComparable: false;
        fallbackReason: "clock-provider-unavailable" | "clock-unavailable" | "clock-not-calibrated" | "source-declared-local-receipt";
      }
  );
  schedule: {
    verified: true;
    interval: number;
    unit: FundingCurveHorizonUnit;
    fundingTime: number;
    nextFundingTime: number;
  };
  current: {
    settlementAt: number;
    estimateRate: number;
    estimateRateBps: number;
    rateUnit: FundingCurveRateUnit;
    nextEstimateRate?: number;
    nextEstimateRateBps?: number;
    minimumRate?: number;
    maximumRate?: number;
  };
  history: FundingCurveHistoryPoint[];
  settlements: FundingCurveSettlementPoint[];
  scenarios: FundingCurveScenarioProjection[];
  source: FundingCurveSourceProvenance;
}

export type FundingCurveRejectionCode = "venue-unavailable" | "funding-unsupported" | "unsupported-rate-unit" | "identity-mismatch" | "stale-source" | "future-source-time" | "unverified-schedule" | "unsupported-schedule" | "invalid-source" | "projection-too-large" | "upstream-unavailable";

export interface FundingCurveRejection {
  venue: string;
  instrumentId: string;
  code: FundingCurveRejectionCode;
  message: string;
  retryable: boolean;
}

export interface FundingCurveResponse {
  engine: typeof FUNDING_CURVE_ENGINE;
  readOnly: true;
  researchOnly: true;
  executable: false;
  evaluatedAt: number;
  horizonEnd: number;
  contract: {
    source: "credential-free-public-venue-adapters";
    rateUnit: FundingCurveRateUnit;
    stressUnit: FundingCurveStressUnit;
    scheduleRequirement: "adapter-verified-discrete-settlements";
    projection: "point-in-time-estimate-persistence";
    pnl: "not-computed-without-explicit-notional-and-price-path";
    execution: "none";
  };
  crossVenueClock:
    | {
        status: "not-applicable";
        eligible: false;
        reason: "fewer-than-two-successful-venues";
        comparedVenueCount: number;
        calibratedVenueCount: number;
        maxSkewMs: number;
      }
    | {
        status: "blocked";
        eligible: false;
        reason: "clock-not-calibrated" | "skew-exceeded";
        comparedVenueCount: number;
        calibratedVenueCount: number;
        maxSkewMs: number;
        maximumPossibleSkewMs?: number;
      }
    | {
        status: "eligible";
        eligible: true;
        clockBasis: "calibrated-venue-interval";
        comparedVenueCount: number;
        calibratedVenueCount: number;
        maxSkewMs: number;
        maximumPossibleSkewMs: number;
      };
  curves: FundingCurveResult[];
  rejections: FundingCurveRejection[];
}

export interface FundingCurveAdapterObservation {
  selection: FundingCurveSelection;
  schedule: PublicFundingSchedule;
}
