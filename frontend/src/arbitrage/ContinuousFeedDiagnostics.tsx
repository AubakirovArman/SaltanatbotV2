import type { Locale } from "../i18n";
import type { ContinuousFeedHealthResponse } from "./continuousFeedHealth";
import { continuousFeedHealthText } from "./continuousFeedHealthText";

interface Props {
  locale: Locale;
  snapshot?: ContinuousFeedHealthResponse;
  loading?: boolean;
  error?: string;
}

export function ContinuousFeedDiagnostics({ locale, snapshot, loading = false, error }: Props) {
  return (
    <section className="arb-feed-diagnostics" aria-labelledby="arb-feed-diagnostics-title" aria-busy={loading}>
      <header>
        <div>
          <h3 id="arb-feed-diagnostics-title">{continuousFeedHealthText(locale, "title")}</h3>
          <p>{continuousFeedHealthText(locale, "hint")}</p>
        </div>
        {snapshot ? <span className={`arb-feed-health is-${snapshot.state}`}>{continuousFeedHealthText(locale, snapshot.state)}</span> : null}
      </header>
      {error ? (
        <p className="arb-error" role="alert">
          {continuousFeedHealthText(locale, "error")}: {error}
        </p>
      ) : null}
      {!snapshot && loading ? <p>{continuousFeedHealthText(locale, "loading")}</p> : null}
      {snapshot ? (
        <>
          <dl className="arb-feed-diagnostics-summary">
            <div>
              <dt>{continuousFeedHealthText(locale, "streams")}</dt>
              <dd>{snapshot.counts.streams}</dd>
            </div>
            <div>
              <dt>{continuousFeedHealthText(locale, "healthyStreams")}</dt>
              <dd>{snapshot.counts.healthy}</dd>
            </div>
            <div>
              <dt>{continuousFeedHealthText(locale, "reconnecting")}</dt>
              <dd>{snapshot.counts.reconnecting}</dd>
            </div>
            <div>
              <dt>{continuousFeedHealthText(locale, "bookContinuityReady")}</dt>
              <dd>{snapshot.counts.bookContinuityReady}</dd>
            </div>
          </dl>
          {snapshot.sources.length === 0 ? (
            <p>{continuousFeedHealthText(locale, "empty")}</p>
          ) : (
            // biome-ignore lint/a11y/noNoninteractiveTabindex: The horizontally scrollable diagnostics table must be keyboard-scrollable.
            <div className="arb-table-scroll" role="region" aria-label={continuousFeedHealthText(locale, "table")} tabIndex={0}>
              <table className="arb-live-table arb-feed-diagnostics-table">
                <caption className="sr-only">{continuousFeedHealthText(locale, "table")}</caption>
                <thead>
                  <tr>
                    <th scope="col">{continuousFeedHealthText(locale, "source")}</th>
                    <th scope="col">{continuousFeedHealthText(locale, "market")}</th>
                    <th scope="col">{continuousFeedHealthText(locale, "transport")}</th>
                    <th scope="col">{continuousFeedHealthText(locale, "generation")}</th>
                    <th scope="col">{continuousFeedHealthText(locale, "continuity")}</th>
                    <th scope="col">{continuousFeedHealthText(locale, "lastReceive")}</th>
                    <th scope="col">{continuousFeedHealthText(locale, "readiness")}</th>
                  </tr>
                </thead>
                <tbody>
                  {snapshot.sources.map((source) => (
                    <tr key={source.instrumentId}>
                      <td>
                        <strong>{source.venue}</strong>
                        <small>{source.instrumentId}</small>
                      </td>
                      <td>{source.marketType}</td>
                      <td>
                        <span className={`arb-source-state is-${source.health}`}>{continuousFeedHealthText(locale, source.health)}</span>
                        <small>{source.state}</small>
                        {source.reconnect.scheduled ? <small>{continuousFeedHealthText(locale, "reconnectScheduled")}</small> : null}
                      </td>
                      <td>
                        <strong>{source.generation}</strong>
                        <small>{continuousFeedHealthText(locale, "reconnectsObserved", { value: String(source.reconnect.observedConnectionRestarts) })}</small>
                      </td>
                      <td>{continuity(locale, source)}</td>
                      <td>{lastReceive(locale, source)}</td>
                      <td>
                        <span className={`arb-source-state ${source.bookContinuityReady ? "is-healthy" : "is-unhealthy"}`}>{continuousFeedHealthText(locale, source.bookContinuityReady ? "ready" : "notReady")}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : null}
    </section>
  );
}

function continuity(locale: Locale, source: ContinuousFeedHealthResponse["sources"][number]) {
  const proof = source.continuity;
  if (!proof) return continuousFeedHealthText(locale, "noContinuity");
  return (
    <>
      <strong>{proof.protocol}</strong>
      {"sequence" in proof ? <small>{continuousFeedHealthText(locale, "sequence", { value: String(proof.sequence) })}</small> : null}
      {"checksum" in proof ? <small>{continuousFeedHealthText(locale, "checksum", { value: String(proof.checksum) })}</small> : null}
      <small>{continuousFeedHealthText(locale, proof.generationMatches ? "currentGeneration" : "staleGeneration")}</small>
      <small>{continuousFeedHealthText(locale, proof.fresh ? "fresh" : "stale")}</small>
    </>
  );
}

function lastReceive(locale: Locale, source: ContinuousFeedHealthResponse["sources"][number]) {
  const value = source.lastReceive;
  if (!value) return continuousFeedHealthText(locale, "noReceive");
  return (
    <>
      <time dateTime={new Date(value.at).toISOString()}>{continuousFeedHealthText(locale, "receivedAgo", { value: String(value.ageMs) })}</time>
      <small>{continuousFeedHealthText(locale, value.fresh ? "fresh" : "stale")}</small>
    </>
  );
}
