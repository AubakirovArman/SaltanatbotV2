import { AlertTriangle, ArrowRight, RefreshCw, Search, ShieldAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { localeTag, type Locale } from "../i18n";
import { ensureNotificationPermission, playAlertBeep, showSystemNotification } from "../market/alerts";
import { getToken, notifyArbitrageAlert } from "../trading/tradeClient";
import { ArbitrageControls } from "./ArbitrageControls";
import { ArbitragePaperPanel } from "./ArbitragePaperPanel";
import { ArbitrageTable, formatBps } from "./ArbitrageTable";
import { fetchArbitrageDepth, type ArbitrageDepthResponse, type ArbitrageOpportunity } from "./client";
import { loadFeeProfile, netEdgeBps, routeCostBps, storeFeeProfile } from "./fees";
import { closePaperPosition, loadPaperPositions, openPaperPosition, storePaperPositions, type ArbitragePaperPosition } from "./paper";
import { arbitrageText } from "./text";
import { useArbitrageStream } from "./useArbitrageStream";

interface Props { locale: Locale; onOpenChart(symbol: string): void }
interface DepthState { routeId: string; loading: boolean; error?: string; value?: ArbitrageDepthResponse }
const ALERT_KEY = "sbv2:arbitrage-alert:v1";

export function ArbitrageScreener({ locale, onOpenChart }: Props) {
  const { scan, connection, error, refresh } = useArbitrageStream();
  const [search, setSearch] = useState("");
  const [minEdge, setMinEdge] = useState(0);
  const [minCapacity, setMinCapacity] = useState(1_000);
  const [profile, setProfile] = useState(loadFeeProfile);
  const [notionalUsd, setNotionalUsd] = useState(10_000);
  const [depth, setDepth] = useState<DepthState>();
  const [positions, setPositions] = useState<ArbitragePaperPosition[]>(loadPaperPositions);
  const [alertConfig, setAlertConfig] = useState(() => loadAlertConfig());
  const [notice, setNotice] = useState<string>();
  const previousEligible = useRef(new Set<string>());
  const initializedAlerts = useRef(false);

  useEffect(() => { storeFeeProfile(profile); }, [profile]);
  useEffect(() => { storePaperPositions(positions); }, [positions]);
  useEffect(() => { localStorage.setItem(ALERT_KEY, JSON.stringify(alertConfig)); }, [alertConfig]);

  const opportunities = useMemo(() => {
    const query = search.trim().toUpperCase();
    return (scan?.opportunities ?? []).filter((row) => (!query || row.symbol.includes(query)) && netEdgeBps(row, profile) >= minEdge && row.topBookCapacityUsd >= minCapacity)
      .sort((left, right) => netEdgeBps(right, profile) - netEdgeBps(left, profile));
  }, [minCapacity, minEdge, profile, scan?.opportunities, search]);

  useEffect(() => {
    if (!alertConfig.enabled || !scan) { initializedAlerts.current = false; previousEligible.current.clear(); return; }
    const current = new Set(scan.opportunities.filter((row) => netEdgeBps(row, profile) >= alertConfig.thresholdBps && row.topBookCapacityUsd >= minCapacity).map((row) => row.id));
    if (!initializedAlerts.current) { previousEligible.current = current; initializedAlerts.current = true; return; }
    const fired = scan.opportunities.filter((row) => current.has(row.id) && !previousEligible.current.has(row.id));
    previousEligible.current = current;
    if (fired.length === 0) return;
    playAlertBeep();
    for (const row of fired.slice(0, 3)) {
      const edge = netEdgeBps(row, profile);
      showSystemNotification(`${row.symbol} · ${formatBps(edge)}`, `${row.spotExchange} spot → ${row.futuresExchange} perpetual`, `arb-${row.id}`);
      if (getToken()) void notifyArbitrageAlert({ symbol: row.symbol, spotExchange: row.spotExchange, futuresExchange: row.futuresExchange, netEdgeBps: edge, minimumNetEdgeBps: alertConfig.thresholdBps }).catch(() => undefined);
    }
    setNotice(arbitrageText(locale, "alertFired", { count: String(fired.length) }));
  }, [alertConfig, locale, minCapacity, profile, scan]);

  const analyzeDepth = useCallback(async (row: ArbitrageOpportunity) => {
    setDepth({ routeId: row.id, loading: true });
    try { setDepth({ routeId: row.id, loading: false, value: await fetchArbitrageDepth(row, notionalUsd) }); }
    catch (cause) { setDepth({ routeId: row.id, loading: false, error: cause instanceof Error ? cause.message : "Order-book depth unavailable" }); }
  }, [notionalUsd]);

  const openPaper = useCallback(async (row: ArbitrageOpportunity) => {
    setDepth({ routeId: row.id, loading: true });
    try {
      const value = await fetchArbitrageDepth(row, notionalUsd); setDepth({ routeId: row.id, loading: false, value });
      if (!value.complete) { setNotice(arbitrageText(locale, "paperDepthBlocked")); return; }
      setPositions((current) => [openPaperPosition(row, value, profile), ...current]);
      setNotice(arbitrageText(locale, "paperOpened", { symbol: row.symbol }));
    } catch (cause) { setDepth({ routeId: row.id, loading: false, error: cause instanceof Error ? cause.message : "Order-book depth unavailable" }); }
  }, [locale, notionalUsd, profile]);

  const closePaper = (position: ArbitragePaperPosition) => {
    const quote = scan?.opportunities.find((row) => row.id === position.routeId); if (!quote) return;
    setPositions((current) => current.map((value) => value.id === position.id ? closePaperPosition(value, quote) : value));
  };
  const toggleAlerts = (enabled: boolean) => { if (enabled) void ensureNotificationPermission(); setAlertConfig((value) => ({ ...value, enabled })); };
  const best = opportunities[0] ? netEdgeBps(opportunities[0], profile) : undefined;

  return <section className="arb-screener" aria-labelledby="arb-title">
    <header className="arb-hero"><div><span className="arb-eyebrow">Binance <ArrowRight size={12} aria-hidden="true" /> Bybit</span><h1 id="arb-title">{arbitrageText(locale, "title")}</h1><p>{arbitrageText(locale, "description")}</p></div>
      <div className="arb-hero-actions"><span className={`arb-connection ${connection}`}>{arbitrageText(locale, connection)}</span><button type="button" className="arb-refresh" onClick={() => void refresh()}><RefreshCw size={15} aria-hidden="true" />{arbitrageText(locale, "refresh")}</button></div></header>
    <form className="arb-filters" onSubmit={(event) => event.preventDefault()}>
      <label htmlFor="arb-search">{arbitrageText(locale, "search")}<span className="arb-search-control"><Search size={14} aria-hidden="true" /><input id="arb-search" type="search" value={search} placeholder={arbitrageText(locale, "searchPlaceholder")} onChange={(event) => setSearch(event.target.value)} /></span></label>
      <label htmlFor="arb-min-edge">{arbitrageText(locale, "minEdge")}<span className="arb-number-control"><input id="arb-min-edge" type="number" value={minEdge / 100} step="0.01" min="-100" max="100" onChange={(event) => setMinEdge((event.target.valueAsNumber || 0) * 100)} /><span>%</span></span></label>
      <label htmlFor="arb-min-capacity">{arbitrageText(locale, "minCapacity")}<span className="arb-number-control"><span>$</span><input id="arb-min-capacity" type="number" value={minCapacity} step="100" min="0" onChange={(event) => setMinCapacity(Math.max(0, event.target.valueAsNumber || 0))} /></span></label>
    </form>
    <ArbitrageControls locale={locale} profile={profile} onProfile={setProfile} alertEnabled={alertConfig.enabled} onAlertEnabled={toggleAlerts} alertThresholdBps={alertConfig.thresholdBps} onAlertThreshold={(thresholdBps) => setAlertConfig((value) => ({ ...value, thresholdBps }))} notionalUsd={notionalUsd} onNotional={setNotionalUsd} />
    {error && <div className="arb-notice danger" role="alert"><AlertTriangle size={15} aria-hidden="true" /> {error}</div>}{scan?.stale && <div className="arb-notice warning"><AlertTriangle size={15} aria-hidden="true" /> {arbitrageText(locale, "stale")}</div>}
    {notice && <div className="arb-notice info" role="status">{notice}<button type="button" onClick={() => setNotice(undefined)}>×</button></div>}
    <div className="arb-summary"><Summary label={arbitrageText(locale, "scanned")} value={String(scan?.scannedSymbols ?? "—")} /><Summary label={arbitrageText(locale, "matching")} value={String(opportunities.length)} /><Summary label={arbitrageText(locale, "bestEdge")} value={best === undefined ? "—" : formatBps(best)} tone={best !== undefined && best > 0 ? "positive" : undefined} /><Summary label={arbitrageText(locale, "updated")} value={scan ? new Date(scan.updatedAt).toLocaleTimeString(localeTag(locale)) : "—"} /></div>
    {scan && <div className="arb-source-row" aria-label={arbitrageText(locale, "sourceHealth")}>{scan.sources.map((source) => <span key={`${source.exchange}-${source.market}`} className={source.ok ? "ok" : "error"} title={source.message}><i aria-hidden="true" /> {source.exchange === "binance" ? "Binance" : "Bybit"} {arbitrageText(locale, source.market)} · {arbitrageText(locale, source.ok ? "connected" : "unavailable")}</span>)}</div>}
    <ArbitrageTable locale={locale} rows={opportunities} costs={(row) => routeCostBps(row, profile)} net={(row) => netEdgeBps(row, profile)} depth={depth} onDepth={analyzeDepth} onPaper={openPaper} onOpenChart={onOpenChart} />
    {opportunities.length === 0 && <div className="arb-empty"><strong>{arbitrageText(locale, "noResults")}</strong><span>{arbitrageText(locale, "noResultsHint")}</span></div>}
    <ArbitragePaperPanel locale={locale} positions={positions} quotes={scan?.opportunities ?? []} onClose={closePaper} onClearClosed={() => setPositions((current) => current.filter((position) => !position.closedAt))} />
    <aside className="arb-risk"><ShieldAlert size={18} aria-hidden="true" /><div><strong>{arbitrageText(locale, "riskTitle")}</strong><p>{arbitrageText(locale, "risk")}</p></div></aside>
  </section>;
}

function Summary({ label, value, tone }: { label: string; value: string; tone?: "positive" }) { return <div className={tone ? `arb-summary-card ${tone}` : "arb-summary-card"}><span>{label}</span><strong>{value}</strong></div>; }
function loadAlertConfig(): { enabled: boolean; thresholdBps: number } { try { const value = JSON.parse(localStorage.getItem(ALERT_KEY) ?? "null") as { enabled?: unknown; thresholdBps?: unknown } | null; return { enabled: value?.enabled === true, thresholdBps: typeof value?.thresholdBps === "number" ? value.thresholdBps : 50 }; } catch { return { enabled: false, thresholdBps: 50 }; } }
