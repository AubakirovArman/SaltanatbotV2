import { describe, expect, it, vi } from "vitest";
import { lowerBooleanIdentifier, lowerNumericIdentifier, type IdentifierLoweringContext } from "../src/strategy/pine/identifierLowering";

function context(overrides: Partial<IdentifierLoweringContext> = {}): IdentifierLoweringContext {
  return {
    addBooleanVariable: vi.fn(),
    addNumericVariable: vi.fn(),
    boundValue: () => undefined,
    hasBooleanInput: () => false,
    hasBooleanVariable: () => false,
    hasDrawingHandle: () => false,
    hasNumericVariable: () => false,
    hasOpaqueState: () => false,
    hasPlotHandle: () => false,
    storageName: (name) => name === "state.ready" ? "state_ready" : name,
    trueRange: () => ({ k: "atr", period: { k: "num", v: 1 } }),
    unsupportedFunction: (name) => new Error(`unsupported ${name}`) as never,
    warnOnce: vi.fn(),
    ...overrides
  };
}

describe("Pine identifier lowering", () => {
  it("resolves price fields, constants and deterministic strategy context", () => {
    const ctx = context();
    expect(lowerNumericIdentifier(ctx, "close")).toEqual({ k: "price", field: "close" });
    expect(lowerNumericIdentifier(ctx, "math.pi")).toEqual({ k: "num", v: Math.PI });
    expect(lowerNumericIdentifier(ctx, "strategy.equity")).toEqual({ k: "ctx", key: "equity" });
  });

  it("fails closed for future-dependent and non-deterministic identifiers", () => {
    expect(() => lowerNumericIdentifier(context(), "last_bar_index")).toThrow("knowledge of the future");
    expect(() => lowerNumericIdentifier(context(), "timenow")).toThrow("non-deterministic");
  });

  it("preserves typed bound values and rejects cross-type reads", () => {
    const numeric = context({ boundValue: () => ({ t: "num", e: { k: "num", v: 4 } }) });
    expect(lowerNumericIdentifier(numeric, "length")).toEqual({ k: "num", v: 4 });
    const text = context({ boundValue: () => ({ t: "str", v: "Long" }) });
    expect(() => lowerBooleanIdentifier(text, "mode")).toThrow("not a condition");
  });

  it("maps boolean inputs and mutable numeric state without losing type", () => {
    expect(lowerBooleanIdentifier(context({ hasBooleanInput: (name) => name === "enabled" }), "enabled")).toEqual({
      k: "compare", op: "!=", a: { k: "input", name: "enabled" }, b: { k: "num", v: 0 }
    });
    expect(lowerBooleanIdentifier(context({ hasNumericVariable: (name) => name === "counter" }), "counter")).toEqual({
      k: "compare", op: "!=", a: { k: "var", name: "counter" }, b: { k: "num", v: 0 }
    });
  });

  it("flattens user-object fields through an explicit state mutation callback", () => {
    const ctx = context();
    expect(lowerBooleanIdentifier(ctx, "state.ready")).toEqual({ k: "varb", name: "state_ready" });
    expect(ctx.addBooleanVariable).toHaveBeenCalledWith("state_ready");
  });

  it("degrades opaque collection reads visibly", () => {
    const ctx = context({ hasOpaqueState: (name) => name === "items" });
    expect(lowerBooleanIdentifier(ctx, "items")).toEqual({ k: "bool", v: false });
    expect(ctx.warnOnce).toHaveBeenCalledWith("opaqueread", expect.stringContaining("collection/object state"));
  });
});
