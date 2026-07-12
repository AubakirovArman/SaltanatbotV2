import type { AnchoredVwapPoint } from "../anchoredVwap";
import type { DrawingObject } from "../drawings";
import type { Viewport } from "../types";

export function drawAnchoredVwap(
  ctx: CanvasRenderingContext2D,
  viewport: Viewport,
  drawing: DrawingObject,
  points: AnchoredVwapPoint[],
  decimals: number,
  emphasized = false
) {
  const anchor = drawing.points[0];
  if (!anchor) return;
  const visible = points.filter((point) => {
    const x = viewport.timeToX(point.time);
    return x >= viewport.plot.left - viewport.barSpacing && x <= viewport.plot.right + viewport.barSpacing;
  });
  const anchorX = viewport.timeToX(anchor.time);
  const levels = drawing.style.levels?.filter((level) => Number.isFinite(level) && level > 0) ?? [1, 2];

  ctx.save();
  ctx.beginPath();
  ctx.rect(viewport.plot.left, viewport.plot.top, viewport.plot.width, viewport.plot.height);
  ctx.clip();
  if (anchorX >= viewport.plot.left && anchorX <= viewport.plot.right) {
    ctx.globalAlpha = 0.32;
    ctx.strokeStyle = drawing.style.color;
    ctx.setLineDash([2, 4]);
    ctx.beginPath();
    ctx.moveTo(anchorX, viewport.plot.top);
    ctx.lineTo(anchorX, viewport.plot.bottom);
    ctx.stroke();
  }
  if (visible.length === 0) {
    ctx.restore();
    return;
  }

  drawBandFill(ctx, viewport, visible, drawing.style.color);
  ctx.lineWidth = drawing.style.width * (emphasized ? 1.6 : 1);
  ctx.strokeStyle = drawing.style.color;
  ctx.setLineDash(drawing.style.dashed ? [5, 4] : []);
  ctx.globalAlpha = 0.96;
  drawSeries(ctx, viewport, visible, (point) => point.vwap);
  for (const level of levels) {
    ctx.globalAlpha = level === 1 ? 0.48 : 0.25;
    ctx.setLineDash(level === 1 ? [4, 3] : [2, 4]);
    drawSeries(ctx, viewport, visible, (point) => point.vwap + point.deviation * level);
    drawSeries(ctx, viewport, visible, (point) => point.vwap - point.deviation * level);
  }

  const latest = visible.at(-1)!;
  const x = Math.min(viewport.plot.right - 74, viewport.timeToX(latest.time) + 6);
  const y = viewport.priceToY(latest.vwap);
  ctx.globalAlpha = 0.96;
  ctx.setLineDash([]);
  ctx.fillStyle = drawing.style.color;
  ctx.font = "600 9px ui-monospace, SFMono-Regular, monospace";
  ctx.textAlign = "left";
  ctx.textBaseline = "bottom";
  ctx.fillText(`AVWAP ${latest.vwap.toFixed(decimals)}`, x, y - 3);
  ctx.restore();
}

function drawBandFill(ctx: CanvasRenderingContext2D, viewport: Viewport, points: AnchoredVwapPoint[], color: string) {
  ctx.globalAlpha = 0.055;
  ctx.fillStyle = color;
  ctx.beginPath();
  points.forEach((point, index) => {
    const x = viewport.timeToX(point.time);
    const y = viewport.priceToY(point.vwap + point.deviation);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const point = points[index];
    ctx.lineTo(viewport.timeToX(point.time), viewport.priceToY(point.vwap - point.deviation));
  }
  ctx.closePath();
  ctx.fill();
}

function drawSeries(ctx: CanvasRenderingContext2D, viewport: Viewport, points: AnchoredVwapPoint[], value: (point: AnchoredVwapPoint) => number) {
  ctx.beginPath();
  points.forEach((point, index) => {
    const x = viewport.timeToX(point.time);
    const y = viewport.priceToY(value(point));
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}
