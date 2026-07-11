/** Stable browser backtest facade. Domain modules live under `backtest/`. */
export { DEFAULT_CONFIG, runBacktest } from "./backtest/execution";
export {
  previewStrategy,
  type PlotSeries,
  type ShapeBox,
  type ShapeOverlays,
  type ShapeRay,
  type ShapeVLine,
  type StrategyPreview
} from "./backtest/preview";
export type {
  BacktestConfig,
  BacktestMetrics,
  BacktestResult,
  EquityPoint,
  TestedRange,
  Trade,
  TradeMarker
} from "./backtestTypes";
export type { PreviewTable } from "./previewTables";
