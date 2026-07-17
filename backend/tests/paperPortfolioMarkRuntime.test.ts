import { describe, expect, it, vi } from "vitest";
import {
  paperValuationMarkFromClosedCandle,
  persistClosedPaperMark
} from "../src/trading/paperPortfolioMarkRuntime.js";
import type { RunningBot } from "../src/trading/engineRuntime.js";
import type { BotConfig } from "../src/trading/types.js";

const NOW = 1_800_000_000_000;

function config(overrides: Partial<BotConfig> = {}): BotConfig {
  return {
    id: "mark-bot",
    revision: 4,
    ownerUserId: "mark-owner",
    accountId: "paper:mark-bot",
    paperPortfolioId: "mark-portfolio",
    paperAllocationMicros: 10_000_000_000,
    paperLedgerEpoch: 2,
    name: "Mark bot",
    strategyName: "Mark strategy",
    ir: { name: "mark", inputs: [], body: [] },
    symbol: "BTCUSDT",
    timeframe: "1m",
    exchange: "paper",
    market: "futures",
    sizeMode: "quote",
    sizeValue: 100,
    leverage: 1,
    notifyMarkers: false,
    status: "running",
    createdAt: NOW - 10_000,
    updatedAt: NOW - 1_000,
    ...overrides
  };
}

const candle = {
  time: NOW - 60_000,
  open: 64_700,
  high: 64_800,
  low: 64_600,
  close: 64_703.1234564,
  volume: 100,
  final: true,
  source: "binance-public"
};

describe("durable paper valuation marks", () => {
  it("builds fixed-micros evidence with a bounded timeframe-aware expiry", () => {
    expect(paperValuationMarkFromClosedCandle(config(), candle, NOW)).toEqual({
      ownerUserId: "mark-owner",
      portfolioId: "mark-portfolio",
      ledgerEpoch: 2,
      botId: "mark-bot",
      botRevision: 4,
      symbol: "BTCUSDT",
      priceMicros: 64_703_123_456,
      asOf: NOW,
      source: "paper:binance-public:closed-candle",
      expiresAt: NOW + 120_000,
      evidence: {
        kind: "closed-candle",
        candleTime: NOW - 60_000,
        timeframe: "1m",
        priceField: "close",
        final: true
      },
      persistedAt: NOW
    });
    expect(paperValuationMarkFromClosedCandle(
      config({ paperPortfolioId: undefined }),
      candle,
      NOW
    )).toBeUndefined();
  });

  it("writes one durable mark and pauses fail-closed when persistence fails", () => {
    const bot = {
      config: config(),
      paused: false,
      vars: new Map(),
      buffer: [candle]
    } as unknown as RunningBot;
    const write = vi.fn();
    const report = vi.fn();
    expect(persistClosedPaperMark(bot, candle, report, NOW, write)).toBe(true);
    expect(write).toHaveBeenCalledOnce();
    expect(report).not.toHaveBeenCalled();

    write.mockImplementation(() => { throw new Error("SQLite unavailable"); });
    expect(persistClosedPaperMark(bot, candle, report, NOW, write)).toBe(false);
    expect(bot.paused).toBe(true);
    expect(bot.pauseReason).toMatch(/SQLite unavailable/);
    expect(report).toHaveBeenCalledWith(expect.stringMatching(/valuation mark failed/i));
  });

  it("rejects invalid prices instead of manufacturing a zero mark", () => {
    expect(() => paperValuationMarkFromClosedCandle(
      config(),
      { ...candle, close: 0 },
      NOW
    )).toThrow(/outside fixed/i);
  });
});
