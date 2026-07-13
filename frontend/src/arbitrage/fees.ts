import type { ArbitrageExchange, ArbitrageOpportunity } from "./client";

export interface ArbitrageFeeProfile {
  binanceSpotTakerBps: number;
  binancePerpetualTakerBps: number;
  bybitSpotTakerBps: number;
  bybitPerpetualTakerBps: number;
  roundTripSlippageReserveBps: number;
}

export const DEFAULT_FEE_PROFILE: ArbitrageFeeProfile = {
  binanceSpotTakerBps: 10, binancePerpetualTakerBps: 5,
  bybitSpotTakerBps: 10, bybitPerpetualTakerBps: 6,
  roundTripSlippageReserveBps: 8
};

const KEY = "sbv2:arbitrage-fees:v1";

export function routeCostBps(row: Pick<ArbitrageOpportunity, "spotExchange" | "futuresExchange">, profile: ArbitrageFeeProfile): number {
  return 2 * (spotFee(row.spotExchange, profile) + perpetualFee(row.futuresExchange, profile)) + profile.roundTripSlippageReserveBps;
}

export function netEdgeBps(row: ArbitrageOpportunity, profile: ArbitrageFeeProfile): number { return row.grossSpreadBps - routeCostBps(row, profile); }

export function loadFeeProfile(): ArbitrageFeeProfile {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<ArbitrageFeeProfile> | null;
    if (!value) return DEFAULT_FEE_PROFILE;
    return Object.fromEntries(Object.entries(DEFAULT_FEE_PROFILE).map(([key, fallback]) => [key, bounded(value[key as keyof ArbitrageFeeProfile], fallback)])) as unknown as ArbitrageFeeProfile;
  } catch { return DEFAULT_FEE_PROFILE; }
}

export function storeFeeProfile(profile: ArbitrageFeeProfile) { localStorage.setItem(KEY, JSON.stringify(profile)); }

function spotFee(exchange: ArbitrageExchange, profile: ArbitrageFeeProfile) { return exchange === "binance" ? profile.binanceSpotTakerBps : profile.bybitSpotTakerBps; }
function perpetualFee(exchange: ArbitrageExchange, profile: ArbitrageFeeProfile) { return exchange === "binance" ? profile.binancePerpetualTakerBps : profile.bybitPerpetualTakerBps; }
function bounded(value: unknown, fallback: number) { return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1_000 ? value : fallback; }
