import { describe, expect, it } from "vitest";
import type { StrategyIR } from "../src/strategy/ir";
import { buildSpec, comboCount, initOptSpec } from "../src/strategy/optimization/model";

const ir: StrategyIR = {
  name: "Optimization model",
  inputs: [
    { name: "fast", value: 10, min: 2, max: 50, step: 1 },
    { name: "slow", value: 30, min: 5, max: 100, step: 5 }
  ],
  body: []
};

describe("optimization model", () => {
  it("builds bounded default axes from strategy inputs", () => {
    const state = initOptSpec(ir);
    expect(state.axes).toHaveLength(2);
    expect(state.axes[0]).toMatchObject({ name: "fast", enabled: true });
    expect(state.axes[0].min).toBeGreaterThanOrEqual(2);
    expect(state.axes[0].max).toBeLessThanOrEqual(50);
  });

  it("counts enabled sweep combinations deterministically", () => {
    const state = initOptSpec(ir);
    state.axes[0] = { ...state.axes[0], enabled: true, min: 1, max: 3, step: 1 };
    state.axes[1] = { ...state.axes[1], enabled: true, min: 10, max: 20, step: 5 };
    expect(comboCount(state)).toBe(9);
  });

  it("emits only enabled axes in the worker specification", () => {
    const state = initOptSpec(ir);
    state.axes[1] = { ...state.axes[1], enabled: false };
    expect(buildSpec(state).params.map((parameter) => parameter.name)).toEqual(["fast"]);
  });
});
