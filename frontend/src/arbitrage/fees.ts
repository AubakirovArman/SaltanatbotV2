import type { ArbitrageExchange, ArbitrageOpportunity } from "./client";
import type { MarketOpportunityBasisScenario } from "@saltanatbotv2/arbitrage-sdk";
import { readTenantLocalItem, writeTenantLocalItem, type TenantLocalStorage } from "../app/tenantLocalStorage";

export interface ArbitrageFeeProfile {
  binanceSpotTakerBps: number;
  binancePerpetualTakerBps: number;
  bybitSpotTakerBps: number;
  bybitPerpetualTakerBps: number;
  roundTripSlippageReserveBps: number;
  expectedHoldingHours: number;
  annualBorrowRatePct: number;
  transferCostUsd: number;
  derivativeInitialMarginPct: number;
  derivativeSafetyBufferPct: number;
}

export const DEFAULT_FEE_PROFILE: ArbitrageFeeProfile = {
  binanceSpotTakerBps: 10,
  binancePerpetualTakerBps: 5,
  bybitSpotTakerBps: 10,
  bybitPerpetualTakerBps: 6,
  roundTripSlippageReserveBps: 8,
  expectedHoldingHours: 8,
  annualBorrowRatePct: 0,
  transferCostUsd: 0,
  derivativeInitialMarginPct: 20,
  derivativeSafetyBufferPct: 10
};

export const ARBITRAGE_FEE_PROFILE_STORAGE_KEY = "sbv2:arbitrage-fees:v2";

export interface ArbitrageCostBreakdown {
  tradingFeesBps: number;
  slippageReserveBps: number;
  borrowCostBps: number;
  transferCostBps: number;
  fundingCostBps: number;
  fundingSettlementCount: number;
  fundingScheduleVerified: boolean;
  totalBps: number;
}

export interface BasisDisplayedScenario {
  netEdgeBps: number;
  projectedNetProfitUsd: number;
  basisScenario: MarketOpportunityBasisScenario;
}

type FundingSchedule = Pick<ArbitrageOpportunity, "fundingRate" | "fundingIntervalMinutes" | "fundingScheduleVerified" | "nextFundingTime">;

export function routeCostBreakdown(row: Pick<ArbitrageOpportunity, "spotExchange" | "futuresExchange"> & FundingSchedule, profile: ArbitrageFeeProfile, notionalUsd = 10_000, now = Date.now()): ArbitrageCostBreakdown {
  const tradingFeesBps = 2 * (spotFee(row.spotExchange, profile) + perpetualFee(row.futuresExchange, profile));
  const borrowCostBps = (((profile.annualBorrowRatePct / 100) * profile.expectedHoldingHours) / (365 * 24)) * 10_000;
  const transferCostBps = (profile.transferCostUsd / Math.max(10, notionalUsd)) * 10_000;
  const fundingSettlementCount = projectedFundingSettlements(row, profile.expectedHoldingHours, now);
  // A positive funding rate is received by the short perpetual leg and therefore reduces cost.
  const fundingCostBps = -row.fundingRate * fundingSettlementCount * 10_000;
  const totalBps = tradingFeesBps + profile.roundTripSlippageReserveBps + borrowCostBps + transferCostBps + fundingCostBps;
  return {
    tradingFeesBps,
    slippageReserveBps: profile.roundTripSlippageReserveBps,
    borrowCostBps,
    transferCostBps,
    fundingCostBps,
    fundingSettlementCount,
    fundingScheduleVerified: row.fundingScheduleVerified,
    totalBps
  };
}

export function routeCostBps(row: Pick<ArbitrageOpportunity, "spotExchange" | "futuresExchange"> & FundingSchedule, profile: ArbitrageFeeProfile, notionalUsd = 10_000): number {
  return routeCostBreakdown(row, profile, notionalUsd).totalBps;
}

export function routeNonFundingCostBps(row: Pick<ArbitrageOpportunity, "spotExchange" | "futuresExchange">, profile: ArbitrageFeeProfile, notionalUsd = 10_000) {
  return routeCostBreakdown({ ...row, fundingRate: 0, fundingScheduleVerified: false }, profile, notionalUsd).totalBps;
}

export function maximumRouteNonFundingCostBps(profile: ArbitrageFeeProfile, notionalUsd = 10_000) {
  return Math.max(routeNonFundingCostBps({ spotExchange: "binance", futuresExchange: "bybit" }, profile, notionalUsd), routeNonFundingCostBps({ spotExchange: "bybit", futuresExchange: "binance" }, profile, notionalUsd));
}

export function netEdgeBps(row: ArbitrageOpportunity, profile: ArbitrageFeeProfile, notionalUsd = 10_000): number {
  return basisDisplayedScenario(row, profile, notionalUsd).netEdgeBps;
}

export function projectedNetProfitUsd(row: ArbitrageOpportunity, profile: ArbitrageFeeProfile, notionalUsd = 10_000) {
  return basisDisplayedScenario(row, profile, notionalUsd).projectedNetProfitUsd;
}

/** One coherent scenario shared by filtering, displayed metrics and Automation handoff. */
export function basisDisplayedScenario(row: ArbitrageOpportunity, profile: ArbitrageFeeProfile, requestedNotionalUsd = 10_000, computedAt = Date.now()): BasisDisplayedScenario {
  const requested = Math.max(0, requestedNotionalUsd);
  const executableNotionalUsd = Math.min(requested, Math.max(0, row.topBookCapacityUsd));
  const costNotional = executableNotionalUsd || requested;
  const breakdown = routeCostBreakdown(row, profile, costNotional, computedAt);
  const net = row.grossSpreadBps - breakdown.totalBps;
  return {
    netEdgeBps: net,
    projectedNetProfitUsd: (executableNotionalUsd * net) / 10_000,
    basisScenario: {
      model: "browser-basis-cost-v1",
      computedAt,
      requestedNotionalUsd: requested,
      executableNotionalUsd,
      assumptions: {
        spotTakerBps: spotFee(row.spotExchange, profile),
        perpetualTakerBps: perpetualFee(row.futuresExchange, profile),
        roundTripSlippageReserveBps: profile.roundTripSlippageReserveBps,
        expectedHoldingHours: profile.expectedHoldingHours,
        annualBorrowRatePct: profile.annualBorrowRatePct,
        transferCostUsd: profile.transferCostUsd
      },
      costBreakdownBps: {
        tradingFees: breakdown.tradingFeesBps,
        slippage: breakdown.slippageReserveBps,
        borrow: breakdown.borrowCostBps,
        transfer: breakdown.transferCostBps,
        funding: breakdown.fundingCostBps,
        total: breakdown.totalBps,
        fundingSettlementCount: breakdown.fundingSettlementCount,
        fundingScheduleVerified: breakdown.fundingScheduleVerified
      }
    }
  };
}

export interface ArbitrageCapitalEstimate {
  executableNotionalUsd: number;
  spotCapitalUsd: number;
  derivativeInitialMarginUsd: number;
  derivativeSafetyBufferUsd: number;
  requiredCapitalUsd: number;
}

export interface ArbitrageConvergenceScenario {
  convergencePct: number;
  grossPnlUsd: number;
  costUsd: number;
  netPnlUsd: number;
  roiPct: number;
}

/** Explicit capital denominator used by ROI; it remains a user scenario, not account telemetry. */
export function capitalEstimate(row: Pick<ArbitrageOpportunity, "topBookCapacityUsd">, profile: ArbitrageFeeProfile, requestedNotionalUsd: number): ArbitrageCapitalEstimate {
  const executableNotionalUsd = Math.min(Math.max(0, requestedNotionalUsd), Math.max(0, row.topBookCapacityUsd));
  const spotCapitalUsd = executableNotionalUsd;
  const derivativeInitialMarginUsd = executableNotionalUsd * (profile.derivativeInitialMarginPct / 100);
  const derivativeSafetyBufferUsd = executableNotionalUsd * (profile.derivativeSafetyBufferPct / 100);
  return {
    executableNotionalUsd,
    spotCapitalUsd,
    derivativeInitialMarginUsd,
    derivativeSafetyBufferUsd,
    requiredCapitalUsd: spotCapitalUsd + derivativeInitialMarginUsd + derivativeSafetyBufferUsd
  };
}

export function projectedRoiPct(row: ArbitrageOpportunity, profile: ArbitrageFeeProfile, requestedNotionalUsd = 10_000) {
  const capital = capitalEstimate(row, profile, requestedNotionalUsd);
  return capital.requiredCapitalUsd > 0 ? (projectedNetProfitUsd(row, profile, requestedNotionalUsd) / capital.requiredCapitalUsd) * 100 : 0;
}

/** Shows how much of the observed entry basis must actually converge before the route earns it. */
export function convergenceScenarios(row: ArbitrageOpportunity, profile: ArbitrageFeeProfile, requestedNotionalUsd = 10_000, now = Date.now()): ArbitrageConvergenceScenario[] {
  const capital = capitalEstimate(row, profile, requestedNotionalUsd);
  const breakdown = routeCostBreakdown(row, profile, capital.executableNotionalUsd || requestedNotionalUsd, now);
  const costUsd = (capital.executableNotionalUsd * breakdown.totalBps) / 10_000;
  return [100, 75, 50, 25, 0].map((convergencePct) => {
    const grossPnlUsd = capital.executableNotionalUsd * (row.grossSpreadBps / 10_000) * (convergencePct / 100);
    const netPnlUsd = grossPnlUsd - costUsd;
    return {
      convergencePct,
      grossPnlUsd,
      costUsd,
      netPnlUsd,
      roiPct: capital.requiredCapitalUsd > 0 ? (netPnlUsd / capital.requiredCapitalUsd) * 100 : 0
    };
  });
}

export function loadFeeProfile(ownerId?: string, storage: TenantLocalStorage | undefined = browserStorage()): ArbitrageFeeProfile {
  if (!storage) return DEFAULT_FEE_PROFILE;
  try {
    const value = JSON.parse(readTenantLocalItem(storage, ARBITRAGE_FEE_PROFILE_STORAGE_KEY, ownerId) ?? "null") as Partial<ArbitrageFeeProfile> | null;
    if (!value) return DEFAULT_FEE_PROFILE;
    return Object.fromEntries(Object.entries(DEFAULT_FEE_PROFILE).map(([key, fallback]) => [key, bounded(key as keyof ArbitrageFeeProfile, value[key as keyof ArbitrageFeeProfile], fallback)])) as unknown as ArbitrageFeeProfile;
  } catch {
    return DEFAULT_FEE_PROFILE;
  }
}

export function storeFeeProfile(profile: ArbitrageFeeProfile, ownerId?: string, storage: TenantLocalStorage | undefined = browserStorage()) {
  if (!storage) return;
  try {
    writeTenantLocalItem(storage, ARBITRAGE_FEE_PROFILE_STORAGE_KEY, JSON.stringify(profile), ownerId);
  } catch {
    // Storage can be unavailable; the current scenario remains usable in memory.
  }
}

/**
 * Counts funding events used by the estimate. Unknown schedules never earn a
 * speculative credit; a negative current rate is charged for at least one
 * settlement even when nextFundingTime is missing.
 */
export function projectedFundingSettlements(schedule: FundingSchedule, holdingHours: number, now = Date.now()) {
  if (!(holdingHours > 0) || !Number.isFinite(schedule.fundingRate)) return 0;
  const end = now + holdingHours * 60 * 60_000;
  if (!schedule.fundingScheduleVerified) {
    return schedule.fundingRate < 0 ? 1 : 0;
  }
  if (!(schedule.fundingIntervalMinutes && schedule.fundingIntervalMinutes > 0) || !(schedule.nextFundingTime && schedule.nextFundingTime > 0) || !Number.isFinite(end)) {
    return 0;
  }
  const intervalMs = schedule.fundingIntervalMinutes * 60_000;
  let next = schedule.nextFundingTime;
  if (next <= now) next += (Math.floor((now - next) / intervalMs) + 1) * intervalMs;
  return next > end ? 0 : 1 + Math.floor((end - next) / intervalMs);
}

function spotFee(exchange: ArbitrageExchange, profile: ArbitrageFeeProfile) {
  return exchange === "binance" ? profile.binanceSpotTakerBps : profile.bybitSpotTakerBps;
}
function perpetualFee(exchange: ArbitrageExchange, profile: ArbitrageFeeProfile) {
  return exchange === "binance" ? profile.binancePerpetualTakerBps : profile.bybitPerpetualTakerBps;
}
function bounded(key: keyof ArbitrageFeeProfile, value: unknown, fallback: number) {
  const maximum = key === "transferCostUsd" ? 1_000_000 : key === "expectedHoldingHours" ? 720 : 1_000;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= maximum ? value : fallback;
}

function browserStorage(): TenantLocalStorage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}
