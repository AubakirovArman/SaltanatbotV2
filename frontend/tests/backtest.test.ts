import { describe, expect, it } from "vitest";
import { type BacktestConfig, DEFAULT_CONFIG, previewStrategy, runBacktest } from "../src/strategy/backtest";
import type { StrategyIR } from "../src/strategy/ir";
import type { Candle } from "../src/types";

/**
 * Backtest determinism + honesty. These assert the money-critical broker
 * behaviour: no look-ahead (next_open fill timing), and gap-honest stop fills.
 */

// Build a flat candle then override individual bars for controlled scenarios.
function candle(time: number, o: number, h: number, l: number, c: number): Candle {
  return { time, open: o, high: h, low: l, close: c, volume: 1000 };
}

const MIN = 60_000;

// A trivial strategy: go long while close is above `level`, exit when it dips
// below. `level` is an input so warm-up is 1 bar (no indicators).
function thresholdStrategy(level: number): StrategyIR {
  return {
    name: "threshold",
    inputs: [{ name: "level", value: level }],
    body: [
      { k: "entry", direction: "long", when: { k: "compare", op: ">", a: { k: "price", field: "close" }, b: { k: "input", name: "level" } } },
      { k: "exit", when: { k: "compare", op: "<", a: { k: "price", field: "close" }, b: { k: "input", name: "level" } } },
      { k: "size", mode: "units", value: { k: "num", v: 1 } },
    ],
  };
}

// A cross-based strategy: enter long when close crosses above a 2-bar SMA.
function crossStrategy(): StrategyIR {
  return {
    name: "cross",
    inputs: [],
    body: [
      {
        k: "entry",
        direction: "long",
        when: {
          k: "cross",
          dir: "above",
          a: { k: "price", field: "close" },
          b: { k: "ma", kind: "sma", period: { k: "num", v: 2 }, source: { k: "price", field: "close" } },
        },
      },
      {
        k: "exit",
        when: {
          k: "cross",
          dir: "below",
          a: { k: "price", field: "close" },
          b: { k: "ma", kind: "sma", period: { k: "num", v: 2 }, source: { k: "price", field: "close" } },
        },
      },
      { k: "size", mode: "units", value: { k: "num", v: 1 } },
    ],
  };
}

const noFriction: BacktestConfig = {
  ...DEFAULT_CONFIG,
  commissionPct: 0,
  slippagePct: 0,
  initialCapital: 10_000,
};

describe("backtest determinism", () => {
  it("produces byte-identical results for the same (ir, candles, config) twice", () => {
    const ir = crossStrategy();
    const candles: Candle[] = [];
    // A deterministic zig-zag that generates several crossovers.
    const closes = [100, 101, 99, 102, 98, 103, 97, 104, 96, 105, 95, 106];
    closes.forEach((c, i) => candles.push(candle(i * MIN, c, c + 1, c - 1, c)));

    const a = runBacktest(ir, candles, noFriction);
    const b = runBacktest(ir, candles, noFriction);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.trades).toEqual(b.trades);
    expect(a.metrics).toEqual(b.metrics);
  });
});

describe("next_open fill timing (no look-ahead)", () => {
  it("fills a signalled entry at the NEXT bar's open, not the signal bar", () => {
    const ir = thresholdStrategy(100);
    // bar 0 close 99 (below level, no entry)
    // bar 1 close 105 (above level -> entry SIGNAL on bar 1)
    // bar 2 open 106  -> entry fills here at 106
    // bars stay high so no exit.
    const candles = [
      candle(0 * MIN, 99, 100, 98, 99),
      candle(1 * MIN, 100, 106, 99, 105),
      candle(2 * MIN, 106, 112, 105, 110),
      candle(3 * MIN, 110, 115, 109, 112),
    ];
    const result = runBacktest(ir, candles, { ...noFriction, fillTiming: "next_open" });
    expect(result.trades).toHaveLength(1);
    const trade = result.trades[0];
    expect(trade.entryIndex).toBe(2); // filled on the bar AFTER the signal
    expect(trade.entryPrice).toBe(106); // at bar 2's OPEN
  });

  it("same_close timing fills on the signalling bar's own close", () => {
    const ir = thresholdStrategy(100);
    const candles = [
      candle(0 * MIN, 99, 100, 98, 99),
      candle(1 * MIN, 100, 106, 99, 105),
      candle(2 * MIN, 106, 112, 105, 110),
    ];
    const result = runBacktest(ir, candles, { ...noFriction, fillTiming: "same_close" });
    expect(result.trades[0].entryIndex).toBe(1);
    expect(result.trades[0].entryPrice).toBe(105); // bar 1 close
  });
});

describe("known crossover produces the expected trade", () => {
  it("enters long on the bar after a close/SMA2 cross-above", () => {
    // closes: 100, 100, 100, 110 -> SMA2 lags; the cross-above of close over
    // SMA2 happens on bar 3 (close 110 vs sma2 = (100+110)/2 = 105).
    const closes = [100, 100, 100, 110, 111, 112];
    const candles = closes.map((c, i) => candle(i * MIN, c, c + 1, c - 1, c));
    const result = runBacktest(crossStrategy(), candles, { ...noFriction, fillTiming: "next_open" });
    expect(result.trades).toHaveLength(1);
    // Signal on bar 3, fill at bar 4's open (111).
    expect(result.trades[0].entryIndex).toBe(4);
    expect(result.trades[0].entryPrice).toBe(111);
    expect(result.trades[0].direction).toBe("long");
  });
});

describe("previewStrategy runs bar-major (setvar state accumulates)", () => {
  it("plots a per-bar counter that increments across bars", () => {
    // Each bar: count = count + 1; then plot count. State must carry across bars,
    // which the old statement-major preview (that never ran setvar) could not do.
    const ir: StrategyIR = {
      name: "counter",
      inputs: [],
      body: [
        { k: "setvar", name: "count", value: { k: "arith", op: "+", a: { k: "var", name: "count" }, b: { k: "num", v: 1 } } },
        { k: "plot", value: { k: "var", name: "count" }, label: "count", color: "#fff" },
      ],
    };
    const candles = [100, 101, 102, 103].map((c, i) => candle(i * MIN, c, c + 1, c - 1, c));
    const { plots } = previewStrategy(ir, candles);
    expect(plots).toHaveLength(1);
    expect(plots[0].points.map((p) => p.value)).toEqual([1, 2, 3, 4]);
  });
});

describe("gap-through-stop honesty", () => {
  it("fills a gapped stop at the bar OPEN, not the (better) stop price", () => {
    // Enter long, attach a price stop at 95. Then a bar gaps DOWN so its open
    // (90) is already below the stop (95). An honest engine fills at 90, not 95.
    const ir: StrategyIR = {
      name: "gap-stop",
      inputs: [],
      body: [
        // Enter long on bar 0 (close 100 > 0).
        { k: "entry", direction: "long", when: { k: "compare", op: ">", a: { k: "price", field: "close" }, b: { k: "num", v: 0 } } },
        { k: "stop", mode: "price", value: { k: "num", v: 95 } },
        { k: "size", mode: "units", value: { k: "num", v: 1 } },
      ],
    };
    const candles = [
      candle(0 * MIN, 100, 101, 99, 100), // entry signal
      candle(1 * MIN, 100, 101, 99, 100), // entry fills at open 100
      candle(2 * MIN, 90, 91, 88, 89), // GAP DOWN through the stop; open 90 < stop 95
    ];
    const result = runBacktest(ir, candles, { ...noFriction, fillTiming: "next_open" });
    const stopTrade = result.trades.find((t) => t.reason === "stop");
    expect(stopTrade).toBeDefined();
    expect(stopTrade?.entryPrice).toBe(100);
    // Gap-honest: fill = min(open, stop) for a long = min(90, 95) = 90.
    expect(stopTrade?.exitPrice).toBe(90);
    // PnL = 1 * (90 - 100) = -10, strictly worse than the -5 a naive 95 fill implies.
    expect(stopTrade?.pnl).toBeCloseTo(-10, 9);
  });

  it("fills a normal (non-gapped) stop at the stop price with slippage off", () => {
    const ir: StrategyIR = {
      name: "clean-stop",
      inputs: [],
      body: [
        { k: "entry", direction: "long", when: { k: "compare", op: ">", a: { k: "price", field: "close" }, b: { k: "num", v: 0 } } },
        { k: "stop", mode: "price", value: { k: "num", v: 95 } },
        { k: "size", mode: "units", value: { k: "num", v: 1 } },
      ],
    };
    const candles = [
      candle(0 * MIN, 100, 101, 99, 100),
      candle(1 * MIN, 100, 101, 99, 100), // entry fills at 100
      candle(2 * MIN, 100, 100, 94, 96), // low 94 pierces stop 95, open 100 above stop
    ];
    const result = runBacktest(ir, candles, { ...noFriction, fillTiming: "next_open" });
    const stopTrade = result.trades.find((t) => t.reason === "stop");
    // No gap: raw = min(open 100, stop 95) = 95, slippage off -> exit at 95.
    expect(stopTrade?.exitPrice).toBe(95);
    expect(stopTrade?.pnl).toBeCloseTo(-5, 9);
  });
});
