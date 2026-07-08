import {
  Magnet,
  MousePointer2,
  Move,
  MoveHorizontal,
  MoveVertical,
  Ratio,
  RectangleHorizontal,
  Scaling,
  TrendingDown,
  TrendingUp,
  Trash2,
  Workflow,
  X
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  anchorFromPixel,
  createDrawing,
  TOOL_POINT_COUNT,
  type Anchor,
  type DrawingObject,
  type DrawingTool,
  type ShapeTool
} from "../chart/drawings";
import { drawChart, setChartTheme } from "../chart/ChartEngine";
import { compareColor } from "../chart/compareColors";
import { loadDrawings, saveDrawings } from "../chart/drawingStore";
import { hitTest } from "../chart/objects/hitTest";
import type { ChartMarker, ChartPlot, ChartTrade, CompareLegendSnapshot, CompareSeries, PriceMode, Viewport } from "../chart/types";
import type { IndicatorConfig } from "../chart/indicatorTypes";
import type { Candle, ChartType, Instrument, Timeframe } from "../types";
import { ChartIndicatorOverlay, type StrategyMenuItem } from "./ChartIndicatorOverlay";
import { CompareControl, type CompareCandidate } from "./CompareControl";

interface ChartCanvasProps {
  candles: Candle[];
  chartType: ChartType;
  instrument: Instrument;
  timeframe: Timeframe;
  indicators: IndicatorConfig[];
  onIndicatorsChange: (indicators: IndicatorConfig[]) => void;
  onEditIndicatorLogic: (indicator: IndicatorConfig) => void;
  signals?: ChartMarker[];
  trades?: ChartTrade[];
  strategyName?: string;
  onClearStrategy?: () => void;
  strategies?: StrategyMenuItem[];
  activeStrategyId?: string;
  onAddStrategy?: (id: string) => void;
  plots?: ChartPlot[];
  theme?: string;
  onNeedHistory?: () => void;
  /** When set, scroll the viewport so this time lands in view. */
  focusTime?: number;
  /** Compare overlay: other symbols' candles keyed by symbol. */
  compareSeries?: Record<string, Candle[]>;
  /** Ordered list of compare symbols (drives color assignment + legend order). */
  compareSymbols?: string[];
  /** Catalog symbols selectable in the Compare picker. */
  compareCandidates?: CompareCandidate[];
  onAddCompare?: (symbol: string) => void;
  onRemoveCompare?: (symbol: string) => void;
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
  indicators,
  onIndicatorsChange,
  onEditIndicatorLogic,
  signals,
  trades,
  strategyName,
  onClearStrategy,
  strategies,
  activeStrategyId,
  onAddStrategy,
  plots,
  theme,
  onNeedHistory,
  focusTime,
  compareSeries,
  compareSymbols,
  compareCandidates,
  onAddCompare,
  onRemoveCompare
}: ChartCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const frameRef = useRef<number>();
  const viewportRef = useRef<Viewport>();
  const interactionRef = useRef<Interaction>();
  const drawingsRef = useRef<DrawingObject[]>([]);

  const [tool, setTool] = useState<DrawingTool>("cursor");
  const [magnet, setMagnet] = useState(false);
  const [showVolume, setShowVolume] = useState(true);
  const [drawings, setDrawings] = useState<DrawingObject[]>([]);
  const [draft, setDraft] = useState<{ tool: ShapeTool; points: Anchor[] }>();
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

  const latest = candles.at(-1);
  drawingsRef.current = drawings;

  // Assemble the compare overlay: attach a stable per-slot color to each symbol
  // that actually has data. Order follows `compareSymbols` so colors are stable.
  const compare = useMemo<CompareSeries[]>(() => {
    if (!compareSymbols || compareSymbols.length === 0 || !compareSeries) return [];
    return compareSymbols
      .map((symbol, index) => ({ symbol, color: compareColor(index), candles: compareSeries[symbol] ?? [] }))
      .filter((entry) => entry.candles.length > 0);
  }, [compareSymbols, compareSeries]);

  // Load / persist drawings per symbol.
  useEffect(() => {
    const loaded = loadDrawings(instrument.symbol);
    setDrawings(loaded);
    setSelectedId(undefined);
    setDraft(undefined);
    setTool("cursor");
  }, [instrument.symbol]);

  useEffect(() => {
    const id = window.setTimeout(() => saveDrawings(instrument.symbol, drawings), 250);
    return () => window.clearTimeout(id);
  }, [drawings, instrument.symbol]);

  // Keyboard: Esc cancels/deselects, Delete removes selected.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
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

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const render = () => {
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      applyCanvasTheme(canvas);
      drawChart({
        ctx,
        width: canvas.width,
        height: canvas.height,
        candles,
        chartType,
        decimals: instrument.decimals,
        view,
        indicators,
        drawings,
        draftDrawing: draftPreview,
        selectedDrawingId: selectedId,
        hoveredDrawingId: hoveredId,
        signals,
        trades,
        plots,
        showVolume,
        compare,
        baseSymbol: instrument.symbol,
        onViewport: (viewport) => {
          viewportRef.current = viewport;
        },
        onCompareLegend: (entries) => {
          setCompareLegend((current) => (sameLegend(current, entries) ? current : entries));
        }
      });
    };
    cancelAnimationFrame(frameRef.current ?? 0);
    frameRef.current = requestAnimationFrame(render);
    return () => cancelAnimationFrame(frameRef.current ?? 0);
  }, [candles, chartType, draftPreview, drawings, hoveredId, indicators, instrument.decimals, instrument.symbol, signals, trades, plots, compare, selectedId, showVolume, theme, view]);

  // Lazy-load older history when the viewport nears the left (oldest) edge.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport && viewport.start <= 40 && candles.length > 0) onNeedHistory?.();
  }, [view, candles.length, onNeedHistory]);

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
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resize = ([entry]: ResizeObserverEntry[]) => {
      const dpc = entry.devicePixelContentBoxSize?.[0];
      const width = dpc?.inlineSize ?? Math.round(entry.contentRect.width * devicePixelRatio);
      const height = dpc?.blockSize ?? Math.round(entry.contentRect.height * devicePixelRatio);
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
        setView((current) => ({ ...current }));
      }
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

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
      <div className="tool-rail" aria-label="Drawing tools">
        <ToolButton active={tool === "cursor"} label="Cursor (Esc)" onClick={() => setTool("cursor")}>
          <MousePointer2 size={15} aria-hidden="true" />
        </ToolButton>
        <ToolButton active={tool === "trendline"} label="Trend line" onClick={() => setTool("trendline")}>
          <TrendingUp size={15} aria-hidden="true" />
        </ToolButton>
        <ToolButton active={tool === "ray"} label="Ray" onClick={() => setTool("ray")}>
          <Move size={15} aria-hidden="true" />
        </ToolButton>
        <ToolButton active={tool === "hline"} label="Horizontal line" onClick={() => setTool("hline")}>
          <MoveHorizontal size={15} aria-hidden="true" />
        </ToolButton>
        <ToolButton active={tool === "vline"} label="Vertical line" onClick={() => setTool("vline")}>
          <MoveVertical size={15} aria-hidden="true" />
        </ToolButton>
        <ToolButton active={tool === "rectangle"} label="Rectangle" onClick={() => setTool("rectangle")}>
          <RectangleHorizontal size={15} aria-hidden="true" />
        </ToolButton>
        <ToolButton active={tool === "fib"} label="Fibonacci retracement" onClick={() => setTool("fib")}>
          <Ratio size={15} aria-hidden="true" />
        </ToolButton>
        <ToolButton active={tool === "long"} label="Long position" onClick={() => setTool("long")}>
          <TrendingUp size={15} aria-hidden="true" className="ic-up" />
        </ToolButton>
        <ToolButton active={tool === "short"} label="Short position" onClick={() => setTool("short")}>
          <TrendingDown size={15} aria-hidden="true" className="ic-down" />
        </ToolButton>
        <span className="rail-divider" aria-hidden="true" />
        <ToolButton active={magnet} label="Magnet (snap to price)" onClick={() => setMagnet((value) => !value)}>
          <Magnet size={15} aria-hidden="true" />
        </ToolButton>
        <span className="rail-spacer" aria-hidden="true" />
        <ToolButton active={showVolume} label="Toggle volume" onClick={() => setShowVolume((value) => !value)}>
          <Scaling size={15} aria-hidden="true" />
        </ToolButton>
        <button
          type="button"
          className="rail-trash"
          aria-label="Delete all drawings"
          title="Delete all drawings"
          onClick={() => {
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
            {trades && trades.length > 0 && <b>{trades.length} trades</b>}
            {signals && signals.length > 0 && <b>{signals.length} signals</b>}
            <button type="button" onClick={onClearStrategy} title="Remove from chart" aria-label="Remove strategy from chart">
              <X size={12} aria-hidden="true" />
            </button>
          </div>
        )}
        <ChartIndicatorOverlay
          indicators={indicators}
          onChange={onIndicatorsChange}
          onEditLogic={onEditIndicatorLogic}
          strategies={strategies}
          activeStrategyId={activeStrategyId}
          onAddStrategy={onAddStrategy}
        />
        {onAddCompare && onRemoveCompare && (
          <CompareControl
            candidates={compareCandidates ?? []}
            active={compareSymbols ?? []}
            max={MAX_COMPARE}
            legend={compareLegend}
            onAdd={onAddCompare}
            onRemove={onRemoveCompare}
          />
        )}
        <button
          type="button"
          className="scale-toggle"
          aria-label="Cycle price scale"
          title="Price scale (linear / log / percent)"
          onClick={cyclePriceMode}
        >
          {view.priceMode === "linear" ? "LIN" : view.priceMode === "log" ? "LOG" : "%"}
        </button>
        <canvas
          ref={canvasRef}
          className={`chart-canvas ${tool === "cursor" ? "" : "drawing"}`}
          role="img"
          aria-label={`${instrument.symbol} ${chartType} chart on ${timeframe}`}
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
          }}
          onPointerUp={(event) => {
            event.currentTarget.releasePointerCapture(event.pointerId);
            interactionRef.current = undefined;
          }}
          onWheel={(event) => {
            const next = Math.min(4, Math.max(0.4, view.zoom + (event.deltaY > 0 ? -0.1 : 0.1)));
            setView((current) => ({ ...current, zoom: next }));
          }}
        />
      </div>
      <p className="sr-only" aria-live="polite">
        Latest {instrument.symbol} close is {latest?.close.toFixed(instrument.decimals) ?? "loading"}.
      </p>
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
      entry.color === other.color &&
      entry.base === other.base &&
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

/** Sync the canvas palette to the active CSS theme variables. */
function applyCanvasTheme(el: HTMLElement) {
  const styles = getComputedStyle(el);
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
