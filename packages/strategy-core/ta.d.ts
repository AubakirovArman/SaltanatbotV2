import type { Candle } from "@saltanatbotv2/contracts";
export type PriceField = "open" | "high" | "low" | "close" | "volume" | "hl2" | "hlc3" | "ohlc4";
/** One candle's value for a price field (incl. the hl2/hlc3/ohlc4 composites). */
export declare function priceAt(candle: Candle, field: PriceField): number;
export declare function sourceSeries(candles: Candle[], field: PriceField): number[];
export declare function sma(src: number[], period: number): number[];
export declare function ema(src: number[], period: number): number[];
export declare function wma(src: number[], period: number): number[];
export declare function vwma(src: number[], volume: number[], period: number): number[];
export declare function stdev(src: number[], period: number): number[];
export declare function correlationSeries(a: number[], b: number[], period: number): number[];
export declare function rsi(src: number[], period: number): number[];
export declare function atr(candles: Candle[], period: number): number[];
export declare function highest(src: number[], period: number): number[];
export declare function lowest(src: number[], period: number): number[];
export declare function change(src: number[], period: number): number[];
export declare function bollingerBand(src: number[], period: number, dev: number, band: "upper" | "middle" | "lower"): number[];
/** Stochastic %K: position of close inside the [lowest low, highest high] window. */
export declare function stochK(candles: Candle[], period: number): number[];
export declare function williamsR(candles: Candle[], period: number): number[];
export declare function cci(candles: Candle[], period: number): number[];
/** Rate of change, percent: (src / src[n bars ago] - 1) * 100. */
export declare function roc(src: number[], period: number): number[];
export declare function macdLine(src: number[], fast: number, slow: number, signal: number, line: "macd" | "signal" | "histogram"): number[];
/** ta.valuewhen: the value of `src` on the Nth most recent bar where `cond`
 *  was true (occurrence 0 = most recent). NaN until enough matches exist. */
export declare function valueWhen(cond: boolean[], src: number[], occurrence: number): number[];
/** ta.highestbars / ta.lowestbars: offset (0 or negative) to the extremum of
 *  `src` in the trailing window. Ties pick the most recent bar. */
export declare function extremeBars(kind: "highest" | "lowest", src: number[], period: number): number[];
/** ta.linreg: least-squares line over the window (x = 0..period-1, oldest →
 *  newest), evaluated at x = period - 1 - offset. */
export declare function linregSeries(src: number[], period: number, offset: number): number[];
/** ta.vwap: session-anchored VWAP — cumulative Σ(hlc3·vol)/Σvol, reset when
 *  the UTC day changes. */
export declare function vwapSeries(candles: Candle[]): number[];
/** ta.supertrend: ATR bands around hl2 with ratcheting final bands.
 *  dir = -1 uptrend (value rides the lower band), +1 downtrend. */
export declare function supertrendSeries(candles: Candle[], factor: number, atrPeriod: number): {
    value: number[];
    dir: number[];
};
/** ta.dmi: Wilder's directional movement — +DI / -DI over diLen, ADX = RMA of
 *  DX over adxLen. */
export declare function dmiSeries(candles: Candle[], diLen: number, adxLen: number): {
    plus: number[];
    minus: number[];
    adx: number[];
};
/** ta.mfi: money flow index over typical price (hlc3) and volume. */
export declare function mfiSeries(candles: Candle[], period: number): number[];
/** ta.cmo: Chande momentum — 100·(Σup − Σdown)/(Σup + Σdown) of 1-bar momenta. */
export declare function cmoSeries(src: number[], period: number): number[];
/** ta.tsi: true strength index — double-EMA-smoothed 1-bar momentum ratio. */
export declare function tsiSeries(src: number[], shortLen: number, longLen: number): number[];
/** ta.alma: Arnaud Legoux MA — gaussian window weights with
 *  m = offset·(period−1), s = period/sigma (j = 0 oldest … period−1 newest). */
export declare function almaSeries(src: number[], period: number, offset: number, sigma: number): number[];
/** ta.cog: center of gravity — −Σ(src[i−j]·(j+1)) / Σ src[i−j], the most
 *  recent bar weighted 1. */
export declare function cogSeries(src: number[], period: number): number[];
/** ta.percentrank: percent of the PREVIOUS `period` values (excluding the
 *  current bar) that are ≤ the current value, 0..100. */
export declare function percentRankSeries(src: number[], period: number): number[];
/** ta.sar: classic parabolic stop-and-reverse (ported from Pine's reference
 *  implementation, including the two-bar high/low clamp). */
export declare function sarSeries(candles: Candle[], start: number, inc: number, max: number): number[];
/** ta.kc: Keltner channels — EMA(close) middle, bands ± mult·RMA(TR). */
export declare function kcSeries(candles: Candle[], period: number, mult: number): {
    upper: number[];
    middle: number[];
    lower: number[];
};
