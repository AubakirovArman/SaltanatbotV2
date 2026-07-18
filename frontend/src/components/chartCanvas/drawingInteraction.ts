import { anchorFromPixel, type Anchor, type DrawingObject, type DrawingTool, type ShapeTool } from "../../chart/drawings";
import { channelWidth, lineValueAt } from "../../chart/geometry";
import type { CompareLegendSnapshot, PriceMode, Viewport, VolumeProfileSnapshot } from "../../chart/types";
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

export function snapDrawingAnchor(tool: DrawingTool, viewport: Viewport, candles: Candle[], x: number, y: number, magnet: boolean) {
  const anchor = snapAnchor(viewport, candles, x, y, magnet);
  if (tool !== "anchored-vwap") return anchor;
  const candle = candles[clampIndex(Math.round(viewport.xToIndex(x)), candles.length)];
  return candle ? { time: candle.time, price: (candle.high + candle.low + candle.close) / 3 } : anchor;
}

export function moveDrawing(drawing: DrawingObject, part: number | "body", next: Anchor, dt: number, dp: number): DrawingObject {
  if (part === "body") {
    return { ...drawing, points: drawing.points.map((point) => ({ time: point.time + dt, price: point.price + dp })) };
  }
  if (drawing.tool === "parallel-channel" && drawing.points.length === 3) {
    const [a, b, w] = drawing.points;
    // Endpoint drags reshape the base line while the width offset is preserved as a price
    // delta; dragging the width anchor changes only the width. Degenerate geometry (shared
    // base-line time, zero width) is refused so the canonical channel contract keeps holding.
    if (part === 0 || part === 1) {
      const nextA = part === 0 ? next : a;
      const nextB = part === 1 ? next : b;
      if (nextA.time === nextB.time) return drawing;
      const offset = channelWidth(a, b, w);
      const price = lineValueAt(nextA, nextB, w.time) + (Number.isFinite(offset) ? offset : 0);
      return { ...drawing, points: [nextA, nextB, { time: w.time, price }] };
    }
    if (part === 2 && channelWidth(a, b, next) === 0) return drawing;
  }
  return { ...drawing, points: drawing.points.map((point, index) => (index === part ? next : point)) };
}

/** Whether the clicked anchor may extend the draft; keeps parallel channels contract-valid. */
export function canCommitDrawingAnchor(tool: ShapeTool, committed: Anchor[], anchor: Anchor): boolean {
  if (tool !== "parallel-channel") return true;
  if (committed.length === 1) return anchor.time !== committed[0].time;
  if (committed.length === 2) {
    const width = channelWidth(committed[0], committed[1], anchor);
    return Number.isFinite(width) && width !== 0;
  }
  return true;
}

export function clampIndex(index: number, length: number) {
  return Math.max(0, Math.min(length - 1, index));
}

export function pointerPoint(event: { clientX: number; clientY: number; currentTarget: HTMLCanvasElement }) {
  const rect = event.currentTarget.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

export function nextPriceMode(current: PriceMode): PriceMode {
  const modes: PriceMode[] = ["linear", "log", "percent"];
  return modes[(modes.indexOf(current) + 1) % modes.length];
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
