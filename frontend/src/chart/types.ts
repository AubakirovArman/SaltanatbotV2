import type { Candle, ChartType } from "../types";
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
  symbol: string;
  color: string;
  pct?: number;
  base: boolean;
}

export interface DraftDrawing {
  tool: DrawingObject["tool"];
  points: Anchor[];
}

export interface ChartMarker {
  time: number;
  price: number;
  kind: "buy" | "sell" | "exit";
  label?: string;
}

/** A named line the strategy plots on the price pane (e.g. an EMA it uses). */
export interface ChartPlot {
  label: string;
  color: string;
  points: { time: number; value: number }[];
  /** Overlaid on the price pane (default) or drawn in a separate sub-pane. */
  pane?: "price" | "sub";
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

/**
 * One symbol overlaid on the price pane for relative-performance comparison.
 * `candles` is the raw series for the same timeframe/exchange as the base chart;
 * the compare renderer normalizes it to % change from the first visible bar.
 */
export interface CompareSeries {
  symbol: string;
  color: string;
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
