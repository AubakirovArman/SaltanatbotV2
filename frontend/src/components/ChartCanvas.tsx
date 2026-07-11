import {
  Magnet,
  Layers3,
  MousePointer2,
  Move,
  MoveHorizontal,
  MoveVertical,
  MoveDiagonal,
  Ratio,
  RectangleHorizontal,
  Ruler,
  Scaling,
  SlidersHorizontal,
  TrendingDown,
  TrendingUp,
  Trash2,
  Workflow,
  X
} from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  anchorFromPixel,
  createDrawing,
  TOOL_POINT_COUNT,
  type Anchor,
  type DrawingObject,
  type DrawingTool,
  type ShapeTool
} from "../chart/drawings";
import { useChartRenderer } from "../chart/useChartRenderer";
import { loadDrawings, saveDrawings } from "../chart/drawingStore";
import { hitTest } from "../chart/objects/hitTest";
import { visibleCandles } from "../chart/scales";
import type { ChartLivePosition, ChartMarker, ChartPlot, ChartShapes, ChartTable, ChartTrade, CompareLegendSnapshot, CompareOverlayConfig, CompareSeries, LinkedCrosshair, PriceMode, Viewport } from "../chart/types";
import type { IndicatorConfig } from "../chart/indicatorTypes";
import type { PriceAlert } from "../market/alerts";
import type { Locale } from "../i18n";
import { shellText } from "../i18n/shell";
import type { Candle, ChartType, Instrument, Timeframe } from "../types";
import { ChartIndicatorOverlay, type StrategyMenuItem } from "./ChartIndicatorOverlay";
import { ChartDataPanel } from "./ChartDataPanel";
import { CompareControl, type CompareCandidate } from "./CompareControl";
import { DrawingObjectsPanel } from "./DrawingObjectsPanel";

interface ChartCanvasProps {
  candles: Candle[];
  chartType: ChartType;
  instrument: Instrument;
  timeframe: Timeframe;
  locale: Locale;
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

const MAX_COMPARE = 3;

type Interaction =
  | { mode: "pan"; startClientX: number; startOffset: number }
  | { mode: "edit"; id: string; part: number | "body"; last: Anchor }
  | undefined;

const PRICE_MODES: PriceMode[] = ["linear", "log", "percent"];

export function ChartCanvas({
  candles,
  chartType,
  instrument,
  timeframe,
  locale,
  indicators,
  onIndicatorsChange,
  onEditIndicatorLogic,
  signals,
  trades,
  strategyName,
  strategySummary,
  strategyInputs,
  onStrategyInputChange,
  onClearStrategy,
  customIndicators,
  strategies,
  activeArtifactId,
  onAddArtifact,
  plots,
  shapes,
  tables,
  alerts,
  onAddAlert,
  livePositions,
  theme,
  onNeedHistory,
  focusTime,
  compareSeries,
  compareLoading,
  compareErrors,
  compareOverlays,
  compareCandidates,
  compareTimeframes,
  compareChartTypes,
  onAddCompare,
  onUpdateCompare,
  onRemoveCompare,
  chartId = "chart-1",
  linkedCrosshair,
  onLinkedCrosshairChange
}: ChartCanvasProps) {
  const t = (key: Parameters<typeof shellText>[1]) => shellText(locale, key);
  const interactionRef = useRef<Interaction>();
  const drawingsRef = useRef<DrawingObject[]>([]);
  const historyRef = useRef<DrawingObject[][]>([]);
  const redoRef = useRef<DrawingObject[][]>([]);
  const skipHistoryRef = useRef(false);

  const [tool, setTool] = useState<DrawingTool>("cursor");
  const [magnet, setMagnet] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; id?: string; price?: number }>();
  const [showVolume, setShowVolume] = useState(true);
  const [showArtifactSettings, setShowArtifactSettings] = useState(false);
  const [showDrawingObjects, setShowDrawingObjects] = useState(false);
  const [, setHistoryVersion] = useState(0);
  const [drawings, setDrawings] = useState<DrawingObject[]>([]);
  const [draft, setDraft] = useState<{ tool: ShapeTool; points: Anchor[] }>();
  const chartAlerts = useMemo(
    () => (alerts ?? []).filter((a) => a.symbol === instrument.symbol).map((a) => ({ price: a.price, direction: a.direction, triggered: a.triggered })),
    [alerts, instrument.symbol]
  );
  const [hoverAnchor, setHoverAnchor] = useState<Anchor>();
  const [selectedId, setSelectedId] = useState<string>();
  const [hoveredId, setHoveredId] = useState<string>();
  const [hoverIndex, setHoverIndex] = useState<number>();
  const [view, setView] = useState<{
    zoom: number;
    offset: number;
    crosshair?: { x: number; y: number };
    priceMode: PriceMode;
  }>({ zoom: 1, offset: 0, priceMode: "linear" });
  const [compareLegend, setCompareLegend] = useState<CompareLegendSnapshot[]>([]);
  const chartDataSummaryId = useId();

  const latest = candles.at(-1);
  drawingsRef.current = drawings;

  useEffect(() => setShowArtifactSettings(false), [activeArtifactId]);

  // Assemble the compare overlay from configured layers and the fetched data.
  const compare = useMemo<CompareSeries[]>(() => {
    if (!compareOverlays || compareOverlays.length === 0 || !compareSeries) return [];
    return compareOverlays.map((overlay) => ({
      id: overlay.id,
      symbol: overlay.symbol,
      timeframe: overlay.timeframe,
      chartType: overlay.chartType,
      color: overlay.color,
      upColor: overlay.upColor,
      downColor: overlay.downColor,
      candles: compareSeries[overlay.id] ?? []
    }));
  }, [compareOverlays, compareSeries]);

  // Load / persist drawings per symbol.
  useEffect(() => {
    const loaded = loadDrawings(instrument.symbol);
    historyRef.current = [];
    redoRef.current = [];
    setDrawings(loaded);
    setSelectedId(undefined);
    setDraft(undefined);
    setTool("cursor");
  }, [instrument.symbol]);

  useEffect(() => {
    const id = window.setTimeout(() => saveDrawings(instrument.symbol, drawings), 250);
    return () => window.clearTimeout(id);
  }, [drawings, instrument.symbol]);

  // Record drawing snapshots for undo (bounded), skipping the ones an undo restores.
  useEffect(() => {
    if (skipHistoryRef.current) {
      skipHistoryRef.current = false;
      return;
    }
    historyRef.current.push(drawings);
    if (historyRef.current.length > 60) historyRef.current.shift();
    redoRef.current = [];
    setHistoryVersion((value) => value + 1);
  }, [drawings]);

  const undoDrawings = () => {
    const history = historyRef.current;
    if (history.length < 2) return;
    const current = history.pop();
    if (current) redoRef.current.push(current);
    skipHistoryRef.current = true;
    setSelectedId(undefined);
    setDrawings(history[history.length - 1]);
  };

  const redoDrawings = () => {
    const next = redoRef.current.pop();
    if (!next) return;
    historyRef.current.push(next);
    skipHistoryRef.current = true;
    setSelectedId(undefined);
    setDrawings(next);
  };

  // Keyboard: Esc cancels/deselects, Delete removes selected, Ctrl/Cmd+Z undoes.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      if ((event.key === "z" || event.key === "Z") && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        if (event.shiftKey) redoDrawings();
        else undoDrawings();
        return;
      }
      if ((event.key === "y" || event.key === "Y") && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        redoDrawings();
        return;
      }
      if (event.key === "Escape") {
        setDraft(undefined);
        setSelectedId(undefined);
        setTool("cursor");
      } else if ((event.key === "Delete" || event.key === "Backspace") && selectedId) {
        setDrawings((current) => current.filter((drawing) => drawing.id !== selectedId));
        setSelectedId(undefined);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedId]);

  const draftPreview = useMemo(() => {
    if (!draft) return undefined;
    const points = hoverAnchor && draft.points.length < TOOL_POINT_COUNT[draft.tool]
      ? [...draft.points, hoverAnchor]
      : draft.points;
    return { tool: draft.tool, points };
  }, [draft, hoverAnchor]);

  const {
    backgroundCanvasRef,
    primaryCanvasRef,
    indicatorsCanvasRef,
    overlaysCanvasRef,
    interactionCanvasRef,
    viewportRef
  } = useChartRenderer({
    candles,
    chartType,
    decimals: instrument.decimals,
    symbol: instrument.symbol,
    view,
    indicators,
    drawings,
    draftDrawing: draftPreview,
    selectedDrawingId: selectedId,
    hoveredDrawingId: hoveredId,
    signals,
    trades,
    plots,
    shapes,
    alerts: chartAlerts,
    livePositions,
    showVolume,
    compare,
    theme,
    onCompareLegend: (entries) => setCompareLegend((current) => sameLegend(current, entries) ? current : entries)
  });

  // Lazy-load older history when the viewport nears the left (oldest) edge.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport && viewport.start <= 40 && candles.length > 0) onNeedHistory?.();
  }, [view.zoom, view.offset, candles.length, onNeedHistory]);

  // Scroll to a requested time (e.g. the latest backtest signal).
  useEffect(() => {
    if (focusTime === undefined || candles.length === 0) return;
    let idx = candles.length - 1;
    while (idx > 0 && candles[idx].time > focusTime) idx -= 1;
    setView((current) => ({
      ...current,
      offset: Math.max(0, candles.length - 1 - idx - 20)
    }));
  }, [focusTime]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!linkedCrosshair || linkedCrosshair.sourceId === chartId) return;
    const viewport = viewportRef.current;
    if (!viewport) return;
    let index = candles.findIndex((candle) => candle.time >= linkedCrosshair.time);
    if (index < 0) index = candles.length - 1;
    const candle = candles[index];
    if (!candle) return;
    setView((current) => ({
      ...current,
      crosshair: { x: viewport.indexToX(index), y: viewport.priceToY(linkedCrosshair.price) }
    }));
  }, [candles, chartId, linkedCrosshair]);

  const devicePoint = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * devicePixelRatio,
      y: (event.clientY - rect.top) * devicePixelRatio
    };
  };

  const cyclePriceMode = () => {
    setView((current) => {
      const next = PRICE_MODES[(PRICE_MODES.indexOf(current.priceMode) + 1) % PRICE_MODES.length];
      return { ...current, priceMode: next };
    });
  };

  const legendCandle = hoverIndex !== undefined ? candles[hoverIndex] : latest;

  return (
    <div className="chart-surface">
      <div className="tool-rail" aria-label={t("drawingTools")}>
        <ToolButton active={tool === "cursor"} label={t("cursor")} onClick={() => setTool("cursor")}>
          <MousePointer2 size={15} aria-hidden="true" />
        </ToolButton>
        <ToolButton active={tool === "trendline"} label={t("trendLine")} onClick={() => setTool("trendline")}>
          <TrendingUp size={15} aria-hidden="true" />
        </ToolButton>
        <ToolButton active={tool === "ray"} label={t("ray")} onClick={() => setTool("ray")}>
          <Move size={15} aria-hidden="true" />
        </ToolButton>
        <ToolButton active={tool === "extended"} label={t("extendedLine")} onClick={() => setTool("extended")}>
          <MoveDiagonal size={15} aria-hidden="true" />
        </ToolButton>
        <ToolButton active={tool === "hline"} label={t("horizontalLine")} onClick={() => setTool("hline")}>
          <MoveHorizontal size={15} aria-hidden="true" />
        </ToolButton>
        <ToolButton active={tool === "hray"} label={t("horizontalRay")} onClick={() => setTool("hray")}>
          <MoveHorizontal size={15} aria-hidden="true" className="ic-ray" />
        </ToolButton>
        <ToolButton active={tool === "vline"} label={t("verticalLine")} onClick={() => setTool("vline")}>
          <MoveVertical size={15} aria-hidden="true" />
        </ToolButton>
        <ToolButton active={tool === "rectangle"} label={t("rectangle")} onClick={() => setTool("rectangle")}>
          <RectangleHorizontal size={15} aria-hidden="true" />
        </ToolButton>
        <ToolButton active={tool === "fib"} label={t("fibonacci")} onClick={() => setTool("fib")}>
          <Ratio size={15} aria-hidden="true" />
        </ToolButton>
        <ToolButton active={tool === "long"} label={t("longPosition")} onClick={() => setTool("long")}>
          <TrendingUp size={15} aria-hidden="true" className="ic-up" />
        </ToolButton>
        <ToolButton active={tool === "short"} label={t("shortPosition")} onClick={() => setTool("short")}>
          <TrendingDown size={15} aria-hidden="true" className="ic-down" />
        </ToolButton>
        <ToolButton active={tool === "measure"} label={t("measure")} onClick={() => setTool("measure")}>
          <Ruler size={15} aria-hidden="true" />
        </ToolButton>
        <span className="rail-divider" aria-hidden="true" />
        <ToolButton active={magnet} label={t("magnet")} onClick={() => setMagnet((value) => !value)}>
          <Magnet size={15} aria-hidden="true" />
        </ToolButton>
        <span className="rail-spacer" aria-hidden="true" />
        <ToolButton active={showVolume} label={t("toggleVolume")} onClick={() => setShowVolume((value) => !value)}>
          <Scaling size={15} aria-hidden="true" />
        </ToolButton>
        <ToolButton active={showDrawingObjects} label={t("drawingObjects")} onClick={() => setShowDrawingObjects((value) => !value)}>
          <Layers3 size={15} aria-hidden="true" />
        </ToolButton>
        <button
          type="button"
          className="rail-trash"
          aria-label={t("deleteDrawings")}
          title={t("deleteDrawings")}
          onClick={() => {
            if (drawings.length > 0 && !window.confirm(t("deleteDrawingsConfirm"))) return;
            setDraft(undefined);
            setSelectedId(undefined);
            setDrawings([]);
          }}
        >
          <Trash2 size={15} aria-hidden="true" />
        </button>
      </div>
      <div className="chart-stage">
        <div className="chart-legend" aria-hidden="true">
          <span className="legend-symbol">
            <b>{instrument.symbol}</b>
            <i>{timeframe} · {instrument.exchange}</i>
          </span>
          {legendCandle && (
            <>
              <span>O <b>{legendCandle.open.toFixed(instrument.decimals)}</b></span>
              <span>H <b>{legendCandle.high.toFixed(instrument.decimals)}</b></span>
              <span>L <b>{legendCandle.low.toFixed(instrument.decimals)}</b></span>
              <span>C <b>{legendCandle.close.toFixed(instrument.decimals)}</b></span>
              <span className={legendCandle.close >= legendCandle.open ? "up" : "down"}>
                {legendCandle.close >= legendCandle.open ? "+" : ""}
                {(((legendCandle.close - legendCandle.open) / legendCandle.open) * 100).toFixed(2)}%
              </span>
              <span className="vol">V {formatVolume(legendCandle.volume)}</span>
            </>
          )}
        </div>
        {strategyName && (
          <div className="strategy-chip">
            <Workflow size={12} aria-hidden="true" />
            <span>{strategyName}</span>
            {strategySummary && <b>{strategySummary}</b>}
            {trades && trades.length > 0 && <b>{trades.length} {t("trades")}</b>}
            {!strategySummary && signals && signals.length > 0 && <b>{signals.length} {t("signals")}</b>}
            {strategyInputs && strategyInputs.length > 0 && onStrategyInputChange && (
              <button type="button" onClick={() => setShowArtifactSettings((open) => !open)} title={t("indicatorInputs")} aria-label={t("editIndicatorInputs")}>
                <SlidersHorizontal size={12} aria-hidden="true" />
              </button>
            )}
            <button type="button" onClick={() => { setShowArtifactSettings(false); onClearStrategy?.(); }} title={t("removeFromChart")} aria-label={t("removeArtifact")}>
              <X size={12} aria-hidden="true" />
            </button>
          </div>
        )}
        {showArtifactSettings && strategyInputs && onStrategyInputChange && (
          <ArtifactInputPanel locale={locale} inputs={strategyInputs} onChange={onStrategyInputChange} onClose={() => setShowArtifactSettings(false)} />
        )}
        <ChartIndicatorOverlay
          locale={locale}
          indicators={indicators}
          onChange={onIndicatorsChange}
          onEditLogic={onEditIndicatorLogic}
          customIndicators={customIndicators}
          strategies={strategies}
          activeArtifactId={activeArtifactId}
          onAddArtifact={onAddArtifact}
        />
        {onAddCompare && onUpdateCompare && onRemoveCompare && (
          <CompareControl
            locale={locale}
            candidates={compareCandidates ?? []}
            active={compareOverlays ?? []}
            max={MAX_COMPARE}
            timeframes={compareTimeframes ?? [timeframe]}
            chartTypes={compareChartTypes ?? [chartType]}
            legend={compareLegend}
            loading={compareLoading ?? {}}
            errors={compareErrors ?? {}}
            onAdd={onAddCompare}
            onUpdate={onUpdateCompare}
            onRemove={onRemoveCompare}
          />
        )}
        <button
          type="button"
          className="scale-toggle"
          aria-label={t("cyclePriceScale")}
          title={t("priceScale")}
          onClick={cyclePriceMode}
        >
          {view.priceMode === "linear" ? "LIN" : view.priceMode === "log" ? "LOG" : "%"}
        </button>
        <canvas
          ref={backgroundCanvasRef}
          className="chart-canvas chart-canvas-layer chart-canvas-background"
          role="img"
          aria-label={`${instrument.symbol} ${chartType} chart on ${timeframe}`}
          aria-describedby={chartDataSummaryId}
        />
        <canvas ref={primaryCanvasRef} className="chart-canvas chart-canvas-layer chart-canvas-primary" aria-hidden="true" />
        <canvas ref={indicatorsCanvasRef} className="chart-canvas chart-canvas-layer chart-canvas-indicators" aria-hidden="true" />
        <canvas ref={overlaysCanvasRef} className="chart-canvas chart-canvas-layer chart-canvas-overlays" aria-hidden="true" />
        <canvas
          ref={interactionCanvasRef}
          className={`chart-canvas chart-canvas-interaction ${tool === "cursor" ? "" : "drawing"}`}
          aria-hidden="true"
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            const viewport = viewportRef.current;
            if (!viewport) return;
            const { x, y } = devicePoint(event);

            if (tool !== "cursor") {
              const anchor = snapAnchor(viewport, candles, x, y, magnet);
              const committed = draft && draft.tool === tool ? [...draft.points, anchor] : [anchor];
              if (committed.length >= TOOL_POINT_COUNT[tool]) {
                const object = createDrawing(tool, committed);
                setDrawings((current) => [...current, object]);
                setDraft(undefined);
                setHoverAnchor(undefined);
                setSelectedId(object.id);
                setTool("cursor");
              } else {
                setDraft({ tool, points: committed });
              }
              return;
            }

            const hit = hitTest(viewport, drawingsRef.current, x, y, selectedId);
            if (hit) {
              setSelectedId(hit.id);
              interactionRef.current = { mode: "edit", id: hit.id, part: hit.part, last: snapAnchor(viewport, candles, x, y, magnet) };
            } else {
              setSelectedId(undefined);
              interactionRef.current = { mode: "pan", startClientX: event.clientX, startOffset: view.offset };
            }
          }}
          onPointerMove={(event) => {
            const viewport = viewportRef.current;
            const { x, y } = devicePoint(event);
            if (viewport) setHoverIndex(clampIndex(Math.round(viewport.xToIndex(x)), candles.length));
            if (viewport && onLinkedCrosshairChange) {
              const index = clampIndex(Math.round(viewport.xToIndex(x)), candles.length);
              const candle = candles[index];
              if (candle) onLinkedCrosshairChange({ sourceId: chartId, time: candle.time, price: viewport.yToPrice(y) });
            }

            if (tool !== "cursor" && draft && viewport) {
              setHoverAnchor(snapAnchor(viewport, candles, x, y, magnet));
              setView((current) => ({ ...current, crosshair: { x, y } }));
              return;
            }

            const interaction = interactionRef.current;
            if (interaction?.mode === "edit" && viewport) {
              const next = snapAnchor(viewport, candles, x, y, magnet);
              const dt = next.time - interaction.last.time;
              const dp = next.price - interaction.last.price;
              setDrawings((current) =>
                current.map((drawing) => (drawing.id === interaction.id ? moveDrawing(drawing, interaction.part, next, dt, dp) : drawing))
              );
              interaction.last = next;
              setView((current) => ({ ...current, crosshair: { x, y } }));
              return;
            }

            if (interaction?.mode === "pan") {
              const cssBar = (viewport ? viewport.barSpacing : 8) / devicePixelRatio;
              const delta = Math.round((interaction.startClientX - event.clientX) / Math.max(1, cssBar));
              setView((current) => ({ ...current, offset: Math.max(0, interaction.startOffset + delta), crosshair: { x, y } }));
              return;
            }

            setView((current) => ({ ...current, crosshair: { x, y } }));
            if (viewport) {
              const hit = hitTest(viewport, drawingsRef.current, x, y, selectedId);
              setHoveredId(hit?.id);
            }
          }}
          onPointerLeave={() => {
            setView((current) => ({ ...current, crosshair: undefined }));
            setHoveredId(undefined);
            setHoverIndex(undefined);
            onLinkedCrosshairChange?.();
          }}
          onPointerUp={(event) => {
            event.currentTarget.releasePointerCapture(event.pointerId);
            interactionRef.current = undefined;
          }}
          onWheel={(event) => {
            const nextZoom = Math.min(4, Math.max(0.4, view.zoom + (event.deltaY > 0 ? -0.1 : 0.1)));
            const vp = viewportRef.current;
            if (!vp || candles.length === 0) {
              setView((current) => ({ ...current, zoom: nextZoom }));
              return;
            }
            // Anchor the zoom on the bar under the cursor: keep its global index at
            // the same x after the bar spacing changes.
            const rect = event.currentTarget.getBoundingClientRect();
            const cursorX = (event.clientX - rect.left) * devicePixelRatio;
            const indexBefore = vp.xToIndex(cursorX);
            const nv = visibleCandles(candles, vp.plot, nextZoom, view.offset);
            const desiredStart = indexBefore - (cursorX - vp.plot.left - nv.step / 2) / nv.step;
            const newOffset = Math.max(0, Math.round(candles.length - nv.data.length - desiredStart));
            setView((current) => ({ ...current, zoom: nextZoom, offset: newOffset }));
          }}
          onDoubleClick={() => setView((current) => ({ ...current, zoom: 1, offset: 0 }))}
          onContextMenu={(event) => {
            event.preventDefault();
            const viewport = viewportRef.current;
            const rect = event.currentTarget.getBoundingClientRect();
            const x = (event.clientX - rect.left) * devicePixelRatio;
            const y = (event.clientY - rect.top) * devicePixelRatio;
            const hit = viewport ? hitTest(viewport, drawingsRef.current, x, y, selectedId) : undefined;
            if (hit) setSelectedId(hit.id);
            setMenu({ x: event.clientX - rect.left, y: event.clientY - rect.top, id: hit?.id, price: viewport?.yToPrice(y) });
          }}
        />
        {!showArtifactSettings && tables && tables.length > 0 && <ChartTablesOverlay locale={locale} tables={tables} />}
        <ChartDataPanel
          candles={candles}
          decimals={instrument.decimals}
          focusedIndex={hoverIndex}
          signals={signals}
          trades={trades}
          symbol={instrument.symbol}
          timeframe={timeframe}
          locale={locale}
          summaryId={chartDataSummaryId}
        />
        {showDrawingObjects && (
          <DrawingObjectsPanel
            locale={locale}
            drawings={drawings}
            selectedId={selectedId}
            canUndo={historyRef.current.length >= 2}
            canRedo={redoRef.current.length > 0}
            onSelect={setSelectedId}
            onToggleHidden={(id) => setDrawings((current) => current.map((drawing) => drawing.id === id ? { ...drawing, hidden: !drawing.hidden } : drawing))}
            onToggleLocked={(id) => setDrawings((current) => current.map((drawing) => drawing.id === id ? { ...drawing, locked: !drawing.locked } : drawing))}
            onDelete={(id) => { setDrawings((current) => current.filter((drawing) => drawing.id !== id)); setSelectedId(undefined); }}
            onApplyTemplate={(template) => setDrawings((current) => current.map((drawing) => drawing.id === selectedId ? { ...drawing, style: { ...template.style } } : drawing))}
            onUndo={undoDrawings}
            onRedo={redoDrawings}
            onClose={() => setShowDrawingObjects(false)}
          />
        )}
        {selectedId && drawings.some((d) => d.id === selectedId) && (
          <DrawingStyleBar
            locale={locale}
            drawing={drawings.find((d) => d.id === selectedId) as DrawingObject}
            onChange={(patch) => setDrawings((current) => current.map((d) => (d.id === selectedId ? { ...d, style: { ...d.style, ...patch } } : d)))}
          />
        )}
        {menu && (
          <DrawingMenu
            x={menu.x}
            y={menu.y}
            drawing={menu.id ? drawings.find((d) => d.id === menu.id) : undefined}
            hasLocked={drawings.some((d) => d.locked)}
            alertPrice={onAddAlert && menu.price !== undefined ? menu.price : undefined}
            onAddAlert={onAddAlert}
            onUnlockAll={() => setDrawings((current) => current.map((d) => ({ ...d, locked: false })))}
            onClose={() => setMenu(undefined)}
            onDelete={(id) => {
              setDrawings((current) => current.filter((d) => d.id !== id));
              setSelectedId(undefined);
            }}
            onDuplicate={(id) => {
              const src = drawings.find((d) => d.id === id);
              if (src) setDrawings((current) => [...current, createDrawing(src.tool, src.points.map((p) => ({ ...p })), src.style)]);
            }}
            onToggleLock={(id) => setDrawings((current) => current.map((d) => (d.id === id ? { ...d, locked: !d.locked } : d)))}
            onToggleHide={(id) => setDrawings((current) => current.map((d) => (d.id === id ? { ...d, hidden: !d.hidden } : d)))}
            onResetView={() => setView((current) => ({ ...current, zoom: 1, offset: 0 }))}
          />
        )}
      </div>
    </div>
  );
}

function ToolButton({
  active,
  label,
  onClick,
  children
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button type="button" className={active ? "active" : ""} aria-label={label} title={label} onClick={onClick}>
      {children}
    </button>
  );
}

const DRAW_COLORS = ["#4db6ff", "#f7c948", "#23c97a", "#ef5350", "#bd58a4", "#8f9bb3"];

/** Floating style toolbar for the selected drawing (color / width / dash). */
function DrawingStyleBar({ locale, drawing, onChange }: { locale: Locale; drawing: DrawingObject; onChange: (patch: Partial<DrawingObject["style"]>) => void }) {
  return (
    <div
      style={{ position: "absolute", top: 8, left: "50%", transform: "translateX(-50%)", zIndex: 30, display: "flex", gap: 6, alignItems: "center", padding: "5px 8px", background: "#12161f", border: "1px solid rgba(134,150,166,0.25)", borderRadius: 8, boxShadow: "0 4px 16px rgba(0,0,0,0.35)" }}
    >
      {DRAW_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          title={c}
          aria-label={`Colour ${c}`}
          onClick={() => onChange({ color: c })}
          style={{ width: 16, height: 16, borderRadius: "50%", background: c, border: drawing.style.color === c ? "2px solid #fff" : "1px solid rgba(0,0,0,0.35)", cursor: "pointer", padding: 0 }}
        />
      ))}
      <span style={{ width: 1, height: 16, background: "rgba(134,150,166,0.3)" }} />
      {[1, 2, 3].map((w) => (
        <button
          key={w}
          type="button"
          title={`${w}px`}
          onClick={() => onChange({ width: w })}
          style={{ background: Math.round(drawing.style.width) === w ? "rgba(77,182,255,0.25)" : "transparent", border: "none", color: "inherit", cursor: "pointer", borderRadius: 4, padding: "2px 6px", fontSize: 11 }}
        >
          {w}px
        </button>
      ))}
      <button
        type="button"
        title={shellText(locale, "dashedLine")}
        onClick={() => onChange({ dashed: !drawing.style.dashed })}
        style={{ background: drawing.style.dashed ? "rgba(77,182,255,0.25)" : "transparent", border: "none", color: "inherit", cursor: "pointer", borderRadius: 4, padding: "2px 8px", fontSize: 11 }}
      >
        ┄
      </button>
    </div>
  );
}

function MenuItem({ label, onClick, danger }: { label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{ display: "block", width: "100%", textAlign: "left", padding: "6px 10px", background: "transparent", border: "none", color: danger ? "#ef5350" : "inherit", cursor: "pointer", borderRadius: 6, fontSize: 12 }}
    >
      {label}
    </button>
  );
}

/** Right-click menu: acts on the hit drawing, or offers view/unlock actions on empty space. */
function DrawingMenu({
  x, y, drawing, hasLocked, alertPrice, onAddAlert, onClose, onDelete, onDuplicate, onToggleLock, onToggleHide, onResetView, onUnlockAll
}: {
  x: number;
  y: number;
  drawing?: DrawingObject;
  hasLocked: boolean;
  alertPrice?: number;
  onAddAlert?: (price: number) => void;
  onClose: () => void;
  onDelete: (id: string) => void;
  onDuplicate: (id: string) => void;
  onToggleLock: (id: string) => void;
  onToggleHide: (id: string) => void;
  onResetView: () => void;
  onUnlockAll: () => void;
}) {
  return (
    <>
      {/* Click-away / right-click-away catcher. */}
      <div style={{ position: "fixed", inset: 0, zIndex: 40 }} onPointerDown={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div
        className="chart-context-menu"
        style={{ position: "absolute", left: x, top: y, zIndex: 41, background: "#12161f", border: "1px solid rgba(134,150,166,0.25)", borderRadius: 8, padding: 4, minWidth: 150, boxShadow: "0 6px 24px rgba(0,0,0,0.45)" }}
      >
        {drawing ? (
          <>
            {onAddAlert && (drawing.tool === "hline" || drawing.tool === "hray") && (
              <MenuItem label="Alert at this line" onClick={() => { onAddAlert(drawing.points[0].price); onClose(); }} />
            )}
            <MenuItem label="Duplicate" onClick={() => { onDuplicate(drawing.id); onClose(); }} />
            <MenuItem label={drawing.locked ? "Unlock" : "Lock"} onClick={() => { onToggleLock(drawing.id); onClose(); }} />
            <MenuItem label={drawing.hidden ? "Show" : "Hide"} onClick={() => { onToggleHide(drawing.id); onClose(); }} />
            <MenuItem label="Delete" onClick={() => { onDelete(drawing.id); onClose(); }} danger />
          </>
        ) : (
          <>
            {alertPrice !== undefined && onAddAlert && (
              <MenuItem label={`Add alert @ ${alertPrice.toPrecision(6)}`} onClick={() => { onAddAlert(alertPrice); onClose(); }} />
            )}
            <MenuItem label="Reset view" onClick={() => { onResetView(); onClose(); }} />
            {hasLocked && <MenuItem label="Unlock all" onClick={() => { onUnlockAll(); onClose(); }} />}
          </>
        )}
      </div>
    </>
  );
}

/** Pointer → data anchor, optionally snapping time to the bar and price to OHLC. */
function snapAnchor(viewport: Viewport, candles: Candle[], x: number, y: number, magnet: boolean): Anchor {
  const base = anchorFromPixel(viewport, x, y);
  const index = clampIndex(Math.round(viewport.xToIndex(x)), candles.length);
  const candle = candles[index];
  if (!candle) return base;
  const time = candle.time;
  if (!magnet) return { time, price: base.price };
  const levels = [candle.open, candle.high, candle.low, candle.close];
  let best = base.price;
  let bestDist = Infinity;
  for (const level of levels) {
    const dist = Math.abs(viewport.priceToY(level) - y);
    if (dist < bestDist) {
      bestDist = dist;
      best = level;
    }
  }
  return { time, price: bestDist <= 14 ? best : base.price };
}

function moveDrawing(drawing: DrawingObject, part: number | "body", next: Anchor, dt: number, dp: number): DrawingObject {
  if (part === "body") {
    return { ...drawing, points: drawing.points.map((point) => ({ time: point.time + dt, price: point.price + dp })) };
  }
  return { ...drawing, points: drawing.points.map((point, index) => (index === part ? next : point)) };
}

function clampIndex(index: number, length: number) {
  return Math.max(0, Math.min(length - 1, index));
}

/** Skip a legend state update when nothing a viewer would notice changed. */
function sameLegend(a: CompareLegendSnapshot[], b: CompareLegendSnapshot[]) {
  if (a.length !== b.length) return false;
  return a.every((entry, index) => {
    const other = b[index];
    return (
      entry.symbol === other.symbol &&
      entry.id === other.id &&
      entry.color === other.color &&
      entry.base === other.base &&
      entry.timeframe === other.timeframe &&
      entry.chartType === other.chartType &&
      roundPct(entry.pct) === roundPct(other.pct)
    );
  });
}

function roundPct(pct?: number) {
  if (pct === undefined || !Number.isFinite(pct)) return undefined;
  return Math.round(pct * 100) / 100;
}

function formatVolume(volume: number) {
  if (volume >= 1_000_000) return `${(volume / 1_000_000).toFixed(2)}M`;
  if (volume >= 1_000) return `${(volume / 1_000).toFixed(1)}K`;
  return volume.toFixed(0);
}

function ChartTablesOverlay({ locale, tables }: { locale: Locale; tables: ChartTable[] }) {
  const [open, setOpen] = useState(true);
  return (
    <aside className={`chart-tables ${open ? "" : "collapsed"}`} aria-label={shellText(locale, "indicatorStatistics")}>
      <button type="button" className="chart-tables-toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        {shellText(locale, open ? "hideStatistics" : "showStatistics")}
      </button>
      {open && tables.map((table) => (
        <table key={table.id} className="chart-data-table">
          <caption>{table.id}</caption>
          <thead>
            <tr>
              <th scope="col">{shellText(locale, "metric")}</th>
              {table.columns.map((column) => <th key={column} scope="col">{column}</th>)}
            </tr>
          </thead>
          <tbody>
            {table.rows.map((row) => (
              <tr key={row.label}>
                <th scope="row">{row.label}</th>
                {row.values.map((value, index) => <td key={`${row.label}-${table.columns[index]}`}>{formatTableValue(value)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      ))}
    </aside>
  );
}

function ArtifactInputPanel({ locale, inputs, onChange, onClose }: { locale: Locale; inputs: { name: string; value: number }[]; onChange: (name: string, value: number) => void; onClose: () => void }) {
  return (
    <aside className="artifact-input-panel" aria-label={shellText(locale, "indicatorInputs")}>
      <header>
        <strong>{shellText(locale, "inputs")}</strong>
        <button type="button" onClick={onClose} aria-label={shellText(locale, "closeInputs")}><X size={13} aria-hidden="true" /></button>
      </header>
      <div className="artifact-input-list">
        {inputs.map((input) => {
          const boolean = isBooleanInput(input);
          const options = inputOptions(input.name);
          const id = `artifact-input-${input.name.replace(/[^a-z0-9_-]/gi, "-")}`;
          return (
            <label key={input.name} htmlFor={id}>
              <span>{inputLabel(input.name)}</span>
              {options ? (
                <select id={id} value={input.value} onChange={(event) => onChange(input.name, Number(event.target.value))}>
                  {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              ) : boolean ? (
                <input id={id} type="checkbox" checked={input.value !== 0} onChange={(event) => onChange(input.name, event.target.checked ? 1 : 0)} />
              ) : (
                <input id={id} type="number" value={input.value} step="any" onChange={(event) => {
                  const value = event.target.valueAsNumber;
                  if (Number.isFinite(value)) onChange(input.name, value);
                }} />
              )}
            </label>
          );
        })}
      </div>
    </aside>
  );
}

function isBooleanInput(input: { name: string; value: number }) {
  return (input.value === 0 || input.value === 1) && /^(show|use|calculate|enforce|enable|allow)/i.test(input.name);
}

function inputLabel(name: string) {
  return name.replace(/Input$/, "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/^./, (char) => char.toUpperCase());
}

function inputOptions(name: string) {
  if (name === "cyclesDirectionMode") return [{ value: 0, label: "Percentage" }, { value: 1, label: "Duration" }, { value: 2, label: "Both" }];
  if (name === "cyclesDurationUnits") return [{ value: 0, label: "Days" }, { value: 1, label: "Candles" }];
  if (name === "cyclesMinimumFor") return [{ value: 0, label: "None" }, { value: 1, label: "Both" }, { value: 2, label: "Bull" }, { value: 3, label: "Bear" }];
  if (name === "cyclesFirstDirection") return [{ value: 1, label: "Bull" }, { value: -1, label: "Bear" }];
  return undefined;
}

function formatTableValue(value: string | number | null) {
  if (value === null) return "—";
  if (typeof value === "string") return value;
  return Number.isInteger(value) ? String(value) : value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}
