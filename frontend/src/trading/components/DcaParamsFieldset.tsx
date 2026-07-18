import { localeTag, type Locale } from "../../i18n";
import { dcaText, type DcaMessageKey } from "../../i18n/dca";
import { paperPortfolioText } from "../../i18n/paperPortfolio";
import { tradingText } from "../../i18n/trading";
import { dcaWorstCaseExceeds, type DcaDraft, type DcaDraftEvaluation, type DcaDraftField } from "../dcaDraft";
import type { PaperMoney } from "../paperPortfolioTypes";

interface DcaFieldSpec {
  field: DcaDraftField;
  label: DcaMessageKey;
  inputMode: "decimal" | "numeric";
}

const fieldSpecs: DcaFieldSpec[] = [
  { field: "baseOrderQuote", label: "baseOrderQuote", inputMode: "decimal" },
  { field: "safetyOrderQuote", label: "safetyOrderQuote", inputMode: "decimal" },
  { field: "maxSafetyOrders", label: "maxSafetyOrders", inputMode: "numeric" },
  { field: "priceDeviationPct", label: "priceDeviationPct", inputMode: "decimal" },
  { field: "stepScale", label: "stepScale", inputMode: "decimal" },
  { field: "volumeScale", label: "volumeScale", inputMode: "decimal" },
  { field: "takeProfitPct", label: "takeProfitPct", inputMode: "decimal" },
  { field: "stopLossPct", label: "stopLossPct", inputMode: "decimal" },
  { field: "trailingTakeProfitPct", label: "trailingTakeProfitPct", inputMode: "decimal" },
  { field: "cooldownSeconds", label: "cooldownSeconds", inputMode: "numeric" },
  { field: "maxCycleDurationHours", label: "maxCycleDurationHours", inputMode: "numeric" }
];

export function formatQuoteAmount(value: number, locale: Locale): string {
  return `${value.toLocaleString(localeTag(locale), { maximumFractionDigits: 6 })} USDT`;
}

export function DcaParamsFieldset({
  locale,
  draft,
  evaluation,
  name,
  namePlaceholder,
  allocation,
  availableCapital,
  onNameChange,
  onChange
}: {
  locale: Locale;
  draft: DcaDraft;
  evaluation: DcaDraftEvaluation;
  name: string;
  namePlaceholder: string;
  allocation?: PaperMoney;
  availableCapital?: PaperMoney;
  onNameChange: (name: string) => void;
  onChange: (patch: Partial<DcaDraft>) => void;
}) {
  const worstCase = evaluation.worstCaseQuote;
  const allocationExceeded = worstCase !== undefined && !!allocation && dcaWorstCaseExceeds(worstCase, allocation);
  return (
    <fieldset className="form-section dca-params">
      <legend>{dcaText(locale, "paramsTitle")}</legend>
      <label>{tradingText(locale, "botName")}
        <input name="bot-name" value={name} placeholder={namePlaceholder} onChange={(event) => onNameChange(event.target.value)} />
      </label>
      <div className="form-grid dca-params-grid">
        <label>{dcaText(locale, "direction")}
          <select name="dca-direction" value={draft.direction} onChange={(event) => onChange({ direction: event.target.value as DcaDraft["direction"] })}>
            <option value="long">{dcaText(locale, "directionLong")}</option>
            <option value="short">{dcaText(locale, "directionShort")}</option>
          </select>
        </label>
        {fieldSpecs.map((spec) => {
          const issue = evaluation.errors[spec.field];
          const errorId = `dca-${spec.field}-error`;
          return (
            <label key={spec.field}>{dcaText(locale, spec.label)}
              <input
                name={`dca-${spec.field}`}
                type="text"
                inputMode={spec.inputMode}
                value={draft[spec.field]}
                aria-invalid={!!issue}
                aria-describedby={issue ? errorId : undefined}
                onChange={(event) => onChange({ [spec.field]: event.target.value })}
              />
              {issue && <span id={errorId} className="dca-field-error" role="alert">{dcaText(locale, issue.key, issue.values)}</span>}
            </label>
          );
        })}
      </div>
      <div className="dca-worst-case" role="status" aria-live="polite">
        <p className="dca-worst-case-row">
          <span>{dcaText(locale, "worstCaseTitle")}</span>
          <strong>{worstCase === undefined ? paperPortfolioText(locale, "unavailable") : formatQuoteAmount(worstCase, locale)}</strong>
        </p>
        {availableCapital && (
          <p className="dca-worst-case-row">
            <span>{paperPortfolioText(locale, "availableCapital")}</span>
            <strong>{availableCapital} USDT</strong>
          </p>
        )}
        <p className="field-help">{dcaText(locale, "worstCaseHelp")}</p>
      </div>
      {allocationExceeded && <p className="paper-binding-validation" role="alert">{dcaText(locale, "worstCaseExceedsAllocation")}</p>}
      <p className="field-help" role="note">{dcaText(locale, "researchNote")}</p>
    </fieldset>
  );
}
