import type { Candle } from "../types";
import { atr, bollinger, ema, macd, obv, rsi, sma, stochastic, vwap } from "./indicatorMath";
import { isIndicatorVisible } from "./indicatorTypes";
import type {
  BollingerConfig,
  IndicatorConfig,
  MacdConfig,
  ObvConfig,
  PeriodIndicatorConfig,
  StochasticConfig
} from "./indicatorTypes";
import {
  drawBollinger,
  drawMacdPanel,
  drawOscillatorPanel,
  drawRsiPanel,
  drawSeriesLine,
  drawStochasticPanel
} from "./renderers/indicatorRenderers";
import { drawDrawings } from "./renderers/drawingRenderers";
import { drawBars } from "./renderers/bars";
import { drawCandles } from "./renderers/candles";
import { drawLineArea } from "./renderers/lineArea";
import { buildRenko, drawRenko } from "./renderers/renko";
import { drawVolume } from "./renderers/volume";
import { drawMarkers } from "./renderers/markers";
import { drawTradeOverlay } from "./renderers/tradeOverlay";
import { drawAlertLines } from "./renderers/alertLines";
import { drawLivePositions } from "./renderers/livePositions";
import { drawShapes } from "./renderers/shapes";
import { drawStrategyPlots, drawSubPlots } from "./renderers/strategyPlots";
import { drawCompareSeries } from "./renderers/compareSeries";
import { toHeikinAshi } from "./heikinAshi";
import { computePlot, niceTicks, priceScale, visibleCandles } from "./scales";
import { buildViewport } from "./viewport";
import type { DrawChartOptions, PlotArea, PriceMode, PriceScale, Viewport } from "./types";

let theme = {
  background: "#0b0d10",
  panel: "#101419",
  grid: "rgba(134, 150, 166, 0.16)",
  text: "#e5edf4",
  muted: "#7d8a96",
  up: "#23c97a",
  down: "#ef5350",
  accent: "#4db6ff",
  areaFill: "rgba(77, 182, 255, 0.13)"
};

/** Update the canvas palette (driven from CSS variables so themes stay in sync). */
export function setChartTheme(next: Partial<typeof theme>) {
  theme = { ...theme, ...next };
}

export function drawChart(options: DrawChartOptions) {
  const {
    ctx, width, height, candles, chartType, decimals, view, indicators,
    drawings, draftDrawing, signals, trades, plots, shapes, alerts, livePositions, showVolume, onViewport,
    selectedDrawingId, hoveredDrawingId, compare, onCompareLegend
  } = options;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = theme.background;
  ctx.fillRect(0, 0, width, height);

  const priceMode: PriceMode = view.priceMode ?? "linear";
  const lowerIndicators = indicators.filter((indicator) =>
    isIndicatorVisible(indicator) &&
    (indicator.kind === "rsi" ||
      indicator.kind === "macd" ||
      indicator.kind === "stochastic" ||
      indicator.kind === "atr" ||
      indicator.kind === "obv")
  );
  const subPlots = (plots ?? []).filter((series) => series.pane === "sub");
  const pricePlots = (plots ?? []).filter((series) => series.pane !== "sub");
  const subPanelHeight = subPlots.length > 0 ? Math.min(88, Math.max(58, height * 0.14)) : 0;
  const volumeHeight = showVolume ? Math.min(90, Math.max(52, height * 0.13)) : 0;
  const lowerHeight = lowerIndicators.length > 0
    ? Math.min(88, Math.max(58, height * 0.14))
    : 0;
  const mainHeight = Math.max(180, height - lowerIndicators.length * lowerHeight - volumeHeight - subPanelHeight);
  const plot = computePlot(width, mainHeight);
  if (candles.length === 0) {
    drawEmpty(ctx, width, height);
    return;
  }

  const visible = visibleCandles(candles, plot, view.zoom, view.offset);
  const data = chartType === "heikin" ? toHeikinAshi(visible.data) : visible.data;
  const start = Math.max(0, candles.length - clampOffset(candles, view.offset) - visible.data.length);
  const end = start + visible.data.length;
  const computed = computeIndicators(candles, indicators);
  const bricks = chartType === "renko" ? buildRenko(visible.data) : [];
  const extraValues = collectMainValues(computed, start, end);
  const scaleOverride = chartType === "renko" && bricks.length > 0 ? renkoScale(plot, bricks) : undefined;

  const viewport = buildViewport({
    candles, plot, zoom: view.zoom, offset: view.offset, priceMode, extraValues, scaleOverride
  });
  const scale = viewport.scale;
  onViewport?.(viewport);

  drawGrid(ctx, plot, scale, decimals);
  drawTimeAxis(ctx, viewport, decimals, height);

  const renderContext = {
    ctx,
    plot,
    candles: data,
    scale,
    step: viewport.barSpacing,
    decimals,
    theme
  };

  if (chartType === "candles" || chartType === "heikin") drawCandles(renderContext);
  if (chartType === "bars") drawBars(renderContext);
  if (chartType === "line") drawLineArea(renderContext, false);
  if (chartType === "area" || chartType === "baseline") drawLineArea(renderContext, true);
  if (chartType === "renko") drawRenko(renderContext, bricks);
  drawMainIndicators(ctx, computed, start, end, plot, scale, viewport.barSpacing);

  // Compare overlay: normalized %-change lines for other symbols on the price
  // pane. Drawn against `visible.data` (the base's visible window) so it
  // re-bases to the first visible bar as you pan/zoom.
  if (compare && compare.length > 0) {
    const legend = drawCompareSeries(ctx, viewport, {
      baseVisible: visible.data,
      baseSymbol: options.baseSymbol ?? "",
      baseColor: theme.accent,
      series: compare,
      theme
    });
    onCompareLegend?.(legend);
  } else {
    onCompareLegend?.([]);
  }

  let panelTop = plot.bottom + 22;
  if (showVolume) {
    const volPanel = makePanel(plot, panelTop, volumeHeight);
    drawVolume(ctx, volPanel, visible.data, viewport.barSpacing, theme);
    panelTop += volumeHeight;
  }
  drawLowerPanels(ctx, lowerIndicators, computed, start, end, plot, lowerHeight, panelTop);
  if (subPlots.length > 0) {
    const subPanel = makePanel(plot, panelTop + lowerIndicators.length * lowerHeight, subPanelHeight);
    drawSubPlots(ctx, subPanel, viewport, subPlots);
  }

  // Strategy shading sits UNDER the user's own drawings so it never obscures them.
  if (shapes && (shapes.boxes.length > 0 || shapes.vlines.length > 0 || shapes.rays.length > 0)) drawShapes(ctx, viewport, shapes);
  drawDrawings(ctx, viewport, drawings, {
    draft: draftDrawing,
    selectedId: selectedDrawingId,
    hoveredId: hoveredDrawingId,
    decimals
  });
  if (pricePlots.length > 0) drawStrategyPlots(ctx, viewport, pricePlots);
  if (alerts && alerts.length > 0) drawAlertLines(ctx, viewport, alerts, decimals);
  if (livePositions && livePositions.length > 0) drawLivePositions(ctx, viewport, livePositions, decimals);
  if (trades && trades.length > 0) drawTradeOverlay(ctx, viewport, trades, theme, decimals);
  if (signals && signals.length > 0) drawMarkers(ctx, viewport, signals, theme);
  drawLastPrice(ctx, plot, scale, candles[candles.length - 1], decimals, theme);
  if (view.crosshair) drawCrosshair(ctx, plot, viewport, view.crosshair, decimals);
}

function clampOffset(candles: Candle[], offset: number) {
  return Math.max(0, Math.min(offset, Math.max(0, candles.length - 24)));
}

function makePanel(plot: PlotArea, top: number, panelHeight: number): PlotArea {
  return {
    left: plot.left,
    top,
    right: plot.right,
    bottom: top + panelHeight - 18,
    width: plot.width,
    height: panelHeight - 18
  };
}

type ComputedIndicator =
  | { config: PeriodIndicatorConfig; kind: "sma" | "ema" | "rsi" | "vwap" | "atr"; points: ReturnType<typeof sma> }
  | { config: BollingerConfig; kind: "bollinger"; points: ReturnType<typeof bollinger> }
  | { config: MacdConfig; kind: "macd"; points: ReturnType<typeof macd> }
  | { config: StochasticConfig; kind: "stochastic"; points: ReturnType<typeof stochastic> }
  | { config: ObvConfig; kind: "obv"; points: ReturnType<typeof obv> };

const indicatorCache = new WeakMap<Candle[], Map<string, ComputedIndicator>>();

function computeIndicators(candles: Candle[], configs: IndicatorConfig[]): ComputedIndicator[] {
  let cache = indicatorCache.get(candles);
  if (!cache) {
    cache = new Map();
    indicatorCache.set(candles, cache);
  }
  return configs.filter(isIndicatorVisible).map((config): ComputedIndicator => {
    const key = indicatorCalcKey(config);
    const cached = cache.get(key);
    if (cached) return { ...cached, config } as ComputedIndicator;
    let computed: ComputedIndicator;
    switch (config.kind) {
      case "sma":
        computed = { config, kind: config.kind, points: sma(candles, config.period) };
        break;
      case "ema":
        computed = { config, kind: config.kind, points: ema(candles, config.period) };
        break;
      case "rsi":
        computed = { config, kind: config.kind, points: rsi(candles, config.period) };
        break;
      case "vwap":
        computed = { config, kind: config.kind, points: vwap(candles, config.period) };
        break;
      case "atr":
        computed = { config, kind: config.kind, points: atr(candles, config.period) };
        break;
      case "bollinger":
        computed = { config, kind: config.kind, points: bollinger(candles, config.period, config.deviation) };
        break;
      case "macd":
        computed = { config, kind: config.kind, points: macd(candles, config.fast, config.slow, config.signal) };
        break;
      case "stochastic":
        computed = { config, kind: config.kind, points: stochastic(candles, config.period, config.smooth) };
        break;
      case "obv":
        computed = { config, kind: config.kind, points: obv(candles) };
        break;
    }
    cache.set(key, computed);
    return computed;
  });
}

function indicatorCalcKey(config: IndicatorConfig): string {
  if (config.kind === "bollinger") return `${config.kind}:${config.period}:${config.deviation}`;
  if (config.kind === "macd") return `${config.kind}:${config.fast}:${config.slow}:${config.signal}`;
  if (config.kind === "stochastic") return `${config.kind}:${config.period}:${config.smooth}`;
  if (config.kind === "obv") return config.kind;
  return `${config.kind}:${config.period}`;
}

function collectMainValues(computed: ComputedIndicator[], start: number, end: number) {
  return computed.flatMap((indicator) => {
    if (indicator.kind === "bollinger") {
      return indicator.points
        .slice(start, end)
        .flatMap((point) => [point.middle, point.upper, point.lower])
        .filter(isNumber);
    }
    if (indicator.kind === "sma" || indicator.kind === "ema" || indicator.kind === "vwap") {
      return indicator.points.slice(start, end).map((point) => point.value).filter(isNumber);
    }
    return [];
  });
}

function drawMainIndicators(
  ctx: CanvasRenderingContext2D,
  computed: ComputedIndicator[],
  start: number,
  end: number,
  plot: PlotArea,
  scale: PriceScale,
  step: number
) {
  computed.forEach((indicator) => {
    if (indicator.kind === "sma" || indicator.kind === "ema" || indicator.kind === "vwap") {
      drawSeriesLine(ctx, { points: indicator.points, start, end, plot, scale, step, color: indicator.config.color });
    }
    if (indicator.kind === "bollinger") {
      drawBollinger(ctx, indicator.points, start, end, plot, scale, step, {
        middle: indicator.config.color,
        band: indicator.config.bandColor
      });
    }
  });
}

function drawLowerPanels(
  ctx: CanvasRenderingContext2D,
  lowerIndicators: IndicatorConfig[],
  computed: ComputedIndicator[],
  start: number,
  end: number,
  plot: PlotArea,
  lowerHeight: number,
  baseTop: number
) {
  lowerIndicators.forEach((config, index) => {
    const top = baseTop + index * lowerHeight;
    const panel = makePanel(plot, top, lowerHeight);
    const indicator = computed.find((item) => item.config.id === config.id);
    if (!indicator) return;
    if (indicator.kind === "rsi") {
      drawRsiPanel(ctx, panel, indicator.points, start, end, indicator.config.color, theme);
    }
    if (indicator.kind === "macd") {
      drawMacdPanel(ctx, panel, indicator.points, start, end, {
        macd: indicator.config.color,
        signal: indicator.config.signalColor,
        up: indicator.config.histogramUp,
        down: indicator.config.histogramDown
      }, theme);
    }
    if (indicator.kind === "stochastic") {
      drawStochasticPanel(ctx, panel, indicator.points, start, end, {
        k: indicator.config.color,
        d: indicator.config.signalColor
      }, theme);
    }
    if (indicator.kind === "atr") {
      drawOscillatorPanel(ctx, panel, indicator.points, start, end, indicator.config.color, theme, "ATR");
    }
    if (indicator.kind === "obv") {
      drawOscillatorPanel(ctx, panel, indicator.points, start, end, indicator.config.color, theme, "OBV");
    }
  });
}

function drawGrid(
  ctx: CanvasRenderingContext2D,
  plot: PlotArea,
  scale: PriceScale,
  decimals: number
) {
  ctx.strokeStyle = theme.grid;
  ctx.fillStyle = theme.muted;
  ctx.font = '10px "SF Mono", SFMono-Regular, ui-monospace, Menlo, Consolas, monospace';
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";

  const ticks = niceTicks(scale.min, scale.max, 6, scale.mode === "log");
  ticks.forEach((price) => {
    const y = scale.y(price);
    if (y < plot.top - 1 || y > plot.bottom + 1) return;
    ctx.beginPath();
    ctx.moveTo(plot.left, y);
    ctx.lineTo(plot.right, y);
    ctx.stroke();
    ctx.fillText(formatAxisPrice(price, scale, decimals), plot.right + 10, y);
  });
}

function formatAxisPrice(price: number, scale: PriceScale, decimals: number) {
  if (scale.mode === "percent") {
    const pct = ((price - scale.base) / scale.base) * 100;
    return `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
  }
  return price.toFixed(decimals);
}

function drawTimeAxis(
  ctx: CanvasRenderingContext2D,
  viewport: Viewport,
  _decimals: number,
  height: number
) {
  ctx.fillStyle = theme.muted;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.font = '10px "SF Mono", SFMono-Regular, ui-monospace, Menlo, Consolas, monospace';
  ctx.strokeStyle = theme.grid;

  const { plot, start, end, barTimeMs } = viewport;
  const visibleCount = Math.max(1, end - start);
  const every = Math.max(1, Math.round(visibleCount / 7));
  let previous: Date | undefined;
  for (let index = start; index < end; index += 1) {
    if ((index - start) % every !== 0) continue;
    const x = viewport.indexToX(index);
    const time = viewport.lastTime + (index - viewport.lastIndex) * barTimeMs;
    const date = new Date(time);
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
  void height;
}

/** Hierarchical label: show date at day boundaries, else HH:MM (or year on 1d). */
function formatTimeLabel(date: Date, previous: Date | undefined, barTimeMs: number) {
  const newDay = !previous || previous.getDate() !== date.getDate() || previous.getMonth() !== date.getMonth();
  if (barTimeMs >= 86_400_000) {
    const newYear = !previous || previous.getFullYear() !== date.getFullYear();
    return newYear
      ? String(date.getFullYear())
      : date.toLocaleDateString([], { month: "short", day: "numeric" });
  }
  if (newDay) {
    return date.toLocaleDateString([], { month: "short", day: "numeric" });
  }
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function drawLastPrice(
  ctx: CanvasRenderingContext2D,
  plot: PlotArea,
  scale: PriceScale,
  last: Candle | undefined,
  decimals: number,
  chartTheme: typeof theme
) {
  if (!last) return;
  const y = scale.y(last.close);
  if (y < plot.top || y > plot.bottom) return;
  const rising = last.close >= last.open;
  const color = rising ? chartTheme.up : chartTheme.down;
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
  const textWidth = ctx.measureText(label).width;
  const boxW = textWidth + paddingX * 2;
  ctx.fillStyle = color;
  ctx.fillRect(plot.right + 4, y - 9, boxW, 18);
  ctx.fillStyle = "#0b0d10";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(label, plot.right + 4 + paddingX, y);
  ctx.restore();
}

function drawCrosshair(
  ctx: CanvasRenderingContext2D,
  plot: PlotArea,
  viewport: Viewport,
  crosshair: { x: number; y: number },
  decimals: number
) {
  if (
    crosshair.x < plot.left ||
    crosshair.x > plot.right ||
    crosshair.y < plot.top ||
    crosshair.y > plot.bottom
  ) {
    return;
  }
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

  // Price label on Y axis.
  const price = viewport.yToPrice(crosshair.y);
  const priceLabel = formatAxisPrice(price, viewport.scale, decimals);
  drawAxisTag(ctx, plot.right + 4, crosshair.y, priceLabel, "#1c242c", "#e5edf4", "left");

  // Time label on X axis.
  const time = viewport.xToTime(crosshair.x);
  const timeLabel = new Date(time).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
  drawTimeTag(ctx, crosshair.x, plot.bottom + 6, timeLabel);
  ctx.restore();
}

function drawAxisTag(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  label: string,
  bg: string,
  fg: string,
  align: "left" | "center"
) {
  ctx.font = '600 10px "SF Mono", SFMono-Regular, ui-monospace, Menlo, Consolas, monospace';
  const paddingX = 6;
  const textWidth = ctx.measureText(label).width;
  const boxW = textWidth + paddingX * 2;
  const boxX = align === "center" ? x - boxW / 2 : x;
  ctx.fillStyle = bg;
  ctx.fillRect(boxX, y - 9, boxW, 18);
  ctx.fillStyle = fg;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(label, boxX + paddingX, y);
}

function drawTimeTag(ctx: CanvasRenderingContext2D, x: number, y: number, label: string) {
  ctx.font = '600 10px "SF Mono", SFMono-Regular, ui-monospace, Menlo, Consolas, monospace';
  const paddingX = 6;
  const textWidth = ctx.measureText(label).width;
  const boxW = textWidth + paddingX * 2;
  ctx.fillStyle = "#1c242c";
  ctx.fillRect(x - boxW / 2, y, boxW, 18);
  ctx.fillStyle = "#e5edf4";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillText(label, x, y + 3);
  ctx.textAlign = "left";
}

function drawEmpty(ctx: CanvasRenderingContext2D, width: number, height: number) {
  ctx.fillStyle = theme.muted;
  ctx.font = "12px Inter, system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("Waiting for market data", width / 2, height / 2);
  ctx.textAlign = "left";
}

function renkoScale(plot: PlotArea, bricks: Array<{ open: number; close: number }>): PriceScale {
  const prices = bricks.flatMap((brick) => [brick.open, brick.close]);
  return priceScale(
    plot,
    prices.map((price) => ({ time: 0, open: price, high: price, low: price, close: price, volume: 0 })),
    [],
    "linear"
  );
}

function isNumber(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
