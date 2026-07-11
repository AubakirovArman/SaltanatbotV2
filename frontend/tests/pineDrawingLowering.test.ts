import { describe, expect, it, vi } from "vitest";
import { lowerBox, lowerConditionalShading, lowerDisplay, lowerFill, lowerTableCell, type DrawingLoweringContext } from "../src/strategy/pine/drawingLowering";
import { PineConvertError } from "../src/strategy/pine/errors";
import type { PineArg, PineExpr } from "../src/strategy/pine/parser";

const argument = (value: PineExpr, name?: string): PineArg => ({ value, name });

function context(): DrawingLoweringContext {
  return {
    nan: { k: "arith", op: "/", a: { k: "num", v: 0 }, b: { k: "num", v: 0 } },
    bool: () => ({ k: "bool", v: true }),
    num: (expr) => expr.t === "num" ? { k: "num", v: expr.v } : { k: "price", field: "close" },
    color: () => "#112233",
    string: (expr) => expr.t === "str" ? expr.v : undefined,
    isColor: (expr) => expr.t === "ident" && expr.name.startsWith("color."),
    plotHandle: (expr) => expr?.t === "ident" ? { value: { k: "price", field: expr.name === "upper" ? "high" : "low" }, pane: "price", label: expr.name } : undefined,
    warn: vi.fn(),
    warnOnce: vi.fn()
  };
}

describe("Pine drawing lowering", () => {
  it("maps conditional background color to a guarded full-height box", () => {
    const ctx = context();
    const result = lowerConditionalShading(ctx, argument({
      t: "ternary",
      cond: { t: "ident", name: "trend" },
      a: { t: "ident", name: "color.green" },
      b: { t: "ident", name: "na" }
    }), "bgcolor");
    expect(result[0]).toMatchObject({ k: "box", color: "#112233", when: { k: "bool", v: true } });
  });

  it("maps price-pane plot handles to a band", () => {
    const result = lowerFill(context(), [argument({ t: "ident", name: "upper" }), argument({ t: "ident", name: "lower" }), argument({ t: "ident", name: "color.blue" })]);
    expect(result[0]).toMatchObject({ k: "box", top: { k: "price", field: "high" }, bottom: { k: "price", field: "low" } });
  });

  it("maps time-coordinate boxes to projection zones", () => {
    const result = lowerBox(context(), [
      argument({ t: "num", v: 10 }), argument({ t: "num", v: 110 }),
      argument({ t: "num", v: 20 }), argument({ t: "num", v: 90 }),
      argument({ t: "ident", name: "xloc.bar_time" }, "xloc")
    ]);
    expect(result[0]).toMatchObject({ k: "projection", left: { k: "num", v: 10 }, right: { k: "num", v: 20 } });
  });

  it("maps numeric table cells to accessible metrics", () => {
    const result = lowerTableCell(context(), [
      argument({ t: "ident", name: "stats" }), argument({ t: "num", v: 1 }),
      argument({ t: "num", v: 2 }), argument({ t: "num", v: 42 })
    ]);
    expect(result[0]).toMatchObject({ k: "metric", table: "stats", column: "Column 2", label: "Row 3", value: { k: "num", v: 42 } });
  });

  it("degrades display-only conversion errors to warnings", () => {
    const ctx = context();
    expect(lowerDisplay(ctx, "line.new", () => { throw new PineConvertError("bad coordinate"); })).toEqual([]);
    expect(ctx.warn).toHaveBeenCalledWith("Skipped line.new() — bad coordinate");
  });
});
