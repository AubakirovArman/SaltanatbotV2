import { describe, expect, it, vi } from "vitest";
import { lowerStrategyCall, type StrategyCallLoweringContext } from "../src/strategy/pine/strategyCallLowering";
import type { PineArg, PineExpr } from "../src/strategy/pine/parser";

const argument = (value: PineExpr, name?: string): PineArg => ({ value, name });

function context(overrides: Partial<StrategyCallLoweringContext> = {}): StrategyCallLoweringContext {
  return {
    bool: (expr) => ({ k: "bool", v: expr.t !== "ident" || expr.name !== "false" }),
    markEntry: vi.fn(),
    markExplicitExit: vi.fn(),
    num: (expr) => expr.t === "num" ? { k: "num", v: expr.v } : { k: "price", field: "close" },
    warn: vi.fn(),
    warnOnce: vi.fn(),
    ...overrides
  };
}

describe("Pine strategy call lowering", () => {
  it("maps direction, legacy when and quantity on entries", () => {
    const ctx = context();
    expect(lowerStrategyCall(ctx, "strategy.entry", [
      argument({ t: "str", v: "S" }),
      argument({ t: "ident", name: "strategy.short" }),
      argument({ t: "num", v: 2 }, "qty"),
      argument({ t: "ident", name: "ready" }, "when")
    ])).toEqual([
      { k: "entry", direction: "short", when: { k: "bool", v: true } },
      { k: "size", mode: "units", value: { k: "num", v: 2 } }
    ]);
    expect(ctx.markEntry).toHaveBeenCalledWith("short");
  });

  it("maps explicit close and protection prices", () => {
    const closeCtx = context();
    expect(lowerStrategyCall(closeCtx, "strategy.close_all", [])).toEqual([{ k: "exit", when: { k: "bool", v: true } }]);
    expect(closeCtx.markExplicitExit).toHaveBeenCalled();

    const exitCtx = context();
    expect(lowerStrategyCall(exitCtx, "strategy.exit", [
      argument({ t: "ident", name: "close" }, "stop"),
      argument({ t: "num", v: 120 }, "limit")
    ])).toEqual([
      { k: "stop", mode: "price", value: { k: "price", field: "close" } },
      { k: "target", mode: "price", value: { k: "num", v: 120 } }
    ]);
    expect(exitCtx.warnOnce).toHaveBeenCalledWith("exitfreeze", expect.stringContaining("frozen at entry"));
    expect(exitCtx.markExplicitExit).toHaveBeenCalled();
  });

  it("fails closed for tick/trailing exits and risk controls", () => {
    expect(() => lowerStrategyCall(context(), "strategy.exit", [argument({ t: "num", v: 100 }, "trail_points")])).toThrow("tick-based");
    expect(() => lowerStrategyCall(context(), "strategy.risk.max_drawdown", [])).toThrow("weaken trading risk controls");
  });

  it("reports unsupported pending-order cancellation explicitly", () => {
    const ctx = context();
    expect(lowerStrategyCall(ctx, "strategy.cancel_all", [])).toEqual([]);
    expect(ctx.warn).toHaveBeenCalledWith(expect.stringContaining("pending-order command"));
  });

  it("returns undefined for non-strategy calls", () => {
    expect(lowerStrategyCall(context(), "plot", [])).toBeUndefined();
  });
});
