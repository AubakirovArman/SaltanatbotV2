import type { ArbitrageExchange, ArbitrageOpportunity } from "./client";

export interface ArbitrageFeeProfile {
  binanceSpotTakerBps: number;
  binancePerpetualTakerBps: number;
  bybitSpotTakerBps: number;
  bybitPerpetualTakerBps: number;
  roundTripSlippageReserveBps: number;
  expectedHoldingHours: number;
  annualBorrowRatePct: number;
  transferCostUsd: number;
}

export const DEFAULT_FEE_PROFILE: ArbitrageFeeProfile = {
  binanceSpotTakerBps: 10,
  binancePerpetualTakerBps: 5,
  bybitSpotTakerBps: 10,
  bybitPerpetualTakerBps: 6,
  roundTripSlippageReserveBps: 8,
  expectedHoldingHours: 8,
  annualBorrowRatePct: 0,
  transferCostUsd: 0
};

const KEY = "sbv2:arbitrage-fees:v2";

export interface ArbitrageCostBreakdown {
  tradingFeesBps: number;
  slippageReserveBps: number;
  borrowCostBps: number;
  transferCostBps: number;
  fundingCostBps: number;
  totalBps: number;
}

export function routeCostBreakdown(row: Pick<ArbitrageOpportunity, "spotExchange" | "futuresExchange" | "fundingRate">, profile: ArbitrageFeeProfile, notionalUsd = 10_000): ArbitrageCostBreakdown {
  const tradingFeesBps = 2 * (spotFee(row.spotExchange, profile) + perpetualFee(row.futuresExchange, profile));
  const borrowCostBps = (((profile.annualBorrowRatePct / 100) * profile.expectedHoldingHours) / (365 * 24)) * 10_000;
  const transferCostBps = (profile.transferCostUsd / Math.max(10, notionalUsd)) * 10_000;
  // A positive funding rate is received by the short perpetual leg and therefore reduces cost.
  const fundingCostBps = -row.fundingRate * (profile.expectedHoldingHours / 8) * 10_000;
  const totalBps = tradingFeesBps + profile.roundTripSlippageReserveBps + borrowCostBps + transferCostBps + fundingCostBps;
  return { tradingFeesBps, slippageReserveBps: profile.roundTripSlippageReserveBps, borrowCostBps, transferCostBps, fundingCostBps, totalBps };
}

export function routeCostBps(row: Pick<ArbitrageOpportunity, "spotExchange" | "futuresExchange" | "fundingRate">, profile: ArbitrageFeeProfile, notionalUsd = 10_000): number {
  return routeCostBreakdown(row, profile, notionalUsd).totalBps;
}

export function routeNonFundingCostBps(row: Pick<ArbitrageOpportunity, "spotExchange" | "futuresExchange">, profile: ArbitrageFeeProfile, notionalUsd = 10_000) {
  return routeCostBreakdown({ ...row, fundingRate: 0 }, profile, notionalUsd).totalBps;
}

export function maximumRouteNonFundingCostBps(profile: ArbitrageFeeProfile, notionalUsd = 10_000) {
  return Math.max(routeNonFundingCostBps({ spotExchange: "binance", futuresExchange: "bybit" }, profile, notionalUsd), routeNonFundingCostBps({ spotExchange: "bybit", futuresExchange: "binance" }, profile, notionalUsd));
}

export function netEdgeBps(row: ArbitrageOpportunity, profile: ArbitrageFeeProfile, notionalUsd = 10_000): number {
  return row.grossSpreadBps - routeCostBps(row, profile, notionalUsd);
}

export function loadFeeProfile(): ArbitrageFeeProfile {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<ArbitrageFeeProfile> | null;
    if (!value) return DEFAULT_FEE_PROFILE;
    return Object.fromEntries(Object.entries(DEFAULT_FEE_PROFILE).map(([key, fallback]) => [key, bounded(key as keyof ArbitrageFeeProfile, value[key as keyof ArbitrageFeeProfile], fallback)])) as unknown as ArbitrageFeeProfile;
  } catch {
    return DEFAULT_FEE_PROFILE;
  }
}

export function storeFeeProfile(profile: ArbitrageFeeProfile) {
  localStorage.setItem(KEY, JSON.stringify(profile));
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
