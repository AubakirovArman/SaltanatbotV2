import type { DrawingObject, PixelPoint } from "../drawings";
import { formatMeasurementDuration, measureAnchors, signed } from "../measurement";
import type { Viewport } from "../types";

export function drawMeasurement(ctx: CanvasRenderingContext2D, viewport: Viewport, points: PixelPoint[], drawing: DrawingObject, decimals: number) {
  const [start, end] = points;
  const metrics = measureAnchors(drawing.points[0], drawing.points[1], viewport);
  const positive = metrics.priceDelta >= 0;
  const color = positive ? "rgba(35,201,122,0.94)" : "rgba(239,83,80,0.94)";
  const fill = positive ? "rgba(35,201,122,0.08)" : "rgba(239,83,80,0.08)";
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  const width = Math.abs(end.x - start.x);
  const height = Math.abs(end.y - start.y);

  ctx.save();
  ctx.fillStyle = fill;
  ctx.fillRect(x, y, width, height);
  ctx.strokeStyle = color;
  ctx.setLineDash([5, 4]);
  ctx.strokeRect(x, y, width, height);
  ctx.beginPath();
  ctx.moveTo(start.x, start.y);
  ctx.lineTo(end.x, end.y);
  ctx.stroke();

  const primary = `${signed(metrics.priceDelta, decimals)} (${signed(metrics.percentDelta, 2)}%)`;
  const secondary = `${metrics.bars} bars · ${formatMeasurementDuration(metrics.durationMs)}`;
  ctx.setLineDash([]);
  ctx.font = "600 11px Inter, system-ui, sans-serif";
  const badgeWidth = Math.max(ctx.measureText(primary).width, ctx.measureText(secondary).width) + 16;
  const badgeHeight = 34;
  const badgeX = clamp(end.x + 10, viewport.plot.left + 4, viewport.plot.right - badgeWidth - 4);
  const badgeY = clamp(end.y - badgeHeight - 10, viewport.plot.top + 4, viewport.plot.bottom - badgeHeight - 4);
  ctx.fillStyle = color;
  ctx.fillRect(badgeX, badgeY, badgeWidth, badgeHeight);
  ctx.fillStyle = "#07110e";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(primary, badgeX + 8, badgeY + 10);
  ctx.font = "500 10px Inter, system-ui, sans-serif";
  ctx.fillText(secondary, badgeX + 8, badgeY + 24);
  ctx.restore();
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}
