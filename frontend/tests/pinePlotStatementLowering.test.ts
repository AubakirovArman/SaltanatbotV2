import { describe, expect, it, vi } from "vitest";
import { lowerPlotStatement, type PlotStatementLoweringContext } from "../src/strategy/pine/plotStatementLowering";
import type { PineExpr } from "../src/strategy/pine/parser";

function context(overrides: Partial<PlotStatementLoweringContext> = {}): PlotStatementLoweringContext {
  return {
    bool: () => ({ k: "bool", v: true }),
    color: () => "#123456",
    isBooleanExpression: (expr) => expr.t === "ident" && expr.name === "ready",
    num: (expr) => expr.t === "num" ? { k: "num", v: expr.v } : { k: "price", field: "close" },
    pane: () => "price",
    warnOnce: vi.fn(),
    ...overrides
  };
}

describe("Pine plot statement lowering", () => {
  it("maps plots with sanitized labels, colors and panes", () => {
    expect(lowerPlotStatement(context(), "plot", [
      { value: { t: "ident", name: "close" } },
      { value: { t: "str", v: "Close\u0001" } },
      { value: { t: "ident", name: "color.blue" } }
    ])).toEqual([{ k: "plot", value: { k: "price", field: "close" }, label: "Close", color: "#123456", pane: "price" }]);
  });

  it("uses style before location when choosing marker direction", () => {
    const series: PineExpr = { t: "ident", name: "ready" };
    expect(lowerPlotStatement(context(), "plotshape", [
      { value: series },
      { name: "text", value: { t: "str", v: "Sell" } },
      { name: "style", value: { t: "ident", name: "shape.triangledown" } },
      { name: "location", value: { t: "ident", name: "location.belowbar" } }
    ])).toEqual([{ k: "marker", dir: "down", label: "Sell", when: { k: "bool", v: true } }]);
  });

  it("degrades numeric plotchar to a price plot with a warning", () => {
    const ctx = context();
    expect(lowerPlotStatement(ctx, "plotchar", [{ value: { t: "ident", name: "close" } }])?.[0]).toMatchObject({ k: "plot" });
    expect(ctx.warnOnce).toHaveBeenCalledWith("plotchar", expect.stringContaining("price plot"));
  });

  it("maps plotarrow to positive and negative markers", () => {
    expect(lowerPlotStatement(context(), "plotarrow", [{ value: { t: "ident", name: "close" } }])).toMatchObject([
      { k: "marker", dir: "up", when: { k: "compare", op: ">" } },
      { k: "marker", dir: "down", when: { k: "compare", op: "<" } }
    ]);
  });
});
