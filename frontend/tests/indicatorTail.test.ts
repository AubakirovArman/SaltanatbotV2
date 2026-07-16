import { describe, expect, it } from "vitest";
import { computeIndicator, patchIndicatorTail } from "../src/chart/indicatorTail";
import type { IndicatorConfig } from "../src/chart/indicatorTypes";
import { replaceArrayTail } from "../src/market/candleSeries";
import type { Candle } from "../src/types";

const configs: IndicatorConfig[] = [
  { id: "sma", kind: "sma", label: "SMA", enabled: true, period: 20, color: "#fff" },
  { id: "ema", kind: "ema", label: "EMA", enabled: true, period: 20, color: "#fff" },
  { id: "rsi", kind: "rsi", label: "RSI", enabled: true, period: 14, color: "#fff" },
  { id: "vwap", kind: "vwap", label: "VWAP", enabled: true, period: 20, color: "#fff" },
  { id: "atr", kind: "atr", label: "ATR", enabled: true, period: 14, color: "#fff" },
  { id: "bb", kind: "bollinger", label: "BB", enabled: true, period: 20, deviation: 2, color: "#fff", bandColor: "#aaa" },
  { id: "macd", kind: "macd", label: "MACD", enabled: true, fast: 12, slow: 26, signal: 9, color: "#fff", signalColor: "#aaa", histogramUp: "#0f0", histogramDown: "#f00" },
  { id: "stochastic", kind: "stochastic", label: "Stochastic", enabled: true, period: 14, smooth: 3, color: "#fff", signalColor: "#aaa" },
  { id: "obv", kind: "obv", label: "OBV", enabled: true, color: "#fff" }
];

describe("provisional indicator tail", () => {
  it.each(configs.map((config) => [config.kind, config] as const))("matches a full %s recomputation", (_kind, config) => {
    const structural = candles(120);
    const previous = computeIndicator(structural, config);
    const oldTail = structural.at(-1)!;
    const liveTail: Candle = {
      ...oldTail,
      high: oldTail.high + 3,
      low: oldTail.low - 2,
      close: oldTail.close + 1.75,
      volume: oldTail.volume + 50,
      final: false
    };
    const live = replaceArrayTail(structural, liveTail);
    const patched = patchIndicatorTail(previous, live);
    const full = computeIndicator(structural.map((candle, index) => (index === structural.length - 1 ? liveTail : candle)), config);

    expect(patched.points).toHaveLength(full.points.length);
    expectPointClose(patched.points.at(-1)!, full.points.at(-1)!);
  });
});

function candles(count: number): Candle[] {
  return Array.from({ length: count }, (_, index) => {
    const open = 100 + index * 0.3 + Math.sin(index * 0.17);
    const close = open + Math.sin(index * 0.31) * 0.8;
    return {
      time: 1_710_000_000_000 + index * 60_000,
      open,
      high: Math.max(open, close) + 1,
      low: Math.min(open, close) - 1,
      close,
      volume: 100 + index,
      final: index < count - 1
    };
  });
}

function expectPointClose(actual: object, expected: object) {
  expect(Object.keys(actual)).toEqual(Object.keys(expected));
  for (const key of Object.keys(expected) as Array<keyof typeof expected>) {
    const value = expected[key];
    if (typeof value === "number") expect(actual[key as keyof typeof actual]).toBeCloseTo(value, 8);
    else expect(actual[key as keyof typeof actual]).toBe(value);
  }
}
