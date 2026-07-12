import { anchorFromPixel, type Anchor, type DrawingObject } from "../../chart/drawings";
import type { CompareLegendSnapshot, Viewport, VolumeProfileSnapshot } from "../../chart/types";
import type { Candle } from "../../types";

export function snapAnchor(viewport: Viewport, candles: Candle[], x: number, y: number, magnet: boolean): Anchor {
  const base = anchorFromPixel(viewport, x, y);
  const index = clampIndex(Math.round(viewport.xToIndex(x)), candles.length);
  const candle = candles[index];
  if (!candle) return base;
  const time = candle.time;
  if (!magnet) return { time, price: base.price };
  const levels = [candle.open, candle.high, candle.low, candle.close];
  let best = base.price;
  let bestDist = Infinity;
  for (const level of levels) {
    const dist = Math.abs(viewport.priceToY(level) - y);
    if (dist < bestDist) {
      bestDist = dist;
      best = level;
    }
  }
  return { time, price: bestDist <= 14 ? best : base.price };
}

export function moveDrawing(drawing: DrawingObject, part: number | "body", next: Anchor, dt: number, dp: number): DrawingObject {
  if (part === "body") {
    return { ...drawing, points: drawing.points.map((point) => ({ time: point.time + dt, price: point.price + dp })) };
  }
  return { ...drawing, points: drawing.points.map((point, index) => (index === part ? next : point)) };
}

export function clampIndex(index: number, length: number) {
  return Math.max(0, Math.min(length - 1, index));
}

export function sameLegend(a: CompareLegendSnapshot[], b: CompareLegendSnapshot[]) {
  if (a.length !== b.length) return false;
  return a.every((entry, index) => {
    const other = b[index];
    return entry.symbol === other.symbol && entry.id === other.id && entry.color === other.color && entry.base === other.base && entry.timeframe === other.timeframe && entry.chartType === other.chartType && roundPct(entry.pct) === roundPct(other.pct);
  });
}

export function sameVolumeProfile(current?: VolumeProfileSnapshot, next?: VolumeProfileSnapshot) {
  if (!current || !next) return current === next;
  return current.bins === next.bins
    && Math.abs(current.pocPrice - next.pocPrice) < 1e-8
    && Math.abs(current.valueAreaLow - next.valueAreaLow) < 1e-8
    && Math.abs(current.valueAreaHigh - next.valueAreaHigh) < 1e-8
    && Math.abs(current.totalVolume - next.totalVolume) < 1e-5;
}

function roundPct(pct?: number) {
  if (pct === undefined || !Number.isFinite(pct)) return undefined;
  return Math.round(pct * 100) / 100;
}

export function formatVolume(volume: number) {
  if (volume >= 1_000_000) return `${(volume / 1_000_000).toFixed(2)}M`;
  if (volume >= 1_000) return `${(volume / 1_000).toFixed(1)}K`;
  return volume.toFixed(0);
}
