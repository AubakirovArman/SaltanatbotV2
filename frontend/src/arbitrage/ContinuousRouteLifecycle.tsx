import { RefreshCw } from "lucide-react";
import { useMemo } from "react";
import { localeTag, type Locale } from "../i18n";
import { useOpportunityLifecycle } from "./lifecycle";
import { continuousRoutesText } from "./continuousRoutesText";

const UNIVERSE_ID = "continuous-route-families:v1";

export function ContinuousRouteLifecycle({ locale }: { locale: Locale }) {
  const query = useMemo(() => ({ universeId: UNIVERSE_ID, kind: "pairwise" as const, routeLimit: 50, eventLimit: 20 }), []);
  const { data, error, refresh } = useOpportunityLifecycle(true, query);
  const formatTime = (value: number) => new Intl.DateTimeFormat(localeTag(locale), { dateStyle: "short", timeStyle: "medium" }).format(value);

  return (
    <section className="arb-live-lifecycle" aria-labelledby="arb-live-lifecycle-title">
      <header>
        <div>
          <h3 id="arb-live-lifecycle-title">{continuousRoutesText(locale, "lifecycleTitle")}</h3>
          <p>{continuousRoutesText(locale, "lifecycleHint")}</p>
        </div>
        <button type="button" onClick={() => void refresh()} aria-label={continuousRoutesText(locale, "lifecycleRefresh")}>
          <RefreshCw size={14} aria-hidden="true" /> {continuousRoutesText(locale, "lifecycleRefresh")}
        </button>
      </header>
      {error ? (
        <p className="arb-error" role="alert">
          {continuousRoutesText(locale, "lifecycleError")}: {error}
        </p>
      ) : !data ? (
        <p role="status">{continuousRoutesText(locale, "lifecycleLoading")}</p>
      ) : (
        <>
          <p className="arb-live-safety">
            <strong>{continuousRoutesText(locale, "lifecycleReadOnly")}</strong> · {continuousRoutesText(locale, "lifecyclePermission")}: {String(data.executionPermission)}
          </p>
          {data.routes.length === 0 ? (
            <p>{continuousRoutesText(locale, "lifecycleNoRoutes")}</p>
          ) : (
            <div className="arb-table-scroll" role="region" aria-label={continuousRoutesText(locale, "lifecycleTitle")}>
              <table className="arb-live-table">
                <thead>
                  <tr>
                    <th>{continuousRoutesText(locale, "lifecycleRoute")}</th>
                    <th>{continuousRoutesText(locale, "lifecycleStatus")}</th>
                    <th>{continuousRoutesText(locale, "lifecycleEvidence")}</th>
                    <th>{continuousRoutesText(locale, "lifecycleLastSeen")}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.routes.map((route) => (
                    <tr key={route.key}>
                      <td>
                        <code>{route.routeId}</code>
                      </td>
                      <td>
                        <span className={`arb-source-state is-${route.status}`}>{continuousRoutesText(locale, statusKey(route.status))}</span>
                        <small>{route.actionable ? continuousRoutesText(locale, "lifecyclePolicyPassed") : continuousRoutesText(locale, "lifecyclePolicyBlocked")}</small>
                      </td>
                      <td>
                        {route.effectiveEvidenceQuality}
                        <small>
                          {route.evidenceSourceIds.length} · {route.lastReason}
                        </small>
                      </td>
                      <td>
                        <time dateTime={new Date(route.lastSeenAt).toISOString()}>{formatTime(route.lastSeenAt)}</time>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <h4>{continuousRoutesText(locale, "lifecycleEvents")}</h4>
          {data.events.length === 0 ? (
            <p>{continuousRoutesText(locale, "lifecycleNoEvents")}</p>
          ) : (
            <ol className="arb-live-events">
              {data.events.map((event) => (
                <li key={event.id}>
                  <time dateTime={new Date(event.effectiveAt).toISOString()}>{formatTime(event.effectiveAt)}</time>
                  <code>{event.routeId ?? event.universeId}</code>
                  <span>
                    {event.from ? `${continuousRoutesText(locale, statusKey(event.from))} → ` : ""}
                    {event.to ? continuousRoutesText(locale, statusKey(event.to)) : event.type} · {event.reason}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </section>
  );
}

function statusKey(status: "first-seen" | "confirmed" | "decaying" | "expired") {
  return status === "first-seen" ? "lifecycleFirstSeen" : status === "confirmed" ? "lifecycleConfirmed" : status === "decaying" ? "lifecycleDecaying" : "lifecycleExpired";
}
