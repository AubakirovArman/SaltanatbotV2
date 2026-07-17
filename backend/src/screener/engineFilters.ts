import type { Candle, ScreenerFilterV1, ScreenerMaTypeV1 } from "@saltanatbotv2/contracts";
import { atr, ema, macdLine, rsi, sma } from "@saltanatbotv2/strategy-core";

/**
 * Per-filter evaluation on a validated closed-candle window. Indicator math
 * comes exclusively from @saltanatbotv2/strategy-core so screener values match
 * the chart and backtest pipelines. The last closed bar is the evaluation bar;
 * cross states compare the last two closed bars. NaN warm-up output or missing
 * market data always yields "unavailable" — it is never treated as zero.
 */

export interface ScreenerFilterContextV1 {
  /** Closed candles in ascending time order; the tip is the evaluation bar. */
  candles: Candle[];
  /** Close series of the same candles, precomputed once per symbol. */
  closes: number[];
  /** Close of the last closed candle (the evaluation bar). */
  lastClose: number;
  /** 24h quote-asset turnover from the ticker snapshot, when available. */
  quoteVolume24h?: number;
  /** 24h price change percent from the ticker snapshot, when available. */
  change24hPercent?: number;
}

/** Numeric indicator outputs on the evaluation bar, keyed like ScreenerRowMetricsV1. */
export interface ScreenerMetricValuesV1 {
  rsi?: number;
  atrPercent?: number;
  macdHistogram?: number;
  fastMa?: number;
  slowMa?: number;
}

export type ScreenerFilterOutcomeV1 =
  | { status: "matched" | "unmatched"; metrics?: ScreenerMetricValuesV1 }
  | { status: "unavailable"; reason: string };

export function evaluateScreenerFilter(filter: ScreenerFilterV1, context: ScreenerFilterContextV1): ScreenerFilterOutcomeV1 {
  if (filter.kind === "price") {
    return bounded(context.lastClose, filter.min, filter.max);
  }
  if (filter.kind === "quote-volume-24h") {
    if (context.quoteVolume24h === undefined) return unavailable("ticker-unavailable");
    return outcome(context.quoteVolume24h >= Number(filter.min));
  }
  if (filter.kind === "change-24h-percent") {
    if (context.change24hPercent === undefined) return unavailable("ticker-unavailable");
    return bounded(context.change24hPercent, filter.min, filter.max);
  }
  if (filter.kind === "rsi") {
    const value = lastValue(rsi(context.closes, filter.period));
    if (value === undefined) return unavailable("indicator-warm-up");
    return outcome(thresholdMatches(value, filter.condition, Number(filter.value)), { rsi: value });
  }
  if (filter.kind === "ma-cross") {
    return evaluateMaCross(filter, context);
  }
  if (filter.kind === "macd") {
    return evaluateMacd(filter, context);
  }
  const series = atr(context.candles, filter.period);
  const value = lastValue(series);
  if (value === undefined || context.lastClose <= 0) return unavailable("indicator-warm-up");
  const atrPercent = (value / context.lastClose) * 100;
  return outcome(thresholdMatches(atrPercent, filter.condition, Number(filter.value)), { atrPercent });
}

function evaluateMaCross(
  filter: Extract<ScreenerFilterV1, { kind: "ma-cross" }>,
  context: ScreenerFilterContextV1
): ScreenerFilterOutcomeV1 {
  const fastSeries = movingAverage(context.closes, filter.fastType, filter.fastPeriod);
  const slowSeries = movingAverage(context.closes, filter.slowType, filter.slowPeriod);
  const fast = lastValue(fastSeries);
  const slow = lastValue(slowSeries);
  if (fast === undefined || slow === undefined) return unavailable("indicator-warm-up");
  const metrics: ScreenerMetricValuesV1 = { fastMa: fast, slowMa: slow };
  if (filter.state === "fast-above") return outcome(fast > slow, metrics);
  if (filter.state === "fast-below") return outcome(fast < slow, metrics);
  const previousFast = previousValue(fastSeries);
  const previousSlow = previousValue(slowSeries);
  if (previousFast === undefined || previousSlow === undefined) return unavailable("indicator-warm-up");
  if (filter.state === "crossed-up") return outcome(previousFast <= previousSlow && fast > slow, metrics);
  return outcome(previousFast >= previousSlow && fast < slow, metrics);
}

function evaluateMacd(
  filter: Extract<ScreenerFilterV1, { kind: "macd" }>,
  context: ScreenerFilterContextV1
): ScreenerFilterOutcomeV1 {
  const histogram = macdLine(context.closes, filter.fast, filter.slow, filter.signal, "histogram");
  const value = lastValue(histogram);
  if (value === undefined) return unavailable("indicator-warm-up");
  const metrics: ScreenerMetricValuesV1 = { macdHistogram: value };
  if (filter.condition === "histogram-above-zero") return outcome(value > 0, metrics);
  if (filter.condition === "histogram-below-zero") return outcome(value < 0, metrics);
  const previous = previousValue(histogram);
  if (previous === undefined) return unavailable("indicator-warm-up");
  if (filter.condition === "crossed-up") return outcome(previous <= 0 && value > 0, metrics);
  return outcome(previous >= 0 && value < 0, metrics);
}

function movingAverage(closes: number[], type: ScreenerMaTypeV1, period: number): number[] {
  return type === "ema" ? ema(closes, period) : sma(closes, period);
}

function bounded(value: number, min: string | undefined, max: string | undefined): ScreenerFilterOutcomeV1 {
  if (min !== undefined && value < Number(min)) return outcome(false);
  if (max !== undefined && value > Number(max)) return outcome(false);
  return outcome(true);
}

function thresholdMatches(value: number, condition: "above" | "below", threshold: number): boolean {
  return condition === "above" ? value > threshold : value < threshold;
}

function outcome(matched: boolean, metrics?: ScreenerMetricValuesV1): ScreenerFilterOutcomeV1 {
  return { status: matched ? "matched" : "unmatched", ...(metrics ? { metrics } : {}) };
}

function unavailable(reason: string): ScreenerFilterOutcomeV1 {
  return { status: "unavailable", reason };
}

function lastValue(series: number[]): number | undefined {
  return finiteAt(series, series.length - 1);
}

function previousValue(series: number[]): number | undefined {
  return finiteAt(series, series.length - 2);
}

function finiteAt(series: number[], index: number): number | undefined {
  if (index < 0 || index >= series.length) return undefined;
  const value = series[index]!;
  return Number.isFinite(value) ? value : undefined;
}
