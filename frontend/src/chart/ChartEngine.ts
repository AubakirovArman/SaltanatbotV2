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
import { drawVolumeProfile } from "./renderers/volumeProfile";
import { drawSessionLiquidity } from "./renderers/sessionLiquidity";
import { drawMarketSessions } from "./renderers/marketSessions";
import { drawMarketStructureBackground, drawMarketStructureOverlay } from "./renderers/marketStructure";
import { drawCrosshair, drawEmpty, drawGrid, drawLastPrice, drawTimeAxis } from "./renderers/chartChrome";
import { toHeikinAshi } from "./heikinAshi";
import { computePlot, priceScale, visibleCandles } from "./scales";
import { buildViewport, medianBarTime } from "./viewport";
import { buildVolumeProfile } from "./volumeProfile";
import { calculateDrawingAvwaps } from "./anchoredVwap";
import type { ChartShapes, DrawChartOptions, PlotArea, PriceMode, PriceScale, Viewport } from "./types";

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
  bricks: ReturnType<typeof buildRenko>;
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
  if (candles.length === 0) return { empty: true, input };

  const rightPaddingBars = projectionPaddingBars(candles, shapes);
  const visible = visibleCandles(candles, plot, view.zoom, view.offset, rightPaddingBars);
  const data = chartType === "heikin" ? toHeikinAshi(visible.data) : visible.data;
  const start = Math.max(0, candles.length - clampOffset(candles, view.offset) - visible.data.length);
  const end = start + visible.data.length;
  const computed = computeIndicators(candles, indicators);
  const bricks = chartType === "renko" ? buildRenko(visible.data) : [];
  const extraValues = collectMainValues(computed, start, end);
  const scaleOverride = chartType === "renko" && bricks.length > 0 ? renkoScale(plot, bricks) : undefined;

  const viewport = buildViewport({
    candles, plot, zoom: view.zoom, offset: view.offset, priceMode, extraValues, scaleOverride, rightPaddingBars
  });
  onViewport?.(viewport);

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
    bricks,
    lowerIndicators,
    subPlots,
    pricePlots,
    volumeHeight,
    lowerHeight,
    subPanelHeight,
    panelTop: plot.bottom + 22,
    volumeProfile: showVolumeProfile ? buildVolumeProfile(visible.data) : undefined
  };
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
  drawTimeAxis(ctx, plan.viewport, theme);
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
  if (chartType === "renko") drawRenko(renderContext, plan.bricks);

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
    decimals
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
    drawCrosshair(ctx, plan.plot, plan.viewport, input.view.crosshair, input.decimals, theme);
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
}) {
  options.ctx.clearRect(0, 0, options.width, options.height);
  if (options.viewport && options.crosshair) {
    drawCrosshair(options.ctx, options.viewport.plot, options.viewport, options.crosshair, options.decimals, theme);
  }
}

function clampOffset(candles: Candle[], offset: number) {
  return Math.max(0, Math.min(offset, Math.max(0, candles.length - 24)));
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
    if (isLowerIndicator(indicator.config)) return [];
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
    let panelScale: PriceScale | undefined;
    if (indicator.kind === "sma" || indicator.kind === "ema" || indicator.kind === "vwap") {
      const values = indicator.points.slice(start, end).map((point) => point.value).filter(isNumber);
      if (values.length > 0) {
        panelScale = independentScale(panel, values);
        drawSeriesLine(ctx, { points: indicator.points, start, end, plot: panel, scale: panelScale, step: panel.width / Math.max(1, end - start), color: indicator.config.color });
      }
    }
    if (indicator.kind === "bollinger") {
      const values = indicator.points.slice(start, end).flatMap((point) => [point.middle, point.upper, point.lower]).filter(isNumber);
      if (values.length > 0) {
        panelScale = independentScale(panel, values);
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
    const values = indicatorValues(indicator, start, end);
    if (!panelScale && values.length > 0) panelScale = independentScale(panel, values);
    if (panelScale) drawPanelScale(ctx, panel, panelScale, indicator.config.scalePlacement ?? "right");
  });
}

function isLowerIndicator(config: IndicatorConfig) {
  if (config.pane === "separate") return true;
  return config.kind === "rsi" || config.kind === "macd" || config.kind === "stochastic" || config.kind === "atr" || config.kind === "obv";
}

function indicatorValues(indicator: ComputedIndicator, start: number, end: number): number[] {
  if (indicator.kind === "bollinger") return indicator.points.slice(start, end).flatMap((point) => [point.middle, point.upper, point.lower]).filter(isNumber);
  if (indicator.kind === "macd") return indicator.points.slice(start, end).flatMap((point) => [point.macd, point.signal, point.histogram]).filter(isNumber);
  if (indicator.kind === "stochastic") return indicator.points.slice(start, end).flatMap((point) => [point.k, point.d]).filter(isNumber);
  return indicator.points.slice(start, end).map((point) => point.value).filter(isNumber);
}

function independentScale(plot: PlotArea, values: number[]): PriceScale {
  const rawMin = Math.min(...values);
  const rawMax = Math.max(...values);
  const span = Math.max(Math.abs(rawMax - rawMin), Math.abs(rawMax) * 0.01, 1e-9);
  const min = rawMin - span * 0.08;
  const max = rawMax + span * 0.08;
  return {
    min, max, mode: "linear", base: values[0] ?? 0,
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
