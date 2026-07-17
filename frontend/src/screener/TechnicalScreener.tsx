import { AlertTriangle, RefreshCw, ShieldAlert, Square } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  SCREENER_RESULT_ROW_LIMIT_V1,
  SCREENER_RUN_REQUEST_SCHEMA_V1,
  SCREENER_SORT_KEYS_V1,
  SCREENER_TIMEFRAMES_V1,
  SCREENER_UNIVERSE_LIMIT_MAXIMUM_V1,
  SCREENER_UNIVERSE_LIMIT_MINIMUM_V1,
  type ScreenerDefinitionV1,
  type ScreenerRowV1,
  type ScreenerRunResultV1,
  type ScreenerSortDirectionV1,
  type ScreenerSortKeyV1,
  type ScreenerTimeframeV1
} from "@saltanatbotv2/contracts";
import { localeTag, type Locale } from "../i18n";
import { screenerText, type ScreenerMessageKey } from "../i18n/screener";
import { useAuth } from "../auth/AuthRoot";
import type { ArbitrageChartTarget } from "../arbitrage/chartTarget";
import { runScreener, ScreenerApiError } from "./client";
import { buildScreenerDefinition, defaultScreenerFormState, formStateFromDefinition, type ScreenerFormState } from "./definitionForm";
import { screenerChartIndicators } from "./chartContext";
import { TechnicalFilters } from "./TechnicalFilters";
import { TechnicalPresets } from "./TechnicalPresets";
import { TechnicalResultsTable } from "./TechnicalResultsTable";
import "../styles/technical-screener.css";

interface Props {
  locale: Locale;
  onOpenChart(target: ArbitrageChartTarget): void;
}

type RunState = { phase: "idle" } | { phase: "running" } | { phase: "done"; result: ScreenerRunResultV1; definition: ScreenerDefinitionV1 } | { phase: "error"; messageKey: ScreenerMessageKey };

const SORT_KEY_TEXT: Record<ScreenerSortKeyV1, ScreenerMessageKey> = {
  quoteVolume24h: "sortQuoteVolume24h",
  change24hPercent: "sortChange24hPercent",
  lastClose: "sortLastClose",
  symbol: "sortSymbol",
  rsi: "sortRsi",
  atrPercent: "sortAtrPercent"
};

export function TechnicalScreener({ locale, onOpenChart }: Props) {
  const accountAuth = useAuth();
  const ownerId = accountAuth.authRequired ? accountAuth.user?.id : undefined;
  const [form, setForm] = useState<ScreenerFormState>(defaultScreenerFormState);
  const [name, setName] = useState("Momentum screen");
  const [run, setRun] = useState<RunState>({ phase: "idle" });
  const runControllerRef = useRef<AbortController>();
  const running = run.phase === "running";

  useEffect(() => () => runControllerRef.current?.abort(), []);

  const startRun = useCallback(async () => {
    if (!ownerId) return;
    const built = buildScreenerDefinition(form, name);
    if (!built.ok) {
      setRun({ phase: "error", messageKey: "invalidDefinition" });
      return;
    }
    runControllerRef.current?.abort();
    const controller = new AbortController();
    runControllerRef.current = controller;
    setRun({ phase: "running" });
    try {
      const result = await runScreener(
        ownerId,
        { schemaVersion: SCREENER_RUN_REQUEST_SCHEMA_V1, definition: built.definition, researchOnly: true, executionPermission: false },
        { clientRequestId: createRunRequestId(), signal: controller.signal }
      );
      if (!controller.signal.aborted) setRun({ phase: "done", result, definition: built.definition });
    } catch (error) {
      if (!controller.signal.aborted) setRun({ phase: "error", messageKey: runErrorKey(error) });
    }
  }, [form, name, ownerId]);

  const cancelRun = useCallback(() => {
    runControllerRef.current?.abort();
    setRun({ phase: "error", messageKey: "runCancelled" });
  }, []);

  const openRow = useCallback(
    (row: ScreenerRowV1, definition: ScreenerDefinitionV1) => {
      onOpenChart({
        symbol: row.symbol,
        exchange: "binance",
        marketType: "spot",
        priceType: "last",
        timeframe: definition.timeframe,
        indicators: screenerChartIndicators(definition)
      });
    },
    [onOpenChart]
  );

  const buildForPreset = useCallback(() => {
    const built = buildScreenerDefinition(form, name);
    return built.ok ? built.definition : undefined;
  }, [form, name]);

  const applyPreset = useCallback((definition: ScreenerDefinitionV1) => {
    setForm(formStateFromDefinition(definition));
    setName(definition.name);
  }, []);

  const unavailableSummary = useMemo(() => (run.phase === "done" ? formatUnavailableReasons(run.result) : undefined), [run]);

  return (
    <section className="arb-screener tech-screener" aria-labelledby="tech-screener-title">
      <header className="arb-hero tech-screener-hero">
        <div>
          <span className="arb-eyebrow">{screenerText(locale, "eyebrow")}</span>
          <h1 id="tech-screener-title">{screenerText(locale, "title")}</h1>
          <p>{screenerText(locale, "description")}</p>
        </div>
      </header>

      {!ownerId ? (
        <p className="arb-server-hint">{screenerText(locale, "signInRequired")}</p>
      ) : (
        <>
          <form
            className="arb-filters tech-screener-form"
            onSubmit={(event) => {
              event.preventDefault();
              void startRun();
            }}
          >
            <label htmlFor="tech-screener-name">
              {screenerText(locale, "screenName")}
              <input id="tech-screener-name" type="text" maxLength={120} value={name} disabled={running} onChange={(event) => setName(event.target.value)} />
            </label>
            <label htmlFor="tech-screener-timeframe">
              {screenerText(locale, "timeframe")}
              <select id="tech-screener-timeframe" value={form.timeframe} disabled={running} onChange={(event) => setForm((value) => ({ ...value, timeframe: event.target.value as ScreenerTimeframeV1 }))}>
                {SCREENER_TIMEFRAMES_V1.map((timeframe) => (
                  <option key={timeframe} value={timeframe}>
                    {timeframe}
                  </option>
                ))}
              </select>
            </label>
            <label htmlFor="tech-screener-universe">
              {screenerText(locale, "universeLimit")}
              <input
                id="tech-screener-universe"
                type="number"
                min={SCREENER_UNIVERSE_LIMIT_MINIMUM_V1}
                max={SCREENER_UNIVERSE_LIMIT_MAXIMUM_V1}
                step="1"
                value={form.universeLimit}
                disabled={running}
                onChange={(event) => setForm((value) => ({ ...value, universeLimit: clampUniverse(event.target.valueAsNumber) }))}
              />
            </label>
            <label htmlFor="tech-screener-sort">
              {screenerText(locale, "sortKey")}
              <select id="tech-screener-sort" value={form.sortKey} disabled={running} onChange={(event) => setForm((value) => ({ ...value, sortKey: event.target.value as ScreenerSortKeyV1 }))}>
                {SCREENER_SORT_KEYS_V1.map((key) => (
                  <option key={key} value={key}>
                    {screenerText(locale, SORT_KEY_TEXT[key])}
                  </option>
                ))}
              </select>
            </label>
            <label htmlFor="tech-screener-direction">
              {screenerText(locale, "sortDirection")}
              <select id="tech-screener-direction" value={form.sortDirection} disabled={running} onChange={(event) => setForm((value) => ({ ...value, sortDirection: event.target.value as ScreenerSortDirectionV1 }))}>
                <option value="desc">{screenerText(locale, "sortDescending")}</option>
                <option value="asc">{screenerText(locale, "sortAscending")}</option>
              </select>
            </label>
            <span className="tech-screener-run-controls">
              <button className="arb-refresh tech-screener-submit" type="submit" disabled={running}>
                <RefreshCw className={running ? "spin" : undefined} size={15} aria-hidden="true" />
                {screenerText(locale, running ? "running" : "run")}
              </button>
              {running && (
                <button className="arb-refresh tech-screener-cancel" type="button" onClick={cancelRun}>
                  <Square size={15} aria-hidden="true" />
                  {screenerText(locale, "cancelRun")}
                </button>
              )}
            </span>
          </form>

          <TechnicalFilters locale={locale} filters={form.filters} disabled={running} onChange={(filters) => setForm((value) => ({ ...value, filters }))} />

          {run.phase === "error" && (
            <div className="arb-notice danger" role="alert">
              <AlertTriangle size={15} aria-hidden="true" /> {screenerText(locale, run.messageKey)}
            </div>
          )}
          {run.phase === "done" && (
            <>
              <div className="arb-summary">
                <Summary label={screenerText(locale, "universeRequested")} value={String(run.result.universe.requested)} />
                <Summary label={screenerText(locale, "universeEvaluated")} value={String(run.result.universe.evaluated)} />
                <Summary label={screenerText(locale, "universeMatched")} value={String(run.result.universe.matched)} tone={run.result.universe.matched > 0 ? "positive" : undefined} />
                <Summary label={screenerText(locale, "universeUnavailable")} value={String(run.result.universe.unavailable)} />
                <Summary label={screenerText(locale, "generatedAt")} value={new Date(run.result.generatedAt).toLocaleTimeString(localeTag(locale))} />
              </div>
              {unavailableSummary && (
                <div className="arb-notice warning" role="status">
                  <AlertTriangle size={15} aria-hidden="true" /> {screenerText(locale, "unavailableReasons", unavailableSummary)}
                </div>
              )}
              {run.result.rowsTruncated && (
                <div className="arb-notice warning" role="status">
                  <AlertTriangle size={15} aria-hidden="true" /> {screenerText(locale, "truncated", { limit: String(SCREENER_RESULT_ROW_LIMIT_V1) })}
                </div>
              )}
              {run.result.rows.length > 0 ? (
                <TechnicalResultsTable locale={locale} rows={run.result.rows} onOpenRow={(row) => openRow(row, run.definition)} />
              ) : (
                <div className="arb-empty">
                  <strong>{screenerText(locale, "noResults")}</strong>
                  <span>{screenerText(locale, "noResultsHint")}</span>
                </div>
              )}
            </>
          )}

          <TechnicalPresets locale={locale} ownerId={ownerId} disabled={running} buildDefinition={buildForPreset} onApply={applyPreset} />
        </>
      )}

      <aside className="arb-risk">
        <ShieldAlert size={18} aria-hidden="true" />
        <div>
          <strong>{screenerText(locale, "riskTitle")}</strong>
          <p>{screenerText(locale, "risk")}</p>
        </div>
      </aside>
    </section>
  );
}

function Summary({ label, value, tone }: { label: string; value: string; tone?: "positive" }) {
  return (
    <div className={tone ? `arb-summary-card ${tone}` : "arb-summary-card"}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function formatUnavailableReasons(result: ScreenerRunResultV1): { count: string; reasons: string } | undefined {
  const entries = Object.entries(result.unavailableReasons);
  if (result.universe.unavailable === 0 || entries.length === 0) return undefined;
  const reasons = entries
    .sort(([, left], [, right]) => right - left || 0)
    .slice(0, 6)
    .map(([reason, count]) => `${reason} × ${count}`)
    .join(", ");
  return { count: String(result.universe.unavailable), reasons };
}

function runErrorKey(error: unknown): ScreenerMessageKey {
  if (error instanceof ScreenerApiError) {
    if (error.code === "run_timeout") return "runTimeout";
    if (error.code === "run_cancelled") return "runCancelled";
    if (error.code === "network_error" || error.code === "request_timeout") return "runUnavailable";
    return "runFailed";
  }
  return "runFailed";
}

function clampUniverse(value: number): number {
  if (!Number.isFinite(value)) return SCREENER_UNIVERSE_LIMIT_MINIMUM_V1;
  return Math.max(SCREENER_UNIVERSE_LIMIT_MINIMUM_V1, Math.min(SCREENER_UNIVERSE_LIMIT_MAXIMUM_V1, Math.trunc(value)));
}

function createRunRequestId(): string {
  const time = Date.now().toString(36);
  const random = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID().slice(0, 12) : Math.random().toString(36).slice(2, 14);
  return `techrun-${time}-${random}`;
}
