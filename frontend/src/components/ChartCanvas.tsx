import { memo, useEffect, useId, useMemo, useRef, useState } from "react";
import { createDrawing, TOOL_POINT_COUNT, type Anchor, type DrawingObject, type DrawingTool, type ShapeTool } from "../chart/drawings";
import { useChartRenderer } from "../chart/useChartRenderer";
import { hitTest } from "../chart/objects/hitTest";
import { preparePriceCandles } from "../chart/priceRepresentation";
import type { CompareLegendSnapshot, CompareSeries, DraftDrawing, PriceMode, VolumeProfileSnapshot } from "../chart/types";
import { shellText } from "../i18n/shell";
import { localized } from "../i18n";
import { ChartIndicatorOverlay } from "./ChartIndicatorOverlay";
import { ChartDataPanel } from "./ChartDataPanel";
import { CompareControl } from "./CompareControl";
import { chartTypeAriaLabel } from "./chartTypePresentation";
import { DrawingObjectsPanel } from "./DrawingObjectsPanel";
import { ChartDrawingToolbar } from "./chartCanvas/ChartDrawingToolbar";
import { ChartLegend } from "./chartCanvas/ChartLegend";
import { AnchoredVwapLegend } from "./chartCanvas/AnchoredVwapLegend";
import { OrderBookHeatmapLayer } from "./chartCanvas/OrderBookHeatmapLayer";
import { SessionLiquidityBadge, useSessionLiquidity } from "./chartCanvas/SessionLiquidityLayer";
import { TradeFootprintLayer } from "./chartCanvas/TradeFootprintLayer";
import { ArtifactInputPanel, ChartTablesOverlay } from "./chartCanvas/ChartOverlays";
import { DrawingMenu, DrawingStyleBar } from "./chartCanvas/DrawingMenus";
import { ChartPriceHud, VolumeProfileBadge } from "./chartCanvas/ChartPriceHud";
import { nextPriceMode, sameLegend, sameVolumeProfile } from "./chartCanvas/drawingInteraction";
import type { ChartCanvasProps } from "./chartCanvas/types";
import { useChartPointerInteraction } from "./chartCanvas/useChartPointerInteraction";
import { useChartWheelNavigation } from "./chartCanvas/useChartNavigation";
import { useLinkedTimeRange } from "./chartCanvas/useLinkedTimeRange";
import { PriceRepresentationControl, usePriceRepresentationSettings } from "./chartCanvas/PriceRepresentationControl";
import { PriceAxisControl } from "./chartCanvas/PriceAxisControl";
import { QuickMeasureSummary } from "./chartCanvas/QuickMeasureSummary";
import { StrategyChip } from "./chartCanvas/StrategyChip";
import { usePersistentDrawings } from "./chartCanvas/usePersistentDrawings";
import { TimeZoneControl } from "./chartCanvas/TimeZoneControl";
import { useVolumeProfileIndicator } from "./chartCanvas/useVolumeProfileIndicator";
import { normalizeChartTimeZone } from "../chart/timeAxis";
import { recordBrowserRender } from "../performance/browserProbe";
import { samePriceAlertRoute } from "../market/alerts";
import { structuralCandlesOf } from "../market/candleSeries";
import type { Candle } from "../types";

const MAX_COMPARE = 3;
const EMPTY_CANDLES: Candle[] = [];

export const ChartCanvas = memo(function ChartCanvas({
  candles,
  chartType,
  instrument,
  timeframe,
  locale,
  timeZone,
  onTimeZoneChange,
  dataExchange,
  dataMarketType = "spot",
  dataPriceType = "last",
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
  storageOwnerId,
  linkedCrosshair,
  onLinkedCrosshairChange,
  linkedTimeRange,
  onLinkedTimeRangeChange,
  compactChrome = false,
  showIndicatorControls = true,
  operational = true
}: ChartCanvasProps) {
  recordBrowserRender(`ChartCanvas:${chartId}`);
  const t = (key: Parameters<typeof shellText>[1]) => shellText(locale, key);
  const drawingsRef = useRef<DrawingObject[]>([]);
  const historyRef = useRef<DrawingObject[][]>([]);
  const redoRef = useRef<DrawingObject[][]>([]);
  const skipHistoryRef = useRef(false);

  const [tool, setTool] = useState<DrawingTool>("cursor");
  const [magnet, setMagnet] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; id?: string; price?: number }>();
  const [showVolume, setShowVolume] = useState(true);
  const [showOrderBookHeatmap, setShowOrderBookHeatmap] = useState(false);
  const [showTradeFootprint, setShowTradeFootprint] = useState(false);
  const [showArtifactSettings, setShowArtifactSettings] = useState(false);
  const [showDrawingObjects, setShowDrawingObjects] = useState(false);
  const [, setHistoryVersion] = useState(0);
  const [drawings, setDrawings, drawingScopeKey] = usePersistentDrawings(instrument.symbol, chartId, storageOwnerId);
  const [draft, setDraft] = useState<{ tool: ShapeTool; points: Anchor[] }>();
  const [quickMeasure, setQuickMeasure] = useState<DraftDrawing>();
  const [quickMeasureActive, setQuickMeasureActive] = useState(false);
  const chartAlerts = useMemo(
    () => (alerts ?? []).filter((alert) => alert.symbol === instrument.symbol && samePriceAlertRoute(alert, { exchange: dataExchange, marketType: dataMarketType, priceType: dataPriceType })).map((alert) => ({ price: alert.price, direction: alert.direction, triggered: alert.triggered })),
    [alerts, dataExchange, dataMarketType, dataPriceType, instrument.symbol]
  );
  const [hoverAnchor, setHoverAnchor] = useState<Anchor>();
  const [selectedId, setSelectedId] = useState<string>();
  const [hoveredId, setHoveredId] = useState<string>();
  const [hoverIndex, setHoverIndex] = useState<number>();
  const [view, setView] = useState<{ zoom: number; offset: number; crosshair?: { x: number; y: number }; priceMode: PriceMode; priceZoom: number }>({ zoom: 1, offset: 0, priceMode: "linear", priceZoom: 1 });
  const [compareLegend, setCompareLegend] = useState<CompareLegendSnapshot[]>([]);
  const [volumeProfile, setVolumeProfile] = useState<VolumeProfileSnapshot>();
  const [visibleProfileRange, setVisibleProfileRange] = useState<{ startTime: number; endTime: number }>();
  const chartDataSummaryId = useId();
  const priceRepresentation = usePriceRepresentationSettings(instrument.symbol, chartId, storageOwnerId);
  const chartTimeZone = normalizeChartTimeZone(timeZone);

  const latest = candles.at(-1);
  const structuralCandles = operational ? structuralCandlesOf(candles) : EMPTY_CANDLES;
  const displayCandles = useMemo(
    () => operational ? preparePriceCandles(candles, chartType, instrument.decimals, priceRepresentation.settings) : EMPTY_CANDLES,
    [candles, chartType, instrument.decimals, operational, priceRepresentation.settings]
  );
  const structuralDisplayCandles = useMemo(
    () => operational ? preparePriceCandles(structuralCandles as Candle[], chartType, instrument.decimals, priceRepresentation.settings) : EMPTY_CANDLES,
    [chartType, instrument.decimals, operational, priceRepresentation.settings, structuralCandles]
  );
  const orderBookAvailable = instrument.assetClass === "crypto" && instrument.provider === "binance" && dataMarketType === "spot";
  const heatmapRenderKey = `${latest?.time ?? 0}:${candles.length}:${view.zoom}:${view.offset}:${view.priceMode}:${view.priceZoom}`;
  const sessionLiquidity = useSessionLiquidity(candles, instrument.symbol, timeframe, dataExchange, structuralDisplayCandles, dataMarketType, dataPriceType, operational);
  const volumeProfileIndicator = useVolumeProfileIndicator({ symbol: instrument.symbol, chartTimeframe: timeframe, visibleRange: visibleProfileRange, exchange: dataExchange, marketType: dataMarketType, priceType: dataPriceType, storageOwnerId, operational });
  drawingsRef.current = drawings;

  useEffect(() => setShowArtifactSettings(false), [activeArtifactId]);

  // Assemble the compare overlay from configured layers and the fetched data.
  const compare = useMemo<CompareSeries[]>(() => {
    if (!operational || !compareOverlays || compareOverlays.length === 0 || !compareSeries) return [];
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
  }, [compareOverlays, compareSeries, operational]);

  // Reset transient editing state whenever the pane/symbol drawing scope changes.
  useEffect(() => {
    historyRef.current = [];
    redoRef.current = [];
    setSelectedId(undefined);
    setDraft(undefined);
    setTool("cursor");
  }, [drawingScopeKey]);

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
    if (!operational) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
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
        setMenu(undefined);
        setDraft(undefined);
        setQuickMeasure(undefined);
        setSelectedId(undefined);
        setTool("cursor");
      } else if ((event.key === "Delete" || event.key === "Backspace") && selectedId) {
        setDrawings((current) => current.filter((drawing) => drawing.id !== selectedId));
        setSelectedId(undefined);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [operational, selectedId]);

  const draftPreview = useMemo(() => {
    if (!draft) return undefined;
    const points = hoverAnchor && draft.points.length < TOOL_POINT_COUNT[draft.tool] ? [...draft.points, hoverAnchor] : draft.points;
    return { tool: draft.tool, points };
  }, [draft, hoverAnchor]);

  const { backgroundCanvasRef, primaryCanvasRef, indicatorsCanvasRef, overlaysCanvasRef, interactionCanvasRef, viewportRef } = useChartRenderer({
    operational,
    candles,
    displayCandles,
    chartType,
    decimals: instrument.decimals,
    locale,
    timeZone: chartTimeZone,
    symbol: instrument.symbol,
    view,
    indicators,
    drawings,
    draftDrawing: quickMeasure ?? draftPreview,
    selectedDrawingId: selectedId,
    hoveredDrawingId: hoveredId,
    signals,
    trades,
    plots,
    shapes,
    alerts: chartAlerts,
    livePositions,
    showVolume,
    showVolumeProfile: operational && volumeProfileIndicator.visible,
    volumeProfileCandles: volumeProfileIndicator.source.profileCandles,
    volumeProfileTimeframe: volumeProfileIndicator.source.source === "chart" ? undefined : volumeProfileIndicator.source.source,
    volumeProfileRange: volumeProfileIndicator.source.range,
    sessionLiquidity: sessionLiquidity.enabled ? sessionLiquidity.snapshot : undefined,
    marketSessions: sessionLiquidity.marketSessions,
    marketStructure: sessionLiquidity.marketStructure,
    compare,
    theme,
    onCompareLegend: (entries) => setCompareLegend((current) => (sameLegend(current, entries) ? current : entries)),
    onVolumeProfile: (profile) => setVolumeProfile((current) => (sameVolumeProfile(current, profile) ? current : profile)),
    onVisibleTimeRange: setVisibleProfileRange
  });
  useChartWheelNavigation(interactionCanvasRef, viewportRef, displayCandles, setView, operational);
  const pointerInteraction = useChartPointerInteraction({
    chartId,
    displayCandles,
    draft,
    drawingsRef,
    interactionCanvasRef,
    magnet,
    onLinkedCrosshairChange,
    operational,
    resetKey: drawingScopeKey,
    selectedId,
    setDraft,
    setDrawings,
    setHoverAnchor,
    setHoveredId,
    setHoverIndex,
    setMenu,
    setQuickMeasure,
    setQuickMeasureActive,
    setSelectedId,
    setTool,
    setView,
    tool,
    view,
    viewportRef
  });
  useLinkedTimeRange({ candles: displayCandles, chartId, linkedRange: linkedTimeRange, onLinkedRangeChange: onLinkedTimeRangeChange, operational, setView, view, viewportRef });

  // Lazy-load older history when the viewport nears the left (oldest) edge.
  useEffect(() => {
    if (!operational) return;
    const viewport = viewportRef.current;
    if (viewport && viewport.start <= 40 && candles.length > 0) onNeedHistory?.();
  }, [operational, view.zoom, view.offset, candles.length, onNeedHistory]);

  // Scroll to a requested time (e.g. the latest backtest signal).
  useEffect(() => {
    if (!operational || focusTime === undefined || displayCandles.length === 0) return;
    let idx = displayCandles.length - 1;
    while (idx > 0 && displayCandles[idx].time > focusTime) idx -= 1;
    setView((current) => ({
      ...current,
      offset: Math.max(0, displayCandles.length - 1 - idx - 20)
    }));
  }, [focusTime, operational]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!operational || !linkedCrosshair || linkedCrosshair.sourceId === chartId) return;
    const viewport = viewportRef.current;
    if (!viewport) return;
    let index = displayCandles.findIndex((candle) => candle.time >= linkedCrosshair.time);
    if (index < 0) index = displayCandles.length - 1;
    const candle = displayCandles[index];
    if (!candle) return;
    setView((current) => ({
      ...current,
      crosshair: { x: viewport.indexToX(index), y: viewport.priceToY(linkedCrosshair.price) }
    }));
  }, [displayCandles, chartId, linkedCrosshair, operational]);

  const cyclePriceMode = () => setView((current) => ({ ...current, priceMode: nextPriceMode(current.priceMode) }));

  const legendCandle = (hoverIndex !== undefined ? displayCandles[hoverIndex] : undefined) ?? displayCandles.at(-1) ?? latest;

  return (
    <div className={`chart-surface ${compactChrome ? "compact-chart" : ""} ${showIndicatorControls ? "with-indicator-controls" : ""}`} lang={locale}>
      <ChartDrawingToolbar
        locale={locale}
        tool={tool}
        magnet={magnet}
        showVolume={showVolume}
        showOrderBookHeatmap={showOrderBookHeatmap && orderBookAvailable}
        showTradeFootprint={showTradeFootprint && orderBookAvailable}
        orderBookAvailable={orderBookAvailable}
        showObjects={showDrawingObjects}
        hasDrawings={drawings.length > 0}
        canUndo={historyRef.current.length >= 2}
        canRedo={redoRef.current.length > 0}
        hasSelectedDrawing={Boolean(selectedId && drawings.some((drawing) => drawing.id === selectedId))}
        onTool={setTool}
        onUndo={undoDrawings}
        onRedo={redoDrawings}
        onDeleteSelected={() => {
          if (!selectedId) return;
          setDrawings((current) => current.filter((drawing) => drawing.id !== selectedId));
          setSelectedId(undefined);
        }}
        onToggleMagnet={() => setMagnet((value) => !value)}
        onToggleVolume={() => setShowVolume((value) => !value)}
        onToggleOrderBookHeatmap={() => setShowOrderBookHeatmap((value) => !value)}
        onToggleTradeFootprint={() => setShowTradeFootprint((value) => !value)}
        onToggleObjects={() => setShowDrawingObjects((value) => !value)}
        onDeleteAll={() => {
          if (drawings.length > 0 && !window.confirm(t("deleteDrawingsConfirm"))) return;
          setDraft(undefined);
          setSelectedId(undefined);
          setDrawings([]);
        }}
      />
      <div className="chart-stage">
        <ChartLegend candle={legendCandle} chartType={chartType} instrument={instrument} settings={priceRepresentation.settings} timeframe={timeframe} />
        {strategyName && (
          <StrategyChip
            hasInputs={Boolean(strategyInputs?.length && onStrategyInputChange)}
            locale={locale}
            name={strategyName}
            onClear={() => {
              setShowArtifactSettings(false);
              onClearStrategy?.();
            }}
            onToggleSettings={() => setShowArtifactSettings((open) => !open)}
            signals={signals?.length ?? 0}
            summary={strategySummary}
            trades={trades?.length ?? 0}
          />
        )}
        {showArtifactSettings && strategyInputs && onStrategyInputChange && <ArtifactInputPanel locale={locale} inputs={strategyInputs} onChange={onStrategyInputChange} onClose={() => setShowArtifactSettings(false)} />}
        {showIndicatorControls && (
          <ChartIndicatorOverlay locale={locale} indicators={indicators} onChange={onIndicatorsChange} onEditLogic={onEditIndicatorLogic} customIndicators={customIndicators} strategies={strategies} activeArtifactId={activeArtifactId} onAddArtifact={onAddArtifact} volumeProfile={volumeProfileIndicator.control} />
        )}
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
        <PriceRepresentationControl key={chartType} chartType={chartType} locale={locale} state={priceRepresentation} />
        <TimeZoneControl chartId={chartId} locale={locale} value={chartTimeZone} onChange={onTimeZoneChange} />
        <button type="button" className="scale-toggle" aria-label={t("cyclePriceScale")} title={t("priceScale")} onClick={cyclePriceMode}>
          <span>{view.priceMode === "linear" ? "LIN" : view.priceMode === "log" ? "LOG" : "%"}</span>
          <small>{view.priceZoom === 1 ? "AUTO" : `${Math.round(view.priceZoom * 100)}%`}</small>
        </button>
        <PriceAxisControl locale={locale} zoom={view.priceZoom} onZoomChange={(priceZoom) => setView((current) => ({ ...current, priceZoom }))} />
        <button
          type="button"
          className="zoom-reset"
          aria-label={localized(locale, { en: `Reset chart zoom (${Math.round(view.zoom * 100)}%)`, ru: `Сбросить масштаб графика (${Math.round(view.zoom * 100)}%)`, kk: `График масштабын қалпына келтіру (${Math.round(view.zoom * 100)}%)` })}
          title={localized(locale, { en: "Reset zoom", ru: "Сбросить масштаб", kk: "Масштабты қалпына келтіру" })}
          onClick={() => setView((current) => ({ ...current, zoom: 1, offset: 0 }))}
        >
          {Math.round(view.zoom * 100)}%
        </button>
        <VolumeProfileBadge visible={volumeProfileIndicator.visible} profile={volumeProfile} decimals={instrument.decimals} locale={locale} />
        <canvas ref={backgroundCanvasRef} className="chart-canvas chart-canvas-layer chart-canvas-background" role="img" aria-label={chartTypeAriaLabel(locale, chartType, instrument.symbol, timeframe, priceRepresentation.settings)} aria-describedby={chartDataSummaryId} />
        <OrderBookHeatmapLayer enabled={operational && showOrderBookHeatmap && orderBookAvailable} symbol={instrument.symbol} exchange={dataExchange} locale={locale} viewportRef={viewportRef} renderKey={heatmapRenderKey} />
        <canvas ref={primaryCanvasRef} className="chart-canvas chart-canvas-layer chart-canvas-primary" aria-hidden="true" />
        <SessionLiquidityBadge state={sessionLiquidity} decimals={instrument.decimals} locale={locale} compact={compactChrome} />
        <AnchoredVwapLegend drawings={drawings} candles={operational ? candles : EMPTY_CANDLES} decimals={instrument.decimals} locale={locale} timeZone={chartTimeZone} />
        <TradeFootprintLayer enabled={operational && showTradeFootprint && orderBookAvailable} symbol={instrument.symbol} exchange={dataExchange} locale={locale} timeZone={chartTimeZone} candles={candles} viewportRef={viewportRef} renderKey={heatmapRenderKey} storageOwnerId={storageOwnerId} />
        <canvas ref={indicatorsCanvasRef} className="chart-canvas chart-canvas-layer chart-canvas-indicators" aria-hidden="true" />
        <canvas ref={overlaysCanvasRef} className="chart-canvas chart-canvas-layer chart-canvas-overlays" aria-hidden="true" />
        <canvas
          ref={interactionCanvasRef}
          className={`chart-canvas chart-canvas-interaction ${tool === "cursor" ? "" : "drawing"}`}
          data-touch-mode="idle"
          aria-hidden="true"
          title={localized(locale, { en: "Drag to pan · pinch to zoom · Shift-drag to measure", ru: "Перетаскивание — прокрутка · два пальца — масштаб · Shift — измерение", kk: "Сүйреу — жылжыту · екі саусақ — масштаб · Shift-сүйреу — өлшеу" })}
          onPointerDown={pointerInteraction.onPointerDown}
          onPointerMove={pointerInteraction.onPointerMove}
          onPointerLeave={pointerInteraction.onPointerLeave}
          onPointerUp={pointerInteraction.onPointerUp}
          onPointerCancel={pointerInteraction.onPointerCancel}
          onLostPointerCapture={pointerInteraction.onLostPointerCapture}
          onDoubleClick={() => setView((current) => ({ ...current, zoom: 1, offset: 0 }))}
          onContextMenu={(event) => {
            event.preventDefault();
            const viewport = viewportRef.current;
            const rect = event.currentTarget.getBoundingClientRect();
            const x = event.clientX - rect.left;
            const y = event.clientY - rect.top;
            const hit = viewport ? hitTest(viewport, drawingsRef.current, x, y, selectedId) : undefined;
            if (hit) setSelectedId(hit.id);
            setMenu({ x: event.clientX - rect.left, y: event.clientY - rect.top, id: hit?.id, price: viewport?.yToPrice(y) });
          }}
        />
        <ChartPriceHud active={operational} candle={legendCandle} latest={latest} timeframe={timeframe} decimals={instrument.decimals} locale={locale} timeZone={chartTimeZone} viewport={viewportRef.current} crosshair={quickMeasure ? undefined : view.crosshair} />
        <QuickMeasureSummary active={quickMeasureActive} decimals={instrument.decimals} locale={locale} measurement={quickMeasure} viewport={viewportRef.current} />
        {!showArtifactSettings && tables && tables.length > 0 && <ChartTablesOverlay locale={locale} tables={tables} />}
        <ChartDataPanel candles={displayCandles} decimals={instrument.decimals} focusedIndex={hoverIndex} signals={signals} trades={trades} symbol={instrument.symbol} timeframe={timeframe} locale={locale} timeZone={chartTimeZone} summaryId={chartDataSummaryId} />
        {showDrawingObjects && (
          <DrawingObjectsPanel
            locale={locale}
            storageOwnerId={storageOwnerId}
            drawings={drawings}
            selectedId={selectedId}
            canUndo={historyRef.current.length >= 2}
            canRedo={redoRef.current.length > 0}
            onSelect={setSelectedId}
            onToggleHidden={(id) => setDrawings((current) => current.map((drawing) => (drawing.id === id ? { ...drawing, hidden: !drawing.hidden } : drawing)))}
            onToggleLocked={(id) => setDrawings((current) => current.map((drawing) => (drawing.id === id ? { ...drawing, locked: !drawing.locked } : drawing)))}
            onDelete={(id) => {
              setDrawings((current) => current.filter((drawing) => drawing.id !== id));
              setSelectedId(undefined);
            }}
            onApplyTemplate={(template) => setDrawings((current) => current.map((drawing) => (drawing.id === selectedId ? { ...drawing, style: { ...template.style } } : drawing)))}
            onUndo={undoDrawings}
            onRedo={redoDrawings}
            onClose={() => setShowDrawingObjects(false)}
          />
        )}
        {selectedId && drawings.some((d) => d.id === selectedId) && <DrawingStyleBar locale={locale} drawing={drawings.find((d) => d.id === selectedId) as DrawingObject} onChange={(patch) => setDrawings((current) => current.map((d) => (d.id === selectedId ? { ...d, style: { ...d.style, ...patch } } : d)))} />}
        {menu && (
          <DrawingMenu
            locale={locale}
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
              if (src)
                setDrawings((current) => [
                  ...current,
                  createDrawing(
                    src.tool,
                    src.points.map((p) => ({ ...p })),
                    src.style
                  )
                ]);
            }}
            onToggleLock={(id) => setDrawings((current) => current.map((d) => (d.id === id ? { ...d, locked: !d.locked } : d)))}
            onToggleHide={(id) => setDrawings((current) => current.map((d) => (d.id === id ? { ...d, hidden: !d.hidden } : d)))}
            onResetView={() => setView((current) => ({ ...current, zoom: 1, offset: 0 }))}
          />
        )}
      </div>
    </div>
  );
}, (previous, next) => previous.operational === false && next.operational === false);
