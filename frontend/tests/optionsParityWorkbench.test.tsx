// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { OptionsParityEvaluationResponse } from "@saltanatbotv2/arbitrage-sdk";
import { buildOptionsParityScenario, DEFAULT_OPTIONS_PARITY_SCENARIO } from "../src/arbitrage/optionsParityClient";
import { OptionsParityResults } from "../src/arbitrage/OptionsParityWorkbench";

describe("options parity browser scenario", () => {
  it("builds an explicit bounded caller-supplied request without order or credential fields", () => {
    const request = buildOptionsParityScenario(DEFAULT_OPTIONS_PARITY_SCENARIO, 10_000);
    expect(request).toMatchObject({
      targetBaseQuantity: 1,
      evaluatedAt: 10_000,
      primary: { call: { instrument: { optionType: "call", exerciseStyle: "european", automaticExercise: true } }, put: { instrument: { optionType: "put" } } },
      assumptions: { valuationAsset: "USDC", settlement: { holdToExpiry: true }, underlyingShort: { borrowVerified: true, marginVerified: true } },
      limits: { pairingIterations: 24 }
    });
    expect(request.primary.call.book.exchangeTs).toBe(9_900);
    expect(request.primary.call.instrument.expiryTime).toBe(10_000 + 720 * 60 * 60_000);
    expect(JSON.stringify(request)).not.toMatch(/apiKey|apiSecret|credential|orderId|privateKey/);
  });

  it("fails before the network for crossed caller books", () => {
    expect(() => buildOptionsParityScenario({ ...DEFAULT_OPTIONS_PARITY_SCENARIO, callBid: 7_000, callAsk: 6_000 }, 10_000)).toThrow(/book is crossed/);
  });

  it("renders Russian research results and visible-depth legs without an order action", () => {
    const html = renderToStaticMarkup(<OptionsParityResults locale="ru" value={response()} />);
    expect(html).toContain("Исследовательские кандидаты");
    expect(html).toContain("conversion");
    expect(html).toContain("BTC");
    expect(html).toContain("Ноги по видимой глубине");
    expect(html).not.toContain("Выставить ордер");
  });
});

function response(): OptionsParityEvaluationResponse {
  const leg = (role: "call" | "put" | "underlying", side: "buy" | "sell", price: number) => ({
    role,
    instrumentId: `scenario:${role}`,
    side,
    bookSide: side === "buy" ? ("asks" as const) : ("bids" as const),
    nativeQuantity: 1,
    baseQuantity: 1,
    averagePrice: price,
    worstPrice: price,
    valuationCashAmount: price,
    feeValuation: 0.1,
    levelsUsed: 1,
    exchangeTs: 9_900,
    receivedAt: 9_950
  });
  return {
    engine: "options-parity-v1",
    readOnly: true,
    researchOnly: true,
    executable: false,
    evaluatedAt: 10_000,
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
    candidates: [
      {
        id: "options-conversion:scenario",
        strategyKind: "conversion",
        direction: "call-rich",
        edgeKind: "research-simulation",
        executable: false,
        simulationBasis: "visible-depth-taker",
        outcomeLabel: "fixed-valuation-payoff-at-expiry-under-stated-assumptions",
        underlyingAsset: "BTC",
        valuationAsset: "USDC",
        settlementAsset: "USDC",
        expiryTime: 20_000,
        strikes: [100],
        baseQuantity: 1,
        grossEdgeValue: 10,
        feesValue: 0.3,
        borrowCostValue: 0,
        netEdgeValue: 9.7,
        edgeBpsOfReferenceNotional: 970,
        referenceNotional: 100,
        fixedPayoffAtExpiry: 100,
        legs: [leg("call", "sell", 12), leg("put", "buy", 2), leg("underlying", "buy", 100)],
        timestamps: {
          evaluatedAt: 10_000,
          oldestExchangeTs: 9_900,
          newestExchangeTs: 9_900,
          oldestReceivedAt: 9_950,
          newestReceivedAt: 9_950,
          quoteAgeMs: 100,
          legSkewMs: 0,
          oldestAssumptionAsOf: 9_900,
          assumptionAgeMs: 100
        },
        assumptionSources: ["browser-options-scenario"]
      }
    ],
    rejections: []
  };
}
