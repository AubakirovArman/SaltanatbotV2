import type { RenderContext } from "../types";

export function drawLineArea(
  { ctx, candles, plot, scale, step, theme }: RenderContext,
  fill: boolean
) {
  if (candles.length < 2) return;
  const path = new Path2D();

  candles.forEach((candle, index) => {
    const x = plot.left + index * step + step / 2;
    const y = scale.y(candle.close);
    if (index === 0) path.moveTo(x, y);
    else path.lineTo(x, y);
  });

  if (fill) {
    const area = new Path2D(path);
    const lastX = plot.left + (candles.length - 1) * step + step / 2;
    area.lineTo(lastX, plot.bottom);
    area.lineTo(plot.left + step / 2, plot.bottom);
    area.closePath();
    ctx.fillStyle = theme.areaFill;
    ctx.fill(area);
  }

  ctx.strokeStyle = theme.accent;
  ctx.lineWidth = 2;
  ctx.stroke(path);
  ctx.lineWidth = 1;
}
