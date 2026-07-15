import { AlertTriangle, BarChart3, RefreshCw, ShieldAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { localeTag, type Locale } from "../i18n";
import type { ArbitrageChartTarget } from "./chartTarget";
import { fetchNativeSpreadScan, type NativeSpreadContractType, type NativeSpreadOpportunity, type NativeSpreadScanResponse } from "./nativeSpreadClient";
import { nativeSpreadText } from "./nativeSpreadText";
import { ScannerWorkbench, type ScannerColumn, type ScannerVisualRow } from "./ScannerWorkbench";
import type { ScannerFilterValue } from "./scannerPrefs";
import { scannerUxText } from "./scannerUxText";
import { adaptNativeSpreadOpportunity, currentNativeSpreadQuoteAgeMs, isNativeSpreadOpportunityFresh } from "./marketOpportunityAdapters";
import { OpportunityHandoffButton } from "./OpportunityHandoffButton";

interface Props {
  locale: Locale;
  onOpenChart(target: ArbitrageChartTarget): void;
  storageOwner?: string;
}

interface ScanOptions {
  contractType?: NativeSpreadContractType;
  baseCoin: string;
  minimumQuantity: number;
  sort: "capacity" | "tightness" | "freshness";
  maxCandidates: number;
}

const DEFAULT_OPTIONS: ScanOptions = { baseCoin: "", minimumQuantity: 0, sort: "capacity", maxCandidates: 20 };
const PRODUCT_TYPES: NativeSpreadContractType[] = ["FundingRateArb", "CarryTrade", "FutureSpread", "PerpBasis"];
const NATIVE_COLUMNS: readonly ScannerColumn[] = [
  { id: "route", label: "", required: true },
  { id: "legs", label: "" },
  { id: "bid", label: "" },
  { id: "ask", label: "" },
  { id: "width", label: "" },
  { id: "capacity", label: "" },
  { id: "rules", label: "" },
  { id: "quality", label: "" },
  { id: "actions", label: "", required: true }
];
const NATIVE_DEFAULT_COLUMNS = NATIVE_COLUMNS.map((column) => column.id);
const NATIVE_COLUMN_TEXT = { route: "routeColumn", legs: "legsColumn", bid: "bidColumn", ask: "askColumn", width: "widthColumn", capacity: "capacityColumn", rules: "rulesColumn", quality: "qualityColumn", actions: "actionsColumn" } as const;

export function NativeSpreadScreener({ locale, onOpenChart, storageOwner }: Props) {
  const [options, setOptions] = useState(DEFAULT_OPTIONS);
  const [scan, setScan] = useState<NativeSpreadScanResponse>();
  const [error, setError] = useState<"scannerUnavailable">();
  const [loading, setLoading] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const activeRequest = useRef<AbortController>();

  const runScan = useCallback(async (next: ScanOptions) => {
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    setLoading(true);
    setError(undefined);
    try {
      setScan(await fetchNativeSpreadScan(next, controller.signal));
      setNow(Date.now());
    } catch {
      if (!controller.signal.aborted) setError("scannerUnavailable");
    } finally {
      if (activeRequest.current === controller) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void runScan(DEFAULT_OPTIONS);
    const freshnessTimer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      activeRequest.current?.abort();
      window.clearInterval(freshnessTimer);
    };
  }, [runScan]);
  const workspaceColumns = useMemo(() => NATIVE_COLUMNS.map((column) => ({ ...column, label: scannerUxText(locale, NATIVE_COLUMN_TEXT[column.id as keyof typeof NATIVE_COLUMN_TEXT]) })), [locale]);
  const workspaceFilters = useMemo<Record<string, ScannerFilterValue>>(() => ({ ...options, contractType: options.contractType ?? "" }), [options]);
  const visualRows = useMemo<ScannerVisualRow[]>(
    () =>
      (scan?.opportunities ?? []).map((row) => {
        const quoteAgeMs = currentNativeSpreadQuoteAgeMs(row, scan?.updatedAt ?? row.receivedAt, now);
        return ({
        id: row.id,
        label: row.symbol,
        subtitle: `${nativeSpreadText(locale, row.contractType)} · ${scannerUxText(locale, "nativeRoute")}`,
        heatValue: -(row.relativeBookWidthBps ?? Number.MAX_SAFE_INTEGER),
        nodes: [
          { label: row.legs[0].symbol, detail: nativeSpreadText(locale, row.legs[0].contractType) },
          { label: row.symbol, detail: nativeSpreadText(locale, row.contractType) },
          { label: row.legs[1].symbol, detail: nativeSpreadText(locale, row.legs[1].contractType) }
        ],
        metrics: [
          { key: "primary", label: nativeSpreadText(locale, "width"), value: row.relativeBookWidthBps ?? row.bookWidth, formatted: row.relativeBookWidthBps === undefined ? formatNumber(row.bookWidth, locale) : nativeSpreadText(locale, "relativeWidth", { value: row.relativeBookWidthBps.toFixed(2) }) },
          { key: "secondary", label: `${nativeSpreadText(locale, "bid")} → ${nativeSpreadText(locale, "ask")}`, value: row.bookWidth, formatted: `${formatNumber(row.bidPrice, locale)} → ${formatNumber(row.askPrice, locale)}` },
          { key: "capacity", label: nativeSpreadText(locale, "size"), value: row.executableQuantity, formatted: `${formatNumber(row.executableQuantity, locale)} ${row.baseCoin}` },
          { key: "freshness", label: scannerUxText(locale, "freshnessMetric"), value: -quoteAgeMs, formatted: nativeSpreadText(locale, "age", { value: String(Math.round(quoteAgeMs)) }) }
        ]
        });
      }),
    [locale, now, scan?.opportunities, scan?.updatedAt]
  );

  return (
    <section className="arb-screener arb-native-spreads" aria-labelledby="native-spread-title">
      <header className="arb-hero">
        <div>
          <span className="arb-eyebrow">{nativeSpreadText(locale, "eyebrow")}</span>
          <h1 id="native-spread-title">{nativeSpreadText(locale, "title")}</h1>
          <p>{nativeSpreadText(locale, "description")}</p>
        </div>
      </header>

      <form
        className="arb-filters arb-native-spread-filters"
        onSubmit={(event) => {
          event.preventDefault();
          void runScan(options);
        }}
      >
        <label htmlFor="native-product">
          {nativeSpreadText(locale, "product")}
          <select id="native-product" value={options.contractType ?? ""} onChange={(event) => setOptions((value) => ({ ...value, contractType: (event.target.value || undefined) as NativeSpreadContractType | undefined }))}>
            <option value="">{nativeSpreadText(locale, "allProducts")}</option>
            {PRODUCT_TYPES.map((type) => (
              <option key={type} value={type}>
                {nativeSpreadText(locale, type)}
              </option>
            ))}
          </select>
        </label>
        <label htmlFor="native-base">
          {nativeSpreadText(locale, "baseCoin")}
          <input id="native-base" value={options.baseCoin} maxLength={20} pattern="[A-Za-z0-9_-]{0,20}" placeholder={nativeSpreadText(locale, "anyBase")} onChange={(event) => setOptions((value) => ({ ...value, baseCoin: event.target.value.toUpperCase() }))} />
        </label>
        <label htmlFor="native-min-size">
          {nativeSpreadText(locale, "minimumSize")}
          <input id="native-min-size" type="number" min="0" step="0.0001" value={options.minimumQuantity} onChange={(event) => setOptions((value) => ({ ...value, minimumQuantity: Math.max(0, event.target.valueAsNumber || 0) }))} />
        </label>
        <label htmlFor="native-ranking">
          {nativeSpreadText(locale, "ranking")}
          <select id="native-ranking" value={options.sort} onChange={(event) => setOptions((value) => ({ ...value, sort: event.target.value as ScanOptions["sort"] }))}>
            <option value="capacity">{nativeSpreadText(locale, "capacity")}</option>
            <option value="tightness">{nativeSpreadText(locale, "tightness")}</option>
            <option value="freshness">{nativeSpreadText(locale, "freshness")}</option>
          </select>
        </label>
        <label htmlFor="native-candidates">
          {nativeSpreadText(locale, "candidates")}
          <input id="native-candidates" type="number" min="1" max="50" step="1" value={options.maxCandidates} onChange={(event) => setOptions((value) => ({ ...value, maxCandidates: Math.max(1, Math.min(50, Math.trunc(event.target.valueAsNumber || 1))) }))} />
        </label>
        <button className="arb-refresh arb-triangular-submit" type="submit" disabled={loading}>
          <RefreshCw className={loading ? "spin" : undefined} size={15} aria-hidden="true" />
          {nativeSpreadText(locale, loading ? "scanning" : "scan")}
        </button>
      </form>

      {error && (
        <div className="arb-notice danger" role="alert">
          <AlertTriangle size={15} aria-hidden="true" /> {nativeSpreadText(locale, error)}
        </div>
      )}
      {scan?.candidateTruncated && (
        <div className="arb-notice warning">
          <AlertTriangle size={15} aria-hidden="true" /> {nativeSpreadText(locale, "partial")}
        </div>
      )}
      {scan && scan.sourceErrors.length > 0 && (
        <details className="arb-native-errors">
          <summary>{nativeSpreadText(locale, "sourceErrors", { count: String(scan.sourceErrors.length) })}</summary>
          <ul>
            {scan.sourceErrors.slice(0, 20).map((message, index) => (
              <li key={`${index}-${message}`}>{locale === "en" ? message : nativeSpreadText(locale, "sourceErrorItem", { index: String(index + 1) })}</li>
            ))}
          </ul>
        </details>
      )}

      <div className="arb-summary">
        <Summary label={nativeSpreadText(locale, "instruments")} value={scan ? String(scan.totalInstruments) : "—"} />
        <Summary label={nativeSpreadText(locale, "eligible")} value={scan ? String(scan.eligibleInstruments) : "—"} />
        <Summary label={nativeSpreadText(locale, "checked")} value={scan ? String(scan.scannedInstruments) : "—"} />
        <Summary label={nativeSpreadText(locale, "healthy")} value={scan ? String(scan.healthyBooks) : "—"} />
      </div>

      <ScannerWorkbench
        mode="native"
        storageOwner={storageOwner}
        locale={locale}
        filters={workspaceFilters}
        columns={workspaceColumns}
        defaultColumns={NATIVE_DEFAULT_COLUMNS}
        rows={visualRows}
        onApplyFilters={(filters) => {
          const next = normalizeNativeOptions(options, filters);
          setOptions(next);
          void runScan(next);
        }}
      >
        {({ visibleColumns }) => (
          <div className="arb-table-shell" aria-busy={loading}>
            <table className="arb-table arb-native-spread-table" style={{ minWidth: `${Math.max(680, visibleColumns.size * 145)}px` }}>
              <caption>
                {nativeSpreadText(locale, "results")}
                {scan ? (
                  <small>
                    {nativeSpreadText(locale, "updated")}: {new Date(scan.updatedAt).toLocaleTimeString(localeTag(locale))}
                  </small>
                ) : null}
              </caption>
              <thead>
                <tr>
                  {visibleColumns.has("route") && <th scope="col">{nativeSpreadText(locale, "combination")}</th>}
                  {visibleColumns.has("legs") && <th scope="col">{nativeSpreadText(locale, "legs")}</th>}
                  {visibleColumns.has("bid") && <th scope="col">{nativeSpreadText(locale, "bid")}</th>}
                  {visibleColumns.has("ask") && <th scope="col">{nativeSpreadText(locale, "ask")}</th>}
                  {visibleColumns.has("width") && <th scope="col">{nativeSpreadText(locale, "width")}</th>}
                  {visibleColumns.has("capacity") && <th scope="col">{nativeSpreadText(locale, "size")}</th>}
                  {visibleColumns.has("rules") && <th scope="col">{nativeSpreadText(locale, "rules")}</th>}
                  {visibleColumns.has("quality") && <th scope="col">{nativeSpreadText(locale, "quality")}</th>}
                  {visibleColumns.has("actions") && <th scope="col">{nativeSpreadText(locale, "actions")}</th>}
                </tr>
              </thead>
              <tbody>
                {(scan?.opportunities ?? []).map((row) => (
                  <NativeSpreadRow key={row.id} locale={locale} row={row} evaluatedAt={scan?.updatedAt ?? row.receivedAt} now={now} columns={visibleColumns} onOpenChart={onOpenChart} />
                ))}
              </tbody>
            </table>
            {!loading && scan && scan.opportunities.length === 0 && (
              <div className="arb-empty">
                <strong>{nativeSpreadText(locale, "noResults")}</strong>
                <span>{nativeSpreadText(locale, "noResultsHint")}</span>
              </div>
            )}
          </div>
        )}
      </ScannerWorkbench>

      <aside className="arb-risk">
        <ShieldAlert size={18} aria-hidden="true" />
        <div>
          <strong>{nativeSpreadText(locale, "riskTitle")}</strong>
          <p>{nativeSpreadText(locale, "risk")}</p>
        </div>
      </aside>
    </section>
  );
}

export function NativeSpreadRow({ locale, row, evaluatedAt, now, columns, onOpenChart }: { locale: Locale; row: NativeSpreadOpportunity; evaluatedAt: number; now: number; columns: ReadonlySet<string>; onOpenChart(target: ArbitrageChartTarget): void }) {
  const quoteAgeMs = currentNativeSpreadQuoteAgeMs(row, evaluatedAt, now);
  const fresh = isNativeSpreadOpportunityFresh(row, evaluatedAt, now);
  return (
    <tr>
      {columns.has("route") && (
        <th scope="row">
          <strong>{row.symbol}</strong>
          <small>{nativeSpreadText(locale, row.contractType)}</small>
        </th>
      )}
      {columns.has("legs") && (
        <td>
          {row.legs.map((leg) => (
            <span key={`${leg.contractType}-${leg.symbol}`}>
              <strong>{leg.symbol}</strong> · {nativeSpreadText(locale, leg.contractType)}
            </span>
          ))}
        </td>
      )}
      {columns.has("bid") && (
        <td>
          <strong>{formatNumber(row.bidPrice, locale)}</strong>
          <small>{formatNumber(row.bidQuantity, locale)}</small>
        </td>
      )}
      {columns.has("ask") && (
        <td>
          <strong>{formatNumber(row.askPrice, locale)}</strong>
          <small>{formatNumber(row.askQuantity, locale)}</small>
        </td>
      )}
      {columns.has("width") && (
        <td>
          <strong>{formatNumber(row.bookWidth, locale)}</strong>
          <small>{row.relativeBookWidthBps === undefined ? "—" : nativeSpreadText(locale, "relativeWidth", { value: row.relativeBookWidthBps.toFixed(2) })}</small>
        </td>
      )}
      {columns.has("capacity") && (
        <td>
          <strong>{formatNumber(row.executableQuantity, locale)}</strong>
          <small>{row.baseCoin}</small>
        </td>
      )}
      {columns.has("rules") && (
        <td>
          <strong>{nativeSpreadText(locale, "step", { value: formatNumber(row.quantityStep, locale) })}</strong>
          <small>{nativeSpreadText(locale, "minimum", { value: formatNumber(row.minimumQuantity, locale) })}</small>
        </td>
      )}
      {columns.has("quality") && (
        <td>
          <strong>{nativeSpreadText(locale, "restTopBook")}</strong>
          <small>{nativeSpreadText(locale, "age", { value: String(Math.round(quoteAgeMs)) })}</small>
        </td>
      )}
      {columns.has("actions") && (
        <td>
          <span className="arb-row-actions">
            <OpportunityHandoffButton
              locale={locale}
              name={row.symbol}
              disabled={!fresh}
              disabledReason={nativeSpreadText(locale, "staleHandoff")}
              createOpportunity={() => adaptNativeSpreadOpportunity(row, { evaluatedAt, now })}
            />
            {row.legs.map((leg) => (
              <button
                key={`${leg.contractType}-${leg.symbol}`}
                type="button"
                title={nativeSpreadText(locale, "chart", { symbol: leg.symbol })}
                aria-label={nativeSpreadText(locale, "chart", { symbol: leg.symbol })}
                onClick={() => onOpenChart({ symbol: leg.symbol, exchange: "bybit", marketType: leg.contractType === "Spot" ? "spot" : "linear", priceType: "last" })}
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

function Summary({ label, value }: { label: string; value: string }) {
  return (
    <div className="arb-summary-card">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function formatNumber(value: number, locale: Locale) {
  return new Intl.NumberFormat(localeTag(locale), { maximumFractionDigits: 8 }).format(value);
}

function normalizeNativeOptions(current: ScanOptions, filters: Record<string, ScannerFilterValue>): ScanOptions {
  const contractType = typeof filters.contractType === "string" && PRODUCT_TYPES.includes(filters.contractType as NativeSpreadContractType) ? (filters.contractType as NativeSpreadContractType) : filters.contractType === "" ? undefined : current.contractType;
  const baseCoin = typeof filters.baseCoin === "string" && /^[A-Za-z0-9_-]{0,20}$/.test(filters.baseCoin) ? filters.baseCoin.toUpperCase() : current.baseCoin;
  const sort = filters.sort === "capacity" || filters.sort === "tightness" || filters.sort === "freshness" ? filters.sort : current.sort;
  return {
    contractType,
    baseCoin,
    sort,
    minimumQuantity: typeof filters.minimumQuantity === "number" ? clamp(filters.minimumQuantity, 0, 1_000_000_000) : current.minimumQuantity,
    maxCandidates: typeof filters.maxCandidates === "number" ? Math.trunc(clamp(filters.maxCandidates, 1, 50)) : current.maxCandidates
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}
