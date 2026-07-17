import { readFileSync } from "node:fs";
import type { Candle, PriceThresholdAlertDefinitionV1 } from "@saltanatbotv2/contracts";
import { describe, expect, it, vi } from "vitest";
import { PublicClosedCandleReader, type PublicClosedCandleProvider } from "../src/alerts/publicClosedCandleReader.js";

const NOW = 239_999;

describe("public closed candle reader", () => {
  it("selects Binance directly, requests last-price public data and removes the forming tip", async () => {
    const binance = provider([candle(60_000, 100), candle(120_000, 101), candle(180_000, 102, { final: false })]);
    const bybit = provider([]);
    const reader = new PublicClosedCandleReader({ binance, bybit, now: () => NOW });

    const result = await reader.read(definition(), { limit: 3 });

    expect(result).toMatchObject({
      status: "ready",
      exchange: "binance",
      scopeKey: "market:binance:spot:last:BTCUSDT:1m",
      observedAt: NOW,
      candles: [
        { time: 60_000, close: 100, final: true },
        { time: 120_000, close: 101, final: true }
      ]
    });
    expect(binance.getCandles).toHaveBeenCalledWith(expect.objectContaining({ symbol: "BTCUSDT" }), "1m", { limit: 3 }, expect.objectContaining({ marketType: "spot", priceType: "last", signal: expect.anything() }));
    expect(bybit.getCandles).not.toHaveBeenCalled();
  });

  it("refreshes server time after REST so a candle closing during the request is accepted", async () => {
    const now = vi.fn().mockReturnValueOnce(239_999).mockReturnValueOnce(240_000);
    const reader = new PublicClosedCandleReader({
      binance: provider([candle(180_000, 102)]),
      bybit: provider([]),
      now
    });

    await expect(reader.read(definition(), { limit: 1 })).resolves.toMatchObject({
      status: "ready",
      observedAt: 240_000,
      candles: [{ time: 180_000, final: true }]
    });
    expect(now).toHaveBeenCalledTimes(2);
  });

  it("fails closed if the server clock moves backwards during a request", async () => {
    const now = vi.fn().mockReturnValueOnce(240_000).mockReturnValueOnce(239_999);
    const reader = new PublicClosedCandleReader({
      binance: provider([candle(180_000, 102)]),
      bybit: provider([]),
      now
    });

    await expect(reader.read(definition(), { limit: 1 })).resolves.toMatchObject({
      status: "unavailable",
      reason: "invalid-clock",
      observedAt: 239_999
    });
  });

  it("selects the injected Bybit provider for a Bybit linear scope", async () => {
    const binance = provider([]);
    const bybit = provider([candle(120_000, 101)]);
    const reader = new PublicClosedCandleReader({ binance, bybit, now: () => NOW });

    const result = await reader.read(definition({ exchange: "bybit", marketType: "linear" }), { limit: 1 });

    expect(result).toMatchObject({ status: "ready", exchange: "bybit" });
    expect(bybit.getCandles).toHaveBeenCalledWith(expect.objectContaining({ symbol: "BTCUSDT", exchange: "Bybit" }), "1m", { limit: 1 }, expect.objectContaining({ marketType: "linear", priceType: "last", signal: expect.anything() }));
    expect(binance.getCandles).not.toHaveBeenCalled();
  });

  it("continues a durable cursor through a bounded historical page", async () => {
    const binance = provider([candle(60_000, 100), candle(120_000, 101)]);
    const reader = new PublicClosedCandleReader({
      binance,
      bybit: provider([]),
      now: () => 600_000
    });

    const result = await reader.read(definition(), { limit: 2, afterBarTime: 0 });

    expect(result).toMatchObject({
      status: "ready",
      candles: [
        { time: 60_000, close: 100 },
        { time: 120_000, close: 101 }
      ]
    });
    expect(binance.getCandles).toHaveBeenCalledWith(expect.objectContaining({ symbol: "BTCUSDT" }), "1m", { limit: 2, startTime: 60_000, endTime: 120_000 }, expect.objectContaining({ marketType: "spot", priceType: "last", signal: expect.anything() }));
  });

  it("reads the exact armed-at candle after a long outage without a rolling recent window", async () => {
    const binance = provider([candle(60_000, 100)]);
    const reader = new PublicClosedCandleReader({
      binance,
      bybit: provider([]),
      now: () => 9_000_000
    });

    await expect(reader.read(definition(), { limit: 1, startAtBarTime: 60_000 })).resolves.toMatchObject({
      status: "ready",
      candles: [{ time: 60_000, close: 100 }]
    });
    expect(binance.getCandles).toHaveBeenCalledWith(expect.anything(), "1m", { limit: 1, startTime: 60_000, endTime: 60_000 }, expect.objectContaining({ signal: expect.anything() }));
  });

  it("pages a weekly Monday cursor without Unix-epoch week alignment", async () => {
    const week = 7 * 24 * 60 * 60_000;
    const mondayCursor = 4 * 24 * 60 * 60_000;
    const binance = provider([candle(mondayCursor + week, 100), candle(mondayCursor + 2 * week, 101)]);
    const reader = new PublicClosedCandleReader({
      binance,
      bybit: provider([]),
      now: () => mondayCursor + 3 * week + 1_000
    });

    await expect(reader.read(definition({ timeframe: "1w" }), { limit: 2, afterBarTime: mondayCursor })).resolves.toMatchObject({
      status: "ready",
      candles: [{ time: mondayCursor + week }, { time: mondayCursor + 2 * week }]
    });
    expect(binance.getCandles).toHaveBeenCalledWith(expect.anything(), "1w", { limit: 2, startTime: mondayCursor + week, endTime: mondayCursor + 2 * week }, expect.objectContaining({ marketType: "spot", priceType: "last", signal: expect.anything() }));
  });

  it("keeps first observations on a fresh final tip", async () => {
    const reader = new PublicClosedCandleReader({
      binance: provider([candle(60_000, 100), candle(120_000, 101)]),
      bybit: provider([]),
      now: () => 600_000
    });

    await expect(reader.read(definition(), { limit: 2 })).resolves.toMatchObject({
      status: "unavailable",
      reason: "stale-candle-window"
    });
  });

  it("fails closed before I/O when a cursor cannot produce a bounded next page", async () => {
    const binance = provider([]);
    const reader = new PublicClosedCandleReader({ binance, bybit: provider([]), now: () => NOW });

    await expect(reader.read(definition(), { afterBarTime: 120_000 })).resolves.toMatchObject({ status: "unavailable", reason: "no-new-closed-candle" });
    await expect(reader.read(definition(), { afterBarTime: 180_000 })).resolves.toMatchObject({ status: "unavailable", reason: "invalid-after-bar-time" });
    await expect(reader.read(definition(), { afterBarTime: -1 })).resolves.toMatchObject({ status: "unavailable", reason: "invalid-after-bar-time" });
    await expect(reader.read(definition(), { afterBarTime: 0, startAtBarTime: 60_000 })).resolves.toMatchObject({ status: "unavailable", reason: "invalid-start-bar-time" });
    expect(binance.getCandles).not.toHaveBeenCalled();
  });

  it("treats an empty provider page inside a non-empty cursor range as missing evidence", async () => {
    const binance = provider([]);
    const reader = new PublicClosedCandleReader({ binance, bybit: provider([]), now: () => 600_000 });

    await expect(reader.read(definition(), { limit: 2, afterBarTime: 0 })).resolves.toMatchObject({
      status: "unavailable",
      reason: "empty-candle-window"
    });
    expect(binance.getCandles).toHaveBeenCalledOnce();
  });

  it("rejects a provider page that does not begin immediately after the durable cursor", async () => {
    const reader = new PublicClosedCandleReader({
      binance: provider([candle(120_000, 101)]),
      bybit: provider([]),
      now: () => 600_000
    });

    await expect(reader.read(definition(), { limit: 2, afterBarTime: 0 })).resolves.toMatchObject({
      status: "unavailable",
      reason: "candle-range-conflict"
    });
  });

  it.each([
    [{ timeframe: "1M" }, "invalid-definition"],
    [{ priceType: "index" }, "invalid-definition"],
    [{ exchange: "kraken" }, "invalid-definition"]
  ] as const)("rejects an unsupported public scope before provider I/O", async (override, reason) => {
    const binance = provider([]);
    const bybit = provider([]);
    const reader = new PublicClosedCandleReader({ binance, bybit, now: () => NOW });

    const result = await reader.read({
      ...definition(),
      ...override
    } as PriceThresholdAlertDefinitionV1);

    expect(result).toMatchObject({ status: "unavailable", reason });
    expect(binance.getCandles).not.toHaveBeenCalled();
    expect(bybit.getCandles).not.toHaveBeenCalled();
  });

  it.each([
    ["gap", [candle(60_000, 100), candle(180_000, 102, { final: false })], "candle-gap"],
    ["stale tip", [candle(0, 100)], "stale-candle-window"],
    ["final candle before server closure", [candle(240_000, 100)], "candle-finality-conflict"],
    ["non-final candle after server closure", [candle(120_000, 100, { final: false })], "candle-finality-conflict"],
    ["forming candle before a later bar", [candle(180_000, 100, { final: false }), candle(240_000, 101, { final: false })], "forming-candle-order"],
    ["malformed OHLC", [candle(120_000, Number.NaN)], "malformed-candle"]
  ] as const)("fails closed on %s", async (_label, candles, reason) => {
    const reader = new PublicClosedCandleReader({
      binance: provider(candles),
      bybit: provider([]),
      now: () => NOW
    });

    await expect(reader.read(definition(), { limit: candles.length })).resolves.toMatchObject({
      status: "unavailable",
      reason
    });
  });

  it("returns a categorical unavailable result for provider failures and invalid bounds", async () => {
    const failing: PublicClosedCandleProvider = {
      getCandles: vi.fn(async () => {
        throw new Error("secret upstream detail");
      })
    };
    const reader = new PublicClosedCandleReader({
      binance: failing,
      bybit: provider([]),
      now: () => NOW
    });

    await expect(reader.read(definition())).resolves.toEqual({
      status: "unavailable",
      reason: "upstream-unavailable",
      scopeKey: "market:binance:spot:last:BTCUSDT:1m",
      observedAt: NOW
    });
    await expect(reader.read(definition(), { limit: 0 })).resolves.toMatchObject({
      status: "unavailable",
      reason: "invalid-limit"
    });
  });

  it("aborts a public provider that exceeds the reader deadline", async () => {
    let signal: AbortSignal | undefined;
    const hanging: PublicClosedCandleProvider = {
      getCandles: vi.fn((_instrument, _timeframe, _range, options) => {
        signal = options?.signal;
        return new Promise<Candle[]>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      })
    };
    const reader = new PublicClosedCandleReader({
      binance: hanging,
      bybit: provider([]),
      now: () => NOW,
      requestTimeoutMs: 10
    });

    await expect(reader.read(definition())).resolves.toMatchObject({
      status: "unavailable",
      reason: "upstream-unavailable"
    });
    expect(signal?.aborted).toBe(true);
  });

  it("has no router, SQLite fallback, trading, delivery or credential dependency", () => {
    const source = readFileSync(new URL("../src/alerts/publicClosedCandleReader.ts", import.meta.url), "utf8");

    for (const forbidden of ["providers/router", "candleStore", "SyntheticProvider", "trading/", "telegram", "notifications", "apiKey", "apiSecret"]) {
      expect(source).not.toContain(forbidden);
    }
  });
});

function provider(candles: readonly Candle[]): PublicClosedCandleProvider & {
  getCandles: ReturnType<typeof vi.fn>;
} {
  return {
    getCandles: vi.fn(async () => candles.map((item) => ({ ...item })))
  };
}

function definition(override: Partial<PriceThresholdAlertDefinitionV1> = {}): PriceThresholdAlertDefinitionV1 {
  return {
    schemaVersion: "alert-rule-v1",
    kind: "price-threshold",
    name: "BTC threshold",
    enabled: true,
    cooldownSeconds: 0,
    deliveryChannels: ["in-app"],
    researchOnly: true,
    executionPermission: false,
    exchange: "binance",
    marketType: "spot",
    priceType: "last",
    symbol: "BTCUSDT",
    timeframe: "1m",
    direction: "above",
    threshold: "101",
    crossing: "inclusive",
    repeat: "once-until-rearmed",
    ...override
  };
}

function candle(time: number, close: number, override: Partial<Candle> = {}): Candle {
  return {
    time,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 10,
    final: true,
    source: "public-test",
    ...override
  };
}
