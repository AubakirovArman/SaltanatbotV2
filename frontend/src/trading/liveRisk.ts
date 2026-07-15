export interface LiveRiskLimits {
  maxPositionQuote: number;
  maxOrderQuote: number;
  maxDailyLossQuote: number;
  maxOpenOrders: number;
}

export const DEFAULT_LIVE_RISK_LIMITS: LiveRiskLimits = {
  maxPositionQuote: 1_000,
  maxOrderQuote: 250,
  maxDailyLossQuote: 100,
  maxOpenOrders: 10
};

export function validLiveRiskLimits(limits: LiveRiskLimits): boolean {
  return Number.isFinite(limits.maxPositionQuote)
    && limits.maxPositionQuote > 0
    && Number.isFinite(limits.maxOrderQuote)
    && limits.maxOrderQuote > 0
    && limits.maxOrderQuote <= limits.maxPositionQuote
    && Number.isFinite(limits.maxDailyLossQuote)
    && limits.maxDailyLossQuote > 0
    && Number.isSafeInteger(limits.maxOpenOrders)
    && limits.maxOpenOrders > 0;
}
