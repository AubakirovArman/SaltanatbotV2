import { describe, expect, it, vi } from "vitest";
import { lowerValue, type ValueLoweringContext } from "../src/strategy/pine/valueLowering";

function context(overrides: Partial<ValueLoweringContext> = {}): ValueLoweringContext {
  return {
    bool: () => ({ k: "bool", v: true }),
    hasUserFunction: () => false,
    inlineUserFunction: () => ({ t: "num", e: { k: "num", v: 99 } }),
    isBooleanExpression: () => false,
    num: () => ({ k: "num", v: 7 }),
    string: () => undefined,
    switchValue: () => ({ t: "bool", e: { k: "bool", v: false } }),
    ...overrides
  };
}

describe("Pine value lowering", () => {
  it("prioritizes user-function evaluation over generic call classification", () => {
    const inline = vi.fn(() => ({ t: "num", e: { k: "num", v: 99 } } as const));
    const result = lowerValue(context({ hasUserFunction: () => true, inlineUserFunction: inline }), {
      t: "call", callee: "custom", args: []
    });
    expect(result).toEqual({ t: "num", e: { k: "num", v: 99 } });
    expect(inline).toHaveBeenCalledWith("custom", []);
  });

  it("delegates switches before scalar type probing", () => {
    const string = vi.fn(() => "wrong");
    expect(lowerValue(context({ string }), { t: "switch", arms: [] })).toEqual({ t: "bool", e: { k: "bool", v: false } });
    expect(string).not.toHaveBeenCalled();
  });

  it("selects static strings before boolean and numeric lowering", () => {
    const bool = vi.fn(() => ({ k: "bool", v: true } as const));
    const num = vi.fn(() => ({ k: "num", v: 7 } as const));
    expect(lowerValue(context({ string: () => "Long", isBooleanExpression: () => true, bool, num }), { t: "str", v: "Long" })).toEqual({ t: "str", v: "Long" });
    expect(bool).not.toHaveBeenCalled();
    expect(num).not.toHaveBeenCalled();
  });

  it("returns typed boolean and numeric compiler values", () => {
    expect(lowerValue(context({ isBooleanExpression: () => true }), { t: "ident", name: "ready" })).toEqual({ t: "bool", e: { k: "bool", v: true } });
    expect(lowerValue(context(), { t: "num", v: 7 })).toEqual({ t: "num", e: { k: "num", v: 7 } });
  });
});
