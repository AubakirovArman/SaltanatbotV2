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
  showVolume?: boolean;
  /** Called with the viewport built for this frame, for pointer math. */
  onViewport?: (viewport: Viewport) => void;
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
}

/** One executed trade drawn on the price pane: entry → exit with a reason. */
export interface ChartTrade {
  entryTime: number;
  entryPrice: number;
  exitTime: number;
  exitPrice: number;
  direction: "long" | "short";
  reason: "signal" | "stop" | "target" | "close";
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
