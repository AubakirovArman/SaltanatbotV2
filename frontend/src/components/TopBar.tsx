import { ArrowLeftRight, Bot, CandlestickChart, ChevronDown, Command, Download, HardDriveDownload, LayoutDashboard, Keyboard, MoreHorizontal, Moon, PanelLeft, PanelRight, Plus, RotateCcw, ScanSearch, Sun, Trash2, Upload, Workflow } from "lucide-react";
import { useContext, useEffect, useRef, useState } from "react";
import { AccountLauncher } from "../auth/AccountDialog";
import { AuthContext } from "../auth/AuthRoot";
import { nextLocale, translate, type Locale } from "../i18n";
import { automationText } from "../i18n/automation";
import { shellText } from "../i18n/shell";
import type { CatalogResponse, ChartType, Instrument, Timeframe } from "../types";
import type { ConnectionState } from "../hooks/useMarketStream";
import type { ChartLayoutPreset, Workspace } from "../workspace/workspaces";
import { chartTypeIcons, chartTypeLabel } from "./chartTypePresentation";
import { LayoutMenu } from "./topbar/LayoutMenu";
import { RuntimeProfileBadge } from "./RuntimeProfileBadge";
import { useRunningBotsSummary } from "../trading/useRunningBotsSummary";

interface TopBarProps {
  catalog?: CatalogResponse;
  instrument: Instrument;
  timeframe: Timeframe;
  chartType: ChartType;
  mode: "chart" | "strategy" | "trade" | "screener";
  connection: ConnectionState;
  theme: "dark" | "light";
  locale: Locale;
  leftOpen: boolean;
  rightOpen: boolean;
  mobilePanels?: boolean;
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
  canUseDistinctMarkets: boolean;
  onDistinctMarkets: () => void;
  onTimeframeChange: (timeframe: Timeframe) => void;
  onChartTypeChange: (chartType: ChartType) => void;
  onModeChange: (mode: "chart" | "strategy" | "trade" | "screener") => void;
  onOpenRobotsCenter: () => void;
  onStrategyWarmup: () => void;
  onOpenPalette: () => void;
  onOpenShortcutSettings: () => void;
  onOpenOfflineResearch: () => void;
  onToggleTheme: () => void;
  onToggleLocale: () => void;
  onToggleLeft: () => void;
  onToggleRight: () => void;
  onSwapPanels: () => void;
}

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
  mobilePanels = false,
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
  canUseDistinctMarkets,
  onDistinctMarkets,
  onTimeframeChange,
  onChartTypeChange,
  onModeChange,
  onOpenRobotsCenter,
  onStrategyWarmup,
  onOpenPalette,
  onOpenShortcutSettings,
  onOpenOfflineResearch,
  onToggleTheme,
  onToggleLocale,
  onToggleLeft,
  onToggleRight,
  onSwapPanels
}: TopBarProps) {
  const targetLocale = nextLocale(locale);
  const auth = useContext(AuthContext);
  const { count: runningBotsCount, status: runningBotsStatus, paperOnly: paperOnlyRuntime } = useRunningBotsSummary();
  const [mobileUtilitiesOpen, setMobileUtilitiesOpen] = useState(false);
  const utilityRef = useRef<HTMLDivElement | null>(null);
  const utilityLabel = locale === "ru" ? "Дополнительные инструменты" : locale === "kk" ? "Қосымша құралдар" : "More tools";

  useEffect(() => {
    setMobileUtilitiesOpen(false);
  }, [mode]);

  useEffect(() => {
    if (!mobileUtilitiesOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!utilityRef.current?.contains(event.target as Node)) setMobileUtilitiesOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileUtilitiesOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [mobileUtilitiesOpen]);

  return (
    <header className="topbar">
      <div className="brand">
        <img className="brand-logo" src="/logo.svg" alt="" width="26" height="26" aria-hidden="true" />
        <strong aria-hidden="true">SaltanatbotV2</strong>
        <span className="sr-only">SaltanatbotV2</span>
      </div>

      {paperOnlyRuntime && <RuntimeProfileBadge locale={locale} />}

      <button type="button" className="symbol-chip" onClick={onOpenPalette} title={shellText(locale, "switchSymbol")} aria-label={`${shellText(locale, "currentInstrument")} ${instrument.symbol}. ${shellText(locale, "openSymbolSearch")}`}>
        <strong>{instrument.symbol}</strong>
        <ChevronDown size={12} strokeWidth={1.75} aria-hidden="true" />
      </button>

      <span className="divider-v" aria-hidden="true" />

      <TimeframeControl locale={locale} catalog={catalog} timeframe={timeframe} onTimeframeChange={onTimeframeChange} />

      <ChartTypeMenu locale={locale} catalog={catalog} chartType={chartType} onChartTypeChange={onChartTypeChange} />

      <div className="topbar-actions">
        <nav className="workspace-navigation" aria-label={automationText(locale, "primaryNavigation")}>
          <div className="segmented space-tabs">
            <button type="button" className={mode === "chart" ? "active" : ""} onClick={() => onModeChange("chart")} aria-pressed={mode === "chart"}>
              <CandlestickChart size={14} strokeWidth={1.75} aria-hidden="true" />
              <span>{automationText(locale, "monitoring")}</span>
            </button>
            <button
              type="button"
              className={`automation-parent-tab ${mode === "strategy" || mode === "trade" ? "active" : ""}`}
              onClick={() => {
                onStrategyWarmup();
                onModeChange("strategy");
              }}
              onFocus={onStrategyWarmup}
              onPointerEnter={onStrategyWarmup}
              aria-pressed={mode === "strategy" || mode === "trade"}
            >
              <Workflow size={14} strokeWidth={1.75} aria-hidden="true" />
              <span>{automationText(locale, "automation")}</span>
            </button>
            <button type="button" className={mode === "screener" ? "active" : ""} onClick={() => onModeChange("screener")} aria-pressed={mode === "screener"}>
              <ScanSearch size={14} strokeWidth={1.75} aria-hidden="true" />
              <span>{automationText(locale, "screener")}</span>
            </button>
          </div>

          <div className={`segmented automation-tabs ${mode === "strategy" || mode === "trade" ? "context-active" : ""}`} role="group" aria-label={automationText(locale, "automationNavigation")}>
            <button type="button" className={mode === "strategy" ? "active" : ""} onClick={() => onModeChange("strategy")} onFocus={onStrategyWarmup} onPointerEnter={onStrategyWarmup} aria-pressed={mode === "strategy"}>
              <Workflow size={13} strokeWidth={1.75} aria-hidden="true" />
              <span>{automationText(locale, "strategies")}</span>
            </button>
            <button type="button" className={mode === "trade" ? "active" : ""} onClick={() => onModeChange("trade")} aria-pressed={mode === "trade"}>
              <Bot size={13} strokeWidth={1.75} aria-hidden="true" />
              <span>{automationText(locale, "robots")}</span>
              <strong className="mobile-robots-count" aria-hidden="true">
                {runningBotsStatus === "ready" ? (runningBotsCount ?? 0) : "—"}
              </strong>
            </button>
          </div>
        </nav>

        <button
          type="button"
          className={`running-bots-button ${mode === "trade" ? "active" : ""} ${runningBotsStatus === "error" ? "degraded" : ""}`}
          onClick={onOpenRobotsCenter}
          title={runningBotsStatus === "ready" ? automationText(locale, "openRobotsCenter") : automationText(locale, "runningUnavailable")}
          aria-label={`${automationText(locale, "openRobotsCenter")}. ${runningBotsStatus === "ready" ? `${automationText(locale, "running")}: ${runningBotsCount ?? 0}` : automationText(locale, "runningUnavailable")}`}
        >
          <Bot size={14} strokeWidth={1.75} aria-hidden="true" />
          <span>{automationText(locale, "running")}:</span>
          <strong aria-live="polite" aria-atomic="true">
            {runningBotsStatus === "ready" ? (runningBotsCount ?? 0) : "—"}
          </strong>
        </button>

        <div className="mobile-utility-wrap" ref={utilityRef}>
          <button type="button" className={`icon-button mobile-utility-toggle ${mobileUtilitiesOpen ? "active" : ""}`} onClick={() => setMobileUtilitiesOpen((open) => !open)} aria-label={utilityLabel} aria-expanded={mobileUtilitiesOpen} aria-controls="topbar-utility-actions">
            <MoreHorizontal size={18} strokeWidth={1.75} aria-hidden="true" />
          </button>

          <div id="topbar-utility-actions" className={`topbar-utility-actions ${mobileUtilitiesOpen ? "open" : ""}`}>
            {mode === "chart" && (
              <>
                <button
                  type="button"
                  className={`icon-button ${leftOpen ? "active" : ""}`}
                  onClick={() => {
                    onToggleLeft();
                    setMobileUtilitiesOpen(false);
                  }}
                  title={translate(locale, "toggleMarkets")}
                  aria-label={translate(locale, "toggleMarkets")}
                  aria-pressed={leftOpen}
                  aria-controls={mobilePanels ? "markets-panel" : undefined}
                  aria-haspopup={mobilePanels ? "dialog" : undefined}
                >
                  <PanelLeft size={15} strokeWidth={1.75} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className={`icon-button ${rightOpen ? "active" : ""}`}
                  onClick={() => {
                    onToggleRight();
                    setMobileUtilitiesOpen(false);
                  }}
                  title={translate(locale, "toggleInstrument")}
                  aria-label={translate(locale, "toggleInstrument")}
                  aria-pressed={rightOpen}
                  aria-controls={mobilePanels ? "instrument-panel" : undefined}
                  aria-haspopup={mobilePanels ? "dialog" : undefined}
                >
                  <PanelRight size={15} strokeWidth={1.75} aria-hidden="true" />
                </button>
                <LayoutMenu locale={locale} preset={layoutPreset} canUseDistinctMarkets={canUseDistinctMarkets} onChange={onLayoutPresetChange} onDistinctMarkets={onDistinctMarkets} />
                {!mobilePanels && (
                  <button type="button" className={`icon-button ${panelsSwapped ? "active" : ""}`} onClick={onSwapPanels} aria-pressed={panelsSwapped} title={shellText(locale, "swapDockedPanels")} aria-label={shellText(locale, "swapDockedPanels")}>
                    <ArrowLeftRight size={15} aria-hidden="true" />
                  </button>
                )}
              </>
            )}
            <WorkspacesMenu locale={locale} workspaces={workspaces} activeWorkspaceId={activeWorkspaceId} onSave={onSaveWorkspace} onApply={onApplyWorkspace} onDelete={onDeleteWorkspace} onExport={onExportWorkspace} onImport={onImportWorkspace} onRollback={onRollbackWorkspace} />
            <button
              type="button"
              className="icon-button"
              onClick={() => {
                onOpenPalette();
                setMobileUtilitiesOpen(false);
              }}
              title={shellText(locale, "commandPalette")}
              aria-label={translate(locale, "openPalette")}
            >
              <Command size={14} strokeWidth={1.75} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="icon-button"
              onClick={() => {
                onOpenShortcutSettings();
                setMobileUtilitiesOpen(false);
              }}
              title={shellText(locale, "keyboardShortcuts")}
              aria-label={shellText(locale, "keyboardShortcuts")}
            >
              <Keyboard size={14} strokeWidth={1.75} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="icon-button"
              onClick={() => {
                onOpenOfflineResearch();
                setMobileUtilitiesOpen(false);
              }}
              title={shellText(locale, "offlineResearch")}
              aria-label={shellText(locale, "offlineResearch")}
            >
              <HardDriveDownload size={14} strokeWidth={1.75} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="icon-button"
              onClick={() => {
                onToggleTheme();
                setMobileUtilitiesOpen(false);
              }}
              title={translate(locale, "toggleTheme")}
              aria-label={translate(locale, "toggleTheme")}
            >
              {theme === "dark" ? <Sun size={14} strokeWidth={1.75} aria-hidden="true" /> : <Moon size={14} strokeWidth={1.75} aria-hidden="true" />}
            </button>
            <button
              type="button"
              className="icon-button locale-toggle"
              onClick={() => {
                onToggleLocale();
                setMobileUtilitiesOpen(false);
              }}
              title={translate(locale, targetLocale === "ru" ? "switchToRussian" : targetLocale === "kk" ? "switchToKazakh" : "switchToEnglish")}
              aria-label={translate(locale, targetLocale === "ru" ? "switchToRussian" : targetLocale === "kk" ? "switchToKazakh" : "switchToEnglish")}
            >
              {locale.toUpperCase()}
            </button>
            <div className={`status-pill ${connection}`} title={`${shellText(locale, "feedStatus")}: ${connection}`} role="status">
              <i aria-hidden="true" />
              {translate(locale, connection === "connected" ? "statusConnected" : connection === "fallback" ? "statusFallback" : connection === "error" ? "statusError" : "statusConnecting")}
            </div>
            {auth?.user && (
              <AccountLauncher
                locale={locale}
                user={auth.user}
                onOpen={() => {
                  auth.openAccount();
                  setMobileUtilitiesOpen(false);
                }}
              />
            )}
          </div>
        </div>
      </div>
    </header>
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
  // The dropdown repeats every interval because responsive CSS hides the
  // inline segment on medium-width desktops. Keeping the complete list here
  // prevents those intervals from becoming unreachable at that breakpoint.
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
      <div className="segmented timeframes" role="group" aria-label={shellText(locale, "timeframe")}>
        {inline.map((item) => (
          <button type="button" key={item} className={item === timeframe ? "active" : ""} onClick={() => onTimeframeChange(item)} aria-pressed={item === timeframe}>
            {item}
          </button>
        ))}
      </div>
      {extra.length > 0 && (
        <div className="timeframe-more-wrap">
          <button type="button" className={`charttype-button timeframe-more ${activeInExtra ? "active" : ""}`} onClick={() => setOpen((value) => !value)} title={shellText(locale, "moreTimeframes")} aria-label={shellText(locale, "moreTimeframes")} aria-haspopup="menu" aria-expanded={open}>
            <span className="timeframe-more-inline-label">{activeInExtra ? timeframe : "···"}</span>
            <span className="timeframe-more-collapsed-label">{timeframe}</span>
            <ChevronDown size={12} strokeWidth={1.75} aria-hidden="true" />
          </button>
          {open && (
            <div className="charttype-menu timeframe-menu" role="menu">
              {all.map((item) => (
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
  const Icon = chartTypeIcons[chartType];

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
      <button type="button" className="charttype-button" onClick={() => setOpen((value) => !value)} title={shellText(locale, "chartType")} aria-haspopup="menu" aria-expanded={open}>
        <Icon size={15} strokeWidth={1.75} aria-hidden="true" />
        <ChevronDown size={12} strokeWidth={1.75} aria-hidden="true" />
      </button>
      {open && (
        <div className="charttype-menu" role="menu">
          {catalog?.chartTypes.map((item) => {
            const ItemIcon = chartTypeIcons[item];
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
                {chartTypeLabel(locale, item)}
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
      <button type="button" className="icon-button" onClick={() => setOpen((value) => !value)} title={shellText(locale, "savedWorkspaces")} aria-label={shellText(locale, "savedWorkspaces")} aria-haspopup="menu" aria-expanded={open}>
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
          <span className="sr-only" role="status" aria-live="polite">
            {status}
          </span>
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
                    <span>
                      {workspace.symbol} · {workspace.timeframe} · {workspace.chartType} · v{workspace.revision}
                    </span>
                  </button>
                  {workspace.history.length > 0 && (
                    <button type="button" className="workspace-delete" onClick={() => onRollback(workspace.id, workspace.history.at(-1)!.revision)} title={shellText(locale, "rollbackWorkspace")} aria-label={`${shellText(locale, "rollbackWorkspace")} ${workspace.name}`}>
                      <RotateCcw size={13} strokeWidth={1.75} aria-hidden="true" />
                    </button>
                  )}
                  <button type="button" className="workspace-delete" onClick={() => void onExport(workspace.id)} title={shellText(locale, "exportWorkspace")} aria-label={`${shellText(locale, "exportWorkspace")} ${workspace.name}`}>
                    <Download size={13} strokeWidth={1.75} aria-hidden="true" />
                  </button>
                  <button type="button" className="workspace-delete" onClick={() => onDelete(workspace.id)} title={shellText(locale, "deleteWorkspace")} aria-label={`${shellText(locale, "deleteWorkspace")} ${workspace.name}`}>
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
