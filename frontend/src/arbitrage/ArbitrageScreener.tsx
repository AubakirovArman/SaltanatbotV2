import { AlertTriangle, ArrowRight, RefreshCw, Search, ShieldAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { localeTag, type Locale } from "../i18n";
import { fetchArbitrageScan, type ArbitrageOpportunity, type ArbitrageScanResponse } from "./client";
import { arbitrageText } from "./text";

interface Props {
  locale: Locale;
  onOpenChart(symbol: string): void;
}

export function ArbitrageScreener({ locale, onOpenChart }: Props) {
  const [scan, setScan] = useState<ArbitrageScanResponse>();
  const [search, setSearch] = useState("");
  const [minEdgeBps, setMinEdgeBps] = useState(0);
  const [minCapacity, setMinCapacity] = useState(1_000);
  const [costBps, setCostBps] = useState(30);
  const [refreshSeconds, setRefreshSeconds] = useState(3);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();

  const refresh = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const next = await fetchArbitrageScan(costBps, signal);
      setScan(next);
      setError(undefined);
    } catch (cause) {
      if (signal?.aborted) return;
      setError(cause instanceof Error ? cause.message : "Arbitrage market data unavailable");
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [costBps]);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  useEffect(() => {
    if (refreshSeconds <= 0) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, refreshSeconds * 1_000);
    return () => window.clearInterval(timer);
  }, [refresh, refreshSeconds]);

  const opportunities = useMemo(() => {
    const query = search.trim().toUpperCase();
    return (scan?.opportunities ?? []).filter((row) =>
      (!query || row.symbol.includes(query)) && row.netEdgeBps >= minEdgeBps && row.topBookCapacityUsd >= minCapacity
    );
  }, [minCapacity, minEdgeBps, scan?.opportunities, search]);
  const best = opportunities[0]?.netEdgeBps;

  return (
    <section className="arb-screener" aria-labelledby="arb-title">
      <header className="arb-hero">
        <div>
          <span className="arb-eyebrow">Binance <ArrowRight size={12} aria-hidden="true" /> Bybit</span>
          <h1 id="arb-title">{arbitrageText(locale, "title")}</h1>
          <p>{arbitrageText(locale, "description")}</p>
        </div>
        <button type="button" className="arb-refresh" onClick={() => void refresh()} disabled={loading}>
          <RefreshCw size={15} className={loading ? "spin" : ""} aria-hidden="true" />
          {arbitrageText(locale, loading ? "updating" : "refresh")}
        </button>
      </header>

      <form className="arb-filters" onSubmit={(event) => { event.preventDefault(); void refresh(); }}>
        <label htmlFor="arb-search">{arbitrageText(locale, "search")}
          <span className="arb-search-control"><Search size={14} aria-hidden="true" /><input id="arb-search" type="search" value={search} placeholder={arbitrageText(locale, "searchPlaceholder")} onChange={(event) => setSearch(event.target.value)} /></span>
        </label>
        <label htmlFor="arb-min-edge">{arbitrageText(locale, "minEdge")}
          <span className="arb-number-control"><input id="arb-min-edge" type="number" value={minEdgeBps / 100} step="0.01" min="-100" max="100" onChange={(event) => setMinEdgeBps((event.target.valueAsNumber || 0) * 100)} /><span>%</span></span>
        </label>
        <label htmlFor="arb-min-capacity">{arbitrageText(locale, "minCapacity")}
          <span className="arb-number-control"><span>$</span><input id="arb-min-capacity" type="number" value={minCapacity} step="100" min="0" onChange={(event) => setMinCapacity(Math.max(0, event.target.valueAsNumber || 0))} /></span>
        </label>
        <label htmlFor="arb-costs">{arbitrageText(locale, "costs")}
          <span id="arb-costs-hint" className="sr-only">{arbitrageText(locale, "costsHint")}</span>
          <span className="arb-number-control"><input id="arb-costs" type="number" value={costBps} step="1" min="0" max="1000" aria-describedby="arb-costs-hint" onChange={(event) => setCostBps(Math.min(1_000, Math.max(0, event.target.valueAsNumber || 0)))} /><span>bp</span></span>
        </label>
        <label htmlFor="arb-refresh-rate">{arbitrageText(locale, "refreshEvery")}
          <select id="arb-refresh-rate" value={refreshSeconds} onChange={(event) => setRefreshSeconds(Number(event.target.value))}>
            <option value="0">{arbitrageText(locale, "off")}</option>
            {[2, 3, 5, 10, 30].map((seconds) => <option key={seconds} value={seconds}>{seconds} {arbitrageText(locale, "seconds")}</option>)}
          </select>
        </label>
      </form>

      {error && <div className="arb-notice danger" role="alert"><AlertTriangle size={15} aria-hidden="true" /> {error}</div>}
      {scan?.stale && <div className="arb-notice warning"><AlertTriangle size={15} aria-hidden="true" /> {arbitrageText(locale, "stale")}</div>}

      <div className="arb-summary">
        <Summary label={arbitrageText(locale, "scanned")} value={String(scan?.scannedSymbols ?? "—")} />
        <Summary label={arbitrageText(locale, "matching")} value={String(opportunities.length)} />
        <Summary label={arbitrageText(locale, "bestEdge")} value={best === undefined ? "—" : formatBps(best)} tone={best !== undefined && best > 0 ? "positive" : undefined} />
        <Summary label={arbitrageText(locale, "updated")} value={scan ? new Date(scan.updatedAt).toLocaleTimeString(localeTag(locale)) : "—"} />
      </div>

      {scan && (
        <div className="arb-source-row" aria-label={arbitrageText(locale, "sourceHealth")}>
          {scan.sources.map((source) => <span key={`${source.exchange}-${source.market}`} className={source.ok ? "ok" : "error"} title={source.message}><i aria-hidden="true" /> {venue(source.exchange)} {arbitrageText(locale, source.market)} · {arbitrageText(locale, source.ok ? "connected" : "unavailable")}</span>)}
        </div>
      )}

      <div className="arb-table-shell">
        <table className="arb-table">
          <caption>{arbitrageText(locale, "results")}</caption>
          <thead><tr>
            <th scope="col">{arbitrageText(locale, "pair")}</th>
            <th scope="col">{arbitrageText(locale, "buySpot")}</th>
            <th scope="col">{arbitrageText(locale, "shortPerpetual")}</th>
            <th scope="col">{arbitrageText(locale, "grossSpread")}</th>
            <th scope="col">{arbitrageText(locale, "netEdge")}</th>
            <th scope="col">{arbitrageText(locale, "capacity")}</th>
            <th scope="col">{arbitrageText(locale, "funding")}</th>
            <th scope="col"><span className="sr-only">{arbitrageText(locale, "action")}</span></th>
          </tr></thead>
          <tbody>{opportunities.map((row) => <OpportunityRow key={row.id} row={row} locale={locale} onOpenChart={onOpenChart} />)}</tbody>
        </table>
        {!loading && opportunities.length === 0 && <div className="arb-empty"><strong>{arbitrageText(locale, "noResults")}</strong><span>{arbitrageText(locale, "noResultsHint")}</span></div>}
      </div>

      <aside className="arb-risk"><ShieldAlert size={18} aria-hidden="true" /><div><strong>{arbitrageText(locale, "riskTitle")}</strong><p>{arbitrageText(locale, "risk")}</p></div></aside>
    </section>
  );
}

function OpportunityRow({ row, locale, onOpenChart }: { row: ArbitrageOpportunity; locale: Locale; onOpenChart(symbol: string): void }) {
  const price = (value: number) => new Intl.NumberFormat(localeTag(locale), { maximumSignificantDigits: 10 }).format(value);
  const money = (value: number) => new Intl.NumberFormat(localeTag(locale), { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value);
  return <tr>
    <th scope="row"><strong>{row.symbol}</strong><small>USDT</small></th>
    <td><strong>{venue(row.spotExchange)}</strong><span>{arbitrageText(locale, "buyAt")} {price(row.spotAsk)}</span></td>
    <td><strong>{venue(row.futuresExchange)}</strong><span>{arbitrageText(locale, "sellAt")} {price(row.futuresBid)}</span></td>
    <td>{formatBps(row.grossSpreadBps)}</td>
    <td><mark className={row.netEdgeBps > 0 ? "positive" : "negative"}>{formatBps(row.netEdgeBps)}</mark><small>−{row.estimatedTotalCostBps.toFixed(0)} bp</small></td>
    <td>{money(row.topBookCapacityUsd)}</td>
    <td className={row.fundingRate >= 0 ? "funding-positive" : "funding-negative"}>{(row.fundingRate * 100).toFixed(4)}%</td>
    <td><button type="button" className="arb-chart-link" onClick={() => onOpenChart(row.symbol)} aria-label={arbitrageText(locale, "openChart", { symbol: row.symbol })}><ArrowRight size={15} aria-hidden="true" /></button></td>
  </tr>;
}

function Summary({ label, value, tone }: { label: string; value: string; tone?: "positive" }) {
  return <div className={tone ? `arb-summary-card ${tone}` : "arb-summary-card"}><span>{label}</span><strong>{value}</strong></div>;
}

function venue(exchange: "binance" | "bybit") { return exchange === "binance" ? "Binance" : "Bybit"; }
function formatBps(value: number) { return `${value >= 0 ? "+" : ""}${(value / 100).toFixed(3)}%`; }
