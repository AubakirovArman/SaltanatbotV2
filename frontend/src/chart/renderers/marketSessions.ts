import type { MarketSessionId, MarketSessionRange } from "../marketSessions";
import type { Viewport } from "../types";

const COLORS: Record<MarketSessionId, string> = {
  asia: "#8b5cf6",
  london: "#14b8a6",
  "new-york": "#f59e0b"
};
const LABELS: Record<MarketSessionId, string> = { asia: "ASIA", london: "LONDON", "new-york": "NEW YORK" };

export function drawMarketSessions(ctx: CanvasRenderingContext2D, viewport: Viewport, sessions: MarketSessionRange[]) {
  const { plot } = viewport;
  ctx.save();
  ctx.beginPath();
  ctx.rect(plot.left, plot.top, plot.width, plot.height);
  ctx.clip();
  for (const session of sessions) {
    const rawLeft = viewport.timeToX(session.startTime) - viewport.barSpacing / 2;
    const rawRight = viewport.timeToX(session.endTime) + viewport.barSpacing / 2;
    if (rawRight < plot.left || rawLeft > plot.right) continue;
    const left = Math.max(plot.left, rawLeft);
    const right = Math.min(plot.right, rawRight);
    const top = viewport.priceToY(session.high);
    const bottom = viewport.priceToY(session.low);
    const color = COLORS[session.id];
    ctx.fillStyle = color;
    ctx.globalAlpha = session.active ? 0.035 : 0.018;
    ctx.fillRect(left, top, Math.max(1, right - left), Math.max(1, bottom - top));
    ctx.strokeStyle = color;
    ctx.lineWidth = session.active ? 1.4 : 1;
    ctx.globalAlpha = session.active ? 0.55 : 0.28;
    ctx.setLineDash(session.active ? [] : [3, 4]);
    ctx.strokeRect(left + 0.5, top + 0.5, Math.max(0, right - left - 1), Math.max(0, bottom - top - 1));
    if (right - left >= 44) {
      ctx.setLineDash([]);
      ctx.globalAlpha = 0.72;
      ctx.fillStyle = color;
      ctx.font = "600 9px ui-monospace, SFMono-Regular, monospace";
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillText(LABELS[session.id], left + 4, Math.max(plot.top + 70, top + 3));
    }
  }
  ctx.restore();
}
