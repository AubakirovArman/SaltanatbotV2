import type { PointAndFigureColumn } from "../pointAndFigure";
import type { RenderContext } from "../types";

export function drawPointAndFigure({ ctx, candles, plot, scale, step, theme }: RenderContext) {
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineWidth = Math.max(1.25, Math.min(2.25, step * 0.08));
  (candles as PointAndFigureColumn[]).forEach((column, index) => {
    const x = plot.left + index * step + step / 2;
    const color = column.direction === "x" ? theme.up : theme.down;
    ctx.strokeStyle = color;
    ctx.beginPath();
    for (let box = 1; box <= column.boxes; box += 1) {
      const price = column.open + (column.direction === "x" ? box : -box) * column.boxSize;
      const y = scale.y(price);
      const adjacentY = scale.y(price + column.boxSize);
      const radius = Math.max(1.75, Math.min(8, step * 0.28, Math.abs(adjacentY - y) * 0.38));
      if (column.direction === "x") {
        ctx.moveTo(x - radius, y - radius);
        ctx.lineTo(x + radius, y + radius);
        ctx.moveTo(x + radius, y - radius);
        ctx.lineTo(x - radius, y + radius);
      } else {
        ctx.moveTo(x + radius, y);
        ctx.arc(x, y, radius, 0, Math.PI * 2);
      }
    }
    ctx.stroke();
  });
  ctx.restore();
}
