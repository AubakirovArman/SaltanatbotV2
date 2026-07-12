import type { FootprintInsights } from "../footprintInsights";
import type { Viewport } from "../types";

/** Paints analysis annotations only; the semantic summary remains in React DOM. */
export function drawFootprintInsights(
  ctx: CanvasRenderingContext2D,
  insights: FootprintInsights,
  viewport: Viewport,
  cellWidth: number,
  up: string,
  down: string,
  accent: string,
  panel: string,
  dimmed: number
) {
  const half = cellWidth / 2;
  ctx.save();
  ctx.lineWidth = 1;
  for (const imbalance of insights.imbalances) {
    ctx.globalAlpha = 0.9 * dimmed;
    ctx.strokeStyle = imbalance.side === "buy" ? up : down;
    ctx.strokeRect(imbalance.side === "buy" ? imbalance.x : imbalance.x - half, imbalance.y - 4, half, 8);
  }

  for (const stack of insights.stacks) {
    const first = stack.cells[0];
    const last = stack.cells.at(-1)!;
    const preferredDirection = stack.side === "buy" ? 1 : -1;
    const preferredX = first.x + preferredDirection * (half + 7);
    const direction = preferredX < viewport.plot.left + 16 || preferredX > viewport.plot.right - 16
      ? -preferredDirection
      : preferredDirection;
    const rawX = first.x + direction * (half + 7);
    const x = Math.max(viewport.plot.left + 4, Math.min(viewport.plot.right - 4, rawX));
    const top = Math.min(first.y, last.y) - 4;
    const bottom = Math.max(first.y, last.y) + 4;
    ctx.globalAlpha = 0.95 * dimmed;
    ctx.strokeStyle = stack.side === "buy" ? up : down;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x - direction * 3, top);
    ctx.lineTo(x, top);
    ctx.lineTo(x, bottom);
    ctx.lineTo(x - direction * 3, bottom);
    ctx.stroke();
    ctx.fillStyle = stack.side === "buy" ? up : down;
    ctx.font = "bold 8px ui-monospace, monospace";
    ctx.textBaseline = "middle";
    ctx.textAlign = direction > 0 ? "left" : "right";
    ctx.fillText(`${stack.cells.length}×`, x + direction * 2, (top + bottom) / 2);
  }

  for (const absorption of insights.absorptions) {
    const y = viewport.priceToY(absorption.price);
    if (y < viewport.plot.top + 6 || y > viewport.plot.bottom - 6) continue;
    const color = absorption.absorbedSide === "buy" ? down : up;
    const placeLeft = absorption.x > (viewport.plot.left + viewport.plot.right) / 2;
    const markerX = Math.max(viewport.plot.left + 28, Math.min(viewport.plot.right - 28, absorption.x + (placeLeft ? -(half + 14) : half + 14)));
    ctx.globalAlpha = 0.96 * dimmed;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 2]);
    ctx.beginPath();
    ctx.moveTo(absorption.x, y);
    ctx.lineTo(markerX, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(markerX, y - 5);
    ctx.lineTo(markerX + 5, y);
    ctx.lineTo(markerX, y + 5);
    ctx.lineTo(markerX - 5, y);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.font = "bold 8px ui-monospace, monospace";
    ctx.textBaseline = "middle";
    ctx.textAlign = placeLeft ? "right" : "left";
    const label = "ABS?";
    const labelX = markerX + (placeLeft ? -8 : 8);
    const labelWidth = ctx.measureText(label).width + 6;
    const labelLeft = placeLeft ? labelX - labelWidth : labelX;
    ctx.globalAlpha = 0.9 * dimmed;
    ctx.fillStyle = panel;
    ctx.fillRect(labelLeft, y - 6, labelWidth, 12);
    ctx.strokeStyle = color;
    ctx.strokeRect(labelLeft, y - 6, labelWidth, 12);
    ctx.fillStyle = color;
    ctx.fillText(label, labelX + (placeLeft ? -3 : 3), y);
  }
  ctx.restore();
}
