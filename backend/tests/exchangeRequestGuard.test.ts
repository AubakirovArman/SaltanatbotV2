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
