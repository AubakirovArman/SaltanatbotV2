import { describe, expect, it, vi } from "vitest";
import { lowerDrawingStatement, type DrawingStatementLoweringContext } from "../src/strategy/pine/drawingStatementLowering";

function context(overrides: Partial<DrawingStatementLoweringContext> = {}): DrawingStatementLoweringContext {
  return {
    nan: { k: "arith", op: "/", a: { k: "num", v: 0 }, b: { k: "num", v: 0 } },
    bool: () => ({ k: "bool", v: true }),
    color: () => "#123456",
    hasDrawingHandle: () => false,
    isColor: (expr) => expr.t === "ident" && expr.name.startsWith("color."),
    num: (expr) => expr.t === "num" ? { k: "num", v: expr.v } : { k: "price", field: "close" },
    plotHandle: (expr) => expr?.t === "ident" ? { value: { k: "price", field: expr.name === "upper" ? "high" : "low" }, pane: "price", label: expr.name } : undefined,
    string: (expr) => expr.t === "str" ? expr.v : undefined,
    warn: vi.fn(),
    warnOnce: vi.fn(),
    ...overrides
  };
}

describe("Pine drawing statement lowering", () => {
  it("routes conditional background shading through display lowering", () => {
    expect(lowerDrawingStatement(context(), "bgcolor", [{ value: {
      t: "ternary",
      cond: { t: "ident", name: "ready" },
      a: { t: "ident", name: "color.green" },
      b: { t: "ident", name: "na" }
    } }])?.[0]).toMatchObject({ k: "box", color: "#123456", when: { k: "bool", v: true } });
  });

  it("routes fill calls through tracked plot handles", () => {
    expect(lowerDrawingStatement(context(), "fill", [
      { value: { t: "ident", name: "upper" } },
      { value: { t: "ident", name: "lower" } },
      { value: { t: "ident", name: "color.blue" } }
    ])?.[0]).toMatchObject({ k: "box", top: { k: "price", field: "high" }, bottom: { k: "price", field: "low" } });
  });

  it("classifies tracked handle mutations and collection operations", () => {
    const drawing = context({ hasDrawingHandle: (name) => name === "trendLine" });
    expect(lowerDrawingStatement(drawing, "trendLine.set_y1", [])).toEqual([]);
    expect(drawing.warnOnce).toHaveBeenCalledWith("drawmut", expect.stringContaining("ignored"));

    const collection = context();
    expect(lowerDrawingStatement(collection, "items.push", [])).toEqual([]);
    expect(collection.warnOnce).toHaveBeenCalledWith("collections", expect.stringContaining("opaque"));
  });

  it("reports unsupported display calls without treating them as trading logic", () => {
    const ctx = context();
    expect(lowerDrawingStatement(ctx, "plotcandle", [])).toEqual([]);
    expect(ctx.warn).toHaveBeenCalledWith("Skipped display-only/unsupported call: plotcandle().");
  });

  it("returns undefined for unknown non-display calls", () => {
    expect(lowerDrawingStatement(context(), "vendor.execute", [])).toBeUndefined();
  });
});
