import { SlidersHorizontal, Workflow, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createDrawing, TOOL_POINT_COUNT, type Anchor, type DrawingObject, type DrawingTool, type ShapeTool } from "../chart/drawings";
import { useChartRenderer } from "../chart/useChartRenderer";
import { loadDrawings, saveDrawings } from "../chart/drawingStore";
import { hitTest } from "../chart/objects/hitTest";
import { visibleCandles } from "../chart/scales";
import type { CompareLegendSnapshot, CompareSeries, PriceMode, VolumeProfileSnapshot } from "../chart/types";
import { shellText } from "../i18n/shell";
import { ChartIndicatorOverlay } from "./ChartIndicatorOverlay";
import { ChartDataPanel } from "./ChartDataPanel";
import { CompareControl } from "./CompareControl";
import { DrawingObjectsPanel } from "./DrawingObjectsPanel";
import { ChartDrawingToolbar } from "./chartCanvas/ChartDrawingToolbar";
import { OrderBookHeatmapLayer } from "./chartCanvas/OrderBookHeatmapLayer";
import { SessionLiquidityBadge, useSessionLiquidity } from "./chartCanvas/SessionLiquidityLayer";
import { TradeFootprintLayer } from "./chartCanvas/TradeFootprintLayer";
import { ArtifactInputPanel, ChartTablesOverlay } from "./chartCanvas/ChartOverlays";
import { DrawingMenu, DrawingStyleBar } from "./chartCanvas/DrawingMenus";
import { ChartPriceHud, VolumeProfileBadge } from "./chartCanvas/ChartPriceHud";
import { clampIndex, formatVolume, moveDrawing, sameLegend, sameVolumeProfile, snapAnchor } from "./chartCanvas/drawingInteraction";
import type { ChartCanvasProps } from "./chartCanvas/types";

const MAX_COMPARE = 3;

type Interaction = { mode: "pan"; startClientX: number; startOffset: number } | { mode: "edit"; id: string; part: number | "body"; last: Anchor } | undefined;

const PRICE_MODES: PriceMode[] = ["linear", "log", "percent"];

export function ChartCanvas({
  candles,
  chartType,
  instrument,
  timeframe,
  locale,
  dataExchange,
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
  const [showVolumeProfile, setShowVolumeProfile] = useState(true);
  const [showOrderBookHeatmap, setShowOrderBookHeatmap] = useState(false);
  const [showTradeFootprint, setShowTradeFootprint] = useState(false);
  const [showArtifactSettings, setShowArtifactSettings] = useState(false);
  const [showDrawingObjects, setShowDrawingObjects] = useState(false);
  const [, setHistoryVersion] = useState(0);
  const [drawings, setDrawings] = useState<DrawingObject[]>([]);
  const [draft, setDraft] = useState<{ tool: ShapeTool; points: Anchor[] }>();
  const chartAlerts = useMemo(() => (alerts ?? []).filter((a) => a.symbol === instrument.symbol).map((a) => ({ price: a.price, direction: a.direction, triggered: a.triggered })), [alerts, instrument.symbol]);
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
  const [volumeProfile, setVolumeProfile] = useState<VolumeProfileSnapshot>();
  const chartDataSummaryId = useId();

  const latest = candles.at(-1);
  const orderBookAvailable = instrument.assetClass === "crypto" && instrument.provider === "binance";
  const heatmapRenderKey = `${latest?.time ?? 0}:${candles.length}:${view.zoom}:${view.offset}:${view.priceMode}`;
  const sessionLiquidity = useSessionLiquidity(candles, instrument.symbol, timeframe, dataExchange);
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
    const points = hoverAnchor && draft.points.length < TOOL_POINT_COUNT[draft.tool] ? [...draft.points, hoverAnchor] : draft.points;
    return { tool: draft.tool, points };
  }, [draft, hoverAnchor]);

  const { backgroundCanvasRef, primaryCanvasRef, indicatorsCanvasRef, overlaysCanvasRef, interactionCanvasRef, viewportRef } = useChartRenderer({
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
    showVolumeProfile,
    sessionLiquidity: sessionLiquidity.enabled ? sessionLiquidity.snapshot : undefined,
    compare,
    theme,
    onCompareLegend: (entries) => setCompareLegend((current) => (sameLegend(current, entries) ? current : entries)),
    onVolumeProfile: (profile) => setVolumeProfile((current) => sameVolumeProfile(current, profile) ? current : profile)
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
      <ChartDrawingToolbar
        locale={locale}
        tool={tool}
        magnet={magnet}
        showVolume={showVolume}
        showVolumeProfile={showVolumeProfile}
        showOrderBookHeatmap={showOrderBookHeatmap && orderBookAvailable}
        showTradeFootprint={showTradeFootprint && orderBookAvailable}
        orderBookAvailable={orderBookAvailable}
        showObjects={showDrawingObjects}
        hasDrawings={drawings.length > 0}
        onTool={setTool}
        onToggleMagnet={() => setMagnet((value) => !value)}
        onToggleVolume={() => setShowVolume((value) => !value)}
        onToggleVolumeProfile={() => setShowVolumeProfile((value) => !value)}
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
        <div className="chart-legend" aria-hidden="true">
          <span className="legend-symbol">
            <b>{instrument.symbol}</b>
            <i>
              {timeframe} · {instrument.exchange}
            </i>
          </span>
          {legendCandle && (
            <>
              <span>
                O <b>{legendCandle.open.toFixed(instrument.decimals)}</b>
              </span>
              <span>
                H <b>{legendCandle.high.toFixed(instrument.decimals)}</b>
              </span>
              <span>
                L <b>{legendCandle.low.toFixed(instrument.decimals)}</b>
              </span>
              <span>
                C <b>{legendCandle.close.toFixed(instrument.decimals)}</b>
              </span>
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
            {trades && trades.length > 0 && (
              <b>
                {trades.length} {t("trades")}
              </b>
            )}
            {!strategySummary && signals && signals.length > 0 && (
              <b>
                {signals.length} {t("signals")}
              </b>
            )}
            {strategyInputs && strategyInputs.length > 0 && onStrategyInputChange && (
              <button type="button" onClick={() => setShowArtifactSettings((open) => !open)} title={t("indicatorInputs")} aria-label={t("editIndicatorInputs")}>
                <SlidersHorizontal size={12} aria-hidden="true" />
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setShowArtifactSettings(false);
                onClearStrategy?.();
              }}
              title={t("removeFromChart")}
              aria-label={t("removeArtifact")}
            >
              <X size={12} aria-hidden="true" />
            </button>
          </div>
        )}
        {showArtifactSettings && strategyInputs && onStrategyInputChange && <ArtifactInputPanel locale={locale} inputs={strategyInputs} onChange={onStrategyInputChange} onClose={() => setShowArtifactSettings(false)} />}
        <ChartIndicatorOverlay locale={locale} indicators={indicators} onChange={onIndicatorsChange} onEditLogic={onEditIndicatorLogic} customIndicators={customIndicators} strategies={strategies} activeArtifactId={activeArtifactId} onAddArtifact={onAddArtifact} />
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
        <button type="button" className="scale-toggle" aria-label={t("cyclePriceScale")} title={t("priceScale")} onClick={cyclePriceMode}>
          {view.priceMode === "linear" ? "LIN" : view.priceMode === "log" ? "LOG" : "%"}
        </button>
        <VolumeProfileBadge visible={showVolumeProfile} profile={volumeProfile} decimals={instrument.decimals} locale={locale} />
        <canvas ref={backgroundCanvasRef} className="chart-canvas chart-canvas-layer chart-canvas-background" role="img" aria-label={`${instrument.symbol} ${chartType} chart on ${timeframe}`} aria-describedby={chartDataSummaryId} />
        <OrderBookHeatmapLayer
          enabled={showOrderBookHeatmap && orderBookAvailable}
          symbol={instrument.symbol}
          exchange={dataExchange}
          locale={locale}
          viewportRef={viewportRef}
          renderKey={heatmapRenderKey}
        />
        <canvas ref={primaryCanvasRef} className="chart-canvas chart-canvas-layer chart-canvas-primary" aria-hidden="true" />
        <SessionLiquidityBadge state={sessionLiquidity} decimals={instrument.decimals} locale={locale} />
        <TradeFootprintLayer enabled={showTradeFootprint && orderBookAvailable} symbol={instrument.symbol} exchange={dataExchange} locale={locale} candles={candles} viewportRef={viewportRef} renderKey={heatmapRenderKey} />
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
              setDrawings((current) => current.map((drawing) => (drawing.id === interaction.id ? moveDrawing(drawing, interaction.part, next, dt, dp) : drawing)));
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
        <ChartPriceHud
          candle={legendCandle}
          latest={latest}
          timeframe={timeframe}
          decimals={instrument.decimals}
          locale={locale}
          viewport={viewportRef.current}
          crosshair={view.crosshair}
        />
        {!showArtifactSettings && tables && tables.length > 0 && <ChartTablesOverlay locale={locale} tables={tables} />}
        <ChartDataPanel candles={candles} decimals={instrument.decimals} focusedIndex={hoverIndex} signals={signals} trades={trades} symbol={instrument.symbol} timeframe={timeframe} locale={locale} summaryId={chartDataSummaryId} />
        {showDrawingObjects && (
          <DrawingObjectsPanel
            locale={locale}
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
}
