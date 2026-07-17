import { AlertTriangle, ArrowRight, RefreshCw, Search, ShieldAlert } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { localeTag, type Locale } from "../i18n";
import { useAuth } from "../auth/AuthRoot";
import { ensureNotificationPermission, playAlertBeep, showSystemNotification } from "../market/alerts";
import { getToken, notifyArbitrageAlert } from "../trading/tradeClient";
import { ArbitrageControls } from "./ArbitrageControls";
import { ArbitragePaperPanel, type PaperFundingInput } from "./ArbitragePaperPanel";
import { ArbitrageTable, formatBps, venue, type ArbitrageDepthError } from "./ArbitrageTable";
import { fetchArbitrageDepth, fetchArbitrageExitDepth, type ArbitrageDepthResponse, type ArbitrageOpportunity } from "./client";
import { basisDisplayedScenario, loadFeeProfile, projectedRoiPct, storeFeeProfile } from "./fees";
import { assertPaperOpportunityBinding, openPaperPosition, type ArbitragePaperPosition } from "./paper";
import { appendPaperEvents, createArchiveEvents, createCloseEvent, createFundingEvent, createOpenEvent, loadPaperEvents, replayPaperEvents, storePaperEvents } from "./paperLedger";
import { arbitrageText } from "./text";
import { TriangularScreener } from "./TriangularScreener";
import { useArbitrageStream } from "./useArbitrageStream";
import type { ArbitrageChartTarget } from "./chartTarget";
import { analysisText } from "./analysisText";
import { alertDeliveryText } from "./alertDeliveryText";
import { NativeSpreadScreener } from "./NativeSpreadScreener";
import { evaluateBrowserAlertSnapshot, loadBrowserAlertConfig, storeBrowserAlertConfig } from "./browserAlerts";
import { LifecycleStatus } from "./LifecycleStatus";
import { ScannerWorkbench, type ScannerColumn, type ScannerVisualRow } from "./ScannerWorkbench";
import { loadScannerNavMode, storeScannerNavMode, type ScannerFilterValue } from "./scannerPrefs";
import { scannerUxText } from "./scannerUxText";
import { ContinuousRoutesPanel } from "./ContinuousRoutesPanel";
import { optionsParityText } from "./optionsParityText";
import { SCANNER_MODE_IDS, ScannerModeNav, type ScannerMode } from "./ScannerModeNav";
import { fundingCurveText } from "./fundingCurveText";
import { orderBookMlModeText } from "./orderBookMlModeText";
import { screenerText } from "../i18n/screener";
import "../styles/arbitrage.css";

const OptionsParityWorkbench = lazy(() => import("./OptionsParityWorkbench").then((module) => ({ default: module.OptionsParityWorkbench })));
const FundingCurveWorkbench = lazy(() => import("./FundingCurveWorkbench").then((module) => ({ default: module.FundingCurveWorkbench })));
const OrderBookMlResearchPanel = lazy(() => import("./OrderBookMlResearchPanel").then((module) => ({ default: module.OrderBookMlResearchPanel })));
const TechnicalScreener = lazy(() => import("../screener/TechnicalScreener").then((module) => ({ default: module.TechnicalScreener })));

interface Props {
  locale: Locale;
  onOpenChart(target: ArbitrageChartTarget): void;
}
interface TenantScopedProps extends Props {
  storageOwner?: string;
}
interface DepthState {
  routeId: string;
  loading: boolean;
  error?: ArbitrageDepthError;
  value?: ArbitrageDepthResponse;
}
const BASIS_COLUMNS: readonly ScannerColumn[] = [
  { id: "route", label: "", required: true },
  { id: "spot", label: "" },
  { id: "perpetual", label: "" },
  { id: "gross", label: "" },
  { id: "net", label: "" },
  { id: "profit", label: "" },
  { id: "capacity", label: "" },
  { id: "funding", label: "" },
  { id: "actions", label: "", required: true }
];
const BASIS_DEFAULT_COLUMNS = BASIS_COLUMNS.map((column) => column.id);
const BASIS_COLUMN_TEXT = {
  route: "routeColumn",
  spot: "spotColumn",
  perpetual: "perpetualColumn",
  gross: "grossColumn",
  net: "netColumn",
  profit: "profitColumn",
  capacity: "capacityColumn",
  funding: "fundingColumn",
  actions: "actionsColumn"
} as const;

export function ArbitrageScreener(props: Props) {
  const accountAuth = useAuth();
  const storageOwner = accountAuth.authRequired ? (accountAuth.user?.id ?? "") : undefined;
  const storageScopeKey = storageOwner === undefined ? "legacy" : storageOwner || "unavailable";
  const [mode, setMode] = useState<ScannerMode>(() => loadScannerNavMode(SCANNER_MODE_IDS, "basis", undefined, storageOwner));
  useEffect(() => {
    storeScannerNavMode(mode, undefined, storageOwner);
  }, [mode, storageOwner]);

  return (
    <div className="arb-workspace">
      <ScannerModeNav locale={props.locale} mode={mode} onMode={setMode} />
      {mode === "basis" ? (
        <BasisScreener key={`basis:${storageScopeKey}`} {...props} storageOwner={storageOwner} />
      ) : mode === "triangular" ? (
        <TriangularScreener key={`triangular:${storageScopeKey}`} {...props} storageOwner={storageOwner} />
      ) : mode === "native" ? (
        <NativeSpreadScreener key={`native:${storageScopeKey}`} {...props} storageOwner={storageOwner} />
      ) : mode === "options" ? (
        <Suspense
          fallback={
            <p className="options-parity-status" role="status">
              {optionsParityText(props.locale, "evaluating")}
            </p>
          }
        >
          <OptionsParityWorkbench locale={props.locale} />
        </Suspense>
      ) : mode === "funding" ? (
        <Suspense
          fallback={
            <p className="funding-curve-status" role="status">
              {fundingCurveText(props.locale, "loadingUniverse")}
            </p>
          }
        >
          <FundingCurveWorkbench locale={props.locale} />
        </Suspense>
      ) : mode === "continuous" ? (
        <ContinuousRoutesPanel locale={props.locale} />
      ) : mode === "technical" ? (
        <Suspense
          fallback={
            <p className="arb-server-hint" role="status">
              {screenerText(props.locale, "loading")}
            </p>
          }
        >
          <TechnicalScreener key={`technical:${storageScopeKey}`} locale={props.locale} onOpenChart={props.onOpenChart} />
        </Suspense>
      ) : (
        <Suspense
          fallback={
            <p className="obml-loading" role="status">
              {orderBookMlModeText(props.locale)}…
            </p>
          }
        >
          <OrderBookMlResearchPanel locale={props.locale} />
        </Suspense>
      )}
    </div>
  );
}

function BasisScreener({ locale, onOpenChart, storageOwner }: TenantScopedProps) {
  const accountAuth = useAuth();
  const { scan, connection, error, refresh, clockHealth, clockError, refreshClock } = useArbitrageStream();
  const [search, setSearch] = useState("");
  const [minEdge, setMinEdge] = useState(0);
  const [minCapacity, setMinCapacity] = useState(1_000);
  const [ranking, setRanking] = useState<"profit" | "roi" | "edge" | "capacity" | "quality">("profit");
  const [profile, setProfile] = useState(() => loadFeeProfile(storageOwner));
  const [notionalUsd, setNotionalUsd] = useState(10_000);
  const [depth, setDepth] = useState<DepthState>();
  const [paperEvents, setPaperEvents] = useState(() => loadPaperEvents(storageOwner));
  const [alertConfig, setAlertConfig] = useState(() => loadBrowserAlertConfig(storageOwner));
  const [notice, setNotice] = useState<string>();
  const previousEligible = useRef(new Set<string>());
  const initializedAlerts = useRef(false);

  useEffect(() => {
    storeFeeProfile(profile, storageOwner);
  }, [profile, storageOwner]);
  useEffect(() => {
    storePaperEvents(paperEvents, storageOwner);
  }, [paperEvents, storageOwner]);
  useEffect(() => {
    storeBrowserAlertConfig(alertConfig, storageOwner);
  }, [alertConfig, storageOwner]);

  const opportunities = useMemo(() => {
    const query = search.trim().toUpperCase();
    return (scan?.opportunities ?? [])
      .filter((row) => (!query || row.symbol.includes(query)) && basisDisplayedScenario(row, profile, notionalUsd, row.capturedAt).netEdgeBps >= minEdge && row.topBookCapacityUsd >= minCapacity)
      .sort((left, right) => qualityRank(right) - qualityRank(left) || rankValue(right, ranking, profile, notionalUsd) - rankValue(left, ranking, profile, notionalUsd) || left.id.localeCompare(right.id));
  }, [minCapacity, minEdge, notionalUsd, profile, ranking, scan?.opportunities, search]);
  const workspaceColumns = useMemo(() => BASIS_COLUMNS.map((column) => ({ ...column, label: scannerUxText(locale, BASIS_COLUMN_TEXT[column.id as keyof typeof BASIS_COLUMN_TEXT]) })), [locale]);
  const workspaceFilters = useMemo<Record<string, ScannerFilterValue>>(() => ({ search, minEdge, minCapacity, ranking, notionalUsd }), [minCapacity, minEdge, notionalUsd, ranking, search]);
  const visualRows = useMemo<ScannerVisualRow[]>(
    () =>
      opportunities.map((row) => {
        const scenario = basisDisplayedScenario(row, profile, notionalUsd, row.capturedAt);
        return {
          id: row.id,
          label: row.symbol,
          subtitle: `${venue(row.spotExchange)} → ${venue(row.futuresExchange)} · ${scannerUxText(locale, "basisRoute")}`,
          heatValue: scenario.netEdgeBps,
          nodes: [
            { label: venue(row.spotExchange), detail: arbitrageText(locale, "spot") },
            { label: row.symbol, detail: "USDT" },
            { label: venue(row.futuresExchange), detail: arbitrageText(locale, "perpetual") }
          ],
          metrics: [
            { key: "primary", label: scannerUxText(locale, "netColumn"), value: scenario.netEdgeBps, formatted: formatBps(scenario.netEdgeBps) },
            { key: "secondary", label: scannerUxText(locale, "profitColumn"), value: scenario.projectedNetProfitUsd, formatted: formatCurrency(scenario.projectedNetProfitUsd, locale) },
            { key: "capacity", label: scannerUxText(locale, "capacityColumn"), value: row.topBookCapacityUsd, formatted: formatCurrency(row.topBookCapacityUsd, locale) },
            { key: "freshness", label: scannerUxText(locale, "freshnessMetric"), value: -row.quoteAgeMs, formatted: `${Math.round(row.quoteAgeMs)} ms · ${arbitrageText(locale, signalTextKey(row.dataQuality))}` }
          ]
        };
      }),
    [locale, notionalUsd, opportunities, profile]
  );
  const positions = useMemo(() => replayPaperEvents(paperEvents), [paperEvents]);

  useEffect(() => {
    if (!alertConfig.enabled || !scan) {
      initializedAlerts.current = false;
      previousEligible.current.clear();
      return;
    }
    const evaluated = evaluateBrowserAlertSnapshot(scan, { initialized: initializedAlerts.current, eligibleRouteIds: previousEligible.current }, (row) => basisDisplayedScenario(row, profile, notionalUsd, row.capturedAt).netEdgeBps >= alertConfig.thresholdBps && row.topBookCapacityUsd >= minCapacity);
    previousEligible.current = new Set(evaluated.state.eligibleRouteIds);
    initializedAlerts.current = evaluated.state.initialized;
    const fired = evaluated.fired;
    if (fired.length === 0) return;
    playAlertBeep();
    for (const row of fired.slice(0, 3)) {
      const edge = basisDisplayedScenario(row, profile, notionalUsd, row.capturedAt).netEdgeBps;
      showSystemNotification(
        `${row.symbol} · ${formatBps(edge)}`,
        arbitrageText(locale, "notificationRoute", {
          spotVenue: venue(row.spotExchange),
          spotMarket: arbitrageText(locale, "spot"),
          futuresVenue: venue(row.futuresExchange),
          perpetualMarket: arbitrageText(locale, "perpetual")
        }),
        `arb-${row.id}`
      );
      if (accountAuth.authRequired ? accountAuth.tradingAvailable : Boolean(getToken()))
        void notifyArbitrageAlert({ symbol: row.symbol, spotExchange: row.spotExchange, futuresExchange: row.futuresExchange, netEdgeBps: edge, minimumNetEdgeBps: alertConfig.thresholdBps }).catch(() => {
          setNotice(alertDeliveryText(locale, "immediateFailed"));
        });
    }
    setNotice(arbitrageText(locale, "alertFired", { count: String(fired.length) }));
  }, [accountAuth.authRequired, accountAuth.tradingAvailable, alertConfig, locale, minCapacity, notionalUsd, profile, scan]);

  const analyzeDepth = useCallback(
    async (row: ArbitrageOpportunity) => {
      setDepth({ routeId: row.id, loading: true });
      try {
        setDepth({ routeId: row.id, loading: false, value: await fetchArbitrageDepth(row, notionalUsd) });
      } catch {
        setDepth({ routeId: row.id, loading: false, error: "depthUnavailable" });
      }
    },
    [notionalUsd]
  );

  const openPaper = useCallback(
    async (row: ArbitrageOpportunity) => {
      setDepth({ routeId: row.id, loading: true });
      try {
        const value = await fetchArbitrageDepth(row, notionalUsd);
        setDepth({ routeId: row.id, loading: false, value });
        if (!value.complete) {
          setNotice(arbitrageText(locale, "paperDepthBlocked"));
          return;
        }
        const position = openPaperPosition(row, value, profile);
        setPaperEvents((current) => appendPaperEvents(current, createOpenEvent(position, current)));
        setNotice(arbitrageText(locale, "paperOpened", { symbol: row.symbol }));
      } catch {
        setDepth({ routeId: row.id, loading: false, error: "depthUnavailable" });
      }
    },
    [locale, notionalUsd, profile]
  );

  const closePaper = async (position: ArbitragePaperPosition) => {
    const quote = scan?.opportunities.find((row) => row.id === position.routeId);
    if (!quote) return;
    setDepth({ routeId: position.routeId, loading: true });
    try {
      assertPaperOpportunityBinding(position, quote);
      const value = await fetchArbitrageExitDepth(position, position.notionalUsd, position.matchedQuantity);
      setDepth({ routeId: position.routeId, loading: false, value });
      if (!value.complete) {
        setNotice(arbitrageText(locale, "paperExitBlocked"));
        return;
      }
      setPaperEvents((current) => appendPaperEvents(current, createCloseEvent(position, value, current)));
      setNotice(arbitrageText(locale, "paperClosed", { symbol: position.symbol }));
    } catch {
      setDepth({ routeId: position.routeId, loading: false, error: "exitDepthUnavailable" });
      setNotice(arbitrageText(locale, "exitDepthUnavailable"));
    }
  };
  const recordPaperFunding = (position: ArbitragePaperPosition, input: PaperFundingInput) => {
    try {
      setPaperEvents((current) =>
        appendPaperEvents(
          current,
          createFundingEvent(
            position,
            {
              ...input,
              source: "manual-confirmed"
            },
            current
          )
        )
      );
      setNotice(arbitrageText(locale, "paperFundingRecorded", { symbol: position.symbol }));
    } catch {
      setNotice(arbitrageText(locale, "fundingRecordFailed"));
    }
  };
  const toggleAlerts = (enabled: boolean) => {
    if (enabled) void ensureNotificationPermission();
    setAlertConfig((value) => ({ ...value, enabled }));
  };
  const best = opportunities[0] ? basisDisplayedScenario(opportunities[0], profile, notionalUsd, opportunities[0].capturedAt).netEdgeBps : undefined;

  return (
    <section className="arb-screener" aria-labelledby="arb-title">
      <header className="arb-hero">
        <div>
          <span className="arb-eyebrow">
            Binance <ArrowRight size={12} aria-hidden="true" /> Bybit
          </span>
          <h1 id="arb-title">{arbitrageText(locale, "title")}</h1>
          <p>{arbitrageText(locale, "description")}</p>
        </div>
        <div className="arb-hero-actions">
          <span className={`arb-connection ${connection}`}>{arbitrageText(locale, connection)}</span>
          <button
            type="button"
            className="arb-refresh"
            onClick={() => {
              void refresh();
              void refreshClock();
            }}
          >
            <RefreshCw size={15} aria-hidden="true" />
            {arbitrageText(locale, "refresh")}
          </button>
        </div>
      </header>
      <form className="arb-filters" onSubmit={(event) => event.preventDefault()}>
        <label htmlFor="arb-search">
          {arbitrageText(locale, "search")}
          <span className="arb-search-control">
            <Search size={14} aria-hidden="true" />
            <input id="arb-search" type="search" value={search} placeholder={arbitrageText(locale, "searchPlaceholder")} onChange={(event) => setSearch(event.target.value)} />
          </span>
        </label>
        <label htmlFor="arb-min-edge">
          {arbitrageText(locale, "minEdge")}
          <span className="arb-number-control">
            <input id="arb-min-edge" type="number" value={minEdge / 100} step="0.01" min="-100" max="100" onChange={(event) => setMinEdge((event.target.valueAsNumber || 0) * 100)} />
            <span>%</span>
          </span>
        </label>
        <label htmlFor="arb-min-capacity">
          {arbitrageText(locale, "minCapacity")}
          <span className="arb-number-control">
            <span>$</span>
            <input id="arb-min-capacity" type="number" value={minCapacity} step="100" min="0" onChange={(event) => setMinCapacity(Math.max(0, event.target.valueAsNumber || 0))} />
          </span>
        </label>
        <label htmlFor="arb-ranking">
          {analysisText(locale, "ranking")}
          <select id="arb-ranking" value={ranking} onChange={(event) => setRanking(event.target.value as typeof ranking)}>
            <option value="profit">{analysisText(locale, "sortProfit")}</option>
            <option value="roi">{analysisText(locale, "sortRoi")}</option>
            <option value="edge">{analysisText(locale, "sortEdge")}</option>
            <option value="capacity">{analysisText(locale, "sortCapacity")}</option>
            <option value="quality">{analysisText(locale, "sortQuality")}</option>
          </select>
        </label>
      </form>
      <ArbitrageControls
        locale={locale}
        profile={profile}
        onProfile={setProfile}
        alertEnabled={alertConfig.enabled}
        onAlertEnabled={toggleAlerts}
        alertThresholdBps={alertConfig.thresholdBps}
        onAlertThreshold={(thresholdBps) => setAlertConfig((value) => ({ ...value, thresholdBps }))}
        notionalUsd={notionalUsd}
        onNotional={setNotionalUsd}
        minimumCapacityUsd={minCapacity}
      />
      {error && (
        <div className="arb-notice danger" role="alert">
          <AlertTriangle size={15} aria-hidden="true" /> {arbitrageText(locale, "marketDataUnavailable")}
        </div>
      )}
      {scan?.stale && (
        <div className="arb-notice warning">
          <AlertTriangle size={15} aria-hidden="true" /> {arbitrageText(locale, "stale")}
        </div>
      )}
      {scan?.truncated && (
        <div className="arb-notice warning">
          <AlertTriangle size={15} aria-hidden="true" /> {arbitrageText(locale, "truncated")}
        </div>
      )}
      {clockError && (
        <div className="arb-notice warning" role="status">
          <AlertTriangle size={15} aria-hidden="true" /> {arbitrageText(locale, "clockRequestFailed")}
        </div>
      )}
      {clockHealth?.stale && !clockError && (
        <div className="arb-notice warning" role="status">
          <AlertTriangle size={15} aria-hidden="true" /> {arbitrageText(locale, "clockWarning")}
        </div>
      )}
      {notice && (
        <div className="arb-notice info" role="status">
          {notice}
          <button type="button" aria-label={arbitrageText(locale, "dismissNotice")} title={arbitrageText(locale, "dismissNotice")} onClick={() => setNotice(undefined)}>
            ×
          </button>
        </div>
      )}
      <div className="arb-summary">
        <Summary label={arbitrageText(locale, "scanned")} value={String(scan?.scannedSymbols ?? "—")} />
        <Summary label={arbitrageText(locale, "matching")} value={String(opportunities.length)} />
        <Summary label={arbitrageText(locale, "bestEdge")} value={best === undefined ? "—" : formatBps(best)} tone={best !== undefined && best > 0 ? "positive" : undefined} />
        <Summary label={arbitrageText(locale, "updated")} value={scan ? new Date(scan.updatedAt).toLocaleTimeString(localeTag(locale)) : "—"} />
      </div>
      {(scan || clockHealth) && (
        <div className="arb-health-groups">
          {scan && (
            <div className="arb-health-block">
              <strong>{arbitrageText(locale, "sourceHealth")}</strong>
              <div className="arb-source-row" aria-label={arbitrageText(locale, "sourceHealth")}>
                {scan.sources.map((source) => (
                  <span key={`${source.exchange}-${source.market}`} className={source.ok ? "ok" : "error"} title={locale === "en" ? source.message : undefined}>
                    <i aria-hidden="true" /> {source.exchange === "binance" ? "Binance" : "Bybit"} {arbitrageText(locale, source.market)} · {arbitrageText(locale, source.ok ? "connected" : "unavailable")}
                  </span>
                ))}
              </div>
            </div>
          )}
          {clockHealth && (
            <div className="arb-health-block">
              <strong>{arbitrageText(locale, "clockHealth")}</strong>
              <div className="arb-source-row arb-clock-row" aria-label={arbitrageText(locale, "clockHealth")}>
                {clockHealth.sources.map((source) => (
                  <span key={source.sourceId} className={source.status === "calibrated" && source.ok ? "ok" : source.status === "unavailable" || !source.ok ? "error" : "warning"} title={source.message}>
                    <i aria-hidden="true" /> {source.sourceId.startsWith("binance:") ? "Binance" : source.sourceId.startsWith("bybit:") ? "Bybit" : source.sourceId} · {arbitrageText(locale, clockStatusText(source.status))}
                    {source.offsetMidpointMs !== undefined && source.uncertaintyMs !== undefined && source.roundTripMs !== undefined && (
                      <small>{arbitrageText(locale, "clockMetrics", { offset: source.offsetMidpointMs.toFixed(1), uncertainty: source.uncertaintyMs.toFixed(1), rtt: source.roundTripMs.toFixed(0) })}</small>
                    )}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
      <ScannerWorkbench
        mode="basis"
        storageOwner={storageOwner}
        locale={locale}
        filters={workspaceFilters}
        columns={workspaceColumns}
        defaultColumns={BASIS_DEFAULT_COLUMNS}
        rows={visualRows}
        statusSlot={<LifecycleStatus locale={locale} />}
        onApplyFilters={(filters) => {
          if (typeof filters.search === "string") setSearch(filters.search.slice(0, 40));
          if (typeof filters.minEdge === "number") setMinEdge(clamp(filters.minEdge, -10_000, 10_000));
          if (typeof filters.minCapacity === "number") setMinCapacity(clamp(filters.minCapacity, 0, 1_000_000_000));
          if (typeof filters.ranking === "string" && ["profit", "roi", "edge", "capacity", "quality"].includes(filters.ranking)) setRanking(filters.ranking as typeof ranking);
          if (typeof filters.notionalUsd === "number") setNotionalUsd(clamp(filters.notionalUsd, 100, 10_000_000));
        }}
      >
        {({ visibleColumns }) => (
          <>
            <ArbitrageTable
              locale={locale}
              rows={opportunities}
              columns={visibleColumns}
              scenario={(row) => basisDisplayedScenario(row, profile, notionalUsd, row.capturedAt)}
              depth={depth}
              onDepth={analyzeDepth}
              onPaper={openPaper}
              onOpenChart={onOpenChart}
              profile={profile}
              notionalUsd={notionalUsd}
            />
            {opportunities.length === 0 && (
              <div className="arb-empty">
                <strong>{arbitrageText(locale, "noResults")}</strong>
                <span>{arbitrageText(locale, "noResultsHint")}</span>
              </div>
            )}
          </>
        )}
      </ScannerWorkbench>
      <ArbitragePaperPanel locale={locale} positions={positions} quotes={scan?.opportunities ?? []} onClose={closePaper} onFunding={recordPaperFunding} onClearClosed={() => setPaperEvents((current) => appendPaperEvents(current, ...createArchiveEvents(positions, current)))} />
      <aside className="arb-risk">
        <ShieldAlert size={18} aria-hidden="true" />
        <div>
          <strong>{arbitrageText(locale, "riskTitle")}</strong>
          <p>{arbitrageText(locale, "risk")}</p>
        </div>
      </aside>
    </section>
  );
}

function rankValue(row: ArbitrageOpportunity, ranking: "profit" | "roi" | "edge" | "capacity" | "quality", profile: ReturnType<typeof loadFeeProfile>, notionalUsd: number) {
  if (ranking === "roi") return projectedRoiPct(row, profile, notionalUsd);
  const scenario = basisDisplayedScenario(row, profile, notionalUsd, row.capturedAt);
  if (ranking === "edge") return scenario.netEdgeBps;
  if (ranking === "capacity") return row.topBookCapacityUsd;
  if (ranking === "quality") return row.dataQuality === "fresh" ? 4 : row.dataQuality === "unverified" ? 3 : row.dataQuality === "skewed" ? 2 : 1;
  return scenario.projectedNetProfitUsd;
}

function qualityRank(row: ArbitrageOpportunity) {
  return row.dataQuality === "fresh" ? 3 : row.dataQuality === "unverified" ? 2 : row.dataQuality === "skewed" ? 1 : 0;
}

function clockStatusText(status: "calibrated" | "degraded" | "expired" | "unavailable"): "clockCalibrated" | "clockDegraded" | "clockExpired" | "clockUnavailable" {
  if (status === "calibrated") return "clockCalibrated";
  if (status === "degraded") return "clockDegraded";
  if (status === "expired") return "clockExpired";
  return "clockUnavailable";
}

function Summary({ label, value, tone }: { label: string; value: string; tone?: "positive" }) {
  return (
    <div className={tone ? `arb-summary-card ${tone}` : "arb-summary-card"}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
function signalTextKey(quality: ArbitrageOpportunity["dataQuality"]): "signalQualityFresh" | "signalQualityStale" | "signalQualitySkewed" | "signalQualityUnverified" {
  if (quality === "fresh") return "signalQualityFresh";
  if (quality === "stale") return "signalQualityStale";
  if (quality === "skewed") return "signalQualitySkewed";
  return "signalQualityUnverified";
}

function formatCurrency(value: number, locale: Locale): string {
  return new Intl.NumberFormat(localeTag(locale), { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
