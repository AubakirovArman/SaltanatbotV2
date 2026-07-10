import type { ChartLivePosition, Viewport } from "../types";

/** Draw live bot positions as a solid entry line + a side/qty tag on the price pane. */
export function drawLivePositions(ctx: CanvasRenderingContext2D, viewport: Viewport, positions: ChartLivePosition[], decimals: number) {
  const { plot } = viewport;
  ctx.save();
  ctx.font = "700 9px Inter, system-ui, sans-serif";
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  for (const pos of positions) {
    const y = viewport.priceToY(pos.entryPrice);
    if (y < plot.top || y > plot.bottom) continue;
    const color = pos.side === "long" ? "#23c97a" : "#ef5350";
    ctx.setLineDash([]);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(plot.left, y);
    ctx.lineTo(plot.right, y);
    ctx.stroke();
    const label = `${pos.side === "long" ? "▲ LONG" : "▼ SHORT"} ${trim(pos.qty)} @ ${pos.entryPrice.toFixed(decimals)}`;
    const w = ctx.measureText(label).width + 10;
    ctx.fillStyle = color;
    ctx.fillRect(plot.right - w - 2, y - 8, w, 15);
    ctx.fillStyle = "#0b0e14";
    ctx.fillText(label, plot.right - w + 3, y);
  }
  ctx.restore();
}

function trim(v: number): string {
  return String(Math.round(v * 1e4) / 1e4);
}
