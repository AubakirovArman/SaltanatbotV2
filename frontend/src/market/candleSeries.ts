import type { Candle } from "../types";

const STRUCTURAL_CANDLES = Symbol("saltanatbotv2.structuralCandles");

type StructuralCandleSnapshot = Candle[] & {
  [STRUCTURAL_CANDLES]?: readonly Candle[];
};

export interface CandleSeriesBuffer {
  /**
   * Array-compatible immutable snapshot consumed by the existing chart stack.
   * A provisional same-bar update owns only the replaced tail element and reads
   * retained history through its frozen structural snapshot.
   */
  candles: Candle[];
  /**
   * Dense snapshot whose timestamps change only when the series structure
   * changes. Timestamp-only derived data such as gap analysis can memoize on it.
   */
  structuralCandles: readonly Candle[];
  tailTime?: number;
}

const EMPTY_CANDLES = Object.freeze([]) as unknown as Candle[];

export const EMPTY_CANDLE_SERIES: CandleSeriesBuffer = Object.freeze({
  candles: EMPTY_CANDLES,
  structuralCandles: EMPTY_CANDLES
});

export function createCandleSeriesBuffer(candles: readonly Candle[], maxCandles: number): CandleSeriesBuffer {
  if (candles.length === 0 || maxCandles <= 0) return EMPTY_CANDLE_SERIES;
  const start = Math.max(0, candles.length - maxCandles);
  return fromOwnedDense(candles.slice(start));
}

/** Resolve the dense timestamp basis behind an O(1) provisional-tail snapshot. */
export function structuralCandlesOf(candles: readonly Candle[]): readonly Candle[] {
  return (candles as StructuralCandleSnapshot)[STRUCTURAL_CANDLES] ?? candles;
}

/** Create an immutable O(1) array view that replaces only the final element. */
export function replaceArrayTail<T>(structural: readonly T[], tail: T): T[] {
  if (structural.length === 0) return Object.freeze([tail]) as unknown as T[];
  return Object.freeze(arrayTailSnapshot(structural, tail)) as unknown as T[];
}

function arrayTailSnapshot<T>(structural: readonly T[], tail: T): T[] {
  const snapshot: T[] = [];
  Object.setPrototypeOf(snapshot, structural);
  snapshot.length = structural.length;
  Object.defineProperty(snapshot, structural.length - 1, {
    configurable: false,
    enumerable: true,
    value: tail,
    writable: false
  });
  return snapshot;
}

export function mergeCandleSeriesBuffer(series: CandleSeriesBuffer, next: Candle, maxCandles: number): CandleSeriesBuffer {
  if (maxCandles <= 0) return EMPTY_CANDLE_SERIES;
  if (series.tailTime === next.time && series.candles.length > 0) {
    const currentTail = series.candles.at(-1);
    if (next.final === true && currentTail?.final !== true) {
      const candles = series.candles.slice();
      candles[candles.length - 1] = next;
      return fromOwnedDense(candles);
    }
    return {
      candles: provisionalTailSnapshot(series.structuralCandles, next),
      structuralCandles: series.structuralCandles,
      tailTime: next.time
    };
  }

  const retained = Math.max(0, maxCandles - 1);
  const start = Math.max(0, series.candles.length - retained);
  const candles = series.candles.slice(start);
  candles.push(next);
  return fromOwnedDense(candles);
}

export function prependCandleSeriesBuffer(series: CandleSeriesBuffer, older: readonly Candle[], maxCandles: number): CandleSeriesBuffer {
  if (maxCandles <= 0) return EMPTY_CANDLE_SERIES;
  if (older.length === 0) return series;
  const merged = [...older, ...series.candles];
  const start = Math.max(0, merged.length - maxCandles);
  return fromOwnedDense(start > 0 ? merged.slice(start) : merged);
}

function fromOwnedDense(candles: Candle[]): CandleSeriesBuffer {
  if (candles.length === 0) return EMPTY_CANDLE_SERIES;
  Object.freeze(candles);
  return {
    candles,
    structuralCandles: candles,
    tailTime: candles.at(-1)?.time
  };
}

/**
 * Preserve normal Array behavior and a fresh React-visible identity without
 * copying retained history for every update of the currently forming candle.
 * The sparse own array contains only the live tail; inherited numeric entries
 * come from the immutable dense structural snapshot.
 */
function provisionalTailSnapshot(structuralCandles: readonly Candle[], tail: Candle): Candle[] {
  const snapshot = arrayTailSnapshot(structuralCandles, tail);
  Object.defineProperty(snapshot, STRUCTURAL_CANDLES, {
    configurable: false,
    enumerable: false,
    value: structuralCandles,
    writable: false
  });
  return Object.freeze(snapshot) as unknown as Candle[];
}
