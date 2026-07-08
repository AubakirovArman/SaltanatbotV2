import type { RenderContext } from "../types";

export function drawBars({ ctx, candles, plot, scale, step, theme }: RenderContext) {
  const tick = Math.max(3, Math.min(7, step * 0.42));

  candles.forEach((candle, index) => {
    const x = plot.left + index * step + step / 2;
    const open = scale.y(candle.open);
    const close = scale.y(candle.close);
    const high = scale.y(candle.high);
    const low = scale.y(candle.low);
    ctx.strokeStyle = candle.close >= candle.open ? theme.up : theme.down;
    ctx.beginPath();
    ctx.moveTo(x, high);
    ctx.lineTo(x, low);
    ctx.moveTo(x - tick, open);
    ctx.lineTo(x, open);
    ctx.moveTo(x, close);
    ctx.lineTo(x + tick, close);
    ctx.stroke();
  });
}
