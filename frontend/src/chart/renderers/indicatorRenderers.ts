import type { BollingerPoint, MacdPoint, SeriesPoint, StochasticPoint } from "../indicatorTypes";
import type { ChartTheme, PlotArea, PriceScale } from "../types";

interface LineInput {
  points: SeriesPoint[];
  start: number;
  end: number;
  plot: PlotArea;
  scale: PriceScale;
  step: number;
  color: string;
  width?: number;
}

export function drawSeriesLine(ctx: CanvasRenderingContext2D, input: LineInput) {
  const visible = input.points.slice(input.start, input.end);
  ctx.strokeStyle = input.color;
  ctx.lineWidth = input.width ?? 1.5;
  ctx.beginPath();
  let hasPoint = false;
  visible.forEach((point, index) => {
    if (point.value === undefined) return;
    const x = input.plot.left + index * input.step + input.step / 2;
    const y = input.scale.y(point.value);
    if (!hasPoint) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
    hasPoint = true;
  });
  if (hasPoint) ctx.stroke();
  ctx.lineWidth = 1;
}

export function drawBollinger(
  ctx: CanvasRenderingContext2D,
  points: BollingerPoint[],
  start: number,
  end: number,
  plot: PlotArea,
  scale: PriceScale,
  step: number,
  colors: { middle: string; band: string }
) {
  drawBandLine(ctx, points, start, end, plot, scale, step, "upper", colors.band);
  drawBandLine(ctx, points, start, end, plot, scale, step, "lower", colors.band);
  drawBandLine(ctx, points, start, end, plot, scale, step, "middle", colors.middle);
}

export function drawRsiPanel(
  ctx: CanvasRenderingContext2D,
  panel: PlotArea,
  points: SeriesPoint[],
  start: number,
  end: number,
  color: string,
  theme: ChartTheme
) {
  const scale = fixedScale(panel, 0, 100);
  drawPanelFrame(ctx, panel, theme, "RSI");
  drawThreshold(ctx, panel, scale, 70, theme.down, "70");
  drawThreshold(ctx, panel, scale, 30, theme.up, "30");
  drawSeriesLine(ctx, {
    points,
    start,
    end,
    plot: panel,
    scale,
    step: panel.width / Math.max(1, end - start),
    color,
    width: 1.7
  });
}

export function drawMacdPanel(
  ctx: CanvasRenderingContext2D,
  panel: PlotArea,
  points: MacdPoint[],
  start: number,
  end: number,
  colors: { macd: string; signal: string; up: string; down: string },
  theme: ChartTheme
) {
  const visible = points.slice(start, end);
  const values = visible.flatMap((point) => [point.macd, point.signal, point.histogram]);
  const finite = values.filter((value): value is number => Number.isFinite(value));
  const max = Math.max(...finite.map(Math.abs), 1);
  const scale = fixedScale(panel, -max * 1.2, max * 1.2);
  const step = panel.width / Math.max(1, visible.length);
  drawPanelFrame(ctx, panel, theme, "MACD");
  drawThreshold(ctx, panel, scale, 0, theme.muted, "0");

  visible.forEach((point, index) => {
    if (point.histogram === undefined) return;
    const x = panel.left + index * step + step * 0.25;
    const y = scale.y(Math.max(point.histogram, 0));
    const zero = scale.y(0);
    ctx.fillStyle = point.histogram >= 0 ? colors.up : colors.down;
    ctx.fillRect(x, y, Math.max(1, step * 0.5), Math.max(1, Math.abs(zero - y)));
  });
  drawSeriesLine(ctx, {
    points: points.map((point) => ({ time: point.time, value: point.macd })),
    start,
    end,
    plot: panel,
    scale,
    step,
    color: colors.macd
  });
  drawSeriesLine(ctx, {
    points: points.map((point) => ({ time: point.time, value: point.signal })),
    start,
    end,
    plot: panel,
    scale,
    step,
    color: colors.signal
  });
}

export function drawStochasticPanel(
  ctx: CanvasRenderingContext2D,
  panel: PlotArea,
  points: StochasticPoint[],
  start: number,
  end: number,
  colors: { k: string; d: string },
  theme: ChartTheme
) {
  const scale = fixedScale(panel, 0, 100);
  drawPanelFrame(ctx, panel, theme, "Stoch");
  drawThreshold(ctx, panel, scale, 80, theme.down, "80");
  drawThreshold(ctx, panel, scale, 20, theme.up, "20");
  const step = panel.width / Math.max(1, end - start);
  drawSeriesLine(ctx, {
    points: points.map((point) => ({ time: point.time, value: point.k })),
    start,
    end,
    plot: panel,
    scale,
    step,
    color: colors.k,
    width: 1.7
  });
  drawSeriesLine(ctx, {
    points: points.map((point) => ({ time: point.time, value: point.d })),
    start,
    end,
    plot: panel,
    scale,
    step,
    color: colors.d,
    width: 1.4
  });
}

/** Auto-scaled single-series oscillator panel (ATR, OBV). */
export function drawOscillatorPanel(
  ctx: CanvasRenderingContext2D,
  panel: PlotArea,
  points: SeriesPoint[],
  start: number,
  end: number,
  color: string,
  theme: ChartTheme,
  label: string
) {
  const visible = points.slice(start, end);
  const finite = visible.map((point) => point.value).filter((value): value is number => Number.isFinite(value));
  drawPanelFrame(ctx, panel, theme, label);
  if (finite.length === 0) return;
  let min = Math.min(...finite);
  let max = Math.max(...finite);
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const pad = (max - min) * 0.08;
  const scale = fixedScale(panel, min - pad, max + pad);
  if (min < 0 && max > 0) drawThreshold(ctx, panel, scale, 0, theme.muted, "0");
  drawSeriesLine(ctx, {
    points,
    start,
    end,
    plot: panel,
    scale,
    step: panel.width / Math.max(1, end - start),
    color,
    width: 1.7
  });
}

function drawBandLine(
  ctx: CanvasRenderingContext2D,
  points: BollingerPoint[],
  start: number,
  end: number,
  plot: PlotArea,
  scale: PriceScale,
  step: number,
  key: "middle" | "upper" | "lower",
  color: string
) {
  drawSeriesLine(ctx, {
    points: points.map((point) => ({ time: point.time, value: point[key] })),
    start,
    end,
    plot,
    scale,
    step,
    color
  });
}

function drawPanelFrame(ctx: CanvasRenderingContext2D, panel: PlotArea, theme: ChartTheme, label: string) {
  ctx.strokeStyle = theme.grid;
  ctx.fillStyle = theme.muted;
  ctx.font = "11px Inter, system-ui, sans-serif";
  ctx.strokeRect(panel.left, panel.top, panel.width, panel.height);
  ctx.fillText(label, panel.left + 8, panel.top + 13);
}

function drawThreshold(
  ctx: CanvasRenderingContext2D,
  panel: PlotArea,
  scale: PriceScale,
  value: number,
  color: string,
  label: string
) {
  const y = scale.y(value);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.55;
  ctx.setLineDash([4, 5]);
  ctx.beginPath();
  ctx.moveTo(panel.left, y);
  ctx.lineTo(panel.right, y);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillText(label, panel.right + 8, y);
  ctx.globalAlpha = 1;
}

function fixedScale(plot: PlotArea, min: number, max: number): PriceScale {
  const span = max - min || 1;
  return {
    min,
    max,
    mode: "linear",
    base: min,
    y: (value: number) => plot.top + ((max - value) / span) * plot.height,
    priceAt: (y: number) => max - ((y - plot.top) / plot.height) * span
  };
}
