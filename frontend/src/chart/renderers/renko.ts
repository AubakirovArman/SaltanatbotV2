import type { RenderContext } from "../types";

export function drawRenko({ ctx, candles, plot, scale, step, theme }: RenderContext) {
  const width = Math.max(4, Math.min(16, Math.floor(step * 0.78)));
  candles.forEach((brick, index) => {
    const x = Math.round(plot.left + index * step + step / 2) + 0.5;
    const open = scale.y(brick.open);
    const close = scale.y(brick.close);
    const high = scale.y(brick.high);
    const low = scale.y(brick.low);
    const up = brick.close >= brick.open;
    const color = up ? theme.up : theme.down;
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.moveTo(x, high);
    ctx.lineTo(x, low);
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.3;
    ctx.fillRect(Math.round(x - width / 2) + 0.5, Math.round(Math.min(open, close)) + 0.5, width, Math.max(3, Math.round(Math.abs(open - close))));
    ctx.globalAlpha = 1;
    ctx.strokeRect(Math.round(x - width / 2) + 0.5, Math.round(Math.min(open, close)) + 0.5, width, Math.max(3, Math.round(Math.abs(open - close))));
  });
}
