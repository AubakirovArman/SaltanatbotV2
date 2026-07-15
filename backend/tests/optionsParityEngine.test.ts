import { describe, expect, it } from "vitest";
import { OptionsParityResearchEngine, evaluateOptionsParity } from "../src/arbitrage/engines/optionsParity/index.js";
import type {
  OptionsParityAssumptions,
  OptionsParityBook,
  OptionsParityEvaluationRequest,
  OptionsParityInstrument,
  OptionsParitySeriesSnapshot
} from "../src/arbitrage/engines/optionsParity/index.js";

const NOW = 1_784_000_000_000;
const EXPIRY = NOW + 365 * 24 * 60 * 60_000;

describe("European options parity research engine", () => {
  it("finds call-rich parity, short synthetic and conversion from executable depth", () => {
    const request = scenario({ call: [12, 13], put: [1, 2], spot: [99, 100] });
    const result = evaluateOptionsParity(request);

    expect(result.edgeKind).toBe("research-simulation");
    expect(result.executable).toBe(false);
    expect(result.candidates.map((value) => value.strategyKind)).toEqual(
      expect.arrayContaining(["put-call-parity", "synthetic-forward", "conversion"])
    );
    const conversion = result.candidates.find((value) => value.strategyKind === "conversion")!;
    expect(conversion).toMatchObject({
      direction: "call-rich",
      simulationBasis: "visible-depth-taker",
      outcomeLabel: "fixed-valuation-payoff-at-expiry-under-stated-assumptions",
      baseQuantity: 1,
      grossEdgeValue: 10,
      fixedPayoffAtExpiry: 100,
      executable: false
    });
    expect(conversion.netEdgeValue).toBeCloseTo(9.93, 8);
    expect(conversion.legs.map((value) => [value.role, value.side])).toEqual([
      ["call", "sell"],
      ["put", "buy"],
      ["underlying", "buy"]
    ]);
    const synthetic = result.candidates.find((value) => value.strategyKind === "synthetic-forward")!;
    expect(synthetic.impliedForwardPrice).toBeCloseTo(110, 8);
    expect(synthetic.theoreticalForwardPrice).toBeCloseTo(100, 8);
    expect(synthetic.outcomeLabel).toContain("research-only");
  });

  it("finds put-rich parity, long synthetic and reversal only with verified borrow", () => {
    const request = scenario({ call: [1, 2], put: [12, 13], spot: [99, 100] });
    request.assumptions.underlyingShort!.annualBorrowRate = 0.01;
    const result = evaluateOptionsParity(request);

    expect(result.candidates.map((value) => value.strategyKind)).toEqual(
      expect.arrayContaining(["put-call-parity", "synthetic-forward", "reversal"])
    );
    const reversal = result.candidates.find((value) => value.strategyKind === "reversal")!;
    expect(reversal.direction).toBe("put-rich");
    expect(reversal.grossEdgeValue).toBeCloseTo(9, 8);
    expect(reversal.borrowCostValue).toBeCloseTo(99 * Math.expm1(0.01), 8);
    expect(reversal.fixedPayoffAtExpiry).toBe(-100);

    request.assumptions.underlyingShort = undefined;
    const blocked = evaluateOptionsParity(request);
    expect(blocked.candidates.some((value) => value.strategyKind === "reversal")).toBe(false);
    expect(blocked.candidates.some((value) => value.strategyKind === "synthetic-forward")).toBe(true);
    expect(blocked.rejections).toContainEqual(
      expect.objectContaining({ strategyKind: "reversal", code: "short-capacity", instrumentId: "BTC-USDC" })
    );
  });

  it("walks two-strike executable legs and values a long box at discounted fixed payoff", () => {
    const primary = series("low", 100, [5, 6], [1, 2]);
    const secondary = series("high", 110, [1, 2], [1, 2]);
    const request = scenario({ call: [5, 6], put: [1, 2], spot: [104, 105] });
    request.primary = primary;
    request.secondary = secondary;
    request.assumptions = assumptionsFor([primary, secondary]);

    const result = evaluateOptionsParity(request);
    const box = result.candidates.find((value) => value.strategyKind === "box" && value.direction === "long-box")!;

    expect(box).toMatchObject({
      strikes: [100, 110],
      baseQuantity: 1,
      fixedPayoffAtExpiry: 10,
      grossEdgeValue: 4,
      feesValue: 0.12,
      netEdgeValue: 3.88,
      outcomeLabel: "fixed-valuation-payoff-at-expiry-under-stated-assumptions"
    });
    expect(box.legs).toHaveLength(4);
    expect(box.legs.every((leg) => leg.levelsUsed === 1)).toBe(true);
  });

  it("supports contract-unit depth and per-base capped fees without confusing contracts with base", () => {
    const request = scenario({ call: [12, 13], put: [1, 2], spot: [99, 100] });
    for (const leg of [request.primary.call!, request.primary.put!]) {
      leg.instrument.quantityUnit = "contract";
      leg.instrument.basePerQuantityUnit = 10;
      leg.instrument.quantityStep = 1;
      leg.instrument.minimumQuantity = 1;
      leg.book!.bids = [[leg.book!.bids[0]![0], 2]];
      leg.book!.asks = [[leg.book!.asks[0]![0], 2]];
    }
    request.targetBaseQuantity = 10;
    request.assumptions.shortOptionCapacity[request.primary.call!.instrument.instrumentId]!.availableBaseQuantity = 20;

    const result = evaluateOptionsParity(request);
    const conversion = result.candidates.find((value) => value.strategyKind === "conversion")!;

    expect(conversion.baseQuantity).toBe(10);
    expect(conversion.legs.find((leg) => leg.role === "call")).toMatchObject({ nativeQuantity: 1, baseQuantity: 10 });
    expect(conversion.feesValue).toBeCloseTo(0.7, 8);
  });

  it("requires and applies explicit inverse-premium FX instead of treating coin premium as strike currency", () => {
    const request = scenario({ call: [0.12, 0.13], put: [0.01, 0.02], spot: [99, 100] });
    for (const leg of [request.primary.call!, request.primary.put!]) leg.instrument.premiumAsset = "BTC";
    request.assumptions.premiumFx = {
      BTC: { fromAsset: "BTC", toAsset: "USDC", rate: 100, source: "fixture-btc-usdc", asOf: NOW - 1_000 }
    };

    const result = evaluateOptionsParity(request);
    const conversion = result.candidates.find((value) => value.strategyKind === "conversion")!;

    expect(conversion.grossEdgeValue).toBeCloseTo(10, 8);
    expect(conversion.assumptionSources).toContain("fixture-btc-usdc");

    request.assumptions.premiumFx = {};
    const blocked = evaluateOptionsParity(request);
    expect(blocked.candidates).toEqual([]);
    expect(blocked.rejections).toContainEqual(expect.objectContaining({ code: "missing-assumption" }));
  });

  it("fails closed when settlement cash flows require an unmodelled FX conversion", () => {
    const request = scenario({ call: [12, 13], put: [1, 2], spot: [99, 100] });
    request.primary.call!.instrument.settlementAsset = "BTC";
    request.primary.put!.instrument.settlementAsset = "BTC";

    const result = evaluateOptionsParity(request);

    expect(result.candidates).toEqual([]);
    expect(result.rejections).toContainEqual(
      expect.objectContaining({
        code: "settlement-mismatch",
        message: expect.stringContaining("settlement FX")
      })
    );
  });

  it("fails closed on missing/mismatched legs, stale books, skew and stale assumptions", () => {
    const missing = scenario({ call: [12, 13], put: [1, 2], spot: [99, 100] });
    missing.primary.put = undefined;
    expect(evaluateOptionsParity(missing).rejections[0]).toMatchObject({ code: "missing-leg" });

    const mismatch = scenario({ call: [12, 13], put: [1, 2], spot: [99, 100] });
    mismatch.primary.put!.instrument.strikePrice = 101;
    expect(evaluateOptionsParity(mismatch).rejections[0]).toMatchObject({ code: "identity-mismatch" });

    const stale = scenario({ call: [12, 13], put: [1, 2], spot: [99, 100] });
    stale.primary.call!.book!.exchangeTs = NOW - 10_000;
    expect(evaluateOptionsParity(stale).rejections[0]).toMatchObject({ code: "stale-book" });

    const skewed = scenario({ call: [12, 13], put: [1, 2], spot: [99, 100] });
    skewed.primary.call!.book!.exchangeTs -= 500;
    skewed.primary.call!.book!.receivedAt -= 500;
    expect(evaluateOptionsParity(skewed).rejections[0]).toMatchObject({ code: "skewed-books" });

    const staleAssumption = scenario({ call: [12, 13], put: [1, 2], spot: [99, 100] });
    staleAssumption.assumptions.riskFreeRate.asOf = NOW - 100_000;
    staleAssumption.limits = { ...staleAssumption.limits, maxAssumptionAgeMs: 10_000 };
    expect(evaluateOptionsParity(staleAssumption).rejections[0]).toMatchObject({ code: "stale-assumption" });
  });

  it("keeps engine defaults deterministic and never upgrades research output to execution", () => {
    const request = scenario({ call: [12, 13], put: [1, 2], spot: [99, 100] });
    const engine = new OptionsParityResearchEngine({ now: () => NOW, limits: { minimumNetEdgeValue: 9.95 } });
    const { evaluatedAt: _evaluatedAt, ...withoutTime } = request;
    const result = engine.evaluate(withoutTime);

    expect(result.evaluatedAt).toBe(NOW);
    expect(result.candidates.every((value) => value.executable === false && value.edgeKind === "research-simulation")).toBe(true);
    expect(result.candidates.some((value) => value.netEdgeValue <= 9.95)).toBe(false);
  });
});

function scenario(prices: { call: [number, number]; put: [number, number]; spot: [number, number] }): OptionsParityEvaluationRequest {
  const primary = series("btc-100", 100, prices.call, prices.put);
  return {
    primary,
    underlying: {
      instrument: {
        instrumentId: "BTC-USDC",
        venue: "fixture",
        baseAsset: "BTC",
        quoteAsset: "USDC",
        quantityUnit: "base",
        basePerQuantityUnit: 1,
        quantityStep: 0.1,
        minimumQuantity: 0.1
      },
      book: book("BTC-USDC", prices.spot[0], prices.spot[1], 10)
    },
    targetBaseQuantity: 1,
    evaluatedAt: NOW,
    assumptions: assumptionsFor([primary]),
    limits: { maxQuoteAgeMs: 2_000, maxLegSkewMs: 250, maxAssumptionAgeMs: 60_000 }
  };
}

function series(id: string, strike: number, callPrices: [number, number], putPrices: [number, number]): OptionsParitySeriesSnapshot {
  const call = option(`${id}-C`, strike, "call");
  const put = option(`${id}-P`, strike, "put");
  return {
    seriesId: id,
    call: { instrument: call, book: book(call.instrumentId, callPrices[0], callPrices[1], 5) },
    put: { instrument: put, book: book(put.instrumentId, putPrices[0], putPrices[1], 5) }
  };
}

function option(instrumentId: string, strike: number, optionType: "call" | "put"): OptionsParityInstrument {
  return {
    instrumentId,
    venue: "fixture",
    underlyingAsset: "BTC",
    strikeAsset: "USDC",
    settlementAsset: "USDC",
    premiumAsset: "USDC",
    expiryTime: EXPIRY,
    strikePrice: strike,
    optionType,
    exerciseStyle: "european",
    automaticExercise: true,
    settlementProcess: "cash",
    quantityUnit: "base",
    basePerQuantityUnit: 1,
    quantityStep: 0.1,
    minimumQuantity: 0.1
  };
}

function book(instrumentId: string, bid: number, ask: number, quantity: number): OptionsParityBook {
  return {
    instrumentId,
    bids: [[bid, quantity]],
    asks: [[ask, quantity]],
    exchangeTs: NOW - 100,
    receivedAt: NOW - 50,
    complete: true
  };
}

function assumptionsFor(seriesSnapshots: OptionsParitySeriesSnapshot[]): OptionsParityAssumptions {
  const instruments = seriesSnapshots.flatMap((value) => [value.call!.instrument, value.put!.instrument]);
  return {
    valuationAsset: "USDC",
    riskFreeRate: { annualRate: 0, source: "fixture-risk-free", asOf: NOW - 1_000 },
    dividendYield: { annualRate: 0, source: "fixture-dividend", asOf: NOW - 1_000 },
    settlement: {
      exerciseStyle: "european",
      automaticExercise: true,
      holdToExpiry: true,
      economicSettlement: "cash",
      settlementPriceSource: "fixture-delivery-index",
      acknowledgedProcesses: ["cash"],
      source: "fixture-contract-spec",
      asOf: NOW - 1_000
    },
    premiumFx: { USDC: { fromAsset: "USDC", toAsset: "USDC", rate: 1, source: "identity-fx", asOf: NOW - 1_000 } },
    optionFees: Object.fromEntries(
      instruments.map((instrument) => [
        instrument.instrumentId,
        {
          model: { kind: "per-base-capped", feePerBaseValuation: 0.03, premiumCapFraction: 0.125 },
          source: "fixture-option-fee",
          asOf: NOW - 1_000
        }
      ])
    ),
    underlyingFee: { model: { kind: "notional-bps", bps: 1 }, source: "fixture-spot-fee", asOf: NOW - 1_000 },
    shortOptionCapacity: Object.fromEntries(
      instruments.map((instrument) => [
        instrument.instrumentId,
        {
          availabilityVerified: true,
          marginVerified: true,
          availableBaseQuantity: 5,
          source: "fixture-margin",
          asOf: NOW - 1_000
        }
      ])
    ),
    underlyingShort: {
      borrowVerified: true,
      marginVerified: true,
      availableBaseQuantity: 5,
      annualBorrowRate: 0,
      source: "fixture-borrow",
      asOf: NOW - 1_000
    }
  };
}
