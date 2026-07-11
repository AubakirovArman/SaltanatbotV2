import { describe, expect, it, vi } from "vitest";
import { lowerDeclaration, type DeclarationLoweringContext } from "../src/strategy/pine/declarationLowering";

function context(): DeclarationLoweringContext {
  return { declare: vi.fn(), warn: vi.fn() };
}

describe("Pine declaration lowering", () => {
  it("captures sanitized indicator metadata", () => {
    const ctx = context();
    expect(lowerDeclaration(ctx, "indicator", [
      { value: { t: "str", v: "Trend\u0001" } },
      { name: "overlay", value: { t: "ident", name: "true" } }
    ])).toEqual([]);
    expect(ctx.declare).toHaveBeenCalledWith({ kind: "indicator", name: "Trend", overlay: true });
  });

  it("maps supported strategy default sizing", () => {
    const ctx = context();
    expect(lowerDeclaration(ctx, "strategy", [
      { value: { t: "str", v: "Bot" } },
      { name: "default_qty_type", value: { t: "ident", name: "strategy.percent_of_equity" } },
      { name: "default_qty_value", value: { t: "num", v: 25 } }
    ])).toEqual([{ k: "size", mode: "equity_pct", value: { k: "num", v: 25 } }]);
  });

  it("reports unsupported execution assumptions visibly", () => {
    const ctx = context();
    lowerDeclaration(ctx, "strategy", [
      { name: "default_qty_type", value: { t: "ident", name: "strategy.cash" } },
      { name: "default_qty_value", value: { t: "num", v: 100 } },
      { name: "pyramiding", value: { t: "num", v: 2 } },
      { name: "process_orders_on_close", value: { t: "ident", name: "true" } }
    ]);
    expect(ctx.warn).toHaveBeenCalledTimes(3);
  });

  it("returns undefined for ordinary calls", () => {
    expect(lowerDeclaration(context(), "plot", [])).toBeUndefined();
  });
});
