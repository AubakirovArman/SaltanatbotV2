import type { ChartTheme, ChartTrade, Viewport } from "../types";

const REASON_LABEL: Record<ChartTrade["reason"], string> = {
  target: "TP",
  stop: "SL",
  signal: "EXIT",
  close: "END",
  liquidation: "LIQ"
};

/**
 * Draws executed trades on the price pane: a direction arrow at the entry, a
 * labelled tag at the exit (TP / SL / EXIT / END) and a dashed connector tinted
 * by the trade's outcome (green profit, red loss).
 */
export function drawTradeOverlay(
  ctx: CanvasRenderingContext2D,
  viewport: Viewport,
  trades: ChartTrade[],
  theme: ChartTheme,
  decimals: number
) {
  const { plot } = viewport;
  ctx.save();
  ctx.font = `600 9px ${MONO}`;

  for (const trade of trades) {
    const x1 = viewport.timeToX(trade.entryTime);
    const x2 = viewport.timeToX(trade.exitTime);
    if (Math.max(x1, x2) < plot.left - 20 || Math.min(x1, x2) > plot.right + 20) continue;
    const y1 = viewport.priceToY(trade.entryPrice);
    const y2 = viewport.priceToY(trade.exitPrice);
    const win = trade.pnl >= 0;
    const outcome = win ? theme.up : theme.down;

    // Connector between entry and exit, tinted by outcome.
    ctx.strokeStyle = outcome;
    ctx.globalAlpha = 0.45;
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;

    entryArrow(ctx, x1, y1, trade.direction, theme);
    exitTag(ctx, x2, y2, trade, theme, decimals, plot.left, plot.right);
  }
  ctx.restore();
  ctx.textAlign = "left";
}

const MONO = '"SF Mono", SFMono-Regular, ui-monospace, Menlo, Consolas, monospace';

function entryArrow(ctx: CanvasRenderingContext2D, x: number, y: number, dir: ChartTrade["direction"], theme: ChartTheme) {
  const long = dir === "long";
  const color = long ? theme.up : theme.down;
  const size = 6;
  const baseY = long ? y + 11 : y - 11;
  ctx.fillStyle = color;
  ctx.beginPath();
  if (long) {
    ctx.moveTo(x, baseY - size);
    ctx.lineTo(x - size, baseY + size);
    ctx.lineTo(x + size, baseY + size);
  } else {
    ctx.moveTo(x, baseY + size);
    ctx.lineTo(x - size, baseY - size);
    ctx.lineTo(x + size, baseY - size);
  }
  ctx.closePath();
  ctx.fill();
  // Direction letter inside a soft badge above the arrow.
  ctx.fillStyle = theme.text;
  ctx.textAlign = "center";
  ctx.textBaseline = long ? "top" : "bottom";
  ctx.fillText(long ? "L" : "S", x, long ? baseY + size + 2 : baseY - size - 2);
}

function exitTag(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  trade: ChartTrade,
  theme: ChartTheme,
  decimals: number,
  left: number,
  right: number
) {
  const color =
    trade.reason === "target" ? theme.up : trade.reason === "stop" ? theme.down : theme.accent;
  // Exit dot.
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, 3, 0, Math.PI * 2);
  ctx.fill();

  const label = `${REASON_LABEL[trade.reason]} ${trade.exitPrice.toFixed(decimals)}`;
  ctx.font = `600 9px ${MONO}`;
  const paddingX = 4;
  const width = ctx.measureText(label).width + paddingX * 2;
  const above = trade.direction === "long";
  const boxY = above ? y - 18 : y + 6;
  // Keep the tag fully inside the plot so labels aren't clipped at the edges.
  const boxX = Math.max(left, Math.min(x - width / 2, right - width));
  ctx.fillStyle = color;
  ctx.fillRect(boxX, boxY, width, 13);
  ctx.fillStyle = "#08121b";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(label, boxX + width / 2, boxY + 7);
}
