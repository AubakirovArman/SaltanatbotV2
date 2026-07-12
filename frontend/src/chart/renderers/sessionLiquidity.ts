import type { SessionLiquiditySnapshot } from "../sessionLiquidity";
import type { Viewport } from "../types";

interface Palette {
  accent: string;
  up: string;
  down: string;
  muted: string;
}

export function drawSessionLiquidity(
  ctx: CanvasRenderingContext2D,
  snapshot: SessionLiquiditySnapshot,
  viewport: Viewport,
  palette: Palette
) {
  const { plot } = viewport;
  const sessionLeft = Math.max(plot.left, viewport.timeToX(snapshot.dayStart));
  ctx.save();
  ctx.beginPath();
  ctx.rect(plot.left, plot.top, plot.width, plot.height);
  ctx.clip();

  if (snapshot.upperBand !== undefined && snapshot.lowerBand !== undefined) {
    const upper = viewport.priceToY(snapshot.upperBand);
    const lower = viewport.priceToY(snapshot.lowerBand);
    ctx.globalAlpha = 0.055;
    ctx.fillStyle = palette.accent;
    ctx.fillRect(sessionLeft, Math.min(upper, lower), plot.right - sessionLeft, Math.abs(lower - upper));
  }

  drawLevel(ctx, viewport, snapshot.previousDayHigh, plot.left, palette.down, "PDH", [7, 4], 0.72);
  drawLevel(ctx, viewport, snapshot.previousDayLow, plot.left, palette.up, "PDL", [7, 4], 0.72);
  drawLevel(ctx, viewport, snapshot.high, sessionLeft, palette.down, "H", [2, 4], 0.36);
  drawLevel(ctx, viewport, snapshot.low, sessionLeft, palette.up, "L", [2, 4], 0.36);
  drawLevel(ctx, viewport, snapshot.open, sessionLeft, palette.muted, "O", [3, 3], 0.42);
  drawLevel(ctx, viewport, snapshot.vwap, sessionLeft, palette.accent, "VWAP", [], 0.86);
  drawLevel(ctx, viewport, snapshot.upperBand, sessionLeft, palette.accent, "+1σ", [2, 3], 0.38);
  drawLevel(ctx, viewport, snapshot.lowerBand, sessionLeft, palette.accent, "−1σ", [2, 3], 0.38);

  for (const sweep of snapshot.sweeps) {
    const x = viewport.timeToX(sweep.time);
    if (x < plot.left || x > plot.right) continue;
    const y = viewport.priceToY(sweep.price);
    const direction = sweep.side === "high" ? 1 : -1;
    const color = sweep.side === "high" ? palette.down : palette.up;
    ctx.globalAlpha = 0.92;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x - 5, y + direction * 8);
    ctx.lineTo(x + 5, y + direction * 8);
    ctx.closePath();
    ctx.fill();
    ctx.font = "600 9px ui-monospace, SFMono-Regular, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = sweep.side === "high" ? "top" : "bottom";
    ctx.fillText(sweep.side === "high" ? "PDH SWEEP" : "PDL SWEEP", x, y + direction * 11);
  }
  ctx.restore();
}

function drawLevel(
  ctx: CanvasRenderingContext2D,
  viewport: Viewport,
  price: number | undefined,
  left: number,
  color: string,
  label: string,
  dash: number[],
  alpha: number
) {
  if (price === undefined) return;
  const { plot } = viewport;
  const y = viewport.priceToY(price);
  if (y < plot.top || y > plot.bottom) return;
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.setLineDash(dash);
  ctx.beginPath();
  ctx.moveTo(left, Math.round(y) + 0.5);
  ctx.lineTo(plot.right, Math.round(y) + 0.5);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = color;
  ctx.font = "600 9px ui-monospace, SFMono-Regular, monospace";
  ctx.textAlign = "left";
  ctx.textBaseline = "bottom";
  ctx.fillText(label, Math.min(plot.right - 56, left + 5), y - 2);
}
