import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { SaltanatArbitrageClient } from "../../packages/arbitrage-sdk/client.js";
import type { OptionsParityEvaluationRequest } from "../../packages/arbitrage-sdk/optionsParityTypes.js";
import {
  createOptionsParityEvaluationHandler,
  optionsParityResponseSchema
} from "../src/arbitrage/optionsParityRoutes.js";

const NOW = 1_784_000_000_000;
const servers: Array<ReturnType<ReturnType<typeof express>["listen"]>> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

describe("public options-parity research evaluation API", () => {
  it("returns a strict non-executable envelope with the explicit assumption contract", async () => {
    const response = await post(fixture());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      engine: "options-parity-v1",
      readOnly: true,
      researchOnly: true,
      executable: false,
      evaluatedAt: NOW,
      edgeKind: "research-simulation",
      assumptionContract: {
        authority: "caller-supplied",
        expiry: "explicit-instrument-timestamp",
        settlementFx: "unsupported-settlement-must-equal-valuation-asset",
        premiumFx: "explicit-per-premium-asset",
        fees: "explicit-per-option-and-underlying",
        execution: "none"
      }
    });
    expect(optionsParityResponseSchema.safeParse(body).success).toBe(true);
    expect(body).not.toHaveProperty("order");
    expect((body.candidates as Array<Record<string, unknown>>).length).toBeGreaterThan(0);
    expect((body.candidates as Array<Record<string, unknown>>).every((candidate) => candidate.executable === false)).toBe(true);
  });

  it("rejects credentials, unknown fields, missing explicit assumptions and oversized depth", async () => {
    const cases = [
      () => ({ ...fixture(), apiKey: "must-not-be-accepted" }),
      () => {
        const value = fixture() as Record<string, unknown>;
        (value.assumptions as Record<string, unknown>).optionFees = undefined;
        return value;
      },
      () => {
        const value = fixture();
        value.primary.call.book.asks = Array.from({ length: 401 }, () => [13, 1]);
        return value;
      },
      () => {
        const value = fixture();
        (value.assumptions.optionFees[value.primary.call.instrument.instrumentId] as Record<string, unknown>).secret = "no";
        return value;
      }
    ];
    for (const create of cases) expect((await post(create())).status).toBe(400);
  });

  it("fails closed in the research result on missing FX, settlement conversion, expiry and stale assumptions", async () => {
    const cases: Array<[string, (value: ReturnType<typeof fixture>) => void]> = [
      ["missing-assumption", (value) => {
        value.assumptions.premiumFx = {};
      }],
      ["settlement-mismatch", (value) => {
        value.primary.call.instrument.settlementAsset = "BTC";
        value.primary.put.instrument.settlementAsset = "BTC";
      }],
      ["expired", (value) => {
        value.primary.call.instrument.expiryTime = NOW - 1;
        value.primary.put.instrument.expiryTime = NOW - 1;
      }],
      ["stale-assumption", (value) => {
        value.assumptions.riskFreeRate.asOf = NOW - 100_000;
        value.limits.maxAssumptionAgeMs = 10_000;
      }]
    ];

    for (const [expectedCode, mutate] of cases) {
      const value = fixture();
      mutate(value);
      const response = await post(value);
      expect(response.status).toBe(200);
      const body = (await response.json()) as { candidates: unknown[]; rejections: Array<{ code: string }> };
      expect(body.candidates).toEqual([]);
      expect(body.rejections.some((rejection) => rejection.code === expectedCode)).toBe(true);
    }
  });

  it("rejects a forged executable or execution-shaped response at the strict output boundary", () => {
    const base = {
      engine: "options-parity-v1",
      readOnly: true,
      researchOnly: true,
      executable: false,
      evaluatedAt: NOW,
      edgeKind: "research-simulation",
      assumptionContract: {
        authority: "caller-supplied",
        expiry: "explicit-instrument-timestamp",
        settlement: "european-automatic-hold-to-expiry-cash-equivalent",
        settlementFx: "unsupported-settlement-must-equal-valuation-asset",
        premiumFx: "explicit-per-premium-asset",
        fees: "explicit-per-option-and-underlying",
        execution: "none"
      },
      candidates: [],
      rejections: []
    };
    expect(optionsParityResponseSchema.safeParse({ ...base, executable: true }).success).toBe(false);
    expect(optionsParityResponseSchema.safeParse({ ...base, order: { side: "buy" } }).success).toBe(false);
    expect(optionsParityResponseSchema.safeParse({ ...base, candidates: Array.from({ length: 17 }, () => ({})) }).success).toBe(false);
  });

  it("round-trips the live HTTP envelope through the generated public SDK parser", async () => {
    const app = express();
    app.use(express.json());
    app.post("/api/arbitrage/options-parity/evaluate", createOptionsParityEvaluationHandler(() => NOW));
    const server = app.listen(0);
    servers.push(server);
    const address = server.address();
    const client = new SaltanatArbitrageClient({
      baseUrl: `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`
    });

    await expect(client.optionsParity(fixture() as unknown as OptionsParityEvaluationRequest)).resolves.toMatchObject({
      engine: "options-parity-v1",
      executable: false,
      candidates: expect.arrayContaining([expect.objectContaining({ strategyKind: "conversion" })])
    });
  });
});

async function post(body: unknown) {
  const app = express();
  app.use(express.json());
  app.post("/evaluate", createOptionsParityEvaluationHandler(() => NOW));
  const server = app.listen(0);
  servers.push(server);
  const address = server.address();
  return fetch(`http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/evaluate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

function fixture() {
  const option = (instrumentId: string, optionType: "call" | "put") => ({
    instrument: {
      instrumentId,
      venue: "deribit",
      underlyingAsset: "BTC",
      strikeAsset: "USDC",
      settlementAsset: "USDC",
      premiumAsset: "USDC",
      expiryTime: NOW + 86_400_000,
      strikePrice: 100,
      optionType,
      exerciseStyle: "european" as const,
      automaticExercise: true as const,
      settlementProcess: "cash" as const,
      quantityUnit: "base" as const,
      basePerQuantityUnit: 1,
      quantityStep: 0.1,
      minimumQuantity: 0.1
    },
    book: book(instrumentId, optionType === "call" ? 12 : 1, optionType === "call" ? 13 : 2, 5)
  });
  const call = option("BTC-TEST-100-C", "call");
  const put = option("BTC-TEST-100-P", "put");
  const sourced = { source: "recorded-deribit-fixture", asOf: NOW - 1_000 };
  return {
    primary: { seriesId: "BTC-TEST-100", call, put },
    underlying: {
      instrument: {
        instrumentId: "BTC-USDC",
        venue: "deribit",
        baseAsset: "BTC",
        quoteAsset: "USDC",
        quantityUnit: "base" as const,
        basePerQuantityUnit: 1,
        quantityStep: 0.1,
        minimumQuantity: 0.1
      },
      book: book("BTC-USDC", 99, 100, 10)
    },
    targetBaseQuantity: 1,
    evaluatedAt: NOW,
    assumptions: {
      valuationAsset: "USDC",
      riskFreeRate: { ...sourced, annualRate: 0 },
      dividendYield: { ...sourced, annualRate: 0 },
      settlement: {
        ...sourced,
        exerciseStyle: "european" as const,
        automaticExercise: true as const,
        holdToExpiry: true as const,
        economicSettlement: "cash" as const,
        settlementPriceSource: "deribit-delivery-index",
        acknowledgedProcesses: ["cash" as const]
      },
      premiumFx: { USDC: { ...sourced, fromAsset: "USDC", toAsset: "USDC", rate: 1 } },
      optionFees: {
        [call.instrument.instrumentId]: { ...sourced, model: { kind: "per-base-capped" as const, feePerBaseValuation: 0.03, premiumCapFraction: 0.125 } },
        [put.instrument.instrumentId]: { ...sourced, model: { kind: "per-base-capped" as const, feePerBaseValuation: 0.03, premiumCapFraction: 0.125 } }
      },
      underlyingFee: { ...sourced, model: { kind: "notional-bps" as const, bps: 1 } },
      shortOptionCapacity: {
        [call.instrument.instrumentId]: { ...sourced, availabilityVerified: true as const, marginVerified: true as const, availableBaseQuantity: 5 },
        [put.instrument.instrumentId]: { ...sourced, availabilityVerified: true as const, marginVerified: true as const, availableBaseQuantity: 5 }
      },
      underlyingShort: {
        ...sourced,
        borrowVerified: true as const,
        marginVerified: true as const,
        availableBaseQuantity: 5,
        annualBorrowRate: 0
      }
    },
    limits: {
      maxQuoteAgeMs: 2_000,
      maxLegSkewMs: 250,
      maxFutureClockSkewMs: 1_000,
      maxAssumptionAgeMs: 60_000,
      minimumNetEdgeValue: 0,
      pairingIterations: 20
    }
  };
}

function book(instrumentId: string, bid: number, ask: number, quantity: number) {
  return {
    instrumentId,
    bids: [[bid, quantity]],
    asks: [[ask, quantity]],
    exchangeTs: NOW - 100,
    receivedAt: NOW - 50,
    complete: true as const
  };
}
