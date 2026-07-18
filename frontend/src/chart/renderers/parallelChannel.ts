import { channelWidth } from "../geometry";
import type { DrawingObject } from "../drawings";
import type { Viewport } from "../types";

/**
 * Parallel channel: the base line through anchors a and b plus the same line translated by the
 * signed price offset of the third (width) anchor, with a translucent fill and a Δ-width label.
 * With only two anchors (draft placement) just the base line is drawn.
 */
export function drawParallelChannel(
  ctx: CanvasRenderingContext2D,
  viewport: Viewport,
  drawing: DrawingObject,
  decimals: number
) {
  const [a, b, w] = drawing.points;
  if (!a || !b) return;
  const ax = viewport.timeToX(a.time);
  const ay = viewport.priceToY(a.price);
  const bx = viewport.timeToX(b.time);
  const by = viewport.priceToY(b.price);

  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.lineTo(bx, by);
  ctx.stroke();

  if (!w) return;
  const width = channelWidth(a, b, w);
  if (!Number.isFinite(width) || width === 0) return;
  const ay2 = viewport.priceToY(a.price + width);
  const by2 = viewport.priceToY(b.price + width);

  ctx.save();
  if (drawing.style.fill) {
    ctx.fillStyle = drawing.style.fill;
  } else {
    ctx.globalAlpha = 0.12;
  }
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.lineTo(bx, by);
  ctx.lineTo(bx, by2);
  ctx.lineTo(ax, ay2);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  ctx.beginPath();
  ctx.moveTo(ax, ay2);
  ctx.lineTo(bx, by2);
  ctx.stroke();

  // Measurable width label near the channel midpoint.
  ctx.save();
  ctx.setLineDash([]);
  ctx.font = "600 11px Inter, system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(`Δ ${formatChannelWidth(Math.abs(width), decimals)}`, (ax + bx) / 2, (ay + by + ay2 + by2) / 4);
  ctx.restore();
}

function formatChannelWidth(width: number, decimals: number): string {
  const digits = Math.min(8, Math.max(2, Math.trunc(decimals) || 2));
  return width.toFixed(digits).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}
