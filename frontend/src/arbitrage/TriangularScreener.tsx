import { AlertTriangle, BarChart3, CheckCircle2, RefreshCw, SearchCheck, ShieldAlert, XCircle } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { localeTag, type Locale } from "../i18n";
import { fetchTriangularDepthVerification, fetchTriangularScan, type TriangularDepthVerificationResponse, type TriangularOpportunity, type TriangularScanResponse } from "./triangularClient";
import { triangularText } from "./triangularText";
import type { ArbitrageChartTarget } from "./chartTarget";
import { ScannerWorkbench, type ScannerColumn, type ScannerVisualRow } from "./ScannerWorkbench";
import type { ScannerFilterValue } from "./scannerPrefs";
import { scannerUxText } from "./scannerUxText";
import { adaptTriangularOpportunity } from "./marketOpportunityAdapters";
import { OpportunityHandoffButton } from "./OpportunityHandoffButton";

interface Props {
  locale: Locale;
  onOpenChart(target: ArbitrageChartTarget): void;
}

interface ScanOptions {
  venue: "binance" | "bybit";
  startAsset: string;
  startQuantity: number;
  takerFeeBps: number;
  minimumNetReturnBps: number;
}

type DepthVerificationState = { candidateId: string; status: "loading" } | { candidateId: string; status: "success"; result: TriangularDepthVerificationResponse } | { candidateId: string; status: "error" };

const DEFAULT_OPTIONS: ScanOptions = {
  venue: "binance",
  startAsset: "USDT",
  startQuantity: 1_000,
  takerFeeBps: 10,
  minimumNetReturnBps: 0
};
const TRIANGULAR_COLUMNS: readonly ScannerColumn[] = [
  { id: "route", label: "", required: true },
  { id: "leg1", label: "" },
  { id: "leg2", label: "" },
  { id: "leg3", label: "" },
  { id: "gross", label: "" },
  { id: "net", label: "" },
  { id: "result", label: "" },
  { id: "capacity", label: "" },
  { id: "quality", label: "" },
  { id: "actions", label: "", required: true }
];
const TRIANGULAR_DEFAULT_COLUMNS = TRIANGULAR_COLUMNS.map((column) => column.id);
const TRIANGULAR_COLUMN_TEXT = { route: "routeColumn", leg1: "leg1Column", leg2: "leg2Column", leg3: "leg3Column", gross: "grossColumn", net: "netColumn", result: "resultColumn", capacity: "capacityColumn", quality: "qualityColumn", actions: "actionsColumn" } as const;

export function TriangularScreener({ locale, onOpenChart }: Props) {
  const [options, setOptions] = useState(DEFAULT_OPTIONS);
  const [scan, setScan] = useState<TriangularScanResponse>();
  const [error, setError] = useState<"scannerUnavailable">();
  const [loading, setLoading] = useState(false);
  const [depthVerification, setDepthVerification] = useState<DepthVerificationState>();
  const activeRequest = useRef<AbortController>();
  const activeVerification = useRef<AbortController>();

  const runScan = useCallback(async (nextOptions: ScanOptions) => {
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    setLoading(true);
    setError(undefined);
    activeVerification.current?.abort();
    setDepthVerification(undefined);
    try {
      setScan(await fetchTriangularScan(nextOptions, controller.signal));
    } catch {
      if (!controller.signal.aborted) setError("scannerUnavailable");
    } finally {
      if (activeRequest.current === controller) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void runScan(DEFAULT_OPTIONS);
    return () => {
      activeRequest.current?.abort();
      activeVerification.current?.abort();
    };
  }, [runScan]);

  const verifyDepth = useCallback(
    async (candidate: TriangularOpportunity) => {
      activeVerification.current?.abort();
      const controller = new AbortController();
      activeVerification.current = controller;
      setDepthVerification({ candidateId: candidate.id, status: "loading" });
      try {
        const result = await fetchTriangularDepthVerification(
          {
            venue: candidate.venue,
            startAsset: candidate.startAsset,
            startQuantity: options.startQuantity,
            takerFeeBps: options.takerFeeBps,
            minimumNetReturnBps: options.minimumNetReturnBps,
            symbols: candidate.legs.map((leg) => leg.symbol) as [string, string, string]
          },
          controller.signal
        );
        if (!controller.signal.aborted) setDepthVerification({ candidateId: candidate.id, status: "success", result });
      } catch {
        if (!controller.signal.aborted) setDepthVerification({ candidateId: candidate.id, status: "error" });
      }
    },
    [options.minimumNetReturnBps, options.startQuantity, options.takerFeeBps]
  );

  const best = scan?.opportunities[0]?.netReturnBps;
  const workspaceColumns = useMemo(() => TRIANGULAR_COLUMNS.map((column) => ({ ...column, label: scannerUxText(locale, TRIANGULAR_COLUMN_TEXT[column.id as keyof typeof TRIANGULAR_COLUMN_TEXT]) })), [locale]);
  const workspaceFilters = useMemo<Record<string, ScannerFilterValue>>(() => ({ ...options }), [options]);
  const visualRows = useMemo<ScannerVisualRow[]>(
    () =>
      (scan?.opportunities ?? []).map((row) => {
        const route = [row.legs[0].fromAsset, ...row.legs.map((leg) => leg.toAsset)].join(" → ");
        return {
          id: row.id,
          label: route,
          subtitle: `${row.venue === "binance" ? "Binance" : "Bybit"} · ${scannerUxText(locale, "triangularRoute")}`,
          heatValue: row.netReturnBps,
          nodes: [{ label: row.legs[0].fromAsset, detail: row.legs[0].symbol }, ...row.legs.map((leg) => ({ label: leg.toAsset, detail: leg.symbol }))],
          metrics: [
            { key: "primary", label: triangularText(locale, "netReturn"), value: row.netReturnBps, formatted: formatBps(row.netReturnBps) },
            { key: "secondary", label: triangularText(locale, "result"), value: row.endQuantity, formatted: `${formatNumber(row.startQuantity, locale)} → ${formatNumber(row.endQuantity, locale)} ${row.startAsset}` },
            { key: "capacity", label: triangularText(locale, "capacity"), value: row.limitingCapacity.executableStartQuantity, formatted: `${formatNumber(row.limitingCapacity.executableStartQuantity, locale)} ${row.startAsset}` },
            { key: "freshness", label: scannerUxText(locale, "freshnessMetric"), value: -row.timestamps.quoteAgeMs, formatted: triangularText(locale, "quoteAge", { value: String(Math.round(row.timestamps.quoteAgeMs)) }) }
          ]
        };
      }),
    [locale, scan?.opportunities]
  );

  return (
    <section className="arb-screener arb-triangular" aria-labelledby="triangular-title">
      <header className="arb-hero">
        <div>
          <span className="arb-eyebrow">{triangularText(locale, "eyebrow", { venue: options.venue === "binance" ? "Binance" : "Bybit" })}</span>
          <h1 id="triangular-title">{triangularText(locale, "title")}</h1>
          <p>{triangularText(locale, "description")}</p>
        </div>
      </header>

      <form
        className="arb-filters arb-triangular-filters"
        onSubmit={(event) => {
          event.preventDefault();
          void runScan(options);
        }}
      >
        <label htmlFor="triangular-venue">
          {triangularText(locale, "venue")}
          <select id="triangular-venue" value={options.venue} onChange={(event) => setOptions((value) => ({ ...value, venue: event.target.value as ScanOptions["venue"] }))}>
            <option value="binance">Binance</option>
            <option value="bybit">Bybit</option>
          </select>
        </label>
        <label htmlFor="triangular-asset">
          {triangularText(locale, "startAsset")}
          <input id="triangular-asset" value={options.startAsset} maxLength={20} pattern="[A-Za-z0-9_-]{2,20}" onChange={(event) => setOptions((value) => ({ ...value, startAsset: event.target.value.toUpperCase() }))} />
        </label>
        <label htmlFor="triangular-amount">
          {triangularText(locale, "amount")}
          <input id="triangular-amount" type="number" min="10" max="10000000" step="10" value={options.startQuantity} onChange={(event) => setOptions((value) => ({ ...value, startQuantity: Math.max(10, event.target.valueAsNumber || 10) }))} />
        </label>
        <label htmlFor="triangular-fee">
          {triangularText(locale, "fee")}
          <span className="arb-number-control">
            <input id="triangular-fee" type="number" min="0" max="10" step="0.01" value={options.takerFeeBps / 100} onChange={(event) => setOptions((value) => ({ ...value, takerFeeBps: Math.max(0, (event.target.valueAsNumber || 0) * 100) }))} />
            <span>%</span>
          </span>
        </label>
        <label htmlFor="triangular-return">
          {triangularText(locale, "minimumReturn")}
          <span className="arb-number-control">
            <input id="triangular-return" type="number" min="-10" max="100" step="0.01" value={options.minimumNetReturnBps / 100} onChange={(event) => setOptions((value) => ({ ...value, minimumNetReturnBps: (event.target.valueAsNumber || 0) * 100 }))} />
            <span>%</span>
          </span>
        </label>
        <button className="arb-refresh arb-triangular-submit" type="submit" disabled={loading}>
          <RefreshCw className={loading ? "spin" : undefined} size={15} aria-hidden="true" />
          {triangularText(locale, loading ? "scanning" : "scan")}
        </button>
      </form>

      {error && (
        <div className="arb-notice danger" role="alert">
          <AlertTriangle size={15} aria-hidden="true" /> {triangularText(locale, error)}
        </div>
      )}
      {scan?.truncated && (
        <div className="arb-notice warning">
          <AlertTriangle size={15} aria-hidden="true" /> {triangularText(locale, "truncated")}
        </div>
      )}

      <div className="arb-summary">
        <Summary label={triangularText(locale, "markets")} value={scan ? String(scan.scannedMarkets) : "—"} />
        <Summary label={triangularText(locale, "cycles")} value={scan ? String(scan.scannedCycles) : "—"} />
        <Summary label={triangularText(locale, "opportunities")} value={scan ? String(scan.totalOpportunities) : "—"} />
        <Summary label={triangularText(locale, "bestReturn")} value={best === undefined ? "—" : formatBps(best)} positive={best !== undefined && best > 0} />
      </div>

      <ScannerWorkbench
        mode="triangular"
        locale={locale}
        filters={workspaceFilters}
        columns={workspaceColumns}
        defaultColumns={TRIANGULAR_DEFAULT_COLUMNS}
        rows={visualRows}
        onApplyFilters={(filters) => {
          const next = normalizeTriangularOptions(options, filters);
          setOptions(next);
          void runScan(next);
        }}
      >
        {({ visibleColumns }) => (
          <div className="arb-table-shell" aria-busy={loading}>
            <table className="arb-table arb-triangular-table" style={{ minWidth: `${Math.max(680, visibleColumns.size * 145)}px` }}>
              <caption>
                {triangularText(locale, "results")}
                {scan ? (
                  <small>
                    {triangularText(locale, "updated")}: {new Date(scan.updatedAt).toLocaleTimeString(localeTag(locale))}
                  </small>
                ) : null}
              </caption>
              <thead>
                <tr>
                  {visibleColumns.has("route") && <th scope="col">{triangularText(locale, "route")}</th>}
                  {[1, 2, 3].map((index) =>
                    visibleColumns.has(`leg${index}`) ? (
                      <th scope="col" key={index}>
                        {triangularText(locale, "leg", { index: String(index) })}
                      </th>
                    ) : null
                  )}
                  {visibleColumns.has("gross") && <th scope="col">{triangularText(locale, "grossReturn")}</th>}
                  {visibleColumns.has("net") && <th scope="col">{triangularText(locale, "netReturn")}</th>}
                  {visibleColumns.has("result") && <th scope="col">{triangularText(locale, "result")}</th>}
                  {visibleColumns.has("capacity") && <th scope="col">{triangularText(locale, "capacity")}</th>}
                  {visibleColumns.has("quality") && <th scope="col">{triangularText(locale, "quality")}</th>}
                  {visibleColumns.has("actions") && <th scope="col">{triangularText(locale, "action")}</th>}
                </tr>
              </thead>
              <tbody>
                {(scan?.opportunities ?? []).map((row) => (
                  <TriangularRow key={row.id} locale={locale} row={row} columns={visibleColumns} onOpenChart={onOpenChart} onVerifyDepth={verifyDepth} verifying={depthVerification?.candidateId === row.id && depthVerification.status === "loading"} />
                ))}
              </tbody>
            </table>
            {!loading && scan && scan.opportunities.length === 0 && (
              <div className="arb-empty">
                <strong>{triangularText(locale, "noResults")}</strong>
                <span>{triangularText(locale, "noResultsHint")}</span>
              </div>
            )}
          </div>
        )}
      </ScannerWorkbench>

      <DepthVerificationResult locale={locale} state={depthVerification} />

      <aside className="arb-risk">
        <ShieldAlert size={18} aria-hidden="true" />
        <div>
          <strong>{triangularText(locale, "riskTitle")}</strong>
          <p>{triangularText(locale, "risk")}</p>
        </div>
      </aside>
    </section>
  );
}

function TriangularRow({
  locale,
  row,
  columns,
  onOpenChart,
  onVerifyDepth,
  verifying
}: {
  locale: Locale;
  row: TriangularOpportunity;
  columns: ReadonlySet<string>;
  onOpenChart(target: ArbitrageChartTarget): void;
  onVerifyDepth(row: TriangularOpportunity): void;
  verifying: boolean;
}) {
  const route = [row.legs[0].fromAsset, ...row.legs.map((leg) => leg.toAsset)].join(" → ");
  return (
    <tr>
      {columns.has("route") && (
        <th scope="row">
          <strong>{route}</strong>
          <small>{row.venue}</small>
        </th>
      )}
      {row.legs.map((leg) =>
        columns.has(`leg${leg.index + 1}`) ? (
          <td key={`${row.id}-${leg.index}`}>
            <strong>{leg.symbol}</strong>
            <small>
              {triangularText(locale, leg.side)} · {formatNumber(leg.inputQuantity, locale)} → {formatNumber(leg.outputQuantity, locale)}
            </small>
          </td>
        ) : null
      )}
      {columns.has("gross") && <td>{formatBps(row.grossReturnBps)}</td>}
      {columns.has("net") && (
        <td>
          <mark className={row.netReturnBps > 0 ? "positive" : "negative"}>{formatBps(row.netReturnBps)}</mark>
        </td>
      )}
      {columns.has("result") && (
        <td>
          <strong>
            {formatNumber(row.startQuantity, locale)} → {formatNumber(row.endQuantity, locale)}
          </strong>
          <small>{row.startAsset}</small>
        </td>
      )}
      {columns.has("capacity") && (
        <td>
          <strong>{formatNumber(row.limitingCapacity.executableStartQuantity, locale)}</strong>
          <small>{row.limitingCapacity.utilizationPct.toFixed(1)}%</small>
        </td>
      )}
      {columns.has("quality") && (
        <td>
          <strong>{triangularText(locale, "topBook")}</strong>
          <small>{triangularText(locale, "nonExecutableCandidate")}</small>
          <small>
            {triangularText(locale, "quoteAge", { value: String(Math.round(row.timestamps.quoteAgeMs)) })} · {triangularText(locale, "legSkew", { value: String(Math.round(row.timestamps.legSkewMs)) })}
          </small>
        </td>
      )}
      {columns.has("actions") && (
        <td>
          <span className="arb-row-actions">
            <button className="arb-depth-verify-button" type="button" disabled={verifying} title={triangularText(locale, verifying ? "verifyingDepth" : "verifyDepth")} aria-label={triangularText(locale, verifying ? "verifyingDepth" : "verifyDepth")} onClick={() => onVerifyDepth(row)}>
              <SearchCheck className={verifying ? "spin" : undefined} size={15} aria-hidden="true" />
              <span>{triangularText(locale, verifying ? "verifyingDepthShort" : "verifyDepthShort")}</span>
            </button>
            <OpportunityHandoffButton locale={locale} name={route} createOpportunity={() => adaptTriangularOpportunity(row)} />
            {row.legs.map((leg) => (
              <button
                key={`${row.id}-${leg.index}-chart`}
                type="button"
                title={triangularText(locale, "openChart", { symbol: leg.symbol })}
                aria-label={triangularText(locale, "openChart", { symbol: leg.symbol })}
                onClick={() => onOpenChart({ symbol: leg.symbol, exchange: row.venue, marketType: "spot", priceType: "last" })}
              >
                <BarChart3 size={14} aria-hidden="true" />
              </button>
            ))}
          </span>
        </td>
      )}
    </tr>
  );
}

function DepthVerificationResult({ locale, state }: { locale: Locale; state?: DepthVerificationState }) {
  if (!state) return null;
  if (state.status === "loading") {
    return (
      <section className="arb-depth-verification is-loading" aria-live="polite" aria-busy="true">
        <RefreshCw className="spin" size={18} aria-hidden="true" />
        <div>
          <strong>{triangularText(locale, "verificationRunningTitle")}</strong>
          <p>{triangularText(locale, "verificationRunningBody")}</p>
        </div>
      </section>
    );
  }
  if (state.status === "error") {
    return (
      <section className="arb-depth-verification is-error" role="alert">
        <XCircle size={18} aria-hidden="true" />
        <div>
          <strong>{triangularText(locale, "verificationFailedTitle")}</strong>
          <p>{triangularText(locale, "verificationFailedBody")}</p>
        </div>
      </section>
    );
  }
  const best = state.result.opportunities[0];
  return (
    <section className={`arb-depth-verification ${best ? "is-verified" : "is-rejected"}`} aria-live="polite">
      {best ? <CheckCircle2 size={18} aria-hidden="true" /> : <AlertTriangle size={18} aria-hidden="true" />}
      <div className="arb-depth-verification-content">
        <strong>{triangularText(locale, best ? "verificationPassedTitle" : "verificationRejectedTitle")}</strong>
        <p>{triangularText(locale, best ? "verificationPassedBody" : "verificationRejectedBody")}</p>
        {best ? (
          <dl className="arb-depth-verification-metrics">
            <div>
              <dt>{triangularText(locale, "verifiedNetReturn")}</dt>
              <dd>{formatBps(best.netReturnBps)}</dd>
            </div>
            <div>
              <dt>{triangularText(locale, "verifiedCapacity")}</dt>
              <dd>
                {formatNumber(best.limitingCapacity.executableStartQuantity, locale)} {best.startAsset}
              </dd>
            </div>
            <div>
              <dt>{triangularText(locale, "verifiedAge")}</dt>
              <dd>{Math.round(best.timestamps.quoteAgeMs)} ms</dd>
            </div>
            <div>
              <dt>{triangularText(locale, "verifiedLevels")}</dt>
              <dd>{best.legs.map((leg) => leg.levelsUsed).join(" / ")}</dd>
            </div>
          </dl>
        ) : (
          <ul className="arb-depth-rejections">
            {state.result.rejections.map((rejection) => (
              <li key={`${rejection.cycleId ?? "route"}-${rejection.code}`}>{rejection.message}</li>
            ))}
          </ul>
        )}
        <p className="arb-depth-proof">
          {triangularText(locale, "verificationEvidence")}: {state.result.books.map((book) => `${book.symbol} #${book.sequence} · g${book.connectionGeneration}`).join("; ")}
        </p>
        <p className="arb-depth-boundary">{triangularText(locale, "verificationBoundary")}</p>
      </div>
    </section>
  );
}

function Summary({ label, value, positive = false }: { label: string; value: string; positive?: boolean }) {
  return (
    <div className={positive ? "arb-summary-card positive" : "arb-summary-card"}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function formatBps(value: number) {
  return `${value >= 0 ? "+" : ""}${(value / 100).toFixed(3)}%`;
}

function formatNumber(value: number, locale: Locale) {
  return new Intl.NumberFormat(localeTag(locale), { maximumFractionDigits: 8 }).format(value);
}

function normalizeTriangularOptions(current: ScanOptions, filters: Record<string, ScannerFilterValue>): ScanOptions {
  const venue = filters.venue === "binance" || filters.venue === "bybit" ? filters.venue : current.venue;
  const startAsset = typeof filters.startAsset === "string" && /^[A-Za-z0-9_-]{2,20}$/.test(filters.startAsset) ? filters.startAsset.toUpperCase() : current.startAsset;
  return {
    venue,
    startAsset,
    startQuantity: typeof filters.startQuantity === "number" ? clamp(filters.startQuantity, 10, 10_000_000) : current.startQuantity,
    takerFeeBps: typeof filters.takerFeeBps === "number" ? clamp(filters.takerFeeBps, 0, 1_000) : current.takerFeeBps,
    minimumNetReturnBps: typeof filters.minimumNetReturnBps === "number" ? clamp(filters.minimumNetReturnBps, -1_000, 10_000) : current.minimumNetReturnBps
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
