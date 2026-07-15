import type { Locale } from "../../../i18n";
import { localeTag } from "../../../i18n";
import { researchAlertDeliveryStatusText, researchAlertFamilyText, researchAlertText as text } from "../../researchAlertText";
import type { ResearchAlertDelivery, ResearchAlertDeliverySummary, ResearchAlertPolicy } from "../../researchAlertTypes";

export function ResearchAlertPolicyTable({ locale, policies, editingId, pendingDeleteId, busy, onEdit, onRequestDelete, onConfirmDelete, onCancelDelete }: { locale: Locale; policies: ResearchAlertPolicy[]; editingId?: string; pendingDeleteId?: string; busy: boolean; onEdit: (policy: ResearchAlertPolicy) => void; onRequestDelete: (id: string) => void; onConfirmDelete: (id: string) => void; onCancelDelete: () => void }) {
  return (
    <section className="research-alert-section" aria-labelledby="research-alert-policy-heading">
      <h3 id="research-alert-policy-heading">{text(locale, "policies")}</h3>
      {policies.length === 0 ? <p>{text(locale, "noPolicies")}</p> : (
        // biome-ignore lint/a11y/noNoninteractiveTabindex: The bounded data table must remain keyboard-scrollable on narrow screens.
        <div className="research-alert-table-wrap" role="region" aria-label={text(locale, "policiesCaption")} tabIndex={0}>
          <table>
            <caption>{text(locale, "policiesCaption")}</caption>
            <thead><tr><th scope="col">{text(locale, "name")}</th><th scope="col">{text(locale, "state")}</th><th scope="col">{text(locale, "filters")}</th><th scope="col">{text(locale, "economics")}</th><th scope="col">{text(locale, "freshness")}</th><th scope="col">{text(locale, "lastDelivery")}</th><th scope="col">{text(locale, "updated")}</th><th scope="col">{text(locale, "actions")}</th></tr></thead>
            <tbody>{policies.map((policy) => (
              <tr key={policy.id} className={editingId === policy.id ? "is-editing" : undefined}>
                <th scope="row"><strong>{policy.name}</strong><code>{policy.id}</code></th>
                <td><span className={`research-alert-state ${policy.enabled ? "enabled" : "disabled"}`}>{text(locale, policy.enabled ? "active" : "inactive")}</span></td>
                <td><strong>{policy.families.length} · {policy.families.map((family) => researchAlertFamilyText(locale, family)).join(", ") || text(locale, "notAvailable")}</strong><small>{policy.economicAssetIds.join(", ") || text(locale, "everyAsset")}</small></td>
                <td><dl className="research-alert-metrics"><Metric label={text(locale, "profit")} value={number(policy.minimumConservativeNetProfit, locale)} /><Metric label={text(locale, "edge")} value={`${number(policy.minimumNetEdgeBps, locale)} bps`} /><Metric label={text(locale, "capacity")} value={number(policy.minimumCapacityValuation, locale)} /><Metric label={text(locale, "riskCapital")} value={policy.maximumRiskCapitalValuation === undefined ? text(locale, "notAvailable") : number(policy.maximumRiskCapitalValuation, locale)} /></dl></td>
                <td><strong>{text(locale, policy.minimumEvidenceQuality)}</strong><dl className="research-alert-metrics"><Metric label={text(locale, "maxObservation")} value={duration(policy.maximumObservationAgeMs, locale)} /><Metric label={text(locale, "maxEconomics")} value={duration(policy.maximumEconomicsAgeMs, locale)} /><Metric label={text(locale, "maxIdentity")} value={duration(policy.maximumIdentityAgeMs, locale)} /><Metric label={text(locale, "cooldownShort")} value={`${number(policy.cooldownSeconds, locale)} s`} /></dl></td>
                <td>{policy.lastDelivery ? <DeliverySummary locale={locale} delivery={policy.lastDelivery} /> : text(locale, "notAvailable")}</td>
                <td><time dateTime={new Date(policy.updatedAt).toISOString()}>{date(policy.updatedAt, locale)}</time></td>
                <td><div className="research-alert-row-actions"><button type="button" onClick={() => onEdit(policy)} disabled={busy}>{text(locale, "edit")}</button>{pendingDeleteId === policy.id ? <><button className="danger" type="button" onClick={() => onConfirmDelete(policy.id)} disabled={busy}>{text(locale, "confirmDelete")}</button><button type="button" onClick={onCancelDelete} disabled={busy}>{text(locale, "cancelDelete")}</button></> : <button type="button" onClick={() => onRequestDelete(policy.id)} disabled={busy}>{text(locale, "delete")}</button>}</div></td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function ResearchAlertDeliveryTable({ locale, deliveries }: { locale: Locale; deliveries: ResearchAlertDelivery[] }) {
  return (
    <section className="research-alert-section" aria-labelledby="research-alert-outbox-heading">
      <h3 id="research-alert-outbox-heading">{text(locale, "outbox")}</h3>
      {deliveries.length === 0 ? <p>{text(locale, "noDeliveries")}</p> : (
        // biome-ignore lint/a11y/noNoninteractiveTabindex: The bounded data table must remain keyboard-scrollable on narrow screens.
        <div className="research-alert-table-wrap" role="region" aria-label={text(locale, "outboxCaption")} tabIndex={0}>
          <table>
            <caption>{text(locale, "outboxCaption")}</caption>
            <thead><tr><th scope="col">{text(locale, "route")}</th><th scope="col">{text(locale, "family")}</th><th scope="col">{text(locale, "asset")}</th><th scope="col">{text(locale, "result")}</th><th scope="col">{text(locale, "delivery")}</th><th scope="col">{text(locale, "error")}</th></tr></thead>
            <tbody>{deliveries.map((delivery) => (
              <tr key={delivery.id}>
                <th scope="row"><code>{delivery.routeId}</code><small>{delivery.observationId}</small></th>
                <td>{researchAlertFamilyText(locale, delivery.family)}</td>
                <td><code>{delivery.economicAssetId}</code></td>
                <td><dl className="research-alert-metrics"><Metric label={text(locale, "profit")} value={number(delivery.conservativeNetProfit, locale)} /><Metric label={text(locale, "edge")} value={`${number(delivery.netEdgeBps, locale)} bps`} /><Metric label={text(locale, "capacity")} value={number(delivery.capacityValuation, locale)} /><Metric label={text(locale, "riskCapital")} value={number(delivery.riskCapitalValuation, locale)} /></dl></td>
                <td><DeliverySummary locale={locale} delivery={delivery} /><small className="research-alert-safety-inline">{text(locale, "researchOnly")} · {text(locale, "executionDenied")}</small></td>
                <td className={delivery.lastError ? "research-alert-delivery-error" : undefined}>{delivery.lastError || text(locale, "noError")}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function DeliverySummary({ locale, delivery }: { locale: Locale; delivery: ResearchAlertDeliverySummary }) {
  return <div className="research-alert-delivery-summary"><span className={`research-alert-delivery-status ${delivery.status}`}>{researchAlertDeliveryStatusText(locale, delivery.status)}</span><small>{text(locale, "attempts")}: {delivery.attempts}</small><small>{text(locale, "queued")}: <time dateTime={new Date(delivery.queuedAt).toISOString()}>{date(delivery.queuedAt, locale)}</time></small>{delivery.nextAttemptAt && <small>{text(locale, "nextAttempt")}: <time dateTime={new Date(delivery.nextAttemptAt).toISOString()}>{date(delivery.nextAttemptAt, locale)}</time></small>}{delivery.deliveredAt && <small>{text(locale, "delivered")}: <time dateTime={new Date(delivery.deliveredAt).toISOString()}>{date(delivery.deliveredAt, locale)}</time></small>}{delivery.lastError && <small className="research-alert-delivery-error">{delivery.lastError}</small>}</div>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <><dt>{label}</dt><dd>{value}</dd></>;
}

function number(value: number, locale: Locale): string {
  return new Intl.NumberFormat(localeTag(locale), { maximumFractionDigits: 8 }).format(value);
}

function duration(milliseconds: number, locale: Locale): string {
  if (milliseconds >= 86_400_000 && milliseconds % 86_400_000 === 0) return `${number(milliseconds / 86_400_000, locale)} d`;
  if (milliseconds >= 1_000 && milliseconds % 1_000 === 0) return `${number(milliseconds / 1_000, locale)} s`;
  return `${number(milliseconds, locale)} ms`;
}

function date(value: number, locale: Locale): string {
  return new Intl.DateTimeFormat(localeTag(locale), { dateStyle: "short", timeStyle: "medium" }).format(value);
}
