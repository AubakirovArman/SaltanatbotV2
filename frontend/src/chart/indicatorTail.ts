import type { Candle } from "../types";
import { replaceArrayTail } from "../market/candleSeries";
import { atr, bollinger, ema, macd, obv, rsi, sma, stochastic, vwap } from "./indicatorMath";
import type {
  BollingerConfig,
  IndicatorConfig,
  MacdConfig,
  MacdPoint,
  ObvConfig,
  PeriodIndicatorConfig,
  SeriesPoint,
  StochasticConfig
} from "./indicatorTypes";

interface RsiTailState {
  avgGain: number;
  avgLoss: number;
}

interface MacdTailState {
  fastEma?: number;
  slowEma?: number;
  signalEma?: number;
}

export type ComputedIndicator =
  | { config: PeriodIndicatorConfig; kind: "sma" | "ema" | "vwap" | "atr"; points: ReturnType<typeof sma> }
  | { config: PeriodIndicatorConfig; kind: "rsi"; points: SeriesPoint[]; tailState: RsiTailState }
  | { config: BollingerConfig; kind: "bollinger"; points: ReturnType<typeof bollinger> }
  | { config: MacdConfig; kind: "macd"; points: MacdPoint[]; tailState: MacdTailState }
  | { config: StochasticConfig; kind: "stochastic"; points: ReturnType<typeof stochastic> }
  | { config: ObvConfig; kind: "obv"; points: ReturnType<typeof obv> };

export function computeIndicator(candles: Candle[], config: IndicatorConfig): ComputedIndicator {
  switch (config.kind) {
    case "sma":
      return { config, kind: config.kind, points: sma(candles, config.period) };
    case "ema":
      return { config, kind: config.kind, points: ema(candles, config.period) };
    case "rsi":
      return {
        config,
        kind: config.kind,
        points: rsi(candles, config.period),
        tailState: rsiStateBeforeTail(candles, config.period)
      };
    case "vwap":
      return { config, kind: config.kind, points: vwap(candles, config.period) };
    case "atr":
      return { config, kind: config.kind, points: atr(candles, config.period) };
    case "bollinger":
      return { config, kind: config.kind, points: bollinger(candles, config.period, config.deviation) };
    case "macd":
      return {
        config,
        kind: config.kind,
        points: macd(candles, config.fast, config.slow, config.signal),
        tailState: macdStateBeforeTail(candles, config.fast, config.slow, config.signal)
      };
    case "stochastic":
      return { config, kind: config.kind, points: stochastic(candles, config.period, config.smooth) };
    case "obv":
      return { config, kind: config.kind, points: obv(candles) };
  }
}

export function patchIndicatorTail(indicator: ComputedIndicator, candles: Candle[]): ComputedIndicator {
  const index = candles.length - 1;
  const candle = candles[index];
  if (!candle || index < 1) return computeIndicator(candles, indicator.config);

  switch (indicator.kind) {
    case "sma": {
      if (index < indicator.config.period - 1) return computeIndicator(candles, indicator.config);
      let sum = 0;
      for (let offset = 0; offset < indicator.config.period; offset += 1) sum += candles[index - offset].close;
      return { ...indicator, points: replaceArrayTail(indicator.points, { time: candle.time, value: sum / indicator.config.period }) };
    }
    case "ema": {
      const previous = indicator.points[index - 1]?.value;
      if (previous === undefined) return computeIndicator(candles, indicator.config);
      const multiplier = 2 / (indicator.config.period + 1);
      return { ...indicator, points: replaceArrayTail(indicator.points, { time: candle.time, value: candle.close * multiplier + previous * (1 - multiplier) }) };
    }
    case "bollinger": {
      if (index < indicator.config.period - 1) return computeIndicator(candles, indicator.config);
      let sum = 0;
      let squareSum = 0;
      for (let offset = 0; offset < indicator.config.period; offset += 1) {
        const close = candles[index - offset].close;
        sum += close;
        squareSum += close * close;
      }
      const middle = sum / indicator.config.period;
      const variance = Math.max(0, squareSum / indicator.config.period - middle * middle);
      const band = Math.sqrt(variance) * indicator.config.deviation;
      return { ...indicator, points: replaceArrayTail(indicator.points, { time: candle.time, middle, upper: middle + band, lower: middle - band }) };
    }
    case "vwap": {
      if (index < indicator.config.period - 1) return computeIndicator(candles, indicator.config);
      let priceVolume = 0;
      let volume = 0;
      for (let offset = 0; offset < indicator.config.period; offset += 1) {
        const current = candles[index - offset];
        const typical = (current.high + current.low + current.close) / 3;
        priceVolume += typical * current.volume;
        volume += current.volume;
      }
      return { ...indicator, points: replaceArrayTail(indicator.points, { time: candle.time, value: volume === 0 ? candle.close : priceVolume / volume }) };
    }
    case "atr": {
      const previous = indicator.points[index - 1]?.value;
      if (previous === undefined) return computeIndicator(candles, indicator.config);
      const previousClose = candles[index - 1].close;
      const trueRange = Math.max(candle.high - candle.low, Math.abs(candle.high - previousClose), Math.abs(candle.low - previousClose));
      return { ...indicator, points: replaceArrayTail(indicator.points, { time: candle.time, value: (previous * (indicator.config.period - 1) + trueRange) / indicator.config.period }) };
    }
    case "stochastic": {
      if (index < indicator.config.period - 1) return computeIndicator(candles, indicator.config);
      let highest = Number.NEGATIVE_INFINITY;
      let lowest = Number.POSITIVE_INFINITY;
      for (let offset = 0; offset < indicator.config.period; offset += 1) {
        const current = candles[index - offset];
        highest = Math.max(highest, current.high);
        lowest = Math.min(lowest, current.low);
      }
      const span = highest - lowest;
      const k = span === 0 ? 50 : ((candle.close - lowest) / span) * 100;
      let d: number | undefined;
      if (index >= indicator.config.period - 2 + indicator.config.smooth) {
        let sum = k;
        let complete = true;
        for (let offset = 1; offset < indicator.config.smooth; offset += 1) {
          const value = indicator.points[index - offset]?.k;
          if (value === undefined) {
            complete = false;
            break;
          }
          sum += value;
        }
        if (complete) d = sum / indicator.config.smooth;
      }
      return { ...indicator, points: replaceArrayTail(indicator.points, { time: candle.time, k, d }) };
    }
    case "obv": {
      const previous = indicator.points[index - 1]?.value;
      if (previous === undefined) return computeIndicator(candles, indicator.config);
      const previousClose = candles[index - 1].close;
      const value = candle.close > previousClose ? previous + candle.volume : candle.close < previousClose ? previous - candle.volume : previous;
      return { ...indicator, points: replaceArrayTail(indicator.points, { time: candle.time, value }) };
    }
    case "rsi": {
      const change = candle.close - candles[index - 1].close;
      const gain = Math.max(change, 0);
      const loss = Math.max(-change, 0);
      const avgGain = index <= indicator.config.period
        ? indicator.tailState.avgGain + gain / indicator.config.period
        : (indicator.tailState.avgGain * (indicator.config.period - 1) + gain) / indicator.config.period;
      const avgLoss = index <= indicator.config.period
        ? indicator.tailState.avgLoss + loss / indicator.config.period
        : (indicator.tailState.avgLoss * (indicator.config.period - 1) + loss) / indicator.config.period;
      const value = index < indicator.config.period ? undefined : rsiValue(avgGain, avgLoss);
      return {
        ...indicator,
        points: replaceArrayTail(indicator.points, { time: candle.time, value })
      };
    }
    case "macd": {
      const fastEma = nextEma(indicator.tailState.fastEma, candle.close, indicator.config.fast);
      const slowEma = nextEma(indicator.tailState.slowEma, candle.close, indicator.config.slow);
      const macdValue = index >= indicator.config.fast - 1 && index >= indicator.config.slow - 1
        ? fastEma - slowEma
        : undefined;
      const signalEma = nextEma(indicator.tailState.signalEma, macdValue ?? 0, indicator.config.signal);
      const signalValue = macdValue !== undefined && index >= indicator.config.signal - 1
        ? signalEma
        : undefined;
      return {
        ...indicator,
        points: replaceArrayTail(indicator.points, {
          time: candle.time,
          macd: macdValue,
          signal: signalValue,
          histogram: macdValue !== undefined && signalValue !== undefined ? macdValue - signalValue : undefined
        })
      };
    }
  }
}

function rsiStateBeforeTail(candles: readonly Candle[], period: number): RsiTailState {
  let avgGain = 0;
  let avgLoss = 0;
  const end = Math.max(1, candles.length - 1);
  for (let index = 1; index < end; index += 1) {
    const change = candles[index].close - candles[index - 1].close;
    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);
    if (index <= period) {
      avgGain += gain / period;
      avgLoss += loss / period;
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
    }
  }
  return { avgGain, avgLoss };
}

function macdStateBeforeTail(
  candles: readonly Candle[],
  fast: number,
  slow: number,
  signal: number
): MacdTailState {
  let fastEma: number | undefined;
  let slowEma: number | undefined;
  let signalEma: number | undefined;
  const end = Math.max(0, candles.length - 1);
  for (let index = 0; index < end; index += 1) {
    fastEma = nextEma(fastEma, candles[index].close, fast);
    slowEma = nextEma(slowEma, candles[index].close, slow);
    const macdValue = index >= fast - 1 && index >= slow - 1 ? fastEma - slowEma : undefined;
    signalEma = nextEma(signalEma, macdValue ?? 0, signal);
  }
  return { fastEma, slowEma, signalEma };
}

function nextEma(previous: number | undefined, value: number, period: number): number {
  if (previous === undefined) return value;
  const multiplier = 2 / (period + 1);
  return value * multiplier + previous * (1 - multiplier);
}

function rsiValue(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) return 100;
  const relative = avgGain / avgLoss;
  return 100 - 100 / (1 + relative);
}
