import { RefreshCw, ShieldAlert, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { localeTag, type Locale } from "../i18n";
import { fetchContinuousRoutes, type ContinuousRouteLiveResponse } from "./continuousRoutes";
import { fetchContinuousFeedHealth, type ContinuousFeedHealthResponse } from "./continuousFeedHealth";
import { ContinuousFeedDiagnostics } from "./ContinuousFeedDiagnostics";
import { continuousFeedHealthText } from "./continuousFeedHealthText";
import { ContinuousMarketEconomicsTable } from "./ContinuousMarketEconomicsTable";
import { continuousCoverageReasonText, continuousRoutesText } from "./continuousRoutesText";
import { ContinuousRouteLifecycle } from "./ContinuousRouteLifecycle";

interface Props {
  locale: Locale;
}

export function ContinuousRoutesPanel({ locale }: Props) {
  const [snapshot, setSnapshot] = useState<ContinuousRouteLiveResponse>();
  const [feedHealth, setFeedHealth] = useState<ContinuousFeedHealthResponse>();
  const [error, setError] = useState<string>();
  const [feedHealthError, setFeedHealthError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [feedHealthLoading, setFeedHealthLoading] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  const inFlight = useRef(false);
  const feedHealthInFlight = useRef(false);

  const refresh = useCallback(
    async (signal?: AbortSignal) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setLoading(true);
      try {
        setSnapshot(await fetchContinuousRoutes(signal));
        setNow(Date.now());
        setError(undefined);
      } catch (reason) {
        if (signal?.aborted) return;
        setError(reason instanceof Error ? reason.message : continuousRoutesText(locale, "loadError"));
      } finally {
        inFlight.current = false;
        if (!signal?.aborted) setLoading(false);
      }
    },
    [locale]
  );

  const refreshFeedHealth = useCallback(
    async (signal?: AbortSignal) => {
      if (feedHealthInFlight.current) return;
      feedHealthInFlight.current = true;
      setFeedHealthLoading(true);
      try {
        setFeedHealth(await fetchContinuousFeedHealth(signal));
        setFeedHealthError(undefined);
      } catch (reason) {
        if (signal?.aborted) return;
        setFeedHealthError(reason instanceof Error ? reason.message : continuousFeedHealthText(locale, "error"));
      } finally {
        feedHealthInFlight.current = false;
        if (!signal?.aborted) setFeedHealthLoading(false);
      }
    },
    [locale]
  );

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    void refreshFeedHealth(controller.signal);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void refresh(controller.signal);
        void refreshFeedHealth(controller.signal);
      }
    }, 5_000);
    const freshnessTimer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      window.clearInterval(freshnessTimer);
    };
  }, [refresh, refreshFeedHealth]);

  if (!snapshot && loading)
    return (
      <p className="arb-live-loading" role="status">
        {continuousRoutesText(locale, "loading")}
      </p>
    );
  if (!snapshot) {
    return (
      <section className="arb-live-routes" aria-labelledby="arb-live-title">
        <h2 id="arb-live-title">{continuousRoutesText(locale, "title")}</h2>
        <p className="arb-error" role="alert">
          {continuousRoutesText(locale, "loadError")}: {error}
        </p>
        <ContinuousFeedDiagnostics locale={locale} snapshot={feedHealth} loading={feedHealthLoading} error={feedHealthError} />
        <button
          type="button"
          onClick={() => {
            void refresh();
            void refreshFeedHealth();
          }}
        >
          <RefreshCw size={15} aria-hidden="true" /> {continuousRoutesText(locale, "refresh")}
        </button>
      </section>
    );
  }
  return (
    <ContinuousRoutesView
      locale={locale}
      snapshot={snapshot}
      feedHealth={feedHealth}
      loading={loading}
      feedHealthLoading={feedHealthLoading}
      error={error}
      feedHealthError={feedHealthError}
      onRefresh={() => {
        void refresh();
        void refreshFeedHealth();
      }}
      now={now}
    />
  );
}

export function ContinuousRoutesView({
  locale,
  snapshot,
  feedHealth,
  loading = false,
  feedHealthLoading = false,
  error,
  feedHealthError,
  onRefresh = () => undefined,
  now = snapshot.evaluatedAt
}: { locale: Locale; snapshot: ContinuousRouteLiveResponse; feedHealth?: ContinuousFeedHealthResponse; loading?: boolean; feedHealthLoading?: boolean; error?: string; feedHealthError?: string; onRefresh?: () => void; now?: number }) {
  const [venue, setVenue] = useState("all");
  const [family, setFamily] = useState("all");
  const venues = useMemo(() => [...new Set(snapshot.discovery.sources.map((source) => source.venue))].sort(), [snapshot.discovery.sources]);
  const families = useMemo(() => [...new Set(snapshot.discovery.candidates.map((candidate) => candidate.family))].sort(), [snapshot.discovery.candidates]);
  const byInstrument = useMemo(() => new Map(snapshot.discovery.sources.map((source) => [source.instrumentId, source])), [snapshot.discovery.sources]);
  const candidates = useMemo(
    () => snapshot.discovery.candidates.filter((candidate) => (family === "all" || candidate.family === family) && (venue === "all" || byInstrument.get(candidate.longInstrumentId)?.venue === venue || byInstrument.get(candidate.shortInstrumentId)?.venue === venue)),
    [byInstrument, family, snapshot.discovery.candidates, venue]
  );
  const marketEvaluations = useMemo(
    () => (snapshot.discovery.marketEvaluations ?? []).filter((evaluation) => (family === "all" || evaluation.family === family) && (venue === "all" || byInstrument.get(evaluation.longInstrumentId)?.venue === venue || byInstrument.get(evaluation.shortInstrumentId)?.venue === venue)),
    [byInstrument, family, snapshot.discovery.marketEvaluations, venue]
  );
  const formatTime = (value: number) => new Intl.DateTimeFormat(localeTag(locale), { dateStyle: "short", timeStyle: "medium" }).format(value);

  return (
    <section className="arb-live-routes" aria-labelledby="arb-live-title">
      <header className="arb-live-header">
        <div>
          <h2 id="arb-live-title">{continuousRoutesText(locale, "title")}</h2>
          <p>{continuousRoutesText(locale, "subtitle")}</p>
        </div>
        <button type="button" disabled={loading} onClick={onRefresh} aria-label={continuousRoutesText(locale, "refresh")}>
          <RefreshCw size={15} aria-hidden="true" className={loading ? "spin" : ""} /> {continuousRoutesText(locale, "refresh")}
        </button>
      </header>
      <div className={`arb-live-banner is-${snapshot.state}`} role="status" aria-live="polite">
        <ShieldCheck size={18} aria-hidden="true" />
        <span>
          <strong>{snapshot.state.toUpperCase()}</strong> · {continuousRoutesText(locale, snapshot.state)} <small>{continuousRoutesText(locale, "researchOnly")}</small>
        </span>
      </div>
      {snapshot.coverage ? (
        <div className={`arb-live-coverage ${snapshot.coverage.complete ? "is-complete" : "is-incomplete"}`}>
          {snapshot.coverage.complete ? <ShieldCheck size={18} aria-hidden="true" /> : <ShieldAlert size={18} aria-hidden="true" />}
          <span>
            <strong>{continuousRoutesText(locale, snapshot.coverage.complete ? "coverageComplete" : "coverageIncomplete")}</strong> · {continuousCoverageReasonText(locale, snapshot.coverage.reason)}
            {snapshot.coverage.retainedPriorDiscovery ? <small>{continuousRoutesText(locale, "retainedPriorDiscovery")}</small> : null}
          </span>
        </div>
      ) : null}
      {error ? (
        <p className="arb-error" role="alert">
          {continuousRoutesText(locale, "loadError")}: {error}
        </p>
      ) : null}
      <dl className="arb-live-metrics">
        <div>
          <dt>{continuousRoutesText(locale, "state")}</dt>
          <dd>{snapshot.state}</dd>
        </div>
        {snapshot.coverage ? (
          <div>
            <dt>{continuousRoutesText(locale, "coverageStatus")}</dt>
            <dd>{snapshot.coverage.complete ? continuousRoutesText(locale, "coverageComplete") : continuousRoutesText(locale, "coverageIncomplete")}</dd>
          </div>
        ) : null}
        <div>
          <dt>{continuousRoutesText(locale, "configured")}</dt>
          <dd>{snapshot.configuredInstrumentIds.length}</dd>
        </div>
        <div>
          <dt>{continuousRoutesText(locale, "active")}</dt>
          <dd>{snapshot.activeInstrumentIds.length}</dd>
        </div>
        <div>
          <dt>{continuousRoutesText(locale, "readyBooks")}</dt>
          <dd>{snapshot.discovery.routeReadyBookCount}</dd>
        </div>
        <div>
          <dt>{continuousRoutesText(locale, "candidates")}</dt>
          <dd>{snapshot.discovery.totalCompatibleCandidates}</dd>
        </div>
        {snapshot.discovery.marketEconomics ? (
          <div>
            <dt>{continuousRoutesText(locale, "screened")}</dt>
            <dd>
              {continuousRoutesText(locale, "routeCount", {
                shown: String(snapshot.discovery.marketEconomics.publishedEvaluations),
                total: String(snapshot.discovery.marketEconomics.evaluatedCandidates)
              })}
            </dd>
          </div>
        ) : null}
      </dl>
      <p className="arb-live-time">{snapshot.refreshedAt ? continuousRoutesText(locale, "lastRefresh", { time: formatTime(snapshot.refreshedAt) }) : continuousRoutesText(locale, "observed", { time: formatTime(snapshot.evaluatedAt) })}</p>

      <ContinuousFeedDiagnostics locale={locale} snapshot={feedHealth} loading={feedHealthLoading} error={feedHealthError} />

      {snapshot.unavailable.length > 0 ? (
        <section className="arb-live-unavailable" aria-labelledby="arb-live-unavailable-title">
          <h3 id="arb-live-unavailable-title">{continuousRoutesText(locale, "unavailable")}</h3>
          <ul>
            {snapshot.unavailable.map((item) => (
              <li key={`${item.instrumentId}:${item.reason}`}>
                <code>{item.instrumentId}</code> — {item.reason}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {!feedHealth ? (
        <section aria-labelledby="arb-live-source-title">
          <h3 id="arb-live-source-title">{continuousRoutesText(locale, "sourceHealth")}</h3>
          {/* biome-ignore lint/a11y/noNoninteractiveTabindex: The horizontally scrollable fallback table must be keyboard-scrollable. */}
          <div className="arb-table-scroll" role="region" aria-label={continuousRoutesText(locale, "sourceHealthTable")} tabIndex={0}>
            <table className="arb-live-table">
              <thead>
                <tr>
                  <th scope="col">{continuousRoutesText(locale, "source")}</th>
                  <th scope="col">{continuousRoutesText(locale, "market")}</th>
                  <th scope="col">{continuousRoutesText(locale, "feedState")}</th>
                  <th scope="col">{continuousRoutesText(locale, "evidence")}</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.discovery.sources.map((source) => (
                  <tr key={source.instrumentId}>
                    <td>
                      <strong>{source.venue}</strong>
                      <small>{source.instrumentId}</small>
                    </td>
                    <td>{source.marketType}</td>
                    <td>
                      <span className={`arb-source-state is-${source.state}`}>{source.state}</span>
                      <small>{source.message}</small>
                    </td>
                    <td>{sourceEvidence(locale, source)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <section aria-labelledby="arb-live-candidate-title">
        <div className="arb-live-section-heading">
          <div>
            <h3 id="arb-live-candidate-title">{continuousRoutesText(locale, "routeCandidates")}</h3>
            <p>{continuousRoutesText(locale, "routeCount", { shown: String(candidates.length), total: String(snapshot.discovery.totalCompatibleCandidates) })}</p>
          </div>
          <div className="arb-live-filters">
            <label>
              {continuousRoutesText(locale, "venueFilter")}
              <select value={venue} onChange={(event) => setVenue(event.target.value)}>
                <option value="all">{continuousRoutesText(locale, "allVenues")}</option>
                {venues.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {continuousRoutesText(locale, "familyFilter")}
              <select value={family} onChange={(event) => setFamily(event.target.value)}>
                <option value="all">{continuousRoutesText(locale, "allFamilies")}</option>
                {families.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
        {snapshot.discovery.marketEconomics && snapshot.discovery.marketEvaluations ? (
          <ContinuousMarketEconomicsTable
            locale={locale}
            evaluations={marketEvaluations}
            total={snapshot.discovery.marketEconomics.evaluatedCandidates}
            now={now}
            sourceCurrent={!error && (snapshot.coverage?.current ?? true)}
          />
        ) : null}
        {candidates.length === 0 ? (
          <p>{continuousRoutesText(locale, "noCandidates")}</p>
        ) : (
          <div className="arb-table-scroll" role="region" aria-label={continuousRoutesText(locale, "routeCandidatesTable")}>
            <table className="arb-live-table">
              <thead>
                <tr>
                  <th>{continuousRoutesText(locale, "family")}</th>
                  <th>{continuousRoutesText(locale, "longLeg")}</th>
                  <th>{continuousRoutesText(locale, "shortLeg")}</th>
                  <th>{continuousRoutesText(locale, "identity")}</th>
                </tr>
              </thead>
              <tbody>
                {candidates.map((candidate) => (
                  <tr key={candidate.routeKey}>
                    <td>{candidate.family}</td>
                    <td>
                      <code>{candidate.longInstrumentId}</code>
                      <small>{byInstrument.get(candidate.longInstrumentId)?.state ?? "—"}</small>
                    </td>
                    <td>
                      <code>{candidate.shortInstrumentId}</code>
                      <small>{byInstrument.get(candidate.shortInstrumentId)?.state ?? "—"}</small>
                    </td>
                    <td>
                      <code>{candidate.economicAssetId}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <ContinuousRouteLifecycle locale={locale} />
    </section>
  );
}

function sourceEvidence(locale: Locale, source: ContinuousRouteLiveResponse["discovery"]["sources"][number]) {
  const values = [source.hasBook ? continuousRoutesText(locale, "book") : "", source.hasTopBook ? continuousRoutesText(locale, "topBook") : "", source.hasFunding ? continuousRoutesText(locale, "funding") : ""].filter(Boolean);
  return values.join(" · ") || continuousRoutesText(locale, "noEvidence");
}
