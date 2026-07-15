import { describe, expect, it, vi } from "vitest";
import { SaltanatArbitrageClient } from "./client.js";
import { parseOptionsParityEvaluation } from "./optionsParity.js";
import type { OptionsParityEvaluationRequest } from "./optionsParityTypes.js";

describe("options-parity SDK boundary", () => {
  it("parses a strict non-executable response and verifies its economic/timestamp identities", () => {
    expect(parseOptionsParityEvaluation(responseFixture())).toMatchObject({
      engine: "options-parity-v1",
      readOnly: true,
      researchOnly: true,
      executable: false,
      assumptionContract: { authority: "caller-supplied", execution: "none" },
      candidates: [{ strategyKind: "conversion", netEdgeValue: 9.93 }]
    });
  });

  it("rejects execution-shaped, unknown, malformed and economically forged responses", () => {
    const mutations: Array<(value: ReturnType<typeof responseFixture>) => void> = [
      (value) => {
        value.executable = true as false;
      },
      (value) => {
        (value as Record<string, unknown>).order = { side: "buy" };
      },
      (value) => {
        value.assumptionContract.execution = "orders" as "none";
      },
      (value) => {
        value.candidates[0]!.executable = true as false;
      },
      (value) => {
        (value.candidates[0] as Record<string, unknown>).credential = "forged";
      },
      (value) => {
        value.candidates[0]!.netEdgeValue = 10;
      },
      (value) => {
        value.candidates[0]!.feesValue = 0.08;
      },
      (value) => {
        value.candidates[0]!.edgeBpsOfReferenceNotional = 1;
      },
      (value) => {
        value.candidates[0]!.fixedPayoffAtExpiry = undefined as unknown as number;
      },
      (value) => {
        value.candidates[0]!.timestamps.quoteAgeMs = 99;
      },
      (value) => {
        value.candidates[0]!.expiryTime = 10_000;
      },
      (value) => {
        value.candidates[0]!.assumptionSources = ["fx", "fee"];
      }
    ];
    for (const mutate of mutations) {
      const value = responseFixture();
      mutate(value);
      expect(() => parseOptionsParityEvaluation(value)).toThrow();
    }
    expect(() => parseOptionsParityEvaluation({ ...responseFixture(), candidates: Array.from({ length: 17 }, () => ({})) })).toThrow(/at most 16/);
    expect(() =>
      parseOptionsParityEvaluation({
        ...responseFixture(),
        candidates: [],
        rejections: [{ code: "order-rejected", message: "private execution leaked" }]
      })
    ).toThrow(/code/);
  });

  it("uses only the bounded public POST route and applies the strict response parser", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = input instanceof URL ? input : new URL(String(input));
      expect(url.pathname).toBe("/api/arbitrage/options-parity/evaluate");
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      expect(JSON.parse(String(init?.body))).toEqual({ research: "caller-supplied" });
      return Response.json(responseFixture());
    });
    const client = new SaltanatArbitrageClient({ baseUrl: "https://research.invalid", fetch: fetcher });
    const request = { research: "caller-supplied" } as unknown as OptionsParityEvaluationRequest;

    await expect(client.optionsParity(request)).resolves.toMatchObject({ executable: false, researchOnly: true });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("rejects a forged executable server response through the client method", async () => {
    const forged = responseFixture();
    forged.candidates[0]!.executable = true as false;
    const client = new SaltanatArbitrageClient({
      baseUrl: "https://research.invalid",
      fetch: async () => Response.json(forged)
    });

    await expect(client.optionsParity({} as OptionsParityEvaluationRequest)).rejects.toThrow(/executable/);
  });
});

function responseFixture() {
  const leg = (role: "call" | "put" | "underlying", side: "buy" | "sell", price: number, fee: number) => ({
    role,
    instrumentId: `deribit:${role}`,
    side,
    bookSide: side === "buy" ? ("asks" as const) : ("bids" as const),
    nativeQuantity: 1,
    baseQuantity: 1,
    averagePrice: price,
    worstPrice: price,
    valuationCashAmount: price,
    feeValuation: fee,
    levelsUsed: 1,
    exchangeTs: 9_900,
    receivedAt: 9_950
  });
  return {
    engine: "options-parity-v1" as const,
    readOnly: true as const,
    researchOnly: true as const,
    executable: false as const,
    evaluatedAt: 10_000,
    edgeKind: "research-simulation" as const,
    assumptionContract: {
      authority: "caller-supplied" as const,
      expiry: "explicit-instrument-timestamp" as const,
      settlement: "european-automatic-hold-to-expiry-cash-equivalent" as const,
      settlementFx: "unsupported-settlement-must-equal-valuation-asset" as const,
      premiumFx: "explicit-per-premium-asset" as const,
      fees: "explicit-per-option-and-underlying" as const,
      execution: "none" as const
    },
    candidates: [
      {
        id: "options-conversion:btc-100",
        strategyKind: "conversion" as const,
        direction: "call-rich" as const,
        edgeKind: "research-simulation" as const,
        executable: false as const,
        simulationBasis: "visible-depth-taker" as const,
        outcomeLabel: "fixed-valuation-payoff-at-expiry-under-stated-assumptions" as const,
        underlyingAsset: "BTC",
        valuationAsset: "USDC",
        settlementAsset: "USDC",
        expiryTime: 20_000,
        strikes: [100],
        baseQuantity: 1,
        grossEdgeValue: 10,
        feesValue: 0.07,
        borrowCostValue: 0,
        netEdgeValue: 9.93,
        edgeBpsOfReferenceNotional: 993,
        referenceNotional: 100,
        fixedPayoffAtExpiry: 100,
        legs: [leg("call", "sell", 12, 0.03), leg("put", "buy", 2, 0.03), leg("underlying", "buy", 100, 0.01)],
        timestamps: {
          evaluatedAt: 10_000,
          oldestExchangeTs: 9_900,
          newestExchangeTs: 9_900,
          oldestReceivedAt: 9_950,
          newestReceivedAt: 9_950,
          quoteAgeMs: 100,
          legSkewMs: 0,
          oldestAssumptionAsOf: 9_000,
          assumptionAgeMs: 1_000
        },
        assumptionSources: ["fee", "fx"]
      }
    ],
    rejections: []
  };
}
