import { useMemo, useRef, useState } from "react";
import type { MarketOpportunityEnvelope } from "@saltanatbotv2/arbitrage-sdk";
import { localeTag, type Locale } from "../../i18n";
import { multiLegText } from "../../i18n/multiLeg";
import { worstCaseMultiLegCapitalPreview } from "../multiLegPreview";
import {
  createPaperIdempotencyKey,
  PaperPortfolioApiError,
  submitPaperMultiLegIntent,
  type PaperMultiLegSubmitSource
} from "../paperPortfolioClient";
import type { PaperPortfolioMutationResult } from "../paperPortfolioTypes";
import { usePaperBotBinding } from "../usePaperBotBinding";
import { AccessibleDialog } from "./paper-portfolio/PaperPortfolioDialogs";

/**
 * Confirm dialog for the opportunity → durable multi-leg paper intent handoff:
 * portfolio selector (defaults to the default portfolio), a client mirror of
 * the server worst-case capital reservation, and exact rejection-code
 * surfacing. Research only; the submitted source never carries credentials.
 */
export function RunPaperMultiLegDialog({
  locale,
  ownerUserId,
  opportunity,
  source,
  returnFocus,
  onClose,
  onSubmitted,
  submitIntent = submitPaperMultiLegIntent
}: {
  locale: Locale;
  ownerUserId: string;
  opportunity: MarketOpportunityEnvelope;
  source: PaperMultiLegSubmitSource;
  returnFocus?: HTMLElement | null;
  onClose: () => void;
  onSubmitted: (result: PaperPortfolioMutationResult) => void;
  submitIntent?: typeof submitPaperMultiLegIntent;
}) {
  const binding = usePaperBotBinding({ ownerUserId, enabled: true });
  const preview = useMemo(() => worstCaseMultiLegCapitalPreview(opportunity), [opportunity]);
  /** One stable command key per dialog; retrying the same submission never mints a new one. */
  const idempotencyKey = useRef(createPaperIdempotencyKey());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async () => {
    const portfolioId = binding.selectedPortfolioId;
    if (!portfolioId) {
      setError(multiLegText(locale, "noPortfolios"));
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const result = await submitIntent(ownerUserId, portfolioId, { source }, { idempotencyKey: idempotencyKey.current });
      onSubmitted(result);
    } catch (cause) {
      setError(`${multiLegText(locale, "submitFailed")}: ${errorMessage(cause)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AccessibleDialog
      title={multiLegText(locale, "runAction")}
      locale={locale}
      busy={busy}
      returnFocus={returnFocus}
      onClose={onClose}
      onConfirm={submit}
      confirmLabel={multiLegText(locale, "runAction")}
    >
      <p>{multiLegText(locale, "dialogIntro")}</p>
      <dl className="paper-dialog-revisions">
        <div><dt>{multiLegText(locale, "sourceLabel")}</dt><dd>{opportunity.source.engine} · {opportunity.source.opportunityId}</dd></div>
        <div><dt>{multiLegText(locale, "legCount")}</dt><dd>{opportunity.legs.length}</dd></div>
      </dl>
      <label>
        <span>{multiLegText(locale, "portfolio")}</span>
        <select
          value={binding.selectedPortfolioId ?? ""}
          onChange={(event) => binding.selectPortfolio(event.target.value)}
          disabled={busy || binding.loading || binding.activePortfolios.length === 0}
        >
          {binding.activePortfolios.map((portfolio) => (
            <option key={portfolio.id} value={portfolio.id}>
              {portfolio.name}{portfolio.isDefault ? ` · ${multiLegText(locale, "defaultBadge")}` : ""}
            </option>
          ))}
        </select>
      </label>
      {binding.loading && <p className="paper-dialog-note" role="status">{multiLegText(locale, "loadingPortfolios")}</p>}
      {!binding.loading && binding.activePortfolios.length === 0 && <p className="paper-dialog-validation" role="alert">{multiLegText(locale, "noPortfolios")}</p>}
      {binding.error && <p className="paper-dialog-validation" role="alert">{binding.error.message}</p>}

      <section className="paper-multi-leg-worst-case" aria-label={multiLegText(locale, "worstCaseTitle")}>
        <strong>{multiLegText(locale, "worstCaseTitle")}</strong>
        {preview.status === "ready" ? (
          <>
            <dl className="paper-dialog-revisions">
              <div><dt>{multiLegText(locale, "notional")}</dt><dd>{money(preview.notionalQuote, locale)}</dd></div>
              <div><dt>{multiLegText(locale, "feeReserve")}</dt><dd>{money(preview.feeReserveQuote, locale)}</dd></div>
              <div><dt>{multiLegText(locale, "worstCase")}</dt><dd>{money(preview.worstCaseQuote, locale)}</dd></div>
            </dl>
            <p className="paper-dialog-note">{multiLegText(locale, preview.feeCoverage === "none" ? "feeReserveUnknown" : "worstCaseHelp")}</p>
          </>
        ) : (
          <p className="paper-dialog-note">{multiLegText(locale, "worstCaseUnavailable")}</p>
        )}
      </section>

      {error && <p className="paper-dialog-validation" role="alert">{error}</p>}
    </AccessibleDialog>
  );
}

function money(value: number, locale: Locale): string {
  return `${new Intl.NumberFormat(localeTag(locale), { maximumFractionDigits: 6 }).format(value)} USDT`;
}

function errorMessage(cause: unknown): string {
  if (cause instanceof PaperPortfolioApiError) return `${cause.code}: ${cause.message}`;
  return cause instanceof Error ? cause.message : String(cause);
}
