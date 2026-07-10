import type { ChartAlert, Viewport } from "../types";

/** Draw active price alerts as labelled dashed horizontal lines on the price pane. */
export function drawAlertLines(ctx: CanvasRenderingContext2D, viewport: Viewport, alerts: ChartAlert[], decimals: number) {
  const { plot } = viewport;
  ctx.save();
  ctx.font = "600 9px Inter, system-ui, sans-serif";
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  for (const alert of alerts) {
    const y = viewport.priceToY(alert.price);
    if (y < plot.top || y > plot.bottom) continue;
    const color = alert.triggered ? "#8f9bb3" : "#f7c948";
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(plot.left, y);
    ctx.lineTo(plot.right, y);
    ctx.stroke();
    ctx.setLineDash([]);
    const label = `🔔 ${alert.price.toFixed(decimals)}${alert.triggered ? " ✓" : ""}`;
    const w = ctx.measureText(label).width + 10;
    ctx.fillStyle = color;
    ctx.fillRect(plot.left + 2, y - 8, w, 15);
    ctx.fillStyle = "#0b0e14";
    ctx.fillText(label, plot.left + 7, y);
  }
  ctx.restore();
}
