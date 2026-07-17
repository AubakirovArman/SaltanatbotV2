import { describe, expect, it } from "vitest";
import type { Candle, ScreenerDefinitionV1, ScreenerFilterV1, ScreenerRunResultV1 } from "@saltanatbotv2/contracts";
import { atr as coreAtr, ema as coreEma, macdLine, rsi as coreRsi, sma as coreSma } from "@saltanatbotv2/strategy-core";
import { atr as chartAtr, ema as chartEma, macd as chartMacd, rsi as chartRsi, sma as chartSma } from "../../frontend/src/chart/indicatorMath";
import { evaluateScreener, formatScreenerDecimal } from "../src/screener/engine.js";

const NOW = Date.parse("2026-07-17T12:00:00.000Z");
const HASH = "a".repeat(64);
const HOUR = 3_600_000;
const START = Date.parse("2026-07-01T00:00:00.000Z");

describe("pure screener evaluation core", () => {
  it("matches price and 24h ticker filters against the closed evaluation bar", () => {
    const matched = evaluateSingle([{ kind: "price", min: "50", max: "150" }], [100, 101, 102]);
    expect(matched.universe).toEqual({ requested: 1, evaluated: 1, matched: 1, unavailable: 0 });
    // The row reports the closed-bar close, never the live ticker price.
    expect(matched.rows).toMatchObject([{ symbol: "AAAUSDT", lastClose: "102", closedBarTime: START + 2 * HOUR, matchedFilters: 1 }]);
    expect(matched.closedBarTimeMin).toBe(START + 2 * HOUR);
    expect(matched.closedBarTimeMax).toBe(START + 2 * HOUR);
    expect(matched.rowsTruncated).toBe(false);

    const unmatched = evaluateSingle([{ kind: "price", min: "500" }], [100, 101, 102]);
    expect(unmatched.universe).toEqual({ requested: 1, evaluated: 1, matched: 0, unavailable: 0 });
    expect(unmatched.rows).toEqual([]);

    const volume = evaluateSingle([{ kind: "quote-volume-24h", min: "500000" }], [100, 101, 102], { quoteVolume24h: 1_000_000, change24hPercent: 2 });
    expect(volume.rows).toMatchObject([{ quoteVolume24h: "1000000", change24hPercent: "2" }]);
    const missingTicker = evaluateSingle([{ kind: "quote-volume-24h", min: "500000" }], [100, 101, 102]);
    expect(missingTicker.universe.unavailable).toBe(1);
    expect(missingTicker.unavailableReasons).toEqual({ "ticker-unavailable": 1 });

    expect(evaluateSingle([{ kind: "change-24h-percent", min: "-5", max: "5" }], [100, 101, 102], { change24hPercent: 2 }).universe.matched).toBe(1);
    expect(evaluateSingle([{ kind: "change-24h-percent", min: "-5", max: "5" }], [100, 101, 102], { change24hPercent: 9 }).universe.matched).toBe(0);
    expect(evaluateSingle([{ kind: "change-24h-percent", min: "-5" }], [100, 101, 102]).unavailableReasons).toEqual({ "ticker-unavailable": 1 });
  });

  it("reports indicator warm-up honestly instead of treating missing values as zero", () => {
    const closes = [100, 101, 99, 102, 100, 103, 101, 104, 102, 105];
    const warmingRsi = evaluateSingle([{ kind: "rsi", period: 14, condition: "above", value: "50" }], closes);
    expect(warmingRsi.universe).toEqual({ requested: 1, evaluated: 0, matched: 0, unavailable: 1 });
    expect(warmingRsi.unavailableReasons).toEqual({ "indicator-warm-up": 1 });

    // An unavailable indicator wins over an earlier unmatched filter, so the
    // outcome never depends on filter order.
    const mixed = evaluateSingle(
      [
        { kind: "price", min: "1000000" },
        { kind: "rsi", period: 14, condition: "above", value: "50" }
      ],
      closes
    );
    expect(mixed.unavailableReasons).toEqual({ "indicator-warm-up": 1 });

    expect(evaluateSingle([{ kind: "atr-percent", period: 3, condition: "above", value: "0" }], [100, 101]).unavailableReasons).toEqual({ "indicator-warm-up": 1 });
    // Cross states need the previous closed bar as well, not just the tip.
    expect(
      evaluateSingle([{ kind: "ma-cross", fastType: "sma", fastPeriod: 2, slowType: "sma", slowPeriod: 3, state: "crossed-up" }], [10, 11, 12]).unavailableReasons
    ).toEqual({ "indicator-warm-up": 1 });
    expect(
      evaluateSingle([{ kind: "macd", fast: 2, slow: 3, signal: 2, condition: "crossed-up" }], [10, 11, 12]).unavailableReasons
    ).toEqual({ "indicator-warm-up": 1 });
  });

  it("evaluates rsi thresholds with strategy-core values on the last closed bar", () => {
    const closes = [100, 102, 101, 104, 103, 106, 105, 108, 107, 110, 109, 112, 111, 114, 113, 116, 115, 118, 117, 120];
    const expected = coreRsi(closes, 14).at(-1)!;
    expect(Number.isFinite(expected)).toBe(true);

    const above = evaluateSingle([{ kind: "rsi", period: 14, condition: "above", value: String(Math.floor(expected) - 1) }], closes);
    expect(above.universe.matched).toBe(1);
    expect(above.rows[0]?.metrics.rsi).toBe(formatScreenerDecimal(expected));

    const below = evaluateSingle([{ kind: "rsi", period: 14, condition: "below", value: String(Math.floor(expected) - 1) }], closes);
    expect(below.universe).toEqual({ requested: 1, evaluated: 1, matched: 0, unavailable: 0 });
  });

  it("applies ma-cross state on the last two closed bars", () => {
    // sma(2) closes above sma(3) exactly on the evaluation bar.
    const crossingCloses = [10, 10, 10, 8, 14];
    const crossedUp = evaluateSingle(
      [{ kind: "ma-cross", fastType: "sma", fastPeriod: 2, slowType: "sma", slowPeriod: 3, state: "crossed-up" }],
      crossingCloses
    );
    expect(crossedUp.universe.matched).toBe(1);
    expect(crossedUp.rows[0]?.metrics).toEqual({
      fastMa: formatScreenerDecimal(coreSma(crossingCloses, 2).at(-1)!),
      slowMa: formatScreenerDecimal(coreSma(crossingCloses, 3).at(-1)!)
    });

    // The same cross one bar earlier is fast-above now, but no longer a cross.
    const earlierCloses = [10, 10, 8, 14, 15];
    expect(
      evaluateSingle([{ kind: "ma-cross", fastType: "sma", fastPeriod: 2, slowType: "sma", slowPeriod: 3, state: "crossed-up" }], earlierCloses).universe.matched
    ).toBe(0);
    expect(
      evaluateSingle([{ kind: "ma-cross", fastType: "sma", fastPeriod: 2, slowType: "sma", slowPeriod: 3, state: "fast-above" }], earlierCloses).universe.matched
    ).toBe(1);

    const downCloses = [10, 10, 10, 12, 6];
    expect(
      evaluateSingle([{ kind: "ma-cross", fastType: "sma", fastPeriod: 2, slowType: "sma", slowPeriod: 3, state: "crossed-down" }], downCloses).universe.matched
    ).toBe(1);

    // The fast leg honours its configured moving-average type.
    const emaFast = evaluateSingle(
      [{ kind: "ma-cross", fastType: "ema", fastPeriod: 2, slowType: "sma", slowPeriod: 3, state: "fast-above" }],
      earlierCloses
    );
    expect(emaFast.rows[0]?.metrics.fastMa).toBe(formatScreenerDecimal(coreEma(earlierCloses, 2).at(-1)!));
  });

  it("applies macd histogram conditions on the last two closed bars", () => {
    const rising = Array.from({ length: 30 }, (_, index) => 100 + index);
    const histogram = macdLine(rising, 3, 6, 3, "histogram").at(-1)!;
    expect(histogram).toBeGreaterThan(0);
    const aboveZero = evaluateSingle([{ kind: "macd", fast: 3, slow: 6, signal: 3, condition: "histogram-above-zero" }], rising);
    expect(aboveZero.universe.matched).toBe(1);
    expect(aboveZero.rows[0]?.metrics.macdHistogram).toBe(formatScreenerDecimal(histogram));
    expect(evaluateSingle([{ kind: "macd", fast: 3, slow: 6, signal: 3, condition: "histogram-below-zero" }], rising).universe.matched).toBe(0);

    // A histogram sign flip on the evaluation bar is a cross; one bar later it is not.
    const crossingCloses = [...Array.from({ length: 13 }, (_, index) => 100 - index), 120];
    const series = macdLine(crossingCloses, 2, 4, 2, "histogram");
    expect(series.at(-2)!).toBeLessThanOrEqual(0);
    expect(series.at(-1)!).toBeGreaterThan(0);
    expect(evaluateSingle([{ kind: "macd", fast: 2, slow: 4, signal: 2, condition: "crossed-up" }], crossingCloses).universe.matched).toBe(1);
    expect(evaluateSingle([{ kind: "macd", fast: 2, slow: 4, signal: 2, condition: "crossed-down" }], crossingCloses).universe.matched).toBe(0);

    const afterCross = [...crossingCloses, 135];
    const afterSeries = macdLine(afterCross, 2, 4, 2, "histogram");
    expect(afterSeries.at(-2)!).toBeGreaterThan(0);
    expect(afterSeries.at(-1)!).toBeGreaterThan(0);
    expect(evaluateSingle([{ kind: "macd", fast: 2, slow: 4, signal: 2, condition: "crossed-up" }], afterCross).universe.matched).toBe(0);
  });

  it("applies atr-percent thresholds from strategy-core atr", () => {
    const closes = [100, 104, 98, 105, 101, 107, 103, 109, 105, 111];
    const candles = candleSeries(closes);
    const lastClose = closes.at(-1)!;
    const expected = (coreAtr(candles, 3).at(-1)! / lastClose) * 100;
    expect(expected).toBeGreaterThan(0);

    const above = evaluateSingle([{ kind: "atr-percent", period: 3, condition: "above", value: "0" }], closes);
    expect(above.universe.matched).toBe(1);
    expect(above.rows[0]?.metrics.atrPercent).toBe(formatScreenerDecimal(expected));
    expect(evaluateSingle([{ kind: "atr-percent", period: 3, condition: "below", value: "0" }], closes).universe.matched).toBe(0);
  });

  it("counts acquisition failures and malformed windows as unavailable rows", () => {
    const healthy = candleSeries([100, 101, 102]);
    const formingTip = candleSeries([100, 101, 102]).map((candle, index, all) => (index === all.length - 1 ? { ...candle, final: false } : candle));
    const brokenSequence = candleSeries([100, 101, 102]).map((candle) => ({ ...candle, time: START }));
    const brokenShape = candleSeries([100, 101, 102]).map((candle, index) => (index === 1 ? { ...candle, close: Number.NaN } : candle));
    const overflow = candleSeries([1e16]);
    const result = evaluateScreener({
      definition: definition({ filters: [{ kind: "price", min: "0.00000001" }] }),
      definitionHash: HASH,
      universe: ["AAAUSDT", "BBBUSDT", "CCCUSDT", "DDDUSDT", "EEEUSDT", "FFFUSDT", "GGGUSDT"].map((symbol) => ({ symbol })),
      candlesBySymbol: new Map([
        ["AAAUSDT", healthy],
        ["DDDUSDT", formingTip],
        ["EEEUSDT", brokenSequence],
        ["FFFUSDT", overflow],
        ["GGGUSDT", brokenShape]
      ]),
      unavailableReasonBySymbol: new Map([["BBBUSDT", "upstream-unavailable"]]),
      now: NOW
    });

    expect(result.universe).toEqual({ requested: 7, evaluated: 1, matched: 1, unavailable: 6 });
    expect(result.rows).toMatchObject([{ symbol: "AAAUSDT" }]);
    expect(result.unavailableReasons).toEqual({
      "upstream-unavailable": 1,
      "missing-candles": 1,
      "non-final-candle": 1,
      "malformed-candle-sequence": 1,
      "malformed-candle": 1,
      "row-out-of-range": 1
    });
    expect(result.closedBarTimeMin).toBe(healthy.at(-1)!.time);
    expect(result.closedBarTimeMax).toBe(healthy.at(-1)!.time);
  });

  it("sorts deterministically with undefined-last and symbol tiebreaks", () => {
    const universe = [
      { symbol: "AAAUSDT", quoteVolume24h: 100 },
      { symbol: "BBBUSDT" },
      { symbol: "CCCUSDT", quoteVolume24h: 200 },
      { symbol: "DDDUSDT", quoteVolume24h: 100 }
    ];
    const candlesBySymbol = new Map(universe.map(({ symbol }) => [symbol, candleSeries([5])]));
    const sortRun = (direction: "asc" | "desc") =>
      evaluateScreener({
        definition: definition({ sort: { key: "quoteVolume24h", direction }, filters: [{ kind: "price", min: "0.00000001" }] }),
        definitionHash: HASH,
        universe,
        candlesBySymbol,
        now: NOW
      }).rows.map((row) => row.symbol);

    expect(sortRun("desc")).toEqual(["CCCUSDT", "AAAUSDT", "DDDUSDT", "BBBUSDT"]);
    expect(sortRun("asc")).toEqual(["AAAUSDT", "DDDUSDT", "CCCUSDT", "BBBUSDT"]);
  });

  it("caps result rows at 100 and reports the truncation", () => {
    const symbols = Array.from({ length: 105 }, (_, index) => `S${String(index).padStart(3, "0")}USDT`);
    const result = evaluateScreener({
      definition: definition({ sort: { key: "lastClose", direction: "desc" }, filters: [{ kind: "price", min: "0.00000001" }] }),
      definitionHash: HASH,
      universe: symbols.map((symbol) => ({ symbol })),
      candlesBySymbol: new Map(symbols.map((symbol, index) => [symbol, candleSeries([index + 1])])),
      now: NOW
    });

    expect(result.universe).toEqual({ requested: 105, evaluated: 105, matched: 105, unavailable: 0 });
    expect(result.rows).toHaveLength(100);
    expect(result.rowsTruncated).toBe(true);
    expect(result.rows[0]).toMatchObject({ symbol: "S104USDT", lastClose: "105" });
    expect(result.rows[99]).toMatchObject({ symbol: "S005USDT", lastClose: "6" });
  });

  it("keeps chart and screener indicator math identical on the golden 300-candle fixture", () => {
    const candles = goldenCandles();
    const closes = candles.map((candle) => candle.close);

    expectSeriesParity(coreSma(closes, 20), chartSma(candles, 20).map((point) => point.value), 270);
    expectSeriesParity(coreEma(closes, 21), chartEma(candles, 21).map((point) => point.value), 270);
    expectSeriesParity(coreRsi(closes, 14), chartRsi(candles, 14).map((point) => point.value), 280);
    expectSeriesParity(coreAtr(candles, 14), chartAtr(candles, 14).map((point) => point.value), 280);
    const chartMacdSeries = chartMacd(candles, 12, 26, 9);
    expectSeriesParity(macdLine(closes, 12, 26, 9, "macd"), chartMacdSeries.map((point) => point.macd), 260);
    expectSeriesParity(macdLine(closes, 12, 26, 9, "signal"), chartMacdSeries.map((point) => point.signal), 260);
    expectSeriesParity(macdLine(closes, 12, 26, 9, "histogram"), chartMacdSeries.map((point) => point.histogram), 260);

    // The engine's reported metrics equal what the chart renders for the same bar.
    const result = evaluateScreener({
      definition: definition({
        filters: [
          { kind: "rsi", period: 14, condition: "above", value: "0" },
          { kind: "atr-percent", period: 14, condition: "above", value: "0" }
        ]
      }),
      definitionHash: HASH,
      universe: [{ symbol: "GOLDUSDT" }],
      candlesBySymbol: new Map([["GOLDUSDT", candles]]),
      now: NOW
    });
    expect(result.universe.matched).toBe(1);
    expect(result.rows[0]?.metrics.rsi).toBe(formatScreenerDecimal(chartRsi(candles, 14).at(-1)!.value!));
    expect(result.rows[0]?.metrics.atrPercent).toBe(formatScreenerDecimal((chartAtr(candles, 14).at(-1)!.value! / closes.at(-1)!) * 100));
  });

  it("formats screener decimals canonically", () => {
    expect(formatScreenerDecimal(1.23456789)).toBe("1.23456789");
    expect(formatScreenerDecimal(1.230000001)).toBe("1.23");
    expect(formatScreenerDecimal(100)).toBe("100");
    expect(formatScreenerDecimal(0.1 + 0.2)).toBe("0.3");
    expect(formatScreenerDecimal(-0.000000001)).toBe("0");
    expect(formatScreenerDecimal(-1.5)).toBe("-1.5");
    expect(formatScreenerDecimal(Number.NaN)).toBeUndefined();
    expect(formatScreenerDecimal(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(formatScreenerDecimal(1e15)).toBeUndefined();
  });
});

function definition(overrides: Partial<ScreenerDefinitionV1> = {}): ScreenerDefinitionV1 {
  return {
    schemaVersion: "screener-definition-v1",
    kind: "technical",
    name: "Engine test screen",
    exchange: "binance",
    marketType: "spot",
    priceType: "last",
    timeframe: "1h",
    universeLimit: 200,
    sort: { key: "symbol", direction: "asc" },
    filters: [{ kind: "price", min: "0.00000001" }],
    researchOnly: true,
    executionPermission: false,
    ...overrides
  };
}

function evaluateSingle(
  filters: ScreenerFilterV1[],
  closes: readonly number[],
  ticker: { quoteVolume24h?: number; change24hPercent?: number } = {}
): ScreenerRunResultV1 {
  return evaluateScreener({
    definition: definition({ filters }),
    definitionHash: HASH,
    universe: [{ symbol: "AAAUSDT", lastClose: 999, ...ticker }],
    candlesBySymbol: new Map([["AAAUSDT", candleSeries(closes)]]),
    now: NOW
  });
}

function candleSeries(closes: readonly number[]): Candle[] {
  return closes.map((close, index) => {
    const open = index === 0 ? close : closes[index - 1]!;
    return {
      time: START + index * HOUR,
      open,
      high: Math.max(open, close) * 1.001,
      low: Math.min(open, close) * 0.999,
      close,
      volume: 1_000,
      final: true
    };
  });
}

/** Deterministic pseudo-random walk shared by both indicator implementations. */
function goldenCandles(): Candle[] {
  let state = 0x12345678;
  const next = () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x100000000;
  };
  const candles: Candle[] = [];
  let close = 100;
  for (let index = 0; index < 300; index += 1) {
    const open = close;
    close = Math.max(1, close * (1 + (next() - 0.5) * 0.04));
    candles.push({
      time: START + index * HOUR,
      open,
      high: Math.max(open, close) * (1 + next() * 0.01),
      low: Math.min(open, close) * (1 - next() * 0.01),
      close,
      volume: 500 + Math.floor(next() * 1_000),
      final: true
    });
  }
  return candles;
}

function expectSeriesParity(core: readonly number[], chart: ReadonlyArray<number | undefined>, minimumCompared: number): void {
  expect(core).toHaveLength(chart.length);
  let compared = 0;
  for (let index = 0; index < core.length; index += 1) {
    const coreValue = core[index]!;
    const chartValue = chart[index];
    if (!Number.isFinite(coreValue) || chartValue === undefined) continue;
    expect(coreValue).toBe(chartValue);
    compared += 1;
  }
  expect(compared).toBeGreaterThanOrEqual(minimumCompared);
}
