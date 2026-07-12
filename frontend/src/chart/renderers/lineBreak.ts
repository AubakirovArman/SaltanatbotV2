import type { RenderContext } from "../types";

export function drawLineBreak({ ctx, candles, plot, scale, step, theme }: RenderContext) {
  const width = Math.max(4, Math.min(16, Math.floor(step * 0.78)));
  ctx.lineWidth = 1;

  candles.forEach((line, index) => {
    const open = scale.y(line.open);
    const close = scale.y(line.close);
    const top = Math.min(open, close);
    const height = Math.max(2, Math.abs(open - close));
    const left = Math.round(plot.left + index * step + (step - width) / 2) + 0.5;
    const color = line.close >= line.open ? theme.up : theme.down;
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.72;
    ctx.fillRect(left, Math.round(top) + 0.5, width, Math.max(2, Math.round(height)));
    ctx.globalAlpha = 1;
    ctx.strokeStyle = color;
    ctx.strokeRect(left, Math.round(top) + 0.5, width, Math.max(2, Math.round(height)));
  });
}
