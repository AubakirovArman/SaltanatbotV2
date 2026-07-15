import { RefreshCw } from "lucide-react";
import { useMemo } from "react";
import { localeTag, type Locale } from "../i18n";
import { useOpportunityLifecycle } from "./lifecycle";
import { scannerUxText } from "./scannerUxText";

export function LifecycleStatus({ locale, enabled = true }: { locale: Locale; enabled?: boolean }) {
  const query = useMemo(() => ({ kind: "basis" as const, routeLimit: 100, eventLimit: 10 }), []);
  const { data, error, refresh } = useOpportunityLifecycle(enabled, query);
  const counts = useMemo(() => {
    const result = { firstSeen: 0, confirmed: 0, decaying: 0, actionable: 0 };
    for (const route of data?.routes ?? []) {
      if (route.status === "first-seen") result.firstSeen += 1;
      else if (route.status === "confirmed") result.confirmed += 1;
      else if (route.status === "decaying") result.decaying += 1;
      if (route.actionable) result.actionable += 1;
    }
    return result;
  }, [data?.routes]);

  return (
    <aside className="arb-lifecycle-status" aria-label={scannerUxText(locale, "lifecycleTitle")} aria-busy={enabled && !data && !error}>
      <header>
        <span>
          <strong>{scannerUxText(locale, "lifecycleTitle")}</strong>
          <small>{scannerUxText(locale, "lifecycleReadOnly")}</small>
        </span>
        <button type="button" onClick={() => void refresh()} aria-label={scannerUxText(locale, "lifecycleRefresh")} title={scannerUxText(locale, "lifecycleRefresh")}>
          <RefreshCw size={13} aria-hidden="true" />
        </button>
      </header>
      {error ? (
        <p>{scannerUxText(locale, "lifecycleUnavailable")}</p>
      ) : (
        <dl>
          <div>
            <dt>{scannerUxText(locale, "lifecycleFirstSeen")}</dt>
            <dd>{data ? counts.firstSeen : "—"}</dd>
          </div>
          <div>
            <dt>{scannerUxText(locale, "lifecycleConfirmed")}</dt>
            <dd>{data ? counts.confirmed : "—"}</dd>
          </div>
          <div>
            <dt>{scannerUxText(locale, "lifecycleDecaying")}</dt>
            <dd>{data ? counts.decaying : "—"}</dd>
          </div>
          <div>
            <dt>{scannerUxText(locale, "lifecycleActionable")}</dt>
            <dd>{data ? counts.actionable : "—"}</dd>
          </div>
        </dl>
      )}
      {data ? <time dateTime={new Date(data.generatedAt).toISOString()}>{scannerUxText(locale, "lifecycleUpdated", { time: new Date(data.generatedAt).toLocaleTimeString(localeTag(locale)) })}</time> : null}
    </aside>
  );
}
