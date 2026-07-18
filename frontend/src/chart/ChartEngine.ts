import type { Candle } from "../types";
import { isIndicatorVisible } from "./indicatorTypes";
import type { IndicatorConfig } from "./indicatorTypes";
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
import { drawRenko } from "./renderers/renko";
import { drawKagi } from "./renderers/kagi";
import { drawPointAndFigure } from "./renderers/pointAndFigure";
import { drawLineBreak } from "./renderers/lineBreak";
import { drawVolume } from "./renderers/volume";
import { drawMarkers } from "./renderers/markers";
import { drawTradeOverlay } from "./renderers/tradeOverlay";
import { drawAlertLines } from "./renderers/alertLines";
import { drawLivePositions } from "./renderers/livePositions";
import { drawShapes } from "./renderers/shapes";
import { drawStrategyPlots, drawSubPlots } from "./renderers/strategyPlots";
import { drawCompareSeries } from "./renderers/compareSeries";
import { drawVolumeProfile } from "./renderers/volumeProfile";
import { drawSessionLiquidity } from "./renderers/sessionLiquidity";
import { drawMarketSessions } from "./renderers/marketSessions";
import { drawMarketStructureBackground, drawMarketStructureOverlay } from "./renderers/marketStructure";
import { drawCrosshair, drawEmpty, drawGrid, drawLastPrice, drawTimeAxis } from "./renderers/chartChrome";
import { computePlot, visibleCandles } from "./scales";
import { buildViewport, medianBarTime } from "./viewport";
import { buildVolumeProfile } from "./volumeProfile";
import { candlesIntersectingRange, visibleCandleTimeRange } from "./volumeProfileSource";
import { calculateDrawingAvwaps } from "./anchoredVwap";
import { preparePriceCandles } from "./priceRepresentation";
import type { ChartShapes, DrawChartOptions, PlotArea, PriceMode, PriceScale, Viewport } from "./types";
import { createChartTimeFormatter } from "./timeAxis";
import { recordBrowserMetric } from "../performance/browserProbe";
import { structuralCandlesOf } from "../market/candleSeries";
import { computeIndicator, patchIndicatorTail, type ComputedIndicator } from "./indicatorTail";

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

export type ChartRenderInput = Omit<DrawChartOptions, "ctx">;

interface EmptyChartRenderPlan {
  empty: true;
  input: ChartRenderInput;
}

interface PopulatedChartRenderPlan {
  empty: false;
  input: ChartRenderInput;
  plot: PlotArea;
  viewport: Viewport;
  visible: ReturnType<typeof visibleCandles>;
  data: Candle[];
  start: number;
  end: number;
  computed: ComputedIndicator[];
  lowerIndicators: IndicatorConfig[];
  subPlots: NonNullable<DrawChartOptions["plots"]>;
  pricePlots: NonNullable<DrawChartOptions["plots"]>;
  volumeHeight: number;
  lowerHeight: number;
  subPanelHeight: number;
  panelTop: number;
  volumeProfile: ReturnType<typeof buildVolumeProfile>;
}

export type ChartRenderPlan = EmptyChartRenderPlan | PopulatedChartRenderPlan;

/** Rebind volatile pass inputs without recomputing viewport/indicator geometry. */
export function withChartRenderInput(
  plan: ChartRenderPlan,
  patch: Partial<ChartRenderInput>
): ChartRenderPlan {
  return { ...plan, input: { ...plan.input, ...patch } } as ChartRenderPlan;
}

/** Compute geometry and expensive indicator series once for every dirty pass. */
export function prepareChartRender(input: ChartRenderInput): ChartRenderPlan {
  const {
    width, height, candles, chartType, view, indicators, plots, shapes, showVolume, showVolumeProfile, onViewport
  } = input;

  const priceMode: PriceMode = view.priceMode ?? "linear";
  const priceZoom = view.priceZoom ?? 1;
  const lowerIndicators = indicators.filter((indicator) => isIndicatorVisible(indicator) && isLowerIndicator(indicator));
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
    input.onVisibleTimeRange?.();
    return { empty: true, input };
  }

  const chartCandles = input.displayCandles ?? preparePriceCandles(candles, chartType, input.decimals);
  if (chartCandles.length === 0) {
    input.onVisibleTimeRange?.();
    return { empty: true, input };
  }
  const rightPaddingBars = projectionPaddingBars(chartCandles, shapes);
  const visible = visibleCandles(chartCandles, plot, view.zoom, view.offset, rightPaddingBars);
  const data = visible.data;
  const { start, end } = visible;
  const computed = measureChartEngine("chart.indicators.computeMs", () => computeIndicators(chartCandles, indicators));
  const extraValues = collectMainValues(computed, start, end);

  const viewport = buildViewport({
    candles: chartCandles, plot, zoom: view.zoom, offset: view.offset, priceMode, priceZoom, extraValues, rightPaddingBars
  });
  onViewport?.(viewport);
  const visibleTimeRange = visibleCandleTimeRange(chartCandles, start, end, viewport.barTimeMs);
  input.onVisibleTimeRange?.(visibleTimeRange);
  const explicitRangeMatches = visibleTimeRange?.startTime === input.volumeProfileRange?.startTime
    && visibleTimeRange?.endTime === input.volumeProfileRange?.endTime;
  const profileCandles = input.volumeProfileCandles === undefined
    ? visible.data
    : visibleTimeRange && input.volumeProfileTimeframe && explicitRangeMatches
      ? candlesIntersectingRange(input.volumeProfileCandles, visibleTimeRange, input.volumeProfileTimeframe)
      : [];

  return {
    empty: false,
    input,
    plot,
    viewport,
    visible,
    data,
    start,
    end,
    computed,
    lowerIndicators,
    subPlots,
    pricePlots,
    volumeHeight,
    lowerHeight,
    subPanelHeight,
    panelTop: plot.bottom + 22,
    volumeProfile: showVolumeProfile ? buildVolumeProfile(profileCandles) : undefined
  };
}

function measureChartEngine<T>(name: string, work: () => T): T {
  if (typeof window === "undefined" || !window.__SBV2_BROWSER_PERF_PROBE__) return work();
  const startedAt = performance.now();
  try {
    return work();
  } finally {
    recordBrowserMetric(name, performance.now() - startedAt);
  }
}

export function drawChartBackground(ctx: CanvasRenderingContext2D, plan: ChartRenderPlan) {
  const { width, height, decimals } = plan.input;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = theme.background;
  ctx.fillRect(0, 0, width, height);
  if (plan.empty) {
    drawEmpty(ctx, width, height, theme);
    return;
  }
  drawGrid(ctx, plan.plot, plan.viewport.scale, decimals, theme);
  drawTimeAxis(ctx, plan.viewport, theme, createChartTimeFormatter(plan.input.locale ?? "en", plan.input.timeZone ?? "local"));
}

export function drawChartPrimary(ctx: CanvasRenderingContext2D, plan: ChartRenderPlan, clear = true) {
  const { width, height, chartType, decimals, showVolume, compare, onCompareLegend, onVolumeProfile, marketSessions, marketStructure } = plan.input;
  if (clear) ctx.clearRect(0, 0, width, height);
  if (plan.empty) {
    onCompareLegend?.([]);
    onVolumeProfile?.();
    return;
  }
  const scale = plan.viewport.scale;

  const renderContext = {
    ctx,
    plot: plan.plot,
    candles: plan.data,
    scale,
    step: plan.viewport.barSpacing,
    decimals,
    theme
  };

  if (marketSessions?.length) drawMarketSessions(ctx, plan.viewport, marketSessions);
  if (marketStructure?.fairValueGaps.length) drawMarketStructureBackground(ctx, plan.viewport, marketStructure);
  if (plan.volumeProfile) drawVolumeProfile(ctx, plan.plot, scale, plan.volumeProfile, theme);
  onVolumeProfile?.(plan.volumeProfile ? {
    bins: plan.volumeProfile.bins.length,
    pocPrice: plan.volumeProfile.pocPrice,
    valueAreaLow: plan.volumeProfile.valueAreaLow,
    valueAreaHigh: plan.volumeProfile.valueAreaHigh,
    totalVolume: plan.volumeProfile.totalVolume
  } : undefined);

  if (chartType === "candles" || chartType === "heikin" || chartType === "hollow") drawCandles(renderContext, chartType === "hollow");
  if (chartType === "bars") drawBars(renderContext);
  if (chartType === "line") drawLineArea(renderContext, false);
  if (chartType === "step") drawLineArea(renderContext, false, true);
  if (chartType === "area" || chartType === "baseline") drawLineArea(renderContext, true);
  if (chartType === "renko") drawRenko(renderContext);
  if (chartType === "linebreak") drawLineBreak(renderContext);
  if (chartType === "kagi") drawKagi(renderContext);
  if (chartType === "pnf") drawPointAndFigure(renderContext);

  // Compare overlay: normalized %-change lines for other symbols on the price
  // pane. Drawn against `visible.data` (the base's visible window) so it
  // re-bases to the first visible bar as you pan/zoom.
  if (compare && compare.length > 0) {
    const legend = drawCompareSeries(ctx, plan.viewport, {
      baseVisible: plan.visible.data,
      baseSymbol: plan.input.baseSymbol ?? "",
      baseColor: theme.accent,
      series: compare,
      theme
    });
    onCompareLegend?.(legend);
  } else {
    onCompareLegend?.([]);
  }

  if (showVolume) {
    const volPanel = makePanel(plan.plot, plan.panelTop, plan.volumeHeight);
    drawVolume(ctx, volPanel, plan.visible.data, plan.viewport.barSpacing, theme);
  }
}

export function drawChartIndicators(ctx: CanvasRenderingContext2D, plan: ChartRenderPlan, clear = true) {
  const { width, height, showVolume } = plan.input;
  if (clear) ctx.clearRect(0, 0, width, height);
  if (plan.empty) return;
  drawMainIndicators(ctx, plan.computed, plan.start, plan.end, plan.plot, plan.viewport.scale, plan.viewport.barSpacing);
  const lowerTop = plan.panelTop + (showVolume ? plan.volumeHeight : 0);
  drawLowerPanels(ctx, plan.lowerIndicators, plan.computed, plan.start, plan.end, plan.plot, plan.lowerHeight, lowerTop);
  if (plan.subPlots.length > 0) {
    const subPanel = makePanel(
      plan.plot,
      lowerTop + plan.lowerIndicators.length * plan.lowerHeight,
      plan.subPanelHeight
    );
    drawSubPlots(ctx, subPanel, plan.viewport, plan.subPlots);
  }
}

export function drawChartOverlays(ctx: CanvasRenderingContext2D, plan: ChartRenderPlan, clear = true) {
  const {
    width, height, decimals, candles, drawings, draftDrawing, signals, trades, shapes, alerts, livePositions,
    selectedDrawingId, hoveredDrawingId, sessionLiquidity, anchoredVwapSeries, marketStructure
  } = plan.input;
  if (clear) ctx.clearRect(0, 0, width, height);
  if (plan.empty) return;
  if (sessionLiquidity) drawSessionLiquidity(ctx, sessionLiquidity, plan.viewport, theme);
  if (marketStructure?.swings.length || marketStructure?.breaks.length) drawMarketStructureOverlay(ctx, plan.viewport, marketStructure);
  // Strategy shading sits UNDER the user's own drawings so it never obscures them.
  if (shapes && (shapes.boxes.length > 0 || shapes.vlines.length > 0 || shapes.rays.length > 0)) drawShapes(ctx, plan.viewport, shapes);
  drawDrawings(ctx, plan.viewport, drawings, anchoredVwapSeries ?? {}, {
    draft: draftDrawing,
    selectedId: selectedDrawingId,
    hoveredId: hoveredDrawingId,
    decimals,
    notePalette: { panel: theme.panel, text: theme.text }
  });
  if (plan.pricePlots.length > 0) drawStrategyPlots(ctx, plan.viewport, plan.pricePlots);
  if (alerts && alerts.length > 0) drawAlertLines(ctx, plan.viewport, alerts, decimals);
  if (livePositions && livePositions.length > 0) drawLivePositions(ctx, plan.viewport, livePositions, decimals);
  if (trades && trades.length > 0) drawTradeOverlay(ctx, plan.viewport, trades, theme, decimals);
  if (signals && signals.length > 0) drawMarkers(ctx, plan.viewport, signals, theme);
  drawLastPrice(ctx, plan.plot, plan.viewport.scale, candles[candles.length - 1], theme);
}

/** Backward-compatible single-canvas facade. */
export function drawChart(options: DrawChartOptions) {
  const { ctx, ...input } = options;
  const plan = prepareChartRender({ ...input, anchoredVwapSeries: input.anchoredVwapSeries ?? calculateDrawingAvwaps(input.candles, input.drawings) });
  drawChartBackground(ctx, plan);
  drawChartPrimary(ctx, plan, false);
  drawChartIndicators(ctx, plan, false);
  drawChartOverlays(ctx, plan, false);
  if (!plan.empty && input.view.crosshair) {
    drawCrosshair(ctx, plan.plot, plan.viewport, input.view.crosshair, input.decimals, theme, createChartTimeFormatter(input.locale ?? "en", input.timeZone ?? "local"));
  }
}

/** Paint only volatile pointer interaction on a transparent overlay canvas. */
export function drawChartInteraction(options: {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  viewport?: Viewport;
  crosshair?: { x: number; y: number };
  decimals: number;
  locale?: import("../i18n").Locale;
  timeZone?: import("./timeAxis").ChartTimeZone;
}) {
  options.ctx.clearRect(0, 0, options.width, options.height);
  if (options.viewport && options.crosshair) {
    drawCrosshair(options.ctx, options.viewport.plot, options.viewport, options.crosshair, options.decimals, theme, createChartTimeFormatter(options.locale ?? "en", options.timeZone ?? "local"));
  }
}

function projectionPaddingBars(candles: Candle[], shapes?: ChartShapes) {
  const last = candles.at(-1)?.time;
  if (last === undefined || !shapes?.boxes.length) return 0;
  const future = Math.max(last, ...shapes.boxes.map((box) => box.t2));
  return Math.max(0, Math.ceil((future - last) / medianBarTime(candles)) + 2);
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

const indicatorCache = new WeakMap<Candle[], Map<string, ComputedIndicator>>();

function computeIndicators(candles: Candle[], configs: IndicatorConfig[]): ComputedIndicator[] {
  const structuralCandles = structuralCandlesOf(candles);
  if (structuralCandles !== candles && structuralCandles.length === candles.length) {
    return computeDenseIndicators(structuralCandles as Candle[], configs)
      .map((indicator) => patchIndicatorTail(indicator, candles));
  }
  return computeDenseIndicators(candles, configs);
}

function computeDenseIndicators(candles: Candle[], configs: IndicatorConfig[]): ComputedIndicator[] {
  let cache = indicatorCache.get(candles);
  if (!cache) {
    cache = new Map();
    indicatorCache.set(candles, cache);
  }
  return configs.filter(isIndicatorVisible).map((config): ComputedIndicator => {
    const key = indicatorCalcKey(config);
    const cached = cache.get(key);
    if (cached) return { ...cached, config } as ComputedIndicator;
    const computed = computeIndicator(candles, config);
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
  const values: number[] = [];
  computed.forEach((indicator) => {
    if (isLowerIndicator(indicator.config)) return;
    if (indicator.kind === "bollinger") {
      appendVisibleValues(values, indicator.points, start, end, ["middle", "upper", "lower"]);
      return;
    }
    if (indicator.kind === "sma" || indicator.kind === "ema" || indicator.kind === "vwap") {
      appendVisibleValues(values, indicator.points, start, end, ["value"]);
    }
  });
  return values;
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
    if (isLowerIndicator(indicator.config)) return;
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
    const bounds = indicatorValueBounds(indicator, start, end);
    let panelScale: PriceScale | undefined;
    if (indicator.kind === "sma" || indicator.kind === "ema" || indicator.kind === "vwap") {
      if (bounds) {
        panelScale = independentScale(panel, bounds);
        drawSeriesLine(ctx, { points: indicator.points, start, end, plot: panel, scale: panelScale, step: panel.width / Math.max(1, end - start), color: indicator.config.color });
      }
    }
    if (indicator.kind === "bollinger") {
      if (bounds) {
        panelScale = independentScale(panel, bounds);
        drawBollinger(ctx, indicator.points, start, end, panel, panelScale, panel.width / Math.max(1, end - start), { middle: indicator.config.color, band: indicator.config.bandColor });
      }
    }
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
    if (!panelScale && bounds) panelScale = independentScale(panel, bounds);
    if (panelScale) drawPanelScale(ctx, panel, panelScale, indicator.config.scalePlacement ?? "right");
  });
}

function isLowerIndicator(config: IndicatorConfig) {
  if (config.pane === "separate") return true;
  return config.kind === "rsi" || config.kind === "macd" || config.kind === "stochastic" || config.kind === "atr" || config.kind === "obv";
}

interface IndicatorValueBounds {
  min: number;
  max: number;
  base: number;
}

function indicatorValueBounds(indicator: ComputedIndicator, start: number, end: number): IndicatorValueBounds | undefined {
  if (indicator.kind === "bollinger") return visibleValueBounds(indicator.points, start, end, ["middle", "upper", "lower"]);
  if (indicator.kind === "macd") return visibleValueBounds(indicator.points, start, end, ["macd", "signal", "histogram"]);
  if (indicator.kind === "stochastic") return visibleValueBounds(indicator.points, start, end, ["k", "d"]);
  return visibleValueBounds(indicator.points, start, end, ["value"]);
}

function visibleValueBounds<T extends object, K extends keyof T>(
  points: readonly T[],
  start: number,
  end: number,
  keys: readonly K[]
): IndicatorValueBounds | undefined {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let base: number | undefined;
  const visibleEnd = Math.min(points.length, end);
  for (let index = Math.max(0, start); index < visibleEnd; index += 1) {
    const point = points[index];
    if (!point) continue;
    keys.forEach((key) => {
      const value = point[key];
      if (typeof value !== "number" || !Number.isFinite(value)) return;
      base ??= value;
      min = Math.min(min, value);
      max = Math.max(max, value);
    });
  }
  return base === undefined ? undefined : { min, max, base };
}

function appendVisibleValues<T extends object, K extends keyof T>(
  target: number[],
  points: readonly T[],
  start: number,
  end: number,
  keys: readonly K[]
) {
  const visibleEnd = Math.min(points.length, end);
  for (let index = Math.max(0, start); index < visibleEnd; index += 1) {
    const point = points[index];
    if (!point) continue;
    keys.forEach((key) => {
      const value = point[key];
      if (typeof value === "number" && Number.isFinite(value)) target.push(value);
    });
  }
}

function independentScale(plot: PlotArea, values: IndicatorValueBounds): PriceScale {
  const rawMin = values.min;
  const rawMax = values.max;
  const span = Math.max(Math.abs(rawMax - rawMin), Math.abs(rawMax) * 0.01, 1e-9);
  const min = rawMin - span * 0.08;
  const max = rawMax + span * 0.08;
  return {
    min, max, mode: "linear", base: values.base,
    y: (value) => plot.top + ((max - value) / (max - min)) * plot.height,
    priceAt: (y) => max - ((y - plot.top) / plot.height) * (max - min)
  };
}

function drawPanelScale(ctx: CanvasRenderingContext2D, panel: PlotArea, scale: PriceScale, placement: NonNullable<IndicatorConfig["scalePlacement"]>) {
  if (placement === "hidden") return;
  ctx.save();
  ctx.fillStyle = theme.muted;
  ctx.font = "10px ui-monospace, monospace";
  ctx.textAlign = placement === "left" ? "left" : "right";
  const x = placement === "left" ? panel.left + 4 : panel.right - 4;
  ctx.fillText(formatScaleValue(scale.max), x, panel.top + 11);
  ctx.fillText(formatScaleValue(scale.min), x, panel.bottom - 3);
  ctx.restore();
}

function formatScaleValue(value: number) {
  const absolute = Math.abs(value);
  return absolute >= 1_000 ? value.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 2 }) : value.toFixed(absolute >= 10 ? 2 : 4);
}
