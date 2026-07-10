import type { ChartTheme, CompareChartType, PlotArea, Viewport } from "../types";

export interface NormalizedPoint {
  time: number;
  value: number;
}

export interface NormalizedCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface CompareShapeEntry {
  chartType: CompareChartType;
  color: string;
  upColor: string;
  downColor: string;
  line: NormalizedPoint[];
  candles: NormalizedCandle[];
}

export function drawCompareShape(
  ctx: CanvasRenderingContext2D,
  viewport: Viewport,
  entry: CompareShapeEntry,
  pctToY: (pct: number) => number
) {
  if ((entry.chartType === "candles" || entry.chartType === "heikin") && entry.candles.length > 0) {
    drawCompareCandles(ctx, viewport, entry, pctToY);
    return;
  }
  if (entry.chartType === "bars" && entry.candles.length > 0) {
    drawCompareBars(ctx, viewport, entry, pctToY);
    return;
  }
  drawCompareLine(ctx, viewport, entry, pctToY, entry.chartType === "area" || entry.chartType === "baseline");
}

export function drawZeroLine(ctx: CanvasRenderingContext2D, plot: PlotArea, pctToY: (pct: number) => number, theme: ChartTheme) {
  const zeroY = pctToY(0);
  if (zeroY < plot.top || zeroY > plot.bottom) return;
  ctx.strokeStyle = theme.grid;
  ctx.setLineDash([2, 4]);
  ctx.globalAlpha = 0.7;
  ctx.beginPath();
  ctx.moveTo(plot.left, zeroY);
  ctx.lineTo(plot.right, zeroY);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.globalAlpha = 1;
}

export function drawPercentAxis(
  ctx: CanvasRenderingContext2D,
  plot: PlotArea,
  min: number,
  max: number,
  pctToY: (pct: number) => number,
  theme: ChartTheme
) {
  const ticks = percentTicks(min, max);
  ctx.font = '9px "SF Mono", SFMono-Regular, ui-monospace, Menlo, Consolas, monospace';
  ctx.textBaseline = "middle";
  ctx.textAlign = "right";
  for (const pctValue of ticks) {
    const y = pctToY(pctValue);
    if (y < plot.top - 1 || y > plot.bottom + 1) continue;
    ctx.fillStyle = theme.muted;
    ctx.globalAlpha = 0.75;
    const label = `${pctValue > 0 ? "+" : ""}${pctValue.toFixed(pctValue % 1 === 0 ? 0 : 1)}%`;
    ctx.fillText(label, plot.right - 4, y);
    ctx.globalAlpha = 1;
  }
  ctx.textAlign = "left";
}

function drawCompareLine(
  ctx: CanvasRenderingContext2D,
  viewport: Viewport,
  entry: CompareShapeEntry,
  pctToY: (pct: number) => number,
  fill: boolean
) {
  if (entry.line.length < 2) return;
  const path = new Path2D();
  entry.line.forEach((point, index) => {
    const x = viewport.timeToX(point.time);
    const y = pctToY(point.value);
    if (index === 0) path.moveTo(x, y);
    else path.lineTo(x, y);
  });

  if (fill) {
    const area = new Path2D(path);
    const first = entry.line[0];
    const last = entry.line[entry.line.length - 1];
    const floor = Math.min(viewport.plot.bottom, Math.max(viewport.plot.top, pctToY(0)));
    area.lineTo(viewport.timeToX(last.time), floor);
    area.lineTo(viewport.timeToX(first.time), floor);
    area.closePath();
    ctx.fillStyle = colorAlpha(entry.color, 0.13);
    ctx.fill(area);
  }

  ctx.strokeStyle = entry.color;
  ctx.lineWidth = 1.8;
  ctx.stroke(path);
}

function drawCompareCandles(
  ctx: CanvasRenderingContext2D,
  viewport: Viewport,
  entry: CompareShapeEntry,
  pctToY: (pct: number) => number
) {
  const width = candleWidth(entry.candles, viewport);
  ctx.lineWidth = 1.2;
  for (const candle of entry.candles) {
    const x = viewport.timeToX(candle.time);
    const open = pctToY(candle.open);
    const close = pctToY(candle.close);
    const high = pctToY(candle.high);
    const low = pctToY(candle.low);
    const top = Math.min(open, close);
    const height = Math.max(1, Math.abs(open - close));
    const up = candle.close >= candle.open;
    const color = up ? entry.upColor : entry.downColor;
    ctx.strokeStyle = color;
    ctx.fillStyle = colorAlpha(color, up ? 0.12 : 0.24);
    ctx.beginPath();
    ctx.moveTo(x, high);
    ctx.lineTo(x, low);
    ctx.stroke();
    ctx.fillRect(x - width / 2, top, width, height);
    ctx.strokeRect(x - width / 2, top, width, height);
  }
}

function drawCompareBars(
  ctx: CanvasRenderingContext2D,
  viewport: Viewport,
  entry: CompareShapeEntry,
  pctToY: (pct: number) => number
) {
  const tick = Math.max(3, Math.min(8, candleWidth(entry.candles, viewport) * 0.45));
  ctx.lineWidth = 1.3;
  for (const candle of entry.candles) {
    const x = viewport.timeToX(candle.time);
    const open = pctToY(candle.open);
    const close = pctToY(candle.close);
    const high = pctToY(candle.high);
    const low = pctToY(candle.low);
    ctx.strokeStyle = candle.close >= candle.open ? entry.upColor : entry.downColor;
    ctx.beginPath();
    ctx.moveTo(x, high);
    ctx.lineTo(x, low);
    ctx.moveTo(x - tick, open);
    ctx.lineTo(x, open);
    ctx.moveTo(x, close);
    ctx.lineTo(x + tick, close);
    ctx.stroke();
  }
}

function candleWidth(candles: NormalizedCandle[], viewport: Viewport) {
  if (candles.length < 2) return Math.max(3, Math.min(18, viewport.barSpacing * 0.72));
  let minGap = Infinity;
  for (let i = 1; i < candles.length; i += 1) {
    minGap = Math.min(minGap, Math.abs(viewport.timeToX(candles[i].time) - viewport.timeToX(candles[i - 1].time)));
  }
  return Math.max(3, Math.min(22, (Number.isFinite(minGap) ? minGap : viewport.barSpacing) * 0.62));
}

function colorAlpha(hex: string, alpha: number) {
  const clean = hex.replace("#", "");
  if (clean.length !== 6) return `rgba(77, 182, 255, ${alpha})`;
  const value = Number.parseInt(clean, 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function percentTicks(min: number, max: number): number[] {
  const rough = (max - min) / 4;
  const magnitude = 10 ** Math.floor(Math.log10(Math.abs(rough) || 1));
  const normalized = rough / magnitude;
  const nice = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  const step = nice * magnitude || 1;
  const ticks: number[] = [];
  const first = Math.ceil(min / step) * step;
  for (let value = first; value <= max + step * 0.001; value += step) {
    ticks.push(Number(value.toFixed(6)));
  }
  return ticks;
}
