import type { ChartShapes, Viewport } from "../types";

/**
 * Strategy drawing overlays: boxes (session/killzone shading), vertical event
 * lines, and horizontal levels (support/resistance rays). Data comes from the
 * strategy preview (`previewStrategy(...).shapes`); shapes with non-finite box
 * edges shade the full pane height (bgcolor-style backgrounds).
 *
 * Drawn beneath strategy plot lines and trade overlays so shading never hides
 * price action or signals.
 */
export function drawShapes(ctx: CanvasRenderingContext2D, viewport: Viewport, shapes: ChartShapes) {
  const { plot } = viewport;
  ctx.save();
  ctx.beginPath();
  ctx.rect(plot.left, plot.top, plot.right - plot.left, plot.bottom - plot.top);
  ctx.clip();

  for (const box of shapes.boxes) {
    const x1 = viewport.timeToX(box.t1);
    const x2 = viewport.timeToX(box.t2);
    if (Math.max(x1, x2) < plot.left || Math.min(x1, x2) > plot.right) continue;
    const yTop = Number.isFinite(box.top) ? viewport.priceToY(box.top) : plot.top;
    const yBottom = Number.isFinite(box.bottom) ? viewport.priceToY(box.bottom) : plot.bottom;
    const x = Math.min(x1, x2);
    const w = Math.max(2, Math.abs(x2 - x1));
    const y = Math.min(yTop, yBottom);
    const h = Math.max(1, Math.abs(yBottom - yTop));
    ctx.fillStyle = withAlpha(box.color, 0.14);
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = withAlpha(box.color, 0.55);
    ctx.lineWidth = 1;
    ctx.strokeRect(x, y, w, h);
    if (box.label && w > 34) {
      ctx.fillStyle = withAlpha(box.color, 0.9);
      ctx.font = "10px system-ui, sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillText(box.label, x + 4, y + 3);
    }
  }

  for (const vline of shapes.vlines) {
    const x = viewport.timeToX(vline.time);
    if (x < plot.left || x > plot.right) continue;
    ctx.strokeStyle = withAlpha(vline.color, 0.7);
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(x, plot.top);
    ctx.lineTo(x, plot.bottom);
    ctx.stroke();
    ctx.setLineDash([]);
    if (vline.label) {
      ctx.fillStyle = withAlpha(vline.color, 0.9);
      ctx.font = "10px system-ui, sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillText(vline.label, x + 3, plot.top + 3);
    }
  }

  for (const ray of shapes.rays) {
    const x1 = Math.max(plot.left, viewport.timeToX(ray.time));
    const y = viewport.priceToY(ray.price);
    if (y < plot.top || y > plot.bottom || x1 > plot.right) continue;
    ctx.strokeStyle = withAlpha(ray.color, 0.8);
    ctx.lineWidth = 1.2;
    ctx.setLineDash([6, 3]);
    ctx.beginPath();
    ctx.moveTo(x1, y);
    ctx.lineTo(plot.right, y);
    ctx.stroke();
    ctx.setLineDash([]);
    if (ray.label) {
      ctx.fillStyle = withAlpha(ray.color, 0.95);
      ctx.font = "10px system-ui, sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "bottom";
      ctx.fillText(ray.label, x1 + 3, y - 2);
    }
  }

  ctx.restore();
}

/** Apply an alpha to a #RRGGBB hex (falls back to the raw color for other formats). */
function withAlpha(color: string, alpha: number): string {
  const match = /^#([0-9a-fA-F]{6})$/.exec(color);
  if (!match) return color;
  const n = Number.parseInt(match[1], 16);
  const r = (n >> 16) & 0xff;
  const g = (n >> 8) & 0xff;
  const b = n & 0xff;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
