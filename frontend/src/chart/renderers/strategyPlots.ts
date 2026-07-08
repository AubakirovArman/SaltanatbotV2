import type { ChartPlot, Viewport } from "../types";

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
