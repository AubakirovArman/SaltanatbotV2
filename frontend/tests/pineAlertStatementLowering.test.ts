import { describe, expect, it, vi } from "vitest";
import { lowerAlertStatement, type AlertStatementLoweringContext } from "../src/strategy/pine/alertStatementLowering";

function context(): AlertStatementLoweringContext {
  return { bool: () => ({ k: "bool", v: true }), warn: vi.fn(), warnOnce: vi.fn() };
}

describe("Pine alert statement lowering", () => {
  it("maps alertcondition and preserves TradingView placeholders visibly", () => {
    const ctx = context();
    expect(lowerAlertStatement(ctx, "alertcondition", [
      { value: { t: "ident", name: "ready" } },
      { value: { t: "str", v: "Ready" } },
      { value: { t: "str", v: "Buy {{ticker}}" } }
    ])).toEqual([{ k: "alert", message: "Buy {{ticker}}", when: { k: "bool", v: true } }]);
    expect(ctx.warnOnce).toHaveBeenCalledWith("tmpl", expect.stringContaining("literal text"));
  });

  it("falls back safely for dynamic alert messages", () => {
    const ctx = context();
    expect(lowerAlertStatement(ctx, "alert", [{ value: { t: "ident", name: "message" } }])).toEqual([
      { k: "alert", message: "alert", when: { k: "bool", v: true } }
    ]);
    expect(ctx.warn).toHaveBeenCalledWith(expect.stringContaining("plain string"));
  });

  it("returns undefined for non-alert calls", () => {
    expect(lowerAlertStatement(context(), "plot", [])).toBeUndefined();
  });
});
