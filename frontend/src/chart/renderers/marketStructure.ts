import type { MarketStructureSnapshot, StructureDirection } from "../marketStructure";
import type { Viewport } from "../types";

const COLORS: Record<StructureDirection, string> = { bullish: "#23c97a", bearish: "#ef5350" };

export function drawMarketStructureBackground(ctx: CanvasRenderingContext2D, viewport: Viewport, snapshot: MarketStructureSnapshot) {
  const { plot } = viewport;
  const openEnd = snapshot.lastConfirmedTime ?? viewport.lastTime;
  ctx.save();
  ctx.beginPath();
  ctx.rect(plot.left, plot.top, plot.width, plot.height);
  ctx.clip();
  for (const gap of snapshot.fairValueGaps) {
    const rawLeft = viewport.timeToX(gap.createdTime) - viewport.barSpacing / 2;
    const rawRight = viewport.timeToX(gap.mitigatedAt ?? openEnd) + viewport.barSpacing / 2;
    if (rawRight < plot.left || rawLeft > plot.right) continue;
    const left = Math.max(plot.left, rawLeft);
    const right = Math.min(plot.right, rawRight);
    const top = viewport.priceToY(gap.top);
    const bottom = viewport.priceToY(gap.bottom);
    const open = gap.mitigatedAt === undefined;
    const color = COLORS[gap.direction];
    ctx.fillStyle = color;
    ctx.globalAlpha = open ? 0.07 : 0.018;
    ctx.fillRect(left, top, Math.max(1, right - left), Math.max(1, bottom - top));
    ctx.strokeStyle = color;
    ctx.globalAlpha = open ? 0.38 : 0.12;
    ctx.lineWidth = 1;
    ctx.setLineDash(open ? [3, 3] : [2, 5]);
    ctx.strokeRect(left + 0.5, top + 0.5, Math.max(0, right - left - 1), Math.max(0, bottom - top - 1));
    if (open && right - left > 42) {
      ctx.setLineDash([]);
      ctx.globalAlpha = 0.68;
      ctx.fillStyle = color;
      ctx.font = "600 8px ui-monospace, SFMono-Regular, monospace";
      ctx.textAlign = "left";
      ctx.textBaseline = "bottom";
      ctx.fillText("FVG", left + 4, Math.max(plot.top + 10, top - 2));
    }
  }
  ctx.restore();
}

export function drawMarketStructureOverlay(ctx: CanvasRenderingContext2D, viewport: Viewport, snapshot: MarketStructureSnapshot) {
  const { plot } = viewport;
  ctx.save();
  ctx.beginPath();
  ctx.rect(plot.left, plot.top, plot.width, plot.height);
  ctx.clip();
  for (const swing of snapshot.swings) {
    const x = viewport.timeToX(swing.time);
    const y = viewport.priceToY(swing.price);
    if (x < plot.left || x > plot.right || y < plot.top || y > plot.bottom) continue;
    const color = swing.kind === "high" ? COLORS.bearish : COLORS.bullish;
    ctx.globalAlpha = 0.66;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, 2.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = "600 8px ui-monospace, SFMono-Regular, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = swing.kind === "high" ? "bottom" : "top";
    ctx.fillText(swing.label, x, y + (swing.kind === "high" ? -4 : 4));
  }
  for (const event of snapshot.breaks) {
    const left = viewport.timeToX(event.sourceTime);
    const right = viewport.timeToX(event.time);
    if (right < plot.left || left > plot.right) continue;
    const y = viewport.priceToY(event.price);
    if (y < plot.top || y > plot.bottom) continue;
    const color = COLORS[event.direction];
    ctx.globalAlpha = event.kind === "choch" ? 0.9 : 0.68;
    ctx.strokeStyle = color;
    ctx.lineWidth = event.kind === "choch" ? 1.4 : 1;
    ctx.setLineDash(event.kind === "choch" ? [] : [5, 3]);
    ctx.beginPath();
    ctx.moveTo(Math.max(plot.left, left), Math.round(y) + 0.5);
    ctx.lineTo(Math.min(plot.right, right), Math.round(y) + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = color;
    ctx.font = "700 8px ui-monospace, SFMono-Regular, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = event.direction === "bullish" ? "bottom" : "top";
    const labelX = (Math.max(plot.left, left) + Math.min(plot.right, right)) / 2;
    ctx.fillText(`${event.kind.toUpperCase()} ${event.direction === "bullish" ? "↑" : "↓"}`, labelX, y + (event.direction === "bullish" ? -3 : 3));
  }
  ctx.restore();
}
