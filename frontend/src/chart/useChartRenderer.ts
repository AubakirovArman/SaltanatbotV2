import { useEffect, useMemo, useRef, useState } from "react";
import type { Candle, ChartType } from "../types";
import type { DrawingObject } from "./drawings";
import type { IndicatorConfig } from "./indicatorTypes";
import {
  drawChartBackground,
  drawChartIndicators,
  drawChartInteraction,
  drawChartOverlays,
  drawChartPrimary,
  prepareChartRender,
  setChartTheme,
  withChartRenderInput,
  type ChartRenderPlan
} from "./ChartEngine";
import { createChartLayerScheduler } from "./dirtyLayers";
import type {
  ChartAlert,
  ChartLivePosition,
  ChartMarker,
  ChartPlot,
  ChartShapes,
  ChartTrade,
  ChartView,
  CompareLegendSnapshot,
  CompareSeries,
  DraftDrawing,
  Viewport,
  VolumeProfileSnapshot
} from "./types";
import type { SessionLiquiditySnapshot } from "./sessionLiquidity";
import { calculateDrawingAvwaps, type AnchoredVwapSeries } from "./anchoredVwap";
import type { MarketSessionRange } from "./marketSessions";
import type { MarketStructureSnapshot } from "./marketStructure";

interface UseChartRendererOptions {
  candles: Candle[];
  displayCandles: Candle[];
  chartType: ChartType;
  decimals: number;
  symbol: string;
  view: ChartView;
  indicators: IndicatorConfig[];
  drawings: DrawingObject[];
  draftDrawing?: DraftDrawing;
  selectedDrawingId?: string;
  hoveredDrawingId?: string;
  signals?: ChartMarker[];
  trades?: ChartTrade[];
  plots?: ChartPlot[];
  shapes?: ChartShapes;
  alerts: ChartAlert[];
  livePositions?: ChartLivePosition[];
  showVolume: boolean;
  showVolumeProfile: boolean;
  sessionLiquidity?: SessionLiquiditySnapshot;
  marketSessions?: MarketSessionRange[];
  marketStructure?: MarketStructureSnapshot;
  compare: CompareSeries[];
  theme?: string;
  onCompareLegend(entries: CompareLegendSnapshot[]): void;
  onVolumeProfile(profile?: VolumeProfileSnapshot): void;
}

export function useChartRenderer(options: UseChartRendererOptions) {
  const anchoredVwaps = useMemo(() => calculateDrawingAvwaps(options.candles, options.drawings), [options.candles, options.drawings]);
  const backgroundCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const primaryCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const indicatorsCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlaysCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const interactionCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const renderPlanRef = useRef<ChartRenderPlan>();
  const viewportRef = useRef<Viewport>();
  const legendCallbackRef = useRef(options.onCompareLegend);
  const volumeProfileCallbackRef = useRef(options.onVolumeProfile);
  legendCallbackRef.current = options.onCompareLegend;
  volumeProfileCallbackRef.current = options.onVolumeProfile;
  const [renderRevision, setRenderRevision] = useState(0);
  const schedulerRef = useRef<ReturnType<typeof createChartLayerScheduler>>();
  if (!schedulerRef.current) {
    schedulerRef.current = createChartLayerScheduler({
      request: (callback) => requestAnimationFrame(callback),
      cancel: (id) => cancelAnimationFrame(id)
    });
  }

  useEffect(() => () => schedulerRef.current?.dispose(), []);

  useEffect(() => {
    const backgroundCanvas = backgroundCanvasRef.current;
    const primaryCanvas = primaryCanvasRef.current;
    const indicatorsCanvas = indicatorsCanvasRef.current;
    const overlaysCanvas = overlaysCanvasRef.current;
    const interactionCanvas = interactionCanvasRef.current;
    if (!backgroundCanvas || !primaryCanvas || !indicatorsCanvas || !overlaysCanvas || !interactionCanvas) return;

    schedulerRef.current?.schedule("background", () => {
      const ctx = backgroundCanvas.getContext("2d");
      if (!ctx) return;
      applyCanvasTheme(backgroundCanvas);
      viewportRef.current = undefined;
      const plan = prepareChartRender({
        width: backgroundCanvas.width,
        height: backgroundCanvas.height,
        candles: options.candles,
        displayCandles: options.displayCandles,
        chartType: options.chartType,
        decimals: options.decimals,
        view: { zoom: options.view.zoom, offset: options.view.offset, priceMode: options.view.priceMode },
        indicators: options.indicators,
        drawings: options.drawings,
        draftDrawing: options.draftDrawing,
        selectedDrawingId: options.selectedDrawingId,
        hoveredDrawingId: options.hoveredDrawingId,
        signals: options.signals,
        trades: options.trades,
        plots: options.plots,
        shapes: options.shapes,
        alerts: options.alerts,
        livePositions: options.livePositions,
        showVolume: options.showVolume,
        showVolumeProfile: options.showVolumeProfile,
        marketSessions: options.marketSessions,
        marketStructure: options.marketStructure,
        compare: options.compare,
        baseSymbol: options.symbol,
        onViewport: (viewport) => { viewportRef.current = viewport; },
        onCompareLegend: (entries) => legendCallbackRef.current(entries),
        onVolumeProfile: (profile) => volumeProfileCallbackRef.current(profile)
      });
      renderPlanRef.current = plan;
      drawChartBackground(ctx, plan);
    });
    schedulerRef.current?.schedule("primary", () => drawPrimary(primaryCanvas, renderPlanRef.current, options.compare, options.symbol, legendCallbackRef));
    schedulerRef.current?.schedule("indicators", () => {
      const plan = renderPlanRef.current;
      const ctx = indicatorsCanvas.getContext("2d");
      if (plan && ctx) drawChartIndicators(ctx, plan);
    });
    schedulerRef.current?.schedule("overlays", () => drawOverlays(overlaysCanvas, renderPlanRef.current, options, anchoredVwaps));
    schedulerRef.current?.schedule("interaction", () => drawInteraction(interactionCanvas, viewportRef.current, options));
  }, [options.candles, options.displayCandles, options.chartType, options.indicators, options.decimals, options.symbol, options.plots, options.shapes, options.showVolume, options.showVolumeProfile, options.marketSessions, options.marketStructure, options.theme, options.view.zoom, options.view.offset, options.view.priceMode, renderRevision]);

  useEffect(() => {
    const canvas = primaryCanvasRef.current;
    if (canvas) schedulerRef.current?.schedule("primary", () => drawPrimary(canvas, renderPlanRef.current, options.compare, options.symbol, legendCallbackRef));
  }, [options.compare, options.symbol]);

  useEffect(() => {
    const canvas = overlaysCanvasRef.current;
    if (canvas) schedulerRef.current?.schedule("overlays", () => drawOverlays(canvas, renderPlanRef.current, options, anchoredVwaps));
  }, [options.draftDrawing, options.drawings, options.hoveredDrawingId, options.selectedDrawingId, options.signals, options.trades, options.plots, options.shapes, options.alerts, options.livePositions, options.sessionLiquidity, anchoredVwaps]);

  useEffect(() => {
    const canvas = interactionCanvasRef.current;
    if (canvas) schedulerRef.current?.schedule("interaction", () => drawInteraction(canvas, viewportRef.current, options));
  }, [options.decimals, options.view.crosshair]);

  useEffect(() => {
    const canvases = [backgroundCanvasRef.current, primaryCanvasRef.current, indicatorsCanvasRef.current, overlaysCanvasRef.current, interactionCanvasRef.current];
    const backgroundCanvas = canvases[0];
    if (!backgroundCanvas || canvases.some((canvas) => !canvas)) return;
    const observer = new ResizeObserver(([entry]) => {
      const dpc = entry.devicePixelContentBoxSize?.[0];
      const width = dpc?.inlineSize ?? Math.round(entry.contentRect.width * devicePixelRatio);
      const height = dpc?.blockSize ?? Math.round(entry.contentRect.height * devicePixelRatio);
      if (backgroundCanvas.width === width && backgroundCanvas.height === height) return;
      for (const canvas of canvases) {
        if (!canvas) continue;
        canvas.width = width;
        canvas.height = height;
      }
      setRenderRevision((current) => current + 1);
    });
    observer.observe(backgroundCanvas);
    return () => observer.disconnect();
  }, []);

  return { backgroundCanvasRef, primaryCanvasRef, indicatorsCanvasRef, overlaysCanvasRef, interactionCanvasRef, viewportRef };
}

function drawPrimary(
  canvas: HTMLCanvasElement,
  plan: ChartRenderPlan | undefined,
  compare: CompareSeries[],
  symbol: string,
  callbackRef: { current(entries: CompareLegendSnapshot[]): void }
) {
  const ctx = canvas.getContext("2d");
  if (plan && ctx) drawChartPrimary(ctx, withChartRenderInput(plan, {
    compare,
    baseSymbol: symbol,
    onCompareLegend: (entries) => callbackRef.current(entries)
  }));
}

function drawOverlays(canvas: HTMLCanvasElement, plan: ChartRenderPlan | undefined, options: UseChartRendererOptions, anchoredVwapSeries: AnchoredVwapSeries) {
  const ctx = canvas.getContext("2d");
  if (plan && ctx) drawChartOverlays(ctx, withChartRenderInput(plan, {
    drawings: options.drawings,
    draftDrawing: options.draftDrawing,
    selectedDrawingId: options.selectedDrawingId,
    hoveredDrawingId: options.hoveredDrawingId,
    signals: options.signals,
    trades: options.trades,
    plots: options.plots,
    shapes: options.shapes,
    alerts: options.alerts,
    livePositions: options.livePositions,
    sessionLiquidity: options.sessionLiquidity,
    marketStructure: options.marketStructure,
    anchoredVwapSeries
  }));
}

function drawInteraction(canvas: HTMLCanvasElement, viewport: Viewport | undefined, options: UseChartRendererOptions) {
  const ctx = canvas.getContext("2d");
  if (ctx) drawChartInteraction({
    ctx,
    width: canvas.width,
    height: canvas.height,
    viewport,
    crosshair: options.view.crosshair,
    decimals: options.decimals
  });
}

/** Sync the canvas palette to the active CSS theme variables. */
function applyCanvasTheme(element: HTMLElement) {
  const styles = getComputedStyle(element);
  const read = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;
  setChartTheme({
    background: read("--chart-bg", "#0b0d10"),
    panel: read("--chart-panel", "#101419"),
    grid: read("--chart-grid", "rgba(134, 150, 166, 0.16)"),
    text: read("--text", "#e5edf4"),
    muted: read("--muted", "#7d8a96"),
    up: read("--up", "#23c97a"),
    down: read("--down", "#ef5350"),
    accent: read("--accent", "#4db6ff")
  });
}
