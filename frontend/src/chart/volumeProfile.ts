import type { Candle } from "../types";

export interface VolumeProfileBin {
  low: number;
  high: number;
  total: number;
  up: number;
  down: number;
  valueArea: boolean;
}

export interface VolumeProfile {
  bins: VolumeProfileBin[];
  pocIndex: number;
  pocPrice: number;
  valueAreaLow: number;
  valueAreaHigh: number;
  totalVolume: number;
  maxVolume: number;
}

/** Distribute candle volume uniformly across every price row crossed by its range. */
export function buildVolumeProfile(candles: Candle[], binCount = 28, valueAreaRatio = 0.7): VolumeProfile | undefined {
  const source = candles.filter((candle) =>
    Number.isFinite(candle.open) && Number.isFinite(candle.high) && Number.isFinite(candle.low)
    && Number.isFinite(candle.close) && Number.isFinite(candle.volume)
    && candle.high >= candle.low && candle.volume > 0
  );
  if (source.length === 0) return undefined;

  const count = Math.max(4, Math.min(120, Math.round(binCount)));
  const min = Math.min(...source.map((candle) => candle.low));
  const max = Math.max(...source.map((candle) => candle.high));
  const fallbackSpan = Math.max(Math.abs(max), 1) * 0.001;
  const span = max > min ? max - min : fallbackSpan;
  const floor = max > min ? min : min - span / 2;
  const size = span / count;
  const bins: VolumeProfileBin[] = Array.from({ length: count }, (_, index) => ({
    low: floor + index * size,
    high: floor + (index + 1) * size,
    total: 0,
    up: 0,
    down: 0,
    valueArea: false
  }));

  for (const candle of source) distributeCandle(candle, bins, floor, size);

  const totalVolume = bins.reduce((sum, bin) => sum + bin.total, 0);
  let pocIndex = 0;
  for (let index = 1; index < bins.length; index += 1) {
    if (bins[index].total > bins[pocIndex].total) pocIndex = index;
  }

  let lowIndex = pocIndex;
  let highIndex = pocIndex;
  let valueAreaVolume = bins[pocIndex].total;
  const target = totalVolume * Math.min(1, Math.max(0, valueAreaRatio));
  while (valueAreaVolume < target && (lowIndex > 0 || highIndex < bins.length - 1)) {
    const below = lowIndex > 0 ? bins[lowIndex - 1].total : -1;
    const above = highIndex < bins.length - 1 ? bins[highIndex + 1].total : -1;
    if (above > below) {
      highIndex += 1;
      valueAreaVolume += bins[highIndex].total;
    } else {
      lowIndex -= 1;
      valueAreaVolume += bins[lowIndex].total;
    }
  }
  for (let index = lowIndex; index <= highIndex; index += 1) bins[index].valueArea = true;

  return {
    bins,
    pocIndex,
    pocPrice: (bins[pocIndex].low + bins[pocIndex].high) / 2,
    valueAreaLow: bins[lowIndex].low,
    valueAreaHigh: bins[highIndex].high,
    totalVolume,
    maxVolume: bins[pocIndex].total
  };
}

function distributeCandle(candle: Candle, bins: VolumeProfileBin[], floor: number, size: number) {
  const up = candle.close >= candle.open;
  const range = candle.high - candle.low;
  if (range <= 0) {
    addVolume(bins[binIndex(candle.close, floor, size, bins.length)], candle.volume, up);
    return;
  }

  const first = binIndex(candle.low, floor, size, bins.length);
  const last = binIndex(candle.high, floor, size, bins.length);
  let allocated = 0;
  for (let index = first; index <= last; index += 1) {
    const overlap = Math.max(0, Math.min(candle.high, bins[index].high) - Math.max(candle.low, bins[index].low));
    const volume = candle.volume * overlap / range;
    allocated += volume;
    addVolume(bins[index], volume, up);
  }
  const remainder = candle.volume - allocated;
  if (Math.abs(remainder) > Math.max(1, candle.volume) * 1e-10) {
    addVolume(bins[binIndex((candle.high + candle.low) / 2, floor, size, bins.length)], remainder, up);
  }
}

function addVolume(bin: VolumeProfileBin, volume: number, up: boolean) {
  bin.total += volume;
  if (up) bin.up += volume;
  else bin.down += volume;
}

function binIndex(price: number, floor: number, size: number, count: number) {
  return Math.max(0, Math.min(count - 1, Math.floor((price - floor) / size)));
}
