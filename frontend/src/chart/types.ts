import type { Candle, ChartType, Timeframe } from "../types";
import type { Anchor, DrawingObject } from "./drawings";
import type { IndicatorConfig } from "./indicatorTypes";

export interface PlotArea {
  left: number;
  top: number;
  width: number;
  height: number;
  right: number;
  bottom: number;
}

export type PriceMode = "linear" | "log" | "percent";

export interface LinkedCrosshair {
  sourceId: string;
  time: number;
  price: number;
}

export interface PriceScale {
  min: number;
  max: number;
  mode: PriceMode;
  /** Baseline price for percent mode (first visible close). */
  base: number;
  y: (price: number) => number;
  /** Inverse of `y`: pixel → price. */
  priceAt: (y: number) => number;
}

/**
 * Full coordinate system for one rendered frame. Maps between global candle
 * index / time / price and device pixels, and back. Drawings, crosshair and
 * axes all resolve through this so they stay locked to the data under zoom/pan.
 */
export interface Viewport {
  plot: PlotArea;
  scale: PriceScale;
  /** Device px per bar. */
  barSpacing: number;
  /** Global index of the first visible candle. */
  start: number;
  /** Global index one past the last visible candle. */
  end: number;
  /** Median bar duration in ms (for time extrapolation). */
  barTimeMs: number;
  lastTime: number;
  lastIndex: number;
  indexToX: (globalIndex: number) => number;
  xToIndex: (x: number) => number;
  timeToX: (time: number) => number;
  xToTime: (x: number) => number;
  priceToY: (price: number) => number;
  yToPrice: (y: number) => number;
}

export interface ChartTheme {
  background: string;
  panel: string;
  grid: string;
  text: string;
  muted: string;
  up: string;
  down: string;
  accent: string;
  areaFill: string;
}

export interface ChartView {
  zoom: number;
  offset: number;
  crosshair?: { x: number; y: number };
  priceMode?: PriceMode;
}

export interface DrawChartOptions {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  candles: Candle[];
  chartType: ChartType;
  decimals: number;
  view: ChartView;
  indicators: IndicatorConfig[];
  drawings: DrawingObject[];
  draftDrawing?: DraftDrawing;
  /** Selection + hover for drawing editing (Task 4). */
  selectedDrawingId?: string;
  hoveredDrawingId?: string;
  /** Arrow signals from the strategy overlay. */
  signals?: ChartMarker[];
  /** Executed trades from the strategy overlay (entry↔exit + reason). */
  trades?: ChartTrade[];
  /** Indicator lines the overlaid strategy plots. */
  plots?: ChartPlot[];
  /** Drawing overlays from the strategy (boxes / vlines / levels). */
  shapes?: ChartShapes;
  /** Active price alerts for the current symbol, drawn as horizontal lines. */
  alerts?: ChartAlert[];
  /** Live bot positions on the current symbol, drawn as entry lines. */
  livePositions?: ChartLivePosition[];
  showVolume?: boolean;
  /** Symbols overlaid on the price pane, normalized to % change (Compare). */
  compare?: CompareSeries[];
  /** The base chart's symbol — labels the base line in the compare legend. */
  baseSymbol?: string;
  /** Called with the viewport built for this frame, for pointer math. */
  onViewport?: (viewport: Viewport) => void;
  /** Called with the compare legend (symbol · %change · color) each frame. */
  onCompareLegend?: (entries: CompareLegendSnapshot[]) => void;
}

/** Legend row emitted by the compare renderer for the React overlay. */
export interface CompareLegendSnapshot {
  id: string;
  symbol: string;
  color: string;
  pct?: number;
  base: boolean;
  timeframe?: Timeframe;
  chartType?: CompareChartType;
}

export interface DraftDrawing {
  tool: DrawingObject["tool"];
  points: Anchor[];
}

export interface ChartMarker {
  time: number;
  price: number;
  kind: "buy" | "sell" | "exit" | "marker";
  label?: string;
  color?: string;
}

/** A named line the strategy plots on the price pane (e.g. an EMA it uses). */
export interface ChartPlot {
  label: string;
  color: string;
  points: { time: number; value: number }[];
  /** Overlaid on the price pane (default) or drawn in a separate sub-pane. */
  pane?: "price" | "sub";
}

/** Strategy drawing overlays (boxes / vertical lines / horizontal rays). Non-finite
 *  box edges mean "full pane height" (bgcolor-style background shading). */
export interface ChartShapes {
  boxes: { t1: number; t2: number; top: number; bottom: number; color: string; label?: string; opacity?: number; border?: boolean }[];
  vlines: { time: number; color: string; label?: string }[];
  rays: { time: number; price: number; color: string; label?: string }[];
}

export interface ChartTable {
  id: string;
  columns: string[];
  rows: { label: string; values: (string | number | null)[] }[];
}

/** A price alert drawn on the chart as a horizontal line. */
export interface ChartAlert {
  price: number;
  direction: "above" | "below";
  triggered: boolean;
}

/** A live bot position drawn on the chart (entry line + label). */
export interface ChartLivePosition {
  side: "long" | "short";
  qty: number;
  entryPrice: number;
}

export type CompareChartType = Exclude<ChartType, "renko">;

export interface CompareOverlayConfig {
  id: string;
  symbol: string;
  timeframe: Timeframe;
  chartType: CompareChartType;
  /** Single-color renderers: line / area / baseline. */
  color: string;
  /** Candle-like renderers: candles / Heikin Ashi / bars. */
  upColor: string;
  downColor: string;
}

/**
 * One symbol overlaid on the price pane for relative-performance comparison.
 * `candles` is the raw series for the selected compare timeframe/exchange; the
 * renderer normalizes it to % change from the first visible base-chart bar.
 */
export interface CompareSeries {
  id: string;
  symbol: string;
  timeframe: Timeframe;
  chartType: CompareChartType;
  color: string;
  upColor: string;
  downColor: string;
  candles: Candle[];
}

/** One executed trade drawn on the price pane: entry → exit with a reason. */
export interface ChartTrade {
  entryTime: number;
  entryPrice: number;
  exitTime: number;
  exitPrice: number;
  direction: "long" | "short";
  reason: "signal" | "stop" | "target" | "close" | "liquidation";
  pnl: number;
}

export interface RenderContext {
  ctx: CanvasRenderingContext2D;
  plot: PlotArea;
  candles: Candle[];
  scale: PriceScale;
  step: number;
  decimals: number;
  theme: ChartTheme;
}
