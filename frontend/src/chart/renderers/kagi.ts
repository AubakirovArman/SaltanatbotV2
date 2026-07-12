import type { RenderContext } from "../types";

/** Paint alternating vertical Kagi legs joined by shoulder/waist turns. */
export function drawKagi({ ctx, candles, plot, scale, step, theme }: RenderContext) {
  if (candles.length === 0) return;
  const lineWidth = Math.max(2, Math.min(4, step * 0.18));
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = lineWidth;

  candles.forEach((leg, index) => {
    const x = Math.round(plot.left + index * step + step / 2) + 0.5;
    const open = scale.y(leg.open);
    const close = scale.y(leg.close);
    const color = leg.close >= leg.open ? theme.up : theme.down;
    ctx.strokeStyle = color;
    ctx.beginPath();
    if (index > 0) {
      const previousX = Math.round(plot.left + (index - 1) * step + step / 2) + 0.5;
      ctx.moveTo(previousX, open);
      ctx.lineTo(x, open);
    } else {
      ctx.moveTo(x, open);
    }
    ctx.lineTo(x, close);
    ctx.stroke();

    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, close, Math.max(2, lineWidth * 0.8), 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.restore();
}
