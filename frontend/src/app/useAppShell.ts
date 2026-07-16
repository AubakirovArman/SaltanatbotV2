import { useCallback, useContext, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { AuthContext } from "../auth/AuthRoot";
import type { IndicatorConfig } from "../chart/indicatorTypes";
import type { CompareOverlayConfig } from "../chart/types";
import { loadLocale, localeDirection, nextLocale, storeLocale, type Locale } from "../i18n";
import { warmStrategyLab } from "../strategy/loadStrategyLab";
import { storeIndicators } from "../strategy/storage";
import type { ChartType, DataExchange, Timeframe } from "../types";
import {
  applyIndicatorSelection,
  captureWorkspace,
  downloadWorkspaceFile,
  loadKnownRemoteWorkspaceIds,
  loadWorkspaces,
  parseWorkspaceFileDetailed,
  removeMigratedWorkspaceSource,
  rollbackWorkspace,
  saveKnownRemoteWorkspaceIds,
  saveLastActiveWorkspaceId,
  type ChartLayoutPreset,
  type Workspace,
  type WorkspaceChart,
  type WorkspaceFileRejection,
  type WorkspaceStrategySelection
} from "../workspace/workspaces";
import { createWorkspaceRemoteSync, type WorkspaceConflictAction, type WorkspaceRemoteSync, type WorkspaceSyncStatus } from "../workspace/remoteSync";
import { asCompareChartType, DEFAULT_COMPARE_DOWN, DEFAULT_COMPARE_UP, loadCompare, loadCryptoExchange, loadTheme, MAX_COMPARE, readPanel, writePanel } from "./shellStorage";
import { compareColor } from "../chart/compareColors";
import { loadLastChartSession, saveLastChartSession, type LastChartSession } from "./chartSession";
import { normalizeDistinctMarketSymbols } from "./distinctMarkets";
import { writeTenantLocalItem } from "./tenantLocalStorage";
import {
  captureWorkspaceDrawings,
  chartsForWorkspaceLayout,
  duplicateWorkspace as createWorkspaceDuplicate,
  hydrateLegacyWorkspaceIndicators,
  missingLegacyWorkspaceIndicatorIds,
  restoreWorkspaceDrawings,
  uniqueWorkspaceId,
  workspaceTemplate,
  type WorkspaceTemplateKind
} from "../workspace/shellWorkspaceHelpers";
import { useWorkspaceDrawingSnapshots } from "../workspace/useWorkspaceDrawingSnapshots";
import { useActiveWorkspacePersistence } from "../workspace/useActiveWorkspacePersistence";
import { useLastActiveWorkspace } from "../workspace/useLastActiveWorkspace";
export type { WorkspaceTemplateKind } from "../workspace/shellWorkspaceHelpers";
export type AppMode = "chart" | "strategy" | "trade" | "screener";
export type AppTheme = "dark" | "light";
interface UseAppShellOptions {
  symbol: string;
  setSymbol: Dispatch<SetStateAction<string>>;
  timeframe: Timeframe;
  setTimeframe: Dispatch<SetStateAction<Timeframe>>;
  chartType: ChartType;
  setChartType: Dispatch<SetStateAction<ChartType>>;
  mode: AppMode;
  setMode: Dispatch<SetStateAction<AppMode>>;
  indicators: IndicatorConfig[];
  setIndicators: Dispatch<SetStateAction<IndicatorConfig[]>>;
  selectedStrategy?: WorkspaceStrategySelection;
  onRestoreStrategy?: (selection?: WorkspaceStrategySelection) => WorkspaceStrategyRestoreResult;
  initialChartSession?: LastChartSession;
}

export type WorkspaceImportOutcome = { ok: true } | { ok: false; reason: WorkspaceFileRejection };
export type WorkspaceStrategyRestoreResult = "restored" | "none" | "missing" | "revision_mismatch" | "hash_mismatch";
interface UnresolvedWorkspaceStrategy {
  workspaceId: string;
  selection: WorkspaceStrategySelection;
  selectionAtRestore: string;
}

export function useAppShell(options: UseAppShellOptions) {
  const auth = useContext(AuthContext);
  const workspaceOwner = auth?.authRequired ? (auth.user?.id ?? "") : undefined;
  const [initialChartSession] = useState(() => options.initialChartSession ?? loadLastChartSession({ symbol: options.symbol, timeframe: options.timeframe, chartType: options.chartType }, workspaceOwner));
  const [cryptoExchange, setCryptoExchange] = useState<DataExchange>(() => loadCryptoExchange(workspaceOwner));
  const [theme, setTheme] = useState<AppTheme>(loadTheme);
  const [locale, setLocale] = useState<Locale>(loadLocale);
  const [leftOpen, setLeftOpen] = useState(() => readPanel("mf:panel:left", true));
  const [rightOpen, setRightOpen] = useState(() => readPanel("mf:panel:right", true));
  const [workspaces, setWorkspaces] = useState(() => hydrateLegacyWorkspaceIndicators(loadWorkspaces(workspaceOwner), options.indicators));
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string>();
  const [layoutPreset, setLayoutPresetState] = useState<ChartLayoutPreset>(initialChartSession.preset);
  const [charts, setCharts] = useState<WorkspaceChart[]>(initialChartSession.charts);
  const [activeChartId, setActiveChartId] = useState(initialChartSession.charts[0]?.id);
  const [leftSize, setLeftSize] = useState(260);
  const [rightSize, setRightSize] = useState(280);
  const [panelsSwapped, setPanelsSwapped] = useState(false);
  const [compareOverlays, setCompareOverlays] = useState<CompareOverlayConfig[]>(() => loadCompare(options.timeframe, options.chartType, workspaceOwner));
  const [workspaceSyncStatus, setWorkspaceSyncStatus] = useState<WorkspaceSyncStatus>(() => ({
    phase: auth?.authRequired ? "loading" : "saved",
    pendingCount: 0
  }));
  const [workspaceStrategyRestore, setWorkspaceStrategyRestore] = useState<WorkspaceStrategyRestoreResult>("none");
  const [workspaceMigrationMissingIndicators, setWorkspaceMigrationMissingIndicators] = useState(0);
  const workspaceSync = useRef<WorkspaceRemoteSync>();
  const indicatorsRef = useRef(options.indicators);
  indicatorsRef.current = options.indicators;
  const ownerScope = useRef(workspaceOwner);
  const unresolvedStrategy = useRef<UnresolvedWorkspaceStrategy>();
  const { revision: drawingRevision, snapshots: drawingSnapshots } = useWorkspaceDrawingSnapshots(charts, workspaceOwner);
  const selectedStrategyKey = strategySelectionKey(options.selectedStrategy);
  const currentWorkspaceContext = useCallback((mode = options.mode) => ({
    symbol: options.symbol,
    timeframe: options.timeframe,
    chartType: options.chartType,
    cryptoExchange,
    indicators: options.indicators,
    compareOverlays,
    theme,
    layout: { preset: layoutPreset, leftOpen, rightOpen, leftSize, rightSize, panelsSwapped },
    charts,
    activeChartId,
    mode,
    drawings: captureWorkspaceDrawings(charts, workspaceOwner, drawingSnapshots),
    selectedStrategy: unresolvedStrategy.current?.workspaceId === activeWorkspaceId
      && unresolvedStrategy.current?.selectionAtRestore === selectedStrategyKey
      ? unresolvedStrategy.current?.selection
      : options.selectedStrategy
  }), [activeChartId, activeWorkspaceId, charts, compareOverlays, cryptoExchange, drawingSnapshots, layoutPreset, leftOpen, leftSize, options.chartType, options.indicators, options.mode, options.selectedStrategy, options.symbol, options.timeframe, panelsSwapped, rightOpen, rightSize, selectedStrategyKey, theme, workspaceOwner]);
  const { flushActiveWorkspace, workspacesRef } = useActiveWorkspacePersistence({
    activeWorkspaceId,
    captureContext: currentWorkspaceContext,
    enabled: ownerScope.current === workspaceOwner,
    ownerId: workspaceOwner,
    revisionSignal: drawingRevision,
    setWorkspaces,
    syncRef: workspaceSync,
    workspaces
  });
  useEffect(() => {
    setWorkspaceMigrationMissingIndicators(missingLegacyWorkspaceIndicatorIds(loadWorkspaces(workspaceOwner), options.indicators).length);
  }, [options.indicators, workspaceOwner]);
  useEffect(() => {
    if (ownerScope.current === workspaceOwner) return;
    ownerScope.current = workspaceOwner;
    setActiveWorkspaceId(undefined);
    setWorkspaces(hydrateLegacyWorkspaceIndicators(loadWorkspaces(workspaceOwner), options.indicators));
  }, [options.indicators, workspaceOwner]);
  useEffect(() => {
    if (!auth?.authRequired || !auth.user) return;
    const sync = createWorkspaceRemoteSync(auth.user.id, {
      onWorkspaces: setWorkspaces,
      onStatus: setWorkspaceSyncStatus,
      onMigrationAcknowledged: () => removeMigratedWorkspaceSource(auth.user!.id),
      knownRemoteClientIds: loadKnownRemoteWorkspaceIds(auth.user.id),
      onKnownRemoteClientIds: (ids) => saveKnownRemoteWorkspaceIds(auth.user!.id, ids),
      hydrateWorkspace: (workspace) => {
        const missing = missingLegacyWorkspaceIndicatorIds([workspace], indicatorsRef.current).length;
        if (missing) setWorkspaceMigrationMissingIndicators((current) => Math.max(current, missing));
        return hydrateLegacyWorkspaceIndicators([workspace], indicatorsRef.current)[0];
      }
    });
    workspaceSync.current = sync;
    void sync.start(workspacesRef.current);
    const retry = () => sync.retry();
    window.addEventListener("online", retry);
    return () => {
      window.removeEventListener("online", retry);
      sync.dispose();
      if (workspaceSync.current === sync) workspaceSync.current = undefined;
    };
  }, [auth?.authRequired, auth?.user?.id]);
  useEffect(() => {
    try {
      writeTenantLocalItem(localStorage, "mf:cryptoExchange", cryptoExchange, workspaceOwner);
    } catch {
      /* noop */
    }
  }, [cryptoExchange, workspaceOwner]);
  useEffect(() => writePanel("mf:panel:left", leftOpen), [leftOpen]);
  useEffect(() => writePanel("mf:panel:right", rightOpen), [rightOpen]);
  useEffect(() => {
    try {
      writeTenantLocalItem(localStorage, "sbv2:compare", JSON.stringify(compareOverlays), workspaceOwner);
    } catch {
      /* noop */
    }
  }, [compareOverlays, workspaceOwner]);
  useEffect(() => storeIndicators(options.indicators, workspaceOwner), [options.indicators, workspaceOwner]);
  useEffect(() => saveLastChartSession(layoutPreset, charts, Date.now(), workspaceOwner), [charts, layoutPreset, workspaceOwner]);

  useEffect(() => {
    if (!charts.some((chart) => chart.id === activeChartId)) setActiveChartId(charts[0]?.id);
  }, [activeChartId, charts]);

  useEffect(() => {
    setCharts((current) =>
      current.map((chart, index) => ({
        ...chart,
        symbol: index === 0 || chart.linkSymbol ? options.symbol : chart.symbol,
        timeframe: index === 0 || chart.linkTimeframe ? options.timeframe : chart.timeframe,
        chartType: index === 0 || chart.linkChartType ? options.chartType : chart.chartType
      }))
    );
  }, [options.chartType, options.symbol, options.timeframe]);
  useEffect(() => {
    const unresolved = unresolvedStrategy.current;
    if (!unresolved) return;
    if (unresolved.workspaceId !== activeWorkspaceId || unresolved.selectionAtRestore !== selectedStrategyKey) {
      unresolvedStrategy.current = undefined;
      setWorkspaceStrategyRestore("none");
    }
  }, [activeWorkspaceId, selectedStrategyKey]);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="color-scheme"]')?.setAttribute("content", theme);
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#0b0d10" : "#f2f4f7");
    try {
      localStorage.setItem("mf:theme", theme);
    } catch {
      /* noop */
    }
  }, [theme]);
  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = localeDirection(locale);
    storeLocale(locale);
  }, [locale]);
  useEffect(() => {
    const id = window.setTimeout(() => warmStrategyLab(), 1800);
    return () => window.clearTimeout(id);
  }, []);

  useEffect(() => {
    setCompareOverlays((current) => (current.some((item) => item.symbol === options.symbol) ? current.filter((item) => item.symbol !== options.symbol) : current));
  }, [options.symbol]);

  const addCompare = useCallback(
    (symbol: string) => {
      setCompareOverlays((current) =>
        current.some((item) => item.symbol === symbol) || current.length >= MAX_COMPARE
          ? current
          : [
              ...current,
              {
                id: symbol,
                symbol,
                timeframe: options.timeframe,
                chartType: asCompareChartType(options.chartType),
                color: compareColor(current.length),
                upColor: DEFAULT_COMPARE_UP,
                downColor: DEFAULT_COMPARE_DOWN
              }
            ]
      );
    },
    [options.chartType, options.timeframe]
  );

  const updateCompare = useCallback((id: string, patch: Partial<CompareOverlayConfig>) => {
    setCompareOverlays((current) => current.map((item) => (item.id === id ? { ...item, ...patch, chartType: asCompareChartType(patch.chartType ?? item.chartType) } : item)));
  }, []);
  const removeCompare = useCallback((id: string) => setCompareOverlays((current) => current.filter((item) => item.id !== id)), []);

  const saveWorkspace = useCallback(
    (name: string) => {
      const current = flushActiveWorkspace();
      const workspace = captureWorkspace(name, currentWorkspaceContext());
      setWorkspaces([workspace, ...current]);
      setActiveWorkspaceId(workspace.id);
      lastActiveWorkspace.current = workspace.id;
      saveLastActiveWorkspaceId(workspace.id, workspaceOwner);
    },
    [currentWorkspaceContext, flushActiveWorkspace, workspaceOwner]
  );

  const restoreWorkspaceSnapshot = useCallback((workspace: Workspace) => {
    options.setSymbol(workspace.symbol);
    options.setTimeframe(workspace.timeframe);
    options.setChartType(workspace.chartType);
    setCryptoExchange(workspace.cryptoExchange);
    setTheme(workspace.theme);
    setLeftOpen(workspace.layout.leftOpen);
    setRightOpen(workspace.layout.rightOpen);
    setLayoutPresetState(workspace.layout.preset);
    setCharts(workspace.charts);
    setCompareOverlays(workspace.compareOverlays);
    setLeftSize(workspace.layout.leftSize);
    setRightSize(workspace.layout.rightSize);
    setPanelsSwapped(workspace.layout.panelsSwapped);
    restoreWorkspaceDrawings(workspace, workspaceOwner, drawingSnapshots);
    options.setIndicators((current) => workspace.indicators.length ? workspace.indicators.map((indicator) => ({ ...indicator })) : applyIndicatorSelection(current, workspace.enabledIndicators));
    const strategyRestore = options.onRestoreStrategy?.(workspace.selectedStrategy) ?? "none";
    unresolvedStrategy.current = workspace.selectedStrategy && strategyRestore !== "restored"
      ? {
          workspaceId: workspace.id,
          selection: { ...workspace.selectedStrategy, parameters: { ...workspace.selectedStrategy.parameters } },
          selectionAtRestore: strategySelectionKey(options.selectedStrategy)
        }
      : undefined;
    setWorkspaceStrategyRestore(strategyRestore);
    options.setMode(workspace.mode);
    setActiveWorkspaceId(workspace.id);
    setActiveChartId(workspace.activeChartId ?? workspace.charts[0]?.id);
    return strategyRestore;
  }, [drawingSnapshots, options.onRestoreStrategy, options.selectedStrategy, options.setChartType, options.setIndicators, options.setMode, options.setSymbol, options.setTimeframe, workspaceOwner]);

  const applyWorkspace = useCallback(
    (id: string) => {
      const workspace = flushActiveWorkspace().find((item) => item.id === id);
      if (!workspace) return "none" as const;
      const strategyRestore = restoreWorkspaceSnapshot(workspace);
      lastActiveWorkspace.current = workspace.id;
      saveLastActiveWorkspaceId(workspace.id, workspaceOwner);
      return strategyRestore;
    },
    [flushActiveWorkspace, restoreWorkspaceSnapshot, workspaceOwner]
  );

  const deleteWorkspace = useCallback((id: string) => {
    flushActiveWorkspace();
    setWorkspaces((current) => current.map((item) => (item.id === id ? { ...item, archivedAt: Date.now(), updatedAt: Date.now() } : item)));
    setActiveWorkspaceId((current) => (current === id ? undefined : current));
    if (lastActiveWorkspace.current === id) {
      lastActiveWorkspace.current = undefined;
      saveLastActiveWorkspaceId(undefined, workspaceOwner);
    }
  }, [flushActiveWorkspace, workspaceOwner]);

  const restoreArchivedWorkspace = useCallback((id: string) => {
    setWorkspaces((current) => current.map((item) => (item.id === id ? { ...item, archivedAt: undefined, updatedAt: Date.now() } : item)));
  }, []);

  const purgeArchivedWorkspace = useCallback(async (id: string) => {
    let removed = false;
    if (!auth?.authRequired) {
      const archived = workspaces.some((workspace) => workspace.id === id && workspace.archivedAt);
      if (archived) {
        setWorkspaces((current) => current.filter((workspace) => workspace.id !== id));
        removed = true;
      }
    } else {
      removed = await (workspaceSync.current?.purge(id) ?? Promise.resolve(false));
    }
    if (removed && lastActiveWorkspace.current === id) {
      lastActiveWorkspace.current = undefined;
      saveLastActiveWorkspaceId(undefined, workspaceOwner);
      setActiveWorkspaceId(undefined);
    }
    return removed;
  }, [auth?.authRequired, workspaceOwner, workspaces]);

  const renameWorkspace = useCallback((id: string, name: string) => {
    const normalized = name.trim().slice(0, 120);
    if (!normalized) return false;
    flushActiveWorkspace();
    setWorkspaces((current) => current.map((item) => (item.id === id ? { ...item, name: normalized, updatedAt: Date.now() } : item)));
    return true;
  }, [flushActiveWorkspace]);

  const duplicateWorkspace = useCallback((id: string) => {
    const current = flushActiveWorkspace();
    const source = current.find((workspace) => workspace.id === id);
    if (!source) return false;
    const duplicate = createWorkspaceDuplicate(source, current);
    setWorkspaces([duplicate, ...current]);
    return true;
  }, [flushActiveWorkspace]);

  const canCreatePaperWorkspace = !auth?.authRequired || auth.user?.appRole === "admin" || auth.user?.tradingRole === "paper-trade";
  const createWorkspaceTemplate = useCallback((kind: WorkspaceTemplateKind) => {
    if (kind === "paper-robot" && !canCreatePaperWorkspace) return false;
    const current = flushActiveWorkspace();
    const template = workspaceTemplate(kind, locale);
    const workspace = captureWorkspace(template.name, currentWorkspaceContext(template.mode));
    setWorkspaces([workspace, ...current]);
    options.setMode(template.mode);
    setActiveWorkspaceId(workspace.id);
    lastActiveWorkspace.current = workspace.id;
    saveLastActiveWorkspaceId(workspace.id, workspaceOwner);
    return true;
  }, [canCreatePaperWorkspace, currentWorkspaceContext, flushActiveWorkspace, locale, options.setMode, workspaceOwner]);

  const exportWorkspace = useCallback(
    (id: string) => {
      const workspace = flushActiveWorkspace().find((item) => item.id === id);
      return workspace ? downloadWorkspaceFile(workspace) : Promise.resolve();
    },
    [flushActiveWorkspace]
  );

  const importWorkspace = useCallback(
    async (raw: string): Promise<WorkspaceImportOutcome> => {
      const result = await parseWorkspaceFileDetailed(raw);
      if (!result.ok) return result;
      const missingIndicators = missingLegacyWorkspaceIndicatorIds([result.workspace], options.indicators).length;
      if (missingIndicators) setWorkspaceMigrationMissingIndicators((current) => Math.max(current, missingIndicators));
      const parsed = hydrateLegacyWorkspaceIndicators([result.workspace], options.indicators)[0];
      const duplicate = workspaces.some((workspace) => workspace.id === parsed.id);
      const importId = duplicate ? uniqueWorkspaceId(`${parsed.id}-import-${Date.now()}`, workspaces) : undefined;
      if (auth?.authRequired && workspaceSync.current) {
        let document: unknown;
        try {
          document = JSON.parse(raw);
        } catch {
          return { ok: false, reason: "invalid_json" };
        }
        const acknowledged = await workspaceSync.current.importDocument(document, importId);
        return acknowledged ? { ok: true } : { ok: false, reason: "invalid_workspace" };
      }
      const workspace = importId ? { ...parsed, id: importId, updatedAt: Date.now() } : parsed;
      setWorkspaces((current) => [workspace, ...current]);
      return { ok: true };
    },
    [auth?.authRequired, options.indicators, workspaces]
  );

  const rollbackWorkspaceVersion = useCallback(
    async (id: string, revision: number) => {
      const workspace = workspaces.find((item) => item.id === id);
      const next = auth?.authRequired && workspaceSync.current
        ? await workspaceSync.current.rollbackLatest(id)
        : workspace ? rollbackWorkspace(workspace, revision) : undefined;
      if (!next) return false;
      setWorkspaces((current) => current.map((item) => (item.id === id ? next : item)));
      restoreWorkspaceSnapshot(next);
      return true;
    },
    [auth?.authRequired, restoreWorkspaceSnapshot, workspaces]
  );

  const lastActiveWorkspace = useLastActiveWorkspace({
    applyWorkspace,
    authRequired: Boolean(auth?.authRequired),
    ownerId: workspaceOwner,
    syncPhase: workspaceSyncStatus.phase,
    workspaces
  });

  const setLayoutPreset = useCallback(
    (preset: ChartLayoutPreset) => {
      setLayoutPresetState(preset);
      setCharts((current) => chartsForWorkspaceLayout(preset, current, options.symbol, options.timeframe, options.chartType));
    },
    [options.chartType, options.symbol, options.timeframe]
  );

  const setDistinctMarketLayout = useCallback(
    (symbols: string[]) => {
      const distinct = normalizeDistinctMarketSymbols(options.symbol, symbols, 4);
      if (distinct.length < 4) return false;
      setLayoutPresetState("grid-4");
      setCharts((current) =>
        Array.from({ length: 4 }, (_, index) => {
          const chart = current[index] ?? {
            id: `chart-${index + 1}`,
            symbol: options.symbol,
            timeframe: options.timeframe,
            chartType: options.chartType,
            linkGroup: "primary",
            linkSymbol: index === 0,
            linkTimeframe: true,
            linkChartType: true,
            linkCrosshair: true,
            linkTimeRange: true,
            linkIndicators: true,
            linkCompare: true
          };
          const symbol = distinct[index];
          return { ...chart, symbol, linkSymbol: index === 0, compareOverlays: chart.linkCompare ? undefined : chart.compareOverlays?.filter((overlay) => overlay.symbol !== symbol) };
        })
      );
      return true;
    },
    [options.chartType, options.symbol, options.timeframe]
  );

  const updateChart = useCallback(
    (id: string, patch: Partial<WorkspaceChart>) => {
      setCharts((current) =>
        current.map((chart) => {
          if (chart.id !== id) return chart;
          const next = { ...chart, ...patch, id: chart.id };
          if (patch.linkSymbol === true) next.symbol = options.symbol;
          if (patch.linkTimeframe === true) next.timeframe = options.timeframe;
          if (patch.linkChartType === true) next.chartType = options.chartType;
          if (patch.linkIndicators === true) next.indicatorOverrides = undefined;
          if (patch.linkCompare === true) next.compareOverlays = undefined;
          if (patch.symbol !== undefined && next.compareOverlays) next.compareOverlays = next.compareOverlays.filter((overlay) => overlay.symbol !== patch.symbol);
          return next;
        })
      );
      const chart = charts.find((item) => item.id === id);
      if (!chart) return;
      if (patch.symbol !== undefined && (patch.linkSymbol ?? chart.linkSymbol)) options.setSymbol(patch.symbol);
      if (patch.timeframe !== undefined && (patch.linkTimeframe ?? chart.linkTimeframe)) options.setTimeframe(patch.timeframe);
      if (patch.chartType !== undefined && id === charts[0]?.id) options.setChartType(patch.chartType);
    },
    [charts, options.symbol, options.timeframe, options.setChartType, options.setSymbol, options.setTimeframe]
  );

  const updateActiveChart = useCallback(
    (patch: Partial<WorkspaceChart>) => {
      const chart = charts.find((item) => item.id === activeChartId) ?? charts[0];
      if (!chart) return;
      const independentPatch =
        chart.id === charts[0]?.id
          ? patch
          : {
              ...patch,
              ...(patch.symbol === undefined ? {} : { linkSymbol: false }),
              ...(patch.timeframe === undefined ? {} : { linkTimeframe: false }),
              ...(patch.chartType === undefined ? {} : { linkChartType: false })
            };
      updateChart(chart.id, independentPatch);
    },
    [activeChartId, charts, updateChart]
  );

  const activeChart = charts.find((chart) => chart.id === activeChartId) ?? charts[0];

  return {
    cryptoExchange,
    setCryptoExchange,
    theme,
    locale,
    leftOpen,
    rightOpen,
    leftSize,
    rightSize,
    setLeftSize,
    setRightSize,
    panelsSwapped,
    workspaces,
    workspaceSyncStatus,
    workspaceStrategyRestore,
    workspaceMigrationMissingIndicators,
    activeWorkspaceId,
    layoutPreset,
    setLayoutPreset,
    setDistinctMarketLayout,
    charts,
    activeChart,
    activeChartId,
    setActiveChartId,
    updateChart,
    updateActiveChart,
    compareOverlays,
    addCompare,
    updateCompare,
    removeCompare,
    saveWorkspace,
    applyWorkspace,
    deleteWorkspace,
    restoreArchivedWorkspace,
    purgeArchivedWorkspace,
    renameWorkspace,
    duplicateWorkspace,
    createWorkspaceTemplate,
    canCreatePaperWorkspace,
    exportWorkspace,
    importWorkspace,
    rollbackWorkspaceVersion,
    retryWorkspaceSync: () => workspaceSync.current?.retry(),
    resolveWorkspaceConflict: (action: WorkspaceConflictAction) => {
      flushActiveWorkspace();
      workspaceSync.current?.resolveConflict(action);
    },
    toggleTheme: () => setTheme((current) => (current === "dark" ? "light" : "dark")),
    toggleLocale: () => setLocale(nextLocale),
    toggleLeft: () => setLeftOpen((current) => !current),
    toggleRight: () => setRightOpen((current) => !current),
    swapPanels: () => setPanelsSwapped((current) => !current)
  };
}

function strategySelectionKey(selection?: WorkspaceStrategySelection): string {
  if (!selection) return "";
  const parameters = Object.entries(selection.parameters).sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify([selection.id, selection.revision, selection.hash ?? "", parameters]);
}
