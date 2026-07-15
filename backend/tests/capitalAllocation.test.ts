import { describe, expect, it } from "vitest";
import { allocateCapital, type CapitalAllocationCandidate, type CapitalAllocationRequest } from "../src/arbitrage/economics/index.js";

function candidate(routeId: string, amount: number, profit: number, overrides: Partial<CapitalAllocationCandidate> = {}): CapitalAllocationCandidate {
  return {
    routeId,
    family: "spot-spot",
    outcomeClass: "projected",
    eligible: true,
    unitLabel: "lot",
    minimumUnits: 1,
    maximumUnits: 1,
    conservativeNetProfitPerUnit: profit,
    projectedNetProfitPerUnit: profit,
    riskCapitalPerUnit: amount,
    capitalPerUnit: [{ venue: "alpha", asset: "USDT", amount }],
    ...overrides
  };
}

function request(candidates: CapitalAllocationCandidate[]): CapitalAllocationRequest {
  return {
    modelVersion: "capital-allocation-v1",
    profitMode: "conservative",
    budgets: [{ venue: "alpha", asset: "USDT", amount: 10 }],
    candidates,
    maximumOpenRoutes: 10,
    maximumSearchNodes: 10_000
  };
}

describe("capital allocation", () => {
  it("finds the exact portfolio when a greedy first choice is suboptimal", () => {
    const result = allocateCapital(request([
      candidate("A", 10, 10),
      candidate("B", 6, 7),
      candidate("C", 4, 6)
    ]));
    expect(result).toMatchObject({ optimal: true, truncated: false, netProfit: 13, upperBoundNetProfit: 13, absoluteOptimalityGap: 0 });
    expect(result.allocations.map((row) => row.routeId)).toEqual(["B", "C"]);
    expect(result.unusedCapital).toEqual([{ venue: "alpha", asset: "USDT", amount: 0 }]);
  });

  it("enforces venue/asset budgets, family risk limits and open-route limits", () => {
    const input = request([
      candidate("A", 4, 6, { family: "basis", maximumUnits: 3 }),
      candidate("B", 4, 5, { family: "basis", maximumUnits: 3 })
    ]);
    input.familyLimits = [{ family: "basis", maximumRiskCapital: 4 }];
    input.maximumOpenRoutes = 1;
    const result = allocateCapital(input);
    expect(result.allocations).toEqual([expect.objectContaining({ routeId: "A", units: 1, riskCapital: 4 })]);
    expect(result.familyRiskCapital).toEqual([{ family: "basis", amount: 4 }]);
  });

  it("keeps minimum allocation sizes indivisible", () => {
    const input = request([candidate("A", 3, 4, { minimumUnits: 2, maximumUnits: 3 })]);
    input.budgets[0]!.amount = 5;
    const result = allocateCapital(input);
    expect(result.allocations).toEqual([]);
    expect(result.rejections).toContainEqual(expect.objectContaining({ routeId: "A", code: "below-minimum-size" }));
  });

  it("rejects ineligible, disabled, non-profitable and unbudgeted routes", () => {
    const input = request([
      candidate("ineligible", 1, 1, { eligible: false }),
      candidate("statistical", 1, 1, { outcomeClass: "statistical" }),
      candidate("loss", 1, -1),
      candidate("btc", 1, 1, { capitalPerUnit: [{ venue: "alpha", asset: "BTC", amount: 1 }] })
    ]);
    input.allowedOutcomeClasses = ["locked", "projected"];
    const result = allocateCapital(input);
    expect(result.rejections.map((row) => row.code)).toEqual([
      "missing-capital-budget",
      "ineligible",
      "non-positive-profit",
      "outcome-class-disabled"
    ]);
  });

  it("marks a node-budget incumbent as truncated instead of optimal", () => {
    const input = request([candidate("A", 5, 6, { maximumUnits: 2 }), candidate("B", 3, 4, { maximumUnits: 3 })]);
    input.maximumSearchNodes = 1;
    const result = allocateCapital(input);
    expect(result).toMatchObject({ optimal: false, truncated: true, visitedNodes: 1 });
    expect(result.upperBoundNetProfit).toBeGreaterThanOrEqual(result.netProfit);
    expect(result.absoluteOptimalityGap).toBe(result.upperBoundNetProfit - result.netProfit);
  });

  it("is deterministic across identical calls", () => {
    const input = request([candidate("z", 5, 5), candidate("a", 5, 5)]);
    expect(allocateCapital(input)).toEqual(allocateCapital(input));
  });

  it("rejects duplicate routes and unbounded work settings", () => {
    expect(() => allocateCapital(request([candidate("A", 1, 1), candidate("A", 2, 2)]))).toThrow(/unique route/);
    const input = request([candidate("A", 1, 1)]);
    input.maximumSearchNodes = 2_000_001;
    expect(() => allocateCapital(input)).toThrow(/maximumSearchNodes/);
  });
});
