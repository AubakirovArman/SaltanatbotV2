import type { Candle } from "../../types";
import { niceTicks } from "../scales";
import type { ChartTheme, PlotArea, PriceScale, Viewport } from "../types";

export function drawGrid(ctx: CanvasRenderingContext2D, plot: PlotArea, scale: PriceScale, decimals: number, theme: ChartTheme) {
  ctx.strokeStyle = theme.grid;
  ctx.fillStyle = theme.muted;
  ctx.font = '10px "SF Mono", SFMono-Regular, ui-monospace, Menlo, Consolas, monospace';
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  for (const price of niceTicks(scale.min, scale.max, 6, scale.mode === "log")) {
    const y = scale.y(price);
    if (y < plot.top - 1 || y > plot.bottom + 1) continue;
    ctx.beginPath();
    ctx.moveTo(plot.left, y);
    ctx.lineTo(plot.right, y);
    ctx.stroke();
    ctx.fillText(formatAxisPrice(price, scale, decimals), plot.right + 10, y);
  }
}

export function drawTimeAxis(ctx: CanvasRenderingContext2D, viewport: Viewport, theme: ChartTheme) {
  ctx.fillStyle = theme.muted;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.font = '10px "SF Mono", SFMono-Regular, ui-monospace, Menlo, Consolas, monospace';
  ctx.strokeStyle = theme.grid;
  const { plot, start, end, barTimeMs } = viewport;
  const every = Math.max(1, Math.round(Math.max(1, end - start) / 7));
  let previous: Date | undefined;
  for (let index = start; index < end; index += 1) {
    if ((index - start) % every !== 0) continue;
    const x = viewport.indexToX(index);
    const date = new Date(viewport.lastTime + (index - viewport.lastIndex) * barTimeMs);
    ctx.beginPath();
    ctx.moveTo(x, plot.top);
    ctx.lineTo(x, plot.bottom);
    ctx.strokeStyle = "rgba(134, 150, 166, 0.08)";
    ctx.stroke();
    ctx.fillStyle = theme.muted;
    ctx.fillText(formatTimeLabel(date, previous, barTimeMs), x, plot.bottom + 8);
    previous = date;
  }
  ctx.textAlign = "left";
}

export function drawLastPrice(
  ctx: CanvasRenderingContext2D,
  plot: PlotArea,
  scale: PriceScale,
  last: Candle | undefined,
  decimals: number,
  theme: ChartTheme
) {
  if (!last) return;
  const y = scale.y(last.close);
  if (y < plot.top || y > plot.bottom) return;
  const color = last.close >= last.open ? theme.up : theme.down;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.setLineDash([2, 3]);
  ctx.beginPath();
  ctx.moveTo(plot.left, y);
  ctx.lineTo(plot.right, y);
  ctx.stroke();
  ctx.setLineDash([]);
  const label = formatAxisPrice(last.close, scale, decimals);
  ctx.font = '600 10px "SF Mono", SFMono-Regular, ui-monospace, Menlo, Consolas, monospace';
  const paddingX = 6;
  ctx.fillStyle = color;
  ctx.fillRect(plot.right + 4, y - 9, ctx.measureText(label).width + paddingX * 2, 18);
  ctx.fillStyle = "#0b0d10";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(label, plot.right + 4 + paddingX, y);
  ctx.restore();
}

export function drawCrosshair(
  ctx: CanvasRenderingContext2D,
  plot: PlotArea,
  viewport: Viewport,
  crosshair: { x: number; y: number },
  decimals: number,
  theme: ChartTheme
) {
  if (crosshair.x < plot.left || crosshair.x > plot.right || crosshair.y < plot.top || crosshair.y > plot.bottom) return;
  ctx.save();
  ctx.strokeStyle = "rgba(229, 237, 244, 0.42)";
  ctx.setLineDash([4, 5]);
  ctx.beginPath();
  ctx.moveTo(plot.left, crosshair.y);
  ctx.lineTo(plot.right, crosshair.y);
  ctx.moveTo(crosshair.x, plot.top);
  ctx.lineTo(crosshair.x, plot.bottom);
  ctx.stroke();
  ctx.setLineDash([]);
  drawAxisTag(ctx, plot.right + 4, crosshair.y, formatAxisPrice(viewport.yToPrice(crosshair.y), viewport.scale, decimals), "#1c242c", theme.text);
  const time = new Date(viewport.xToTime(crosshair.x)).toLocaleString([], {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"
  });
  drawTimeTag(ctx, crosshair.x, plot.bottom + 6, time, theme.text);
  ctx.restore();
}

export function drawEmpty(ctx: CanvasRenderingContext2D, width: number, height: number, theme: ChartTheme) {
  ctx.fillStyle = theme.muted;
  ctx.font = "12px Inter, system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("Waiting for market data", width / 2, height / 2);
  ctx.textAlign = "left";
}

function formatAxisPrice(price: number, scale: PriceScale, decimals: number) {
  if (scale.mode === "percent") {
    const pct = ((price - scale.base) / scale.base) * 100;
    return `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
  }
  return price.toFixed(decimals);
}

function formatTimeLabel(date: Date, previous: Date | undefined, barTimeMs: number) {
  const newDay = !previous || previous.getDate() !== date.getDate() || previous.getMonth() !== date.getMonth();
  if (barTimeMs >= 86_400_000) {
    const newYear = !previous || previous.getFullYear() !== date.getFullYear();
    return newYear ? String(date.getFullYear()) : date.toLocaleDateString([], { month: "short", day: "numeric" });
  }
  return newDay
    ? date.toLocaleDateString([], { month: "short", day: "numeric" })
    : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function drawAxisTag(ctx: CanvasRenderingContext2D, x: number, y: number, label: string, background: string, foreground: string) {
  ctx.font = '600 10px "SF Mono", SFMono-Regular, ui-monospace, Menlo, Consolas, monospace';
  const paddingX = 6;
  const width = ctx.measureText(label).width + paddingX * 2;
  ctx.fillStyle = background;
  ctx.fillRect(x, y - 9, width, 18);
  ctx.fillStyle = foreground;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(label, x + paddingX, y);
}

function drawTimeTag(ctx: CanvasRenderingContext2D, x: number, y: number, label: string, color: string) {
  ctx.font = '600 10px "SF Mono", SFMono-Regular, ui-monospace, Menlo, Consolas, monospace';
  const width = ctx.measureText(label).width + 12;
  ctx.fillStyle = "#1c242c";
  ctx.fillRect(x - width / 2, y, width, 18);
  ctx.fillStyle = color;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillText(label, x, y + 3);
  ctx.textAlign = "left";
}
