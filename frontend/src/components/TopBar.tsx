import {
  Activity,
  AreaChart,
  ArrowLeftRight,
  BarChart3,
  Blocks,
  Bot,
  CandlestickChart,
  ChevronDown,
  Command,
  Columns2,
  Download,
  GitCommitVertical,
  Grid2X2,
  LayoutDashboard,
  Keyboard,
  LineChart,
  Moon,
  PanelLeft,
  PanelRight,
  Plus,
  RotateCcw,
  Rows2,
  Square,
  Sun,
  Trash2,
  Upload,
  Workflow
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { translate, type Locale } from "../i18n";
import { shellText } from "../i18n/shell";
import type { CatalogResponse, ChartType, Instrument, Timeframe } from "../types";
import type { ConnectionState } from "../hooks/useMarketStream";
import type { ChartLayoutPreset, Workspace } from "../workspace/workspaces";

interface TopBarProps {
  catalog?: CatalogResponse;
  instrument: Instrument;
  timeframe: Timeframe;
  chartType: ChartType;
  mode: "chart" | "strategy" | "trade";
  connection: ConnectionState;
  theme: "dark" | "light";
  locale: Locale;
  leftOpen: boolean;
  rightOpen: boolean;
  panelsSwapped: boolean;
  workspaces: Workspace[];
  activeWorkspaceId?: string;
  layoutPreset: ChartLayoutPreset;
  onSaveWorkspace: (name: string) => void;
  onApplyWorkspace: (id: string) => void;
  onDeleteWorkspace: (id: string) => void;
  onExportWorkspace: (id: string) => Promise<void>;
  onImportWorkspace: (raw: string) => Promise<boolean>;
  onRollbackWorkspace: (id: string, revision: number) => boolean;
  onLayoutPresetChange: (preset: ChartLayoutPreset) => void;
  onTimeframeChange: (timeframe: Timeframe) => void;
  onChartTypeChange: (chartType: ChartType) => void;
  onModeChange: (mode: "chart" | "strategy" | "trade") => void;
  onStrategyWarmup: () => void;
  onOpenPalette: () => void;
  onOpenShortcutSettings: () => void;
  onToggleTheme: () => void;
  onToggleLocale: () => void;
  onToggleLeft: () => void;
  onToggleRight: () => void;
  onSwapPanels: () => void;
}

const chartIcons = {
  candles: CandlestickChart,
  hollow: Square,
  heikin: Activity,
  bars: BarChart3,
  line: LineChart,
  step: GitCommitVertical,
  area: AreaChart,
  baseline: GitCommitVertical,
  renko: Blocks
} satisfies Record<ChartType, typeof CandlestickChart>;

const chartLabelKeys = { candles: "candlesType", hollow: "hollowType", heikin: "heikinType", bars: "barsType", line: "lineType", step: "stepType", area: "areaType", baseline: "baselineType", renko: "renkoType" } as const;

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
  locale,
  leftOpen,
  rightOpen,
  panelsSwapped,
  workspaces,
  activeWorkspaceId,
  layoutPreset,
  onSaveWorkspace,
  onApplyWorkspace,
  onDeleteWorkspace,
  onExportWorkspace,
  onImportWorkspace,
  onRollbackWorkspace,
  onLayoutPresetChange,
  onTimeframeChange,
  onChartTypeChange,
  onModeChange,
  onStrategyWarmup,
  onOpenPalette,
  onOpenShortcutSettings,
  onToggleTheme,
  onToggleLocale,
  onToggleLeft,
  onToggleRight,
  onSwapPanels
}: TopBarProps) {
  return (
    <header className="topbar">
      <div className="brand">
        <img className="brand-logo" src="/logo.svg" alt="" width="26" height="26" aria-hidden="true" />
        <strong aria-hidden="true">SaltanatbotV2</strong>
        <span className="sr-only">SaltanatbotV2</span>
      </div>

      <button
        type="button"
        className="symbol-chip"
        onClick={onOpenPalette}
        title={shellText(locale, "switchSymbol")}
        aria-label={`${shellText(locale, "currentInstrument")} ${instrument.symbol}. ${shellText(locale, "openSymbolSearch")}`}
      >
        <strong>{instrument.symbol}</strong>
        <ChevronDown size={12} strokeWidth={1.75} aria-hidden="true" />
      </button>

      <span className="divider-v" aria-hidden="true" />

      <TimeframeControl locale={locale} catalog={catalog} timeframe={timeframe} onTimeframeChange={onTimeframeChange} />

      <ChartTypeMenu locale={locale} catalog={catalog} chartType={chartType} onChartTypeChange={onChartTypeChange} />

      <div className="topbar-actions">
        <div className="segmented mode-tabs" aria-label={shellText(locale, "workspaceMode")}>
          <button
            type="button"
            className={mode === "chart" ? "active" : ""}
            onClick={() => onModeChange("chart")}
            aria-pressed={mode === "chart"}
          >
            <CandlestickChart size={14} strokeWidth={1.75} aria-hidden="true" />
            <span>{translate(locale, "chart")}</span>
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
            <span>{translate(locale, "strategy")}</span>
          </button>
          <button
            type="button"
            className={mode === "trade" ? "active" : ""}
            onClick={() => onModeChange("trade")}
            aria-pressed={mode === "trade"}
          >
            <Bot size={14} strokeWidth={1.75} aria-hidden="true" />
            <span>{translate(locale, "trade")}</span>
          </button>
        </div>

        <span className="divider-v" aria-hidden="true" />

        {mode === "chart" && (
          <>
            <button
              type="button"
              className={`icon-button ${leftOpen ? "active" : ""}`}
              onClick={onToggleLeft}
              title={translate(locale, "toggleMarkets")}
              aria-label={translate(locale, "toggleMarkets")}
              aria-pressed={leftOpen}
            >
              <PanelLeft size={15} strokeWidth={1.75} aria-hidden="true" />
            </button>
            <button
              type="button"
              className={`icon-button ${rightOpen ? "active" : ""}`}
              onClick={onToggleRight}
              title={translate(locale, "toggleInstrument")}
              aria-label={translate(locale, "toggleInstrument")}
              aria-pressed={rightOpen}
            >
              <PanelRight size={15} strokeWidth={1.75} aria-hidden="true" />
            </button>
            <LayoutMenu locale={locale} preset={layoutPreset} onChange={onLayoutPresetChange} />
            <button type="button" className={`icon-button ${panelsSwapped ? "active" : ""}`} onClick={onSwapPanels} aria-pressed={panelsSwapped} title={shellText(locale, "swapDockedPanels")} aria-label={shellText(locale, "swapDockedPanels")}>
              <ArrowLeftRight size={15} aria-hidden="true" />
            </button>
          </>
        )}
        <WorkspacesMenu
          locale={locale}
          workspaces={workspaces}
          activeWorkspaceId={activeWorkspaceId}
          onSave={onSaveWorkspace}
          onApply={onApplyWorkspace}
          onDelete={onDeleteWorkspace}
          onExport={onExportWorkspace}
          onImport={onImportWorkspace}
          onRollback={onRollbackWorkspace}
        />
        <button type="button" className="icon-button" onClick={onOpenPalette} title={shellText(locale, "commandPalette")} aria-label={translate(locale, "openPalette")}>
          <Command size={14} strokeWidth={1.75} aria-hidden="true" />
        </button>
        <button type="button" className="icon-button" onClick={onOpenShortcutSettings} title={shellText(locale, "keyboardShortcuts")} aria-label={shellText(locale, "keyboardShortcuts")}>
          <Keyboard size={14} strokeWidth={1.75} aria-hidden="true" />
        </button>
        <button type="button" className="icon-button" onClick={onToggleTheme} title={translate(locale, "toggleTheme")} aria-label={translate(locale, "toggleTheme")}>
          {theme === "dark" ? <Sun size={14} strokeWidth={1.75} aria-hidden="true" /> : <Moon size={14} strokeWidth={1.75} aria-hidden="true" />}
        </button>
        <button
          type="button"
          className="icon-button locale-toggle"
          onClick={onToggleLocale}
          title={locale === "en" ? "Русский" : "English"}
          aria-label={translate(locale, locale === "en" ? "switchToRussian" : "switchToEnglish")}
        >
          {locale.toUpperCase()}
        </button>
        <div className={`status-pill ${connection}`} title={`${shellText(locale, "feedStatus")}: ${connection}`} role="status">
          <i aria-hidden="true" />
          {translate(locale, connection === "connected" ? "statusConnected" : connection === "fallback" ? "statusFallback" : connection === "error" ? "statusError" : "statusConnecting")}
        </div>
      </div>
    </header>
  );
}

const layoutOptions: Array<{ id: ChartLayoutPreset; icon: typeof Square; label: "singleChart" | "verticalSplit" | "horizontalSplit" | "fourChartGrid" }> = [
  { id: "single", icon: Square, label: "singleChart" },
  { id: "split-vertical", icon: Columns2, label: "verticalSplit" },
  { id: "split-horizontal", icon: Rows2, label: "horizontalSplit" },
  { id: "grid-4", icon: Grid2X2, label: "fourChartGrid" }
];

function LayoutMenu({ locale, preset, onChange }: { locale: Locale; preset: ChartLayoutPreset; onChange: (preset: ChartLayoutPreset) => void }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const Current = layoutOptions.find((item) => item.id === preset)?.icon ?? Square;
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!wrapRef.current?.contains(event.target as Node)) setOpen(false); };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);
  return (
    <div className="charttype-menu-wrap" ref={wrapRef}>
      <button type="button" className="icon-button" aria-label={shellText(locale, "chartLayout")} title={shellText(locale, "chartLayout")} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <Current size={15} aria-hidden="true" />
      </button>
      {open && (
        <div className="charttype-menu layout-menu" role="menu">
          {layoutOptions.map((item) => {
            const Icon = item.icon;
            return (
              <button type="button" role="menuitemradio" aria-checked={item.id === preset} className={item.id === preset ? "active" : ""} key={item.id} onClick={() => { onChange(item.id); setOpen(false); }}>
                <Icon size={14} aria-hidden="true" /> {shellText(locale, item.label)}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function TimeframeControl({
  locale,
  catalog,
  timeframe,
  onTimeframeChange
}: {
  locale: Locale;
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
      <div className="segmented timeframes" aria-label={shellText(locale, "timeframe")}>
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
            title={shellText(locale, "moreTimeframes")}
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
  locale,
  catalog,
  chartType,
  onChartTypeChange
}: {
  locale: Locale;
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
        title={shellText(locale, "chartType")}
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
                {shellText(locale, chartLabelKeys[item])}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function WorkspacesMenu({
  locale,
  workspaces,
  activeWorkspaceId,
  onSave,
  onApply,
  onDelete,
  onExport,
  onImport,
  onRollback
}: {
  locale: Locale;
  workspaces: Workspace[];
  activeWorkspaceId?: string;
  onSave: (name: string) => void;
  onApply: (id: string) => void;
  onDelete: (id: string) => void;
  onExport: (id: string) => Promise<void>;
  onImport: (raw: string) => Promise<boolean>;
  onRollback: (id: string, revision: number) => boolean;
}) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState("");
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

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

  const saveCurrent = () => {
    const name = window.prompt(shellText(locale, "saveLayoutPrompt"));
    if (name === null) return;
    if (name.trim()) onSave(name);
  };

  return (
    <div className="charttype-menu-wrap workspaces-menu-wrap" ref={wrapRef}>
      <button
        type="button"
        className="icon-button"
        onClick={() => setOpen((value) => !value)}
        title={shellText(locale, "savedWorkspaces")}
        aria-label={shellText(locale, "savedWorkspaces")}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <LayoutDashboard size={15} strokeWidth={1.75} aria-hidden="true" />
      </button>
      {open && (
        <div className="charttype-menu workspaces-menu" role="menu">
          <button
            type="button"
            className="workspace-save"
            onClick={() => {
              saveCurrent();
              setOpen(false);
            }}
          >
            <Plus size={14} strokeWidth={1.75} aria-hidden="true" />
            {shellText(locale, "saveCurrentAs")}
          </button>
          <button type="button" className="workspace-save" onClick={() => fileRef.current?.click()}>
            <Upload size={14} strokeWidth={1.75} aria-hidden="true" />
            {shellText(locale, "importWorkspace")}
          </button>
          <input
            ref={fileRef}
            className="sr-only"
            type="file"
            accept=".json,.saltanat-workspace.json,application/json"
            onChange={async (event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (!file) return;
              const ok = await onImport(await file.text());
              setStatus(shellText(locale, ok ? "workspaceImported" : "workspaceImportInvalid"));
            }}
          />
          <span className="sr-only" role="status" aria-live="polite">{status}</span>
          {workspaces.length === 0 ? (
            <div className="workspace-empty">{shellText(locale, "noSavedWorkspaces")}</div>
          ) : (
            <div className="workspace-list">
              {workspaces.map((workspace) => (
                <div className={`workspace-row ${workspace.id === activeWorkspaceId ? "active" : ""}`} key={workspace.id}>
                  <button
                    type="button"
                    className="workspace-apply"
                    onClick={() => {
                      onApply(workspace.id);
                      setOpen(false);
                    }}
                    title={`${workspace.symbol} · ${workspace.timeframe} · ${workspace.chartType}`}
                  >
                    <strong>{workspace.name}</strong>
                    <span>{workspace.symbol} · {workspace.timeframe} · {workspace.chartType} · v{workspace.revision}</span>
                  </button>
                  {workspace.history.length > 0 && (
                    <button
                      type="button"
                      className="workspace-delete"
                      onClick={() => onRollback(workspace.id, workspace.history.at(-1)!.revision)}
                      title={shellText(locale, "rollbackWorkspace")}
                      aria-label={`${shellText(locale, "rollbackWorkspace")} ${workspace.name}`}
                    >
                      <RotateCcw size={13} strokeWidth={1.75} aria-hidden="true" />
                    </button>
                  )}
                  <button
                    type="button"
                    className="workspace-delete"
                    onClick={() => void onExport(workspace.id)}
                    title={shellText(locale, "exportWorkspace")}
                    aria-label={`${shellText(locale, "exportWorkspace")} ${workspace.name}`}
                  >
                    <Download size={13} strokeWidth={1.75} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    className="workspace-delete"
                    onClick={() => onDelete(workspace.id)}
                    title={shellText(locale, "deleteWorkspace")}
                    aria-label={`${shellText(locale, "deleteWorkspace")} ${workspace.name}`}
                  >
                    <Trash2 size={13} strokeWidth={1.75} aria-hidden="true" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
