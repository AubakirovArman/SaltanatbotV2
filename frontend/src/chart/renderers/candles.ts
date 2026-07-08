import type { RenderContext } from "../types";

export function drawCandles({ ctx, candles, plot, scale, step, theme }: RenderContext) {
  const bodyWidth = Math.max(2, Math.min(12, step * 0.64));

  candles.forEach((candle, index) => {
    const x = plot.left + index * step + step / 2;
    const open = scale.y(candle.open);
    const close = scale.y(candle.close);
    const high = scale.y(candle.high);
    const low = scale.y(candle.low);
    const up = candle.close >= candle.open;
    const color = up ? theme.up : theme.down;
    const top = Math.min(open, close);
    const height = Math.max(1, Math.abs(open - close));

    ctx.strokeStyle = color;
    ctx.fillStyle = up ? "rgba(35, 201, 122, 0.16)" : "rgba(239, 83, 80, 0.2)";
    ctx.beginPath();
    ctx.moveTo(x, high);
    ctx.lineTo(x, low);
    ctx.stroke();
    ctx.fillRect(x - bodyWidth / 2, top, bodyWidth, height);
    ctx.strokeRect(x - bodyWidth / 2, top, bodyWidth, height);
  });
}
