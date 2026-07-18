import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { PaperMultiLegFill, PaperMultiLegUnresolvedExposure } from "../src/arbitrage/paperMultiLeg/types.js";
import {
  combinedMultiLegPnl,
  MULTI_LEG_ERROR_CODES,
  MULTI_LEG_MAX_ACTIVE_INTENTS_PER_OWNER,
  MULTI_LEG_MAX_ACTIVE_INTENTS_PER_PORTFOLIO,
  multiLegKillSwitchSettingsKey,
  multiLegQuoteToMicros,
  worstCaseMultiLegCapitalQuote
} from "../src/trading/multiLeg/contract.js";
import { migrateTradingStore, TRADING_SCHEMA_VERSION } from "../src/trading/storeSchema.js";

function fill(partial: Partial<PaperMultiLegFill> & Pick<PaperMultiLegFill, "side" | "filledQuantity" | "averagePrice" | "estimatedFee">): PaperMultiLegFill {
  return {
    legIndex: 0,
    venue: "binance",
    instrumentId: "BTCUSDT",
    quantityUnit: "base",
    plannedQuantity: partial.filledQuantity,
    unfilledQuantity: 0,
    ...partial
  } as PaperMultiLegFill;
}

describe("multi-leg worst-case capital", () => {
  it("covers every planned notional plus fees for both directions", () => {
    // leg1: 2·100·(1 + 2·10/10000) = 200.4; leg2: 1·200·(1 + 2·20/10000) = 200.8
    const quote = worstCaseMultiLegCapitalQuote({
      legs: [
        { plannedQuantity: 2, referencePrice: 100, feeBps: 10 },
        { plannedQuantity: 1, referencePrice: 200, feeBps: 20 }
      ] as never
    });
    expect(quote).toBe(401.2);
  });

  it("ceils sub-micro remainders so a reservation never under-covers", () => {
    // 0.0000015·1·(1+0) = 0.0000015 → ceil to 0.000002
    const quote = worstCaseMultiLegCapitalQuote({
      legs: [{ plannedQuantity: 0.0000015, referencePrice: 1, feeBps: 0 }] as never
    });
    expect(quote).toBe(0.000002);
  });

  it("rejects non-positive and non-finite totals", () => {
    expect(() =>
      worstCaseMultiLegCapitalQuote({ legs: [{ plannedQuantity: 0, referencePrice: 100, feeBps: 10 }] as never })
    ).toThrow(/positive finite/);
    expect(() =>
      worstCaseMultiLegCapitalQuote({
        legs: [{ plannedQuantity: Number.POSITIVE_INFINITY, referencePrice: 1, feeBps: 0 }] as never
      })
    ).toThrow(/positive finite/);
  });
});

describe("combined multi-leg paper PnL", () => {
  it("includes both legs and every modeled fee in the realized figure", () => {
    // buy 2@100 fee 0.2 → −200.2; sell 2@101 fee 0.202 → +201.798; net 1.598, fees 0.402
    const result = combinedMultiLegPnl({
      originalFills: [
        fill({ side: "buy", filledQuantity: 2, averagePrice: 100, estimatedFee: 0.2 }),
        fill({ side: "sell", filledQuantity: 2, averagePrice: 101, estimatedFee: 0.202 })
      ],
      compensationFills: [],
      terminal: undefined
    });
    expect(result.netPnlQuote).toBe(1.598);
    expect(result.feesQuote).toBe(0.402);
    expect(result.residualExposure).toEqual([]);
  });

  it("prices an unwind through compensation fills and reports residual exposure explicitly", () => {
    // original buy 1@100 fee 0.1 → −100.1; compensation sell 0.5@99 fee 0.0495 → +49.4505
    const residual: PaperMultiLegUnresolvedExposure[] = [
      { legIndex: 0, venue: "binance", instrumentId: "BTCUSDT", side: "buy", quantityUnit: "base", quantity: 0.5 } as never
    ];
    const result = combinedMultiLegPnl({
      originalFills: [fill({ side: "buy", filledQuantity: 1, averagePrice: 100, estimatedFee: 0.1 })],
      compensationFills: [fill({ side: "sell", filledQuantity: 0.5, averagePrice: 99, estimatedFee: 0.0495 })],
      terminal: { outcome: "manual-review-required", unresolvedExposure: residual } as never
    });
    expect(result.netPnlQuote).toBe(-50.6495);
    expect(result.feesQuote).toBe(0.1495);
    expect(result.residualExposure).toEqual(residual);
  });

  it("normalizes a zero net to positive zero", () => {
    const result = combinedMultiLegPnl({ originalFills: [], compensationFills: [], terminal: undefined });
    expect(Object.is(result.netPnlQuote, -0)).toBe(false);
    expect(result.netPnlQuote).toBe(0);
  });
});

describe("multi-leg quote micros", () => {
  it("scales deterministically and trims binary float noise", () => {
    expect(multiLegQuoteToMicros(1.5)).toBe(1_500_000);
    expect(multiLegQuoteToMicros(0.1 + 0.2)).toBe(300_000);
    expect(multiLegQuoteToMicros(-31.1982)).toBe(-31_198_200);
    expect(multiLegQuoteToMicros(0)).toBe(0);
  });

  it("rejects non-finite and unsafe magnitudes", () => {
    expect(() => multiLegQuoteToMicros(Number.NaN)).toThrow(/finite/);
    expect(() => multiLegQuoteToMicros(Number.MAX_SAFE_INTEGER)).toThrow(/safe integer/);
  });
});

describe("multi-leg constants", () => {
  it("pins the limits, error codes and kill-switch key shape", () => {
    expect(MULTI_LEG_MAX_ACTIVE_INTENTS_PER_OWNER).toBe(3);
    expect(MULTI_LEG_MAX_ACTIVE_INTENTS_PER_PORTFOLIO).toBe(2);
    expect(MULTI_LEG_ERROR_CODES).toEqual({
      INSUFFICIENT_CAPITAL: "MULTI_LEG_INSUFFICIENT_CAPITAL",
      KILL_SWITCH: "MULTI_LEG_KILL_SWITCH",
      PLAN_REJECTED: "MULTI_LEG_PLAN_REJECTED",
      LIMIT_EXCEEDED: "MULTI_LEG_LIMIT_EXCEEDED"
    });
    expect(multiLegKillSwitchSettingsKey(" owner-1 ")).toBe("multiLegKillSwitch:owner-1");
  });
});

describe("trading schema v10 multi-leg tables", () => {
  it("upgrades v9 data intact and enforces append-only intent events", () => {
    const database = new DatabaseSync(":memory:");
    try {
      migrateTradingStore(database, () => 1_720_000_000_000);
      expect(TRADING_SCHEMA_VERSION).toBe(10);

      database.prepare(`
        INSERT INTO paper_multi_leg_intents (
          intentId, ownerUserId, portfolioId, portfolioEpoch, planJson, planHash,
          sourceEngine, sourceOpportunityId, sourceEvaluatedAt, status,
          reservedCapitalMicros, createdAt, updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run("intent-1", "owner-1", "portfolio-1", 1, "{}", "a".repeat(64), "n-leg-v1", "opp-1", 100, "running", 1_000_000, 100, 100);
      database.prepare(`
        INSERT INTO paper_multi_leg_intent_events (intentId, sequence, eventJson, idempotencyKey, ts)
        VALUES (?, ?, ?, ?, ?)
      `).run("intent-1", 1, "{}", "mleg:intent-1:1", 100);

      expect(() =>
        database.prepare("UPDATE paper_multi_leg_intent_events SET eventJson = '[]' WHERE intentId = 'intent-1'").run()
      ).toThrow(/append-only/);
      expect(() =>
        database.prepare("DELETE FROM paper_multi_leg_intent_events WHERE intentId = 'intent-1'").run()
      ).toThrow(/append-only/);
      expect(() =>
        database.prepare(`
          INSERT INTO paper_multi_leg_intent_events (intentId, sequence, eventJson, idempotencyKey, ts)
          VALUES (?, ?, ?, ?, ?)
        `).run("intent-2", 1, "{}", "mleg:intent-1:1", 101)
      ).toThrow(/unique/i);
      expect(() =>
        database.prepare("UPDATE paper_multi_leg_intents SET status = 'paused' WHERE intentId = 'intent-1'").run()
      ).toThrow(/CHECK/i);
    } finally {
      database.close();
    }
  });
});
