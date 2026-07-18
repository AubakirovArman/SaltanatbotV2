import { ChevronDown, GitFork, ShieldAlert, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { localeTag, type Locale } from "../../../i18n";
import { multiLegOutcomeText, multiLegStatusText, multiLegText } from "../../../i18n/multiLeg";
import { PaperPortfolioApiError } from "../../paperPortfolioClient";
import type { PaperMultiLegIntentRow, PaperMultiLegSection } from "../../paperPortfolioTypes";
import { AccessibleDialog } from "./PaperPortfolioDialogs";

/**
 * Owner-scoped multi-leg paper intents inside the portfolio center: outcome
 * badges, per-leg fills/fees/compensation disclosure, explicit residual
 * exposure lines and the owner-level kill switch. Purely additive: the section
 * renders only when the server detail response carries the multiLeg section.
 */
export function PaperMultiLegIntentsSection({
  locale,
  multiLeg,
  canMutate,
  busy,
  onToggleKillSwitch
}: {
  locale: Locale;
  multiLeg: PaperMultiLegSection;
  canMutate: boolean;
  busy: boolean;
  onToggleKillSwitch: (enabled: boolean) => Promise<void>;
}) {
  const [confirm, setConfirm] = useState<{ enabled: boolean; trigger: HTMLElement }>();
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string>();
  const killSwitchKnown = multiLeg.killSwitchEnabled !== undefined;
  const killSwitchEnabled = multiLeg.killSwitchEnabled === true;

  const applyKillSwitch = async () => {
    if (!confirm) return;
    setApplying(true);
    setError(undefined);
    try {
      await onToggleKillSwitch(confirm.enabled);
      setConfirm(undefined);
    } catch (cause) {
      setError(`${multiLegText(locale, "killSwitchFailed")}: ${errorMessage(cause)}`);
    } finally {
      setApplying(false);
    }
  };

  return (
    <section className="paper-multi-leg-section" aria-labelledby="paper-multi-leg-intents-title">
      <header className="paper-multi-leg-head">
        <div>
          <h3 id="paper-multi-leg-intents-title"><GitFork size={17} aria-hidden="true" /> {multiLegText(locale, "intentsTitle")}</h3>
          <p>{multiLegText(locale, "pnlNote")}</p>
        </div>
        <div className="paper-multi-leg-kill-switch" role="group" aria-label={multiLegText(locale, "killSwitchTitle")}>
          <span className={`paper-multi-leg-kill-state ${killSwitchKnown ? (killSwitchEnabled ? "on" : "off") : "unknown"}`}>
            {killSwitchEnabled ? <ShieldAlert size={15} aria-hidden="true" /> : <ShieldCheck size={15} aria-hidden="true" />}
            {multiLegText(locale, killSwitchKnown ? (killSwitchEnabled ? "killSwitchOn" : "killSwitchOff") : "killSwitchUnknown")}
          </span>
          {canMutate && (
            <button
              type="button"
              className="secondary-button"
              disabled={busy || applying}
              onClick={(event) => setConfirm({ enabled: !killSwitchEnabled, trigger: event.currentTarget })}
            >
              {multiLegText(locale, killSwitchEnabled ? "killSwitchDisable" : "killSwitchEnable")}
            </button>
          )}
        </div>
      </header>

      {error && <p className="paper-last-error" role="alert">{error}</p>}

      {multiLeg.intents.length === 0 ? (
        <p className="empty-note">{multiLegText(locale, "noIntents")}</p>
      ) : (
        <ul className="paper-multi-leg-intent-list">
          {multiLeg.intents.map((intent) => (
            <li key={intent.intentId}>
              <IntentCard intent={intent} locale={locale} />
            </li>
          ))}
        </ul>
      )}

      {confirm && (
        <AccessibleDialog
          title={multiLegText(locale, "killSwitchConfirmTitle")}
          locale={locale}
          busy={applying}
          returnFocus={confirm.trigger}
          onClose={() => setConfirm(undefined)}
          onConfirm={applyKillSwitch}
          confirmLabel={multiLegText(locale, confirm.enabled ? "killSwitchEnable" : "killSwitchDisable")}
        >
          <p>{multiLegText(locale, confirm.enabled ? "killSwitchConfirmEnable" : "killSwitchConfirmDisable")}</p>
        </AccessibleDialog>
      )}
    </section>
  );
}

function IntentCard({ intent, locale }: { intent: PaperMultiLegIntentRow; locale: Locale }) {
  const terminalOutcome = intent.outcome;
  const badge = terminalOutcome
    ? multiLegOutcomeText(locale, terminalOutcome)
    : intent.status
      ? multiLegStatusText(locale, intent.status)
      : multiLegText(locale, "unavailable");
  const showResidual = !!intent.residualExposure?.length || terminalOutcome === "compensated" || terminalOutcome === "manual-review-required";
  return (
    <article className="paper-multi-leg-intent">
      <header>
        <span>
          <strong>{intent.sourceOpportunityId ?? intent.intentId}</strong>
          <small>{[intent.sourceEngine, intent.intentId].filter(Boolean).join(" · ")}</small>
        </span>
        <span className={`paper-multi-leg-badge ${badgeTone(intent)}`}>{badge}</span>
      </header>
      <dl className="paper-multi-leg-metrics">
        <Metric label={multiLegText(locale, "reserved")} value={amount(intent.reservedCapital, locale)} />
        <Metric label={multiLegText(locale, "netPnl")} value={amount(intent.netPnl, locale, true)} tone={tone(intent.netPnl)} title={multiLegText(locale, "pnlNote")} />
        <Metric label={multiLegText(locale, "fees")} value={amount(intent.fees, locale)} />
        <Metric label={multiLegText(locale, "legCount")} value={intent.legCount === undefined ? multiLegText(locale, "unavailable") : String(intent.legCount)} />
        <Metric label={multiLegText(locale, "created")} value={intent.createdAt === undefined ? multiLegText(locale, "unavailable") : new Intl.DateTimeFormat(localeTag(locale), { dateStyle: "short", timeStyle: "medium" }).format(intent.createdAt)} />
      </dl>
      {intent.legs.length > 0 && (
        <details className="paper-multi-leg-legs">
          <summary>{multiLegText(locale, "legsDisclosure")} <ChevronDown size={14} aria-hidden="true" /></summary>
          <div className="paper-robot-table-wrap">
            <table className="paper-multi-leg-table">
              <thead>
                <tr>
                  <th scope="col">{multiLegText(locale, "legVenue")}</th>
                  <th scope="col">{multiLegText(locale, "legInstrument")}</th>
                  <th scope="col">{multiLegText(locale, "legSide")}</th>
                  <th scope="col">{multiLegText(locale, "legPlanned")}</th>
                  <th scope="col">{multiLegText(locale, "legFilled")}</th>
                  <th scope="col">{multiLegText(locale, "legAveragePrice")}</th>
                  <th scope="col">{multiLegText(locale, "legFee")}</th>
                  <th scope="col">{multiLegText(locale, "legCompensated")}</th>
                </tr>
              </thead>
              <tbody>
                {intent.legs.map((leg, index) => (
                  <tr key={`${intent.intentId}:${leg.instrumentId ?? index}`}>
                    <td>{leg.venue ?? "—"}</td>
                    <td>{leg.instrumentId ? <code>{leg.instrumentId}</code> : "—"}</td>
                    <td>{leg.side ? multiLegText(locale, leg.side === "buy" ? "sideBuy" : "sideSell") : "—"}</td>
                    <td>{quantity(leg.plannedQuantity, locale)}</td>
                    <td>{quantity(leg.filledQuantity, locale)}</td>
                    <td>{quantity(leg.averagePrice, locale)}</td>
                    <td>{quantity(leg.fee, locale)}</td>
                    <td>{leg.compensated === undefined ? "—" : multiLegText(locale, leg.compensated ? "yes" : "no")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
      {showResidual && (
        <div className="paper-multi-leg-residual" role="note">
          <strong>{multiLegText(locale, "residualTitle")}</strong>
          {intent.residualExposure?.length ? (
            <ul>
              {intent.residualExposure.map((line, index) => (
                <li key={`${intent.intentId}:residual:${line.legId ?? index}`}>
                  <code>{line.instrumentId}</code> · {quantity(line.quantity, locale)}{line.quantityUnit ? ` ${line.quantityUnit}` : ""}
                </li>
              ))}
            </ul>
          ) : null}
          <span>{multiLegText(locale, "residualNote")}</span>
        </div>
      )}
    </article>
  );
}

function Metric({ label, value, tone: valueTone, title }: { label: string; value: string; tone?: "positive" | "negative"; title?: string }) {
  return (
    <div className={valueTone ? `paper-multi-leg-metric ${valueTone}` : "paper-multi-leg-metric"}>
      <dt>{label}</dt>
      <dd title={title}>{value}</dd>
    </div>
  );
}

function badgeTone(intent: PaperMultiLegIntentRow): string {
  if (intent.outcome === "completed") return "completed";
  if (intent.outcome === "compensated") return "compensated";
  if (intent.outcome === "manual-review-required") return "manual";
  if (intent.outcome === "aborted-no-exposure") return "aborted";
  return intent.status === "running" ? "running" : "neutral";
}

function tone(value: number | undefined): "positive" | "negative" | undefined {
  if (value === undefined || value === 0) return undefined;
  return value > 0 ? "positive" : "negative";
}

function amount(value: number | undefined, locale: Locale, signed = false): string {
  if (value === undefined) return "—";
  const formatted = new Intl.NumberFormat(localeTag(locale), {
    maximumFractionDigits: 6,
    ...(signed ? { signDisplay: "exceptZero" as const } : {})
  }).format(value);
  return `${formatted} USDT`;
}

function quantity(value: number | undefined, locale: Locale): string {
  return value === undefined ? "—" : new Intl.NumberFormat(localeTag(locale), { maximumFractionDigits: 8 }).format(value);
}

function errorMessage(cause: unknown): string {
  if (cause instanceof PaperPortfolioApiError) return `${cause.code}: ${cause.message}`;
  return cause instanceof Error ? cause.message : String(cause);
}
