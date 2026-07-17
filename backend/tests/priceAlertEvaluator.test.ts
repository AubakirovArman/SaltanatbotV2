import type { Candle, PriceThresholdAlertDefinitionV1 } from "@saltanatbotv2/contracts";
import { describe, expect, it } from "vitest";
import { evaluatePriceThresholdAlert, validateClosedCandleWindow, type PriceThresholdAlertEvaluationInputV1 } from "../src/alerts/priceEvaluator.js";

const RULE_ID = "11111111-1111-4111-8111-111111111111";
const MINUTE = 60_000;
const NOW = 240_000;

describe("price threshold alert evaluator", () => {
  it("uses exact decimal comparison for an inclusive above match and returns stable evidence", () => {
    const input = evaluationInput({
      definition: definition({ direction: "above", threshold: "101" }),
      candles: [candle(60_000, 100), candle(120_000, 101), candle(180_000, 102)],
      state: { status: "armed", armedAt: 1, initialized: true, eligible: false, lastEvaluatedBarTime: 60_000 }
    });

    const first = evaluatePriceThresholdAlert(input);
    const replay = evaluatePriceThresholdAlert(input);

    expect(first).toEqual(replay);
    expect(first).toMatchObject({
      status: "evaluated",
      evaluatedBars: 1,
      triggered: true,
      observation: {
        candleOpenTime: 120_000,
        candleCloseTime: 180_000,
        close: 101,
        researchOnly: true,
        executionPermission: false
      },
      transition: {
        kind: "price-threshold-triggered",
        from: "armed",
        to: "triggered",
        ruleId: RULE_ID,
        ruleRevision: 3,
        threshold: "101",
        direction: "above",
        occurredAt: 180_000,
        researchOnly: true,
        executionPermission: false
      },
      nextState: {
        status: "triggered",
        initialized: true,
        eligible: true,
        lastEvaluatedBarTime: 120_000
      }
    });
    if (first.status !== "evaluated" || !first.transition) throw new Error("expected transition");
    expect(first.observation.observationKey).toBe("market:binance:spot:last:BTCUSDT:1m:bar:120000");
    expect(first.observation.evidenceFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(first.transition.transitionKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it("matches an exact inclusive below threshold and stops at the first matching bar", () => {
    const result = evaluatePriceThresholdAlert(
      evaluationInput({
        definition: definition({ direction: "below", threshold: "99" }),
        candles: [candle(60_000, 100), candle(120_000, 99), candle(180_000, 98)],
        state: { status: "armed", armedAt: 1, initialized: true, eligible: false, lastEvaluatedBarTime: 60_000 }
      })
    );

    expect(result).toMatchObject({
      status: "evaluated",
      evaluatedBars: 1,
      triggered: true,
      observation: { candleOpenTime: 120_000, close: 99 },
      transition: { direction: "below", observedPrice: 99 }
    });
  });

  it.each([
    ["above", "64703.520000000001", false],
    ["above", "64703.519999999999", true],
    ["above", "64703.52", true],
    ["below", "64703.520000000001", true],
    ["below", "64703.519999999999", false],
    ["below", "64703.52", true]
  ] as const)("compares %s threshold %s without rounding the declaration", (direction, threshold, triggered) => {
    const result = evaluatePriceThresholdAlert(
      evaluationInput({
        definition: definition({ direction, threshold }),
        candles: [candle(120_000, 64_703.52)],
        state: { status: "armed", armedAt: 1, initialized: true, eligible: false, lastEvaluatedBarTime: 60_000 },
        now: 180_000
      })
    );
    expect(result).toMatchObject({ status: "evaluated", triggered });
    if (result.status === "evaluated") expect(Boolean(result.transition)).toBe(triggered);
  });

  it("matches an expanded 1e-8 observed price exactly", () => {
    const result = evaluatePriceThresholdAlert(
      evaluationInput({
        definition: definition({ threshold: "0.00000001" }),
        candles: [candle(120_000, 1e-8, { high: 2e-8, low: 1e-9 })],
        state: { status: "armed", armedAt: 1, initialized: true, eligible: false, lastEvaluatedBarTime: 60_000 },
        now: 180_000
      })
    );
    expect(result).toMatchObject({ status: "evaluated", triggered: true });
  });

  it("advances an armed cursor without creating a transition when no bar matches", () => {
    const result = evaluatePriceThresholdAlert(
      evaluationInput({
        definition: definition({ threshold: "200" }),
        state: {
          status: "armed",
          armedAt: 1,
          initialized: true,
          eligible: false,
          lastEvaluatedBarTime: 60_000
        }
      })
    );

    expect(result).toMatchObject({
      status: "evaluated",
      evaluatedBars: 1,
      triggered: false,
      observation: { candleOpenTime: 120_000, close: 101 },
      nextState: {
        status: "armed",
        initialized: true,
        eligible: false,
        lastEvaluatedBarTime: 120_000
      }
    });
    expect(result).not.toHaveProperty("transition");
  });

  it("is once-until-rearmed and does not re-evaluate a triggered revision", () => {
    const key = "a".repeat(64);
    const result = evaluatePriceThresholdAlert(
      evaluationInput({
        state: {
          status: "triggered",
          armedAt: 1,
          initialized: true,
          eligible: true,
          lastEvaluatedBarTime: 120_000,
          triggeredByTransitionKey: key
        }
      })
    );

    expect(result).toEqual({
      status: "idle",
      reason: "already-triggered",
      scopeKey: "market:binance:spot:last:BTCUSDT:1m",
      nextState: {
        status: "triggered",
        armedAt: 1,
        initialized: true,
        eligible: true,
        lastEvaluatedBarTime: 120_000,
        triggeredByTransitionKey: key
      }
    });
  });

  it("fails closed when the durable cursor cannot be continued exactly", () => {
    const result = evaluatePriceThresholdAlert(
      evaluationInput({
        candles: [candle(120_000, 101), candle(180_000, 102)],
        state: {
          status: "armed",
          armedAt: 1,
          initialized: true,
          eligible: false,
          lastEvaluatedBarTime: 0
        }
      })
    );

    expect(result).toMatchObject({ status: "unavailable", reason: "cursor-gap" });
  });

  it("consumes historical evidence only with an exact durable cursor or armed-at bar", () => {
    const historical = [candle(60_000, 100), candle(120_000, 101)];
    const continued = evaluatePriceThresholdAlert(
      evaluationInput({
        candles: historical,
        now: 600_000,
        definition: definition({ threshold: "200" }),
        state: {
          status: "armed",
          armedAt: 1,
          initialized: true,
          eligible: false,
          lastEvaluatedBarTime: 0
        }
      })
    );
    const firstObservation = evaluatePriceThresholdAlert(
      evaluationInput({
        candles: historical,
        now: 600_000,
        definition: definition({ threshold: "200" }),
        state: { status: "armed", armedAt: 1, initialized: false, eligible: false }
      })
    );

    expect(continued).toMatchObject({
      status: "evaluated",
      evaluatedBars: 1,
      nextState: { lastEvaluatedBarTime: 60_000 }
    });
    expect(firstObservation).toMatchObject({ status: "unavailable", reason: "cursor-gap" });
  });

  it("seeds an initially eligible rule without firing and a replay consumes nothing", () => {
    const seeded = evaluatePriceThresholdAlert(
      evaluationInput({
        candles: [candle(180_000, 101)],
        state: {
          status: "armed",
          armedAt: 180_000,
          initialized: false,
          eligible: false
        }
      })
    );

    expect(seeded).toMatchObject({
      status: "evaluated",
      evaluatedBars: 1,
      triggered: false,
      nextState: {
        status: "armed",
        initialized: true,
        eligible: true,
        lastEvaluatedBarTime: 180_000
      }
    });
    expect(seeded).not.toHaveProperty("transition");
    if (seeded.status !== "evaluated") throw new Error("expected seeded state");

    expect(evaluatePriceThresholdAlert(evaluationInput({ candles: [candle(180_000, 101)], state: seeded.nextState }))).toEqual({
      status: "idle",
      reason: "no-new-closed-candle",
      scopeKey: "market:binance:spot:last:BTCUSDT:1m",
      nextState: seeded.nextState
    });
  });

  it("seeds only the exact bar containing armedAt even when later backlog bars are present", () => {
    const result = evaluatePriceThresholdAlert(
      evaluationInput({
        candles: [candle(60_000, 100), candle(120_000, 101), candle(180_000, 102)],
        state: { status: "armed", armedAt: 60_001, initialized: false, eligible: false }
      })
    );
    expect(result).toMatchObject({
      status: "evaluated",
      evaluatedBars: 1,
      triggered: false,
      observation: { candleOpenTime: 60_000, close: 100 },
      nextState: { initialized: true, eligible: false, lastEvaluatedBarTime: 60_000 }
    });
    expect(result).not.toHaveProperty("transition");

    expect(
      evaluatePriceThresholdAlert(
        evaluationInput({
          candles: [candle(120_000, 101), candle(180_000, 102)],
          state: { status: "armed", armedAt: 60_001, initialized: false, eligible: false }
        })
      )
    ).toMatchObject({ status: "unavailable", reason: "cursor-gap" });
  });

  it("triggers only after a durable ineligible-to-eligible crossing", () => {
    const seeded = evaluatePriceThresholdAlert(
      evaluationInput({
        candles: [candle(180_000, 100)],
        state: {
          status: "armed",
          armedAt: 180_000,
          initialized: false,
          eligible: false
        }
      })
    );
    if (seeded.status !== "evaluated") throw new Error("expected seeded state");

    const crossed = evaluatePriceThresholdAlert(
      evaluationInput({
        candles: [candle(180_000, 100), candle(240_000, 101)],
        state: seeded.nextState,
        now: 300_000
      })
    );

    expect(crossed).toMatchObject({
      status: "evaluated",
      evaluatedBars: 1,
      triggered: true,
      observation: { candleOpenTime: 240_000, close: 101 },
      nextState: {
        status: "triggered",
        initialized: true,
        eligible: true,
        lastEvaluatedBarTime: 240_000
      }
    });
  });

  it.each([
    ["forming candle", [candle(120_000, 100, { final: false })], "non-final-candle"],
    ["server-future candle", [candle(240_000, 100)], "candle-not-closed"],
    ["non-finite candle", [candle(120_000, Number.NaN)], "malformed-candle"],
    ["descending candles", [candle(120_000, 100), candle(60_000, 101)], "malformed-candle-sequence"],
    ["missing interval", [candle(60_000, 100), candle(180_000, 101)], "candle-gap"]
  ] as const)("fails %s closed", (_label, candles, reason) => {
    expect(evaluatePriceThresholdAlert(evaluationInput({ candles }))).toMatchObject({ status: "unavailable", reason });
  });

  it("rejects 1M and non-last definitions through the shared contract parser", () => {
    for (const override of [{ timeframe: "1M" }, { priceType: "mark" }, { exchange: "other" }]) {
      const result = evaluatePriceThresholdAlert(
        evaluationInput({
          definition: { ...definition(), ...override } as PriceThresholdAlertDefinitionV1
        })
      );
      expect(result).toMatchObject({
        status: "unavailable",
        reason: "invalid-definition"
      });
    }
  });

  it("validates a fresh exact closed window without mutating it", () => {
    const candles = [candle(120_000, 101), candle(180_000, 102)];
    const before = structuredClone(candles);

    expect(validateClosedCandleWindow(candles, "1m", NOW)).toMatchObject({
      ok: true,
      intervalMs: MINUTE
    });
    expect(candles).toEqual(before);
  });
});

function definition(override: Partial<PriceThresholdAlertDefinitionV1> = {}): PriceThresholdAlertDefinitionV1 {
  return {
    schemaVersion: "alert-rule-v1",
    kind: "price-threshold",
    name: "BTC threshold",
    enabled: true,
    cooldownSeconds: 0,
    deliveryChannels: ["in-app"],
    researchOnly: true,
    executionPermission: false,
    exchange: "binance",
    marketType: "spot",
    priceType: "last",
    symbol: "BTCUSDT",
    timeframe: "1m",
    direction: "above",
    threshold: "101",
    crossing: "inclusive",
    repeat: "once-until-rearmed",
    ...override
  };
}

function evaluationInput(override: Partial<PriceThresholdAlertEvaluationInputV1> = {}): PriceThresholdAlertEvaluationInputV1 {
  return {
    ruleId: RULE_ID,
    ruleRevision: 3,
    definition: definition(),
    state: {
      status: "armed",
      armedAt: 1,
      initialized: false,
      eligible: false
    },
    candles: [candle(60_000, 100), candle(120_000, 101), candle(180_000, 102)],
    now: NOW,
    ...override
  };
}

function candle(time: number, close: number, override: Partial<Candle> = {}): Candle {
  return {
    time,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 10,
    final: true,
    source: "public-test",
    ...override
  };
}
