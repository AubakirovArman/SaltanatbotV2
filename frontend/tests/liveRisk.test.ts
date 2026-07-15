import { describe, expect, it } from "vitest";
import { DEFAULT_LIVE_RISK_LIMITS, validLiveRiskLimits } from "../src/trading/liveRisk";

describe("live risk form model", () => {
  it("ships conservative valid defaults", () => {
    expect(validLiveRiskLimits(DEFAULT_LIVE_RISK_LIMITS)).toBe(true);
    expect(DEFAULT_LIVE_RISK_LIMITS.maxOrderQuote).toBeLessThanOrEqual(DEFAULT_LIVE_RISK_LIMITS.maxPositionQuote);
  });

  it("rejects zero, non-integer order counts and an order cap above the position cap", () => {
    expect(validLiveRiskLimits({ ...DEFAULT_LIVE_RISK_LIMITS, maxDailyLossQuote: 0 })).toBe(false);
    expect(validLiveRiskLimits({ ...DEFAULT_LIVE_RISK_LIMITS, maxOpenOrders: 1.5 })).toBe(false);
    expect(validLiveRiskLimits({ ...DEFAULT_LIVE_RISK_LIMITS, maxOrderQuote: DEFAULT_LIVE_RISK_LIMITS.maxPositionQuote + 1 })).toBe(false);
  });
});
