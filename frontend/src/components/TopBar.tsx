import {
  Activity,
  AreaChart,
  BarChart3,
  Blocks,
  Bot,
  CandlestickChart,
  ChevronDown,
  Command,
  GitCommitVertical,
  LineChart,
  Moon,
  PanelLeft,
  PanelRight,
  Radio,
  Sun,
  Workflow
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { CatalogResponse, ChartType, Instrument, Timeframe } from "../types";
import type { ConnectionState } from "../hooks/useMarketStream";

interface TopBarProps {
  catalog?: CatalogResponse;
  instrument: Instrument;
  timeframe: Timeframe;
  chartType: ChartType;
  mode: "chart" | "strategy" | "trade";
  connection: ConnectionState;
  theme: "dark" | "light";
  leftOpen: boolean;
  rightOpen: boolean;
  onTimeframeChange: (timeframe: Timeframe) => void;
  onChartTypeChange: (chartType: ChartType) => void;
  onModeChange: (mode: "chart" | "strategy" | "trade") => void;
  onStrategyWarmup: () => void;
  onOpenPalette: () => void;
  onToggleTheme: () => void;
  onToggleLeft: () => void;
  onToggleRight: () => void;
}

const chartIcons = {
  candles: CandlestickChart,
  heikin: Activity,
  bars: BarChart3,
  line: LineChart,
  area: AreaChart,
  baseline: GitCommitVertical,
  renko: Blocks
} satisfies Record<ChartType, typeof CandlestickChart>;

const chartLabels = {
  candles: "Candles",
  heikin: "Heikin Ashi",
  bars: "Bars",
  line: "Line",
  area: "Area",
  baseline: "Baseline",
  renko: "Renko"
} satisfies Record<ChartType, string>;

const statusLabels: Record<ConnectionState, string> = {
  connected: "live",
  fallback: "synth",
  error: "offline",
  connecting: "sync"
};

/** Timeframes shown inline in the compact top-bar segment. The rest live in the
 * "more" dropdown so every timeframe stays selectable without cluttering the bar. */
const COMPACT_TIMEFRAMES: Timeframe[] = ["5m", "15m", "1h", "4h", "1d", "1w"];

export function TopBar({
  catalog,
  instrument,
  timeframe,
  chartType,
  mode,
  connection,
  theme,
  leftOpen,
  rightOpen,
  onTimeframeChange,
  onChartTypeChange,
  onModeChange,
  onStrategyWarmup,
  onOpenPalette,
  onToggleTheme,
  onToggleLeft,
  onToggleRight
}: TopBarProps) {
  return (
    <header className="topbar">
      <div className="brand">
        <Radio size={16} strokeWidth={1.75} aria-hidden="true" />
        <strong>SaltanatbotV2</strong>
      </div>

      <button
        type="button"
        className="symbol-chip"
        onClick={onOpenPalette}
        title="Switch symbol (⌘K)"
        aria-label={`Current instrument ${instrument.symbol}. Open symbol search`}
      >
        <strong>{instrument.symbol}</strong>
        <ChevronDown size={12} strokeWidth={1.75} aria-hidden="true" />
      </button>

      <span className="divider-v" aria-hidden="true" />

      <TimeframeControl catalog={catalog} timeframe={timeframe} onTimeframeChange={onTimeframeChange} />

      <ChartTypeMenu catalog={catalog} chartType={chartType} onChartTypeChange={onChartTypeChange} />

      <div className="topbar-actions">
        <div className="segmented mode-tabs" aria-label="Workspace mode">
          <button
            type="button"
            className={mode === "chart" ? "active" : ""}
            onClick={() => onModeChange("chart")}
            aria-pressed={mode === "chart"}
          >
            <CandlestickChart size={14} strokeWidth={1.75} aria-hidden="true" />
            <span>Chart</span>
          </button>
          <button
            type="button"
            className={mode === "strategy" ? "active" : ""}
            onClick={() => onModeChange("strategy")}
            onFocus={onStrategyWarmup}
            onPointerEnter={onStrategyWarmup}
            aria-pressed={mode === "strategy"}
          >
            <Workflow size={14} strokeWidth={1.75} aria-hidden="true" />
            <span>Strategy</span>
          </button>
          <button
            type="button"
            className={mode === "trade" ? "active" : ""}
            onClick={() => onModeChange("trade")}
            aria-pressed={mode === "trade"}
          >
            <Bot size={14} strokeWidth={1.75} aria-hidden="true" />
            <span>Trade</span>
          </button>
        </div>

        <span className="divider-v" aria-hidden="true" />

        {mode === "chart" && (
          <>
            <button
              type="button"
              className={`icon-button ${leftOpen ? "active" : ""}`}
              onClick={onToggleLeft}
              title="Toggle markets panel"
              aria-label="Toggle markets panel"
              aria-pressed={leftOpen}
            >
              <PanelLeft size={15} strokeWidth={1.75} aria-hidden="true" />
            </button>
            <button
              type="button"
              className={`icon-button ${rightOpen ? "active" : ""}`}
              onClick={onToggleRight}
              title="Toggle instrument panel"
              aria-label="Toggle instrument panel"
              aria-pressed={rightOpen}
            >
              <PanelRight size={15} strokeWidth={1.75} aria-hidden="true" />
            </button>
          </>
        )}
        <button type="button" className="icon-button" onClick={onOpenPalette} title="Command palette (⌘K)" aria-label="Open command palette">
          <Command size={14} strokeWidth={1.75} aria-hidden="true" />
        </button>
        <button type="button" className="icon-button" onClick={onToggleTheme} title="Toggle theme" aria-label="Toggle light or dark theme">
          {theme === "dark" ? <Sun size={14} strokeWidth={1.75} aria-hidden="true" /> : <Moon size={14} strokeWidth={1.75} aria-hidden="true" />}
        </button>
        <div className={`status-pill ${connection}`} title={`Feed: ${connection}`} role="status">
          <i aria-hidden="true" />
          {statusLabels[connection]}
        </div>
      </div>
    </header>
  );
}

function TimeframeControl({
  catalog,
  timeframe,
  onTimeframeChange
}: {
  catalog?: CatalogResponse;
  timeframe: Timeframe;
  onTimeframeChange: (timeframe: Timeframe) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  const all = catalog?.timeframes ?? [];
  const inline = all.filter((tf) => COMPACT_TIMEFRAMES.includes(tf));
  // Anything not shown inline (30m, 2h, 1M, plus 1m) lives in the dropdown.
  const extra = all.filter((tf) => !COMPACT_TIMEFRAMES.includes(tf));
  const activeInExtra = extra.includes(timeframe);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="timeframe-control" ref={wrapRef}>
      <div className="segmented timeframes" aria-label="Timeframe">
        {inline.map((item) => (
          <button
            type="button"
            key={item}
            className={item === timeframe ? "active" : ""}
            onClick={() => onTimeframeChange(item)}
            aria-pressed={item === timeframe}
          >
            {item}
          </button>
        ))}
      </div>
      {extra.length > 0 && (
        <div className="timeframe-more-wrap">
          <button
            type="button"
            className={`charttype-button timeframe-more ${activeInExtra ? "active" : ""}`}
            onClick={() => setOpen((value) => !value)}
            title="More timeframes"
            aria-haspopup="menu"
            aria-expanded={open}
          >
            <span>{activeInExtra ? timeframe : "···"}</span>
            <ChevronDown size={12} strokeWidth={1.75} aria-hidden="true" />
          </button>
          {open && (
            <div className="charttype-menu timeframe-menu" role="menu">
              {extra.map((item) => (
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={item === timeframe}
                  key={item}
                  className={item === timeframe ? "active" : ""}
                  onClick={() => {
                    onTimeframeChange(item);
                    setOpen(false);
                  }}
                >
                  {item}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ChartTypeMenu({
  catalog,
  chartType,
  onChartTypeChange
}: {
  catalog?: CatalogResponse;
  chartType: ChartType;
  onChartTypeChange: (chartType: ChartType) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const Icon = chartIcons[chartType];

  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="charttype-menu-wrap" ref={wrapRef}>
      <button
        type="button"
        className="charttype-button"
        onClick={() => setOpen((value) => !value)}
        title="Chart type"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Icon size={15} strokeWidth={1.75} aria-hidden="true" />
        <ChevronDown size={12} strokeWidth={1.75} aria-hidden="true" />
      </button>
      {open && (
        <div className="charttype-menu" role="menu">
          {catalog?.chartTypes.map((item) => {
            const ItemIcon = chartIcons[item];
            return (
              <button
                type="button"
                role="menuitemradio"
                aria-checked={item === chartType}
                key={item}
                className={item === chartType ? "active" : ""}
                onClick={() => {
                  onChartTypeChange(item);
                  setOpen(false);
                }}
              >
                <ItemIcon size={14} strokeWidth={1.75} aria-hidden="true" />
                {chartLabels[item]}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
