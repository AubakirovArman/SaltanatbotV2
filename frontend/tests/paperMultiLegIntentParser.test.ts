import { describe, expect, it } from "vitest";
import { lenientPaperMultiLegSection } from "../src/trading/paperMultiLegIntentParser";

const completeIntent = {
  intentId: "mleg-0123456789abcdef",
  status: "terminal",
  outcome: "manual-review-required",
  sourceEngine: "route-families-v1",
  sourceOpportunityId: "pairwise-opportunity:fixture",
  legCount: 2,
  reservedCapital: "1150.460000",
  netPnl: "-50.030000",
  fees: "0.030000",
  createdAt: 2_000_000_000_000,
  legs: [
    {
      venue: "fixture-a",
      instrumentId: "fixture-spot",
      side: "buy",
      plannedQuantity: 1,
      filledQuantity: 1,
      averagePrice: 100,
      fee: 0.03,
      compensated: true
    }
  ],
  residualExposure: [
    { legId: "leg-long", instrumentId: "fixture-spot", quantityUnit: "base", quantity: 0.5 }
  ]
};

describe("lenient paper multi-leg section parser", () => {
  it("parses the complete server shape including negative canonical netPnl", () => {
    const section = lenientPaperMultiLegSection({ killSwitchEnabled: true, intents: [completeIntent] });
    expect(section).toEqual({
      killSwitchEnabled: true,
      intents: [{
        intentId: "mleg-0123456789abcdef",
        status: "terminal",
        outcome: "manual-review-required",
        sourceEngine: "route-families-v1",
        sourceOpportunityId: "pairwise-opportunity:fixture",
        legCount: 2,
        reservedCapital: 1150.46,
        netPnl: -50.03,
        fees: 0.03,
        createdAt: 2_000_000_000_000,
        legs: [{
          venue: "fixture-a",
          instrumentId: "fixture-spot",
          side: "buy",
          plannedQuantity: 1,
          filledQuantity: 1,
          averagePrice: 100,
          fee: 0.03,
          compensated: true
        }],
        residualExposure: [{
          legId: "leg-long",
          instrumentId: "fixture-spot",
          quantityUnit: "base",
          quantity: 0.5
        }]
      }]
    });
  });

  it("accepts numeric netPnl of either sign and rejects malformed money strings", () => {
    const section = lenientPaperMultiLegSection({
      intents: [
        { intentId: "numeric", legs: [], netPnl: -12.5, fees: 0.25 },
        { intentId: "malformed", legs: [], netPnl: "50.03", fees: "-1.000000", reservedCapital: "1,150.46" }
      ]
    });
    expect(section?.intents[0]).toMatchObject({ intentId: "numeric", netPnl: -12.5, fees: 0.25 });
    // "50.03" is not canonical six-decimal money; fees must not be negative;
    // absence stays absent instead of becoming zero.
    expect(section?.intents[1]).toEqual({ intentId: "malformed", legs: [] });
    expect(section?.intents[1]).not.toHaveProperty("netPnl");
    expect(section?.intents[1]).not.toHaveProperty("fees");
    expect(section?.intents[1]).not.toHaveProperty("reservedCapital");
  });

  it("drops rows without an intentId and non-object rows instead of failing the snapshot", () => {
    const section = lenientPaperMultiLegSection({
      killSwitchEnabled: "yes",
      intents: [
        { status: "running", legs: [] },
        "not-an-object",
        null,
        { intentId: "   ", legs: [] },
        { intentId: "kept" }
      ]
    });
    expect(section?.intents).toEqual([{ intentId: "kept", legs: [] }]);
    // A malformed kill-switch flag stays unknown rather than defaulting.
    expect(section).not.toHaveProperty("killSwitchEnabled");
  });

  it("drops malformed leg fields and residual lines while keeping the row renderable", () => {
    const section = lenientPaperMultiLegSection({
      intents: [{
        intentId: "degraded",
        legCount: -1,
        createdAt: 1.5,
        legs: [
          { venue: 7, side: "hold", plannedQuantity: "1", filledQuantity: -2, fee: Number.NaN, compensated: "yes" },
          { instrumentId: "kept-instrument", side: "sell", averagePrice: 105 }
        ],
        residualExposure: [
          { instrumentId: "no-quantity" },
          { quantity: 1 },
          { instrumentId: "kept", quantity: Number.POSITIVE_INFINITY },
          { instrumentId: "kept", quantity: 0.5 }
        ]
      }]
    });
    expect(section?.intents[0]).toEqual({
      intentId: "degraded",
      legs: [
        {},
        { instrumentId: "kept-instrument", side: "sell", averagePrice: 105 }
      ],
      residualExposure: [{ instrumentId: "kept", quantity: 0.5 }]
    });
  });

  it("returns undefined for absent or non-object sections", () => {
    expect(lenientPaperMultiLegSection(undefined)).toBeUndefined();
    expect(lenientPaperMultiLegSection(null)).toBeUndefined();
    expect(lenientPaperMultiLegSection([])).toBeUndefined();
    expect(lenientPaperMultiLegSection("section")).toBeUndefined();
    // A section without intents parses to an empty, renderable list.
    expect(lenientPaperMultiLegSection({})).toEqual({ intents: [] });
  });
});
