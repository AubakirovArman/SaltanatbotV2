import type { ChartPlot, PlotArea, Viewport } from "../types";

/**
 * Draws strategy plots marked `pane: "sub"` in their own auto-scaled panel below
 * the chart (for custom oscillators that shouldn't overlay price).
 */
export function drawSubPlots(ctx: CanvasRenderingContext2D, panel: PlotArea, viewport: Viewport, plots: ChartPlot[]) {
  let min = Infinity;
  let max = -Infinity;
  for (const series of plots) {
    for (const point of series.points) {
      const x = viewport.timeToX(point.time);
      if (x < panel.left - 2 || x > panel.right + 2 || !Number.isFinite(point.value)) continue;
      if (point.value < min) min = point.value;
      if (point.value > max) max = point.value;
    }
  }
  if (min === Infinity) return;
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const toY = (v: number) => panel.bottom - ((v - min) / (max - min)) * panel.height;
  ctx.save();
  for (const series of plots) {
    ctx.strokeStyle = series.color;
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    let started = false;
    for (const point of series.points) {
      const x = viewport.timeToX(point.time);
      if (x < panel.left - 2 || x > panel.right + 2 || !Number.isFinite(point.value)) {
        started = false;
        continue;
      }
      const y = toY(point.value);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
  }
  ctx.font = "600 9px Inter, system-ui, sans-serif";
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  let lx = panel.left + 4;
  const ly = panel.top + 9;
  for (const series of plots) {
    ctx.fillStyle = series.color;
    ctx.fillRect(lx, ly - 3, 8, 3);
    lx += 11;
    ctx.fillText(series.label, lx, ly);
    lx += ctx.measureText(series.label).width + 10;
  }
  ctx.restore();
  ctx.textAlign = "left";
}

/**
 * Draws the indicator lines a strategy plots (e.g. the EMAs a cross strategy
 * uses), plus a small legend so each line is identifiable.
 */
export function drawStrategyPlots(ctx: CanvasRenderingContext2D, viewport: Viewport, plots: ChartPlot[]) {
  const { plot } = viewport;
  ctx.save();
  for (const series of plots) {
    ctx.strokeStyle = series.color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    let started = false;
    for (const point of series.points) {
      const x = viewport.timeToX(point.time);
      if (x < plot.left - 2 || x > plot.right + 2) {
        started = false;
        continue;
      }
      const y = viewport.priceToY(point.value);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    if (series.points.length) ctx.stroke();
  }

  // Legend chips under the OHLC line.
  ctx.font = "600 10px Inter, system-ui, sans-serif";
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  let x = plot.left + 4;
  const y = plot.top + 14;
  for (const series of plots) {
    ctx.fillStyle = series.color;
    ctx.fillRect(x, y - 4, 9, 3);
    x += 13;
    const width = ctx.measureText(series.label).width;
    ctx.fillStyle = series.color;
    ctx.fillText(series.label, x, y);
    x += width + 12;
  }
  ctx.restore();
  ctx.textAlign = "left";
}
