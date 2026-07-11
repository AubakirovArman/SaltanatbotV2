import { describe, expect, it } from "vitest";
import {
  ExchangeClockSkewError,
  ExchangeRateLimitError,
  ExchangeRequestGuard,
  getExchangeRequestGuard,
} from "../src/trading/exchange/requestGuard.js";

function response(status: number, headers: Record<string, string> = {}) {
  return { status, headers: new Headers(headers) };
}

describe("exchange signed-request guard", () => {
  it("shares the production circuit across adapters for the same exchange", () => {
    expect(getExchangeRequestGuard("binance")).toBe(getExchangeRequestGuard("binance"));
    expect(getExchangeRequestGuard("binance")).not.toBe(getExchangeRequestGuard("bybit"));
  });

  it("opens a circuit on HTTP 429 and honours Retry-After seconds", () => {
    let now = 1_000;
    const guard = new ExchangeRequestGuard("Test", () => now);
    guard.observeHttpResponse(response(429, { "retry-after": "2" }));

    expect(() => guard.assertAvailable()).toThrow(ExchangeRateLimitError);
    expect(guard.getState()).toEqual({ blockedUntil: 3_000 });
    now = 3_000;
    expect(() => guard.assertAvailable()).not.toThrow();
  });

  it("uses a longer safe default for an exchange ban and caps hostile headers", () => {
    const guard = new ExchangeRequestGuard("Test", () => 10_000);
    guard.observeHttpResponse(response(418));
    expect(guard.getState().blockedUntil).toBe(70_000);

    guard.observeHttpResponse(response(429, { "retry-after": "999999" }));
    expect(guard.getState().blockedUntil).toBe(910_000);
  });

  it("does not open the circuit for ordinary exchange rejections", () => {
    const guard = new ExchangeRequestGuard("Test", () => 1_000);
    guard.observeHttpResponse(response(400));
    expect(() => guard.assertAvailable()).not.toThrow();
  });

  it("opens the shared circuit before exceeding the reserved local budget", () => {
    let now = 1_000;
    const guard = new ExchangeRequestGuard("Test", () => now, { capacity: 4, windowMs: 1_000, reserveRatio: 0.75 });
    guard.assertAvailable();
    guard.assertAvailable();
    guard.assertAvailable();
    expect(guard.getBudgetState()).toMatchObject({ capacity: 4, usedWeight: 3, availableWeight: 0 });
    expect(() => guard.assertAvailable()).toThrow(ExchangeRateLimitError);
    expect(guard.getState()).toEqual({ blockedUntil: 2_000 });
    now = 2_000;
    expect(() => guard.assertAvailable()).not.toThrow();
    expect(guard.getBudgetState().usedWeight).toBe(1);
  });

  it("adapts proactive usage from Binance and Bybit response headers", () => {
    const binance = new ExchangeRequestGuard("Binance", () => 1_000, { capacity: 100, reserveRatio: 0.9 });
    binance.observeHttpResponse(response(200, { "x-mbx-used-weight-1m": "80" }));
    expect(binance.getBudgetState()).toMatchObject({ capacity: 100, usedWeight: 80, availableWeight: 10 });

    const bybit = new ExchangeRequestGuard("Bybit", () => 1_000, { capacity: 100 });
    bybit.observeHttpResponse(response(200, { "x-bapi-limit": "50", "x-bapi-limit-status": "12" }));
    expect(bybit.getBudgetState()).toMatchObject({ capacity: 50, usedWeight: 38, availableWeight: 7 });
  });

  it("detects Binance timestamp rejection and reports estimated clock offset", () => {
    const now = Date.parse("2026-07-11T12:00:05Z");
    const guard = new ExchangeRequestGuard("Binance", () => now);

    expect(() =>
      guard.detectClockSkew(-1021, "Timestamp for this request is outside of the recvWindow", "Sat, 11 Jul 2026 12:00:00 GMT"),
    ).toThrow(ExchangeClockSkewError);
    try {
      guard.detectClockSkew(-1021, "timestamp", "Sat, 11 Jul 2026 12:00:00 GMT");
    } catch (error) {
      expect(error).toMatchObject({ exchange: "Binance", estimatedOffsetMs: 5_000 });
    }
  });

  it("detects Bybit recv-window rejection even without an HTTP error", () => {
    const guard = new ExchangeRequestGuard("Bybit");
    expect(() => guard.detectClockSkew(10002, "The request time exceeds the time window range", null)).toThrow(
      /synchronize the host clock/,
    );
  });
});
