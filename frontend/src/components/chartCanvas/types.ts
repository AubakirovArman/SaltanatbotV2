import type { ChartLivePosition, ChartMarker, ChartPlot, ChartShapes, ChartTable, ChartTrade, CompareOverlayConfig, LinkedCrosshair } from "../../chart/types";
import type { IndicatorConfig } from "../../chart/indicatorTypes";
import type { PriceAlert } from "../../market/alerts";
import type { Locale } from "../../i18n";
import type { Candle, ChartType, DataExchange, Instrument, Timeframe } from "../../types";
import type { StrategyMenuItem } from "../ChartIndicatorOverlay";
import type { CompareCandidate } from "../CompareControl";

export interface ChartCanvasProps {
  candles: Candle[];
  chartType: ChartType;
  instrument: Instrument;
  timeframe: Timeframe;
  locale: Locale;
  dataExchange: DataExchange;
  indicators: IndicatorConfig[];
  onIndicatorsChange: (indicators: IndicatorConfig[]) => void;
  onEditIndicatorLogic: (indicator: IndicatorConfig) => void;
  signals?: ChartMarker[];
  trades?: ChartTrade[];
  strategyName?: string;
  strategySummary?: string;
  strategyInputs?: { name: string; value: number }[];
  onStrategyInputChange?: (name: string, value: number) => void;
  onClearStrategy?: () => void;
  customIndicators?: StrategyMenuItem[];
  strategies?: StrategyMenuItem[];
  activeArtifactId?: string;
  onAddArtifact?: (id: string) => void;
  plots?: ChartPlot[];
  shapes?: ChartShapes;
  tables?: ChartTable[];
  /** Active price alerts (all symbols); the chart draws ones for its symbol. */
  alerts?: PriceAlert[];
  /** Create a price alert at a chart price (from the right-click menu). */
  onAddAlert?: (price: number) => void;
  /** Live bot positions on the current symbol, drawn as entry lines. */
  livePositions?: ChartLivePosition[];
  theme?: string;
  onNeedHistory?: () => void;
  /** When set, scroll the viewport so this time lands in view. */
  focusTime?: number;
  /** Compare overlay: other symbols' candles keyed by symbol. */
  compareSeries?: Record<string, Candle[]>;
  compareLoading?: Record<string, boolean>;
  compareErrors?: Record<string, string | undefined>;
  /** Ordered compare overlay configs (drives color assignment + legend order). */
  compareOverlays?: CompareOverlayConfig[];
  /** Catalog symbols selectable in the Compare picker. */
  compareCandidates?: CompareCandidate[];
  compareTimeframes?: Timeframe[];
  compareChartTypes?: ChartType[];
  onAddCompare?: (symbol: string) => void;
  onUpdateCompare?: (id: string, patch: Partial<CompareOverlayConfig>) => void;
  onRemoveCompare?: (id: string) => void;
  chartId?: string;
  linkedCrosshair?: LinkedCrosshair;
  onLinkedCrosshairChange?: (crosshair?: LinkedCrosshair) => void;
}
