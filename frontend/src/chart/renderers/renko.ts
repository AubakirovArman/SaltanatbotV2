import type { Candle } from "../../types";
import type { RenderContext } from "../types";

interface Brick {
  open: number;
  close: number;
  direction: 1 | -1;
}

export function buildRenko(candles: Candle[]) {
  if (candles.length === 0) return [];
  const ranges = candles.map((candle) => Math.abs(candle.high - candle.low));
  const avgRange = ranges.reduce((sum, value) => sum + value, 0) / ranges.length;
  const brickSize = Math.max(avgRange * 1.6, candles.at(-1)!.close * 0.001);
  const bricks: Brick[] = [];
  let anchor = candles[0].close;

  candles.forEach((candle) => {
    let delta = candle.close - anchor;
    while (Math.abs(delta) >= brickSize) {
      const direction: 1 | -1 = delta > 0 ? 1 : -1;
      const open = anchor;
      const close = anchor + brickSize * direction;
      bricks.push({ open, close, direction });
      anchor = close;
      delta = candle.close - anchor;
    }
  });

  return bricks.slice(-180);
}

export function drawRenko({ ctx, plot, scale, theme }: RenderContext, bricks: Brick[]) {
  if (bricks.length === 0) return;
  const step = plot.width / Math.max(bricks.length, 24);
  const width = Math.max(4, step * 0.78);

  bricks.forEach((brick, index) => {
    const x = plot.left + index * step + step / 2 - width / 2;
    const y1 = scale.y(brick.open);
    const y2 = scale.y(brick.close);
    const y = Math.min(y1, y2);
    const height = Math.max(3, Math.abs(y1 - y2));
    ctx.fillStyle = brick.direction > 0 ? "rgba(35, 201, 122, 0.24)" : "rgba(239, 83, 80, 0.26)";
    ctx.strokeStyle = brick.direction > 0 ? theme.up : theme.down;
    ctx.fillRect(x, y, width, height);
    ctx.strokeRect(x, y, width, height);
  });
}
