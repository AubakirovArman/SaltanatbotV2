import type { ChartShapes, Viewport } from "../types";

/**
 * Strategy drawing overlays: boxes (session/killzone shading), vertical event
 * lines, and horizontal levels (support/resistance rays). Data comes from the
 * strategy preview (`previewStrategy(...).shapes`); shapes with non-finite box
 * edges shade the full pane height (bgcolor-style backgrounds).
 *
 * Alpha is applied via ctx.globalAlpha so every CSS color format (6/8-digit hex,
 * named colors, rgb()) dims correctly — string munging would silently ignore
 * the intended transparency for anything but #RRGGBB.
 */
export function drawShapes(ctx: CanvasRenderingContext2D, viewport: Viewport, shapes: ChartShapes) {
  const { plot } = viewport;
  const half = viewport.barSpacing / 2;
  ctx.save();
  ctx.beginPath();
  ctx.rect(plot.left, plot.top, plot.right - plot.left, plot.bottom - plot.top);
  ctx.clip();

  for (const box of shapes.boxes) {
    // Pad by half a bar each side so a single-bar run covers its bar at any zoom.
    const x1 = viewport.timeToX(box.t1) - half;
    const x2 = viewport.timeToX(box.t2) + half;
    if (Math.max(x1, x2) < plot.left || Math.min(x1, x2) > plot.right) continue;
    const yTop = Number.isFinite(box.top) ? viewport.priceToY(box.top) : plot.top;
    const yBottom = Number.isFinite(box.bottom) ? viewport.priceToY(box.bottom) : plot.bottom;
    const x = Math.min(x1, x2);
    const w = Math.abs(x2 - x1);
    const y = Math.min(yTop, yBottom);
    const h = Math.max(1, Math.abs(yBottom - yTop));
    ctx.fillStyle = box.color;
    ctx.globalAlpha = 0.14;
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = box.color;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.55;
    ctx.strokeRect(x, y, w, h);
    ctx.globalAlpha = 1;
    if (box.label && w > 34) {
      ctx.fillStyle = box.color;
      ctx.globalAlpha = 0.9;
      ctx.font = "10px system-ui, sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillText(box.label, x + 4, y + 3);
      ctx.globalAlpha = 1;
    }
  }

  // Stagger consecutive vline labels across three rows so nearby lines stay legible.
  let vlineLabelRow = 0;
  for (const vline of shapes.vlines) {
    const x = viewport.timeToX(vline.time);
    if (x < plot.left || x > plot.right) continue;
    ctx.strokeStyle = vline.color;
    ctx.globalAlpha = 0.7;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(x, plot.top);
    ctx.lineTo(x, plot.bottom);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    if (vline.label) {
      ctx.fillStyle = vline.color;
      ctx.globalAlpha = 0.9;
      ctx.font = "10px system-ui, sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillText(vline.label, x + 3, plot.top + 3 + (vlineLabelRow % 3) * 12);
      ctx.globalAlpha = 1;
      vlineLabelRow += 1;
    }
  }

  for (const ray of shapes.rays) {
    const x1 = Math.max(plot.left, viewport.timeToX(ray.time));
    const y = viewport.priceToY(ray.price);
    if (y < plot.top || y > plot.bottom || x1 > plot.right) continue;
    ctx.strokeStyle = ray.color;
    ctx.globalAlpha = 0.8;
    ctx.lineWidth = 1.2;
    ctx.setLineDash([6, 3]);
    ctx.beginPath();
    ctx.moveTo(x1, y);
    ctx.lineTo(plot.right, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    if (ray.label) {
      ctx.fillStyle = ray.color;
      ctx.globalAlpha = 0.95;
      ctx.font = "10px system-ui, sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "bottom";
      ctx.fillText(ray.label, x1 + 3, y - 2);
      ctx.globalAlpha = 1;
    }
  }

  ctx.restore();
}
