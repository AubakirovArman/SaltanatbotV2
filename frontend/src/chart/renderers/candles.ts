import type { RenderContext } from "../types";

export function drawCandles({ ctx, candles, plot, scale, step, theme }: RenderContext, hollow = false) {
  const bodyWidth = Math.max(3, Math.min(14, Math.floor(step * 0.7)));
  ctx.lineWidth = 1;

  candles.forEach((candle, index) => {
    const x = Math.round(plot.left + index * step + step / 2) + 0.5;
    const open = scale.y(candle.open);
    const close = scale.y(candle.close);
    const high = scale.y(candle.high);
    const low = scale.y(candle.low);
    const up = candle.close >= candle.open;
    const color = up ? theme.up : theme.down;
    const top = Math.min(open, close);
    const height = Math.max(1, Math.abs(open - close));

    ctx.strokeStyle = color;
    ctx.fillStyle = hollow && up ? theme.background : color;
    ctx.beginPath();
    ctx.moveTo(x, high);
    ctx.lineTo(x, low);
    ctx.stroke();
    const left = Math.round(x - bodyWidth / 2) + 0.5;
    const bodyTop = Math.round(top) + 0.5;
    const bodyHeight = Math.max(1, Math.round(height));
    ctx.fillRect(left, bodyTop, bodyWidth, bodyHeight);
    ctx.strokeRect(left, bodyTop, bodyWidth, bodyHeight);
  });
}
