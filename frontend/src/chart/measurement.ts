import type { Anchor } from "./drawings";
import type { Viewport } from "./types";

export interface MeasurementMetrics {
  priceDelta: number;
  percentDelta: number;
  bars: number;
  durationMs: number;
}

export function measureAnchors(start: Anchor, end: Anchor, viewport: Pick<Viewport, "barSpacing" | "timeToX">): MeasurementMetrics {
  const priceDelta = end.price - start.price;
  return {
    priceDelta,
    percentDelta: start.price ? priceDelta / start.price * 100 : 0,
    bars: Math.max(0, Math.round(Math.abs(viewport.timeToX(end.time) - viewport.timeToX(start.time)) / Math.max(1, viewport.barSpacing))),
    durationMs: Math.abs(end.time - start.time)
  };
}

export function formatMeasurementDuration(durationMs: number) {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1_000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor(totalMinutes % 1_440 / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d${hours ? ` ${hours}h` : ""}`;
  if (hours > 0) return `${hours}h${minutes ? ` ${minutes}m` : ""}`;
  return `${minutes}m`;
}

export function signed(value: number, decimals: number) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(decimals)}`;
}
