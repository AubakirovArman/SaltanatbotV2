import { localeTag, type Locale } from "../../i18n";
import { gridText, type GridMessageKey } from "../../i18n/grid";
import { paperPortfolioText } from "../../i18n/paperPortfolio";
import { tradingText } from "../../i18n/trading";
import { gridWorstCaseExceeds, type GridDraft, type GridDraftEvaluation, type GridDraftField } from "../gridDraft";
import type { PaperMoney } from "../paperPortfolioTypes";
import { formatQuoteAmount } from "./DcaParamsFieldset";

interface GridFieldSpec {
  field: Extract<GridDraftField, "lowerBound" | "upperBound" | "gridLevels" | "orderQuote" | "stopLossPrice" | "maxCycles" | "cooldownSeconds">;
  label: GridMessageKey;
  inputMode: "decimal" | "numeric";
}

const fieldSpecs: GridFieldSpec[] = [
  { field: "lowerBound", label: "lowerBound", inputMode: "decimal" },
  { field: "upperBound", label: "upperBound", inputMode: "decimal" },
  { field: "gridLevels", label: "gridLevels", inputMode: "numeric" },
  { field: "orderQuote", label: "orderQuote", inputMode: "decimal" },
  { field: "stopLossPrice", label: "stopLossPrice", inputMode: "decimal" },
  { field: "maxCycles", label: "maxCycles", inputMode: "numeric" },
  { field: "cooldownSeconds", label: "cooldownSeconds", inputMode: "numeric" }
];

export function GridParamsFieldset({
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
  draft: GridDraft;
  evaluation: GridDraftEvaluation;
  name: string;
  namePlaceholder: string;
  allocation?: PaperMoney;
  availableCapital?: PaperMoney;
  onNameChange: (name: string) => void;
  onChange: (patch: Partial<GridDraft>) => void;
}) {
  const worstCase = evaluation.worstCaseQuote;
  const allocationExceeded = worstCase !== undefined && !!allocation && gridWorstCaseExceeds(worstCase, allocation);
  return (
    <fieldset className="form-section grid-params">
      <legend>{gridText(locale, "paramsTitle")}</legend>
      <label>{tradingText(locale, "botName")}
        <input name="bot-name" value={name} placeholder={namePlaceholder} onChange={(event) => onNameChange(event.target.value)} />
      </label>
      <div className="form-grid grid-params-grid">
        <label>{gridText(locale, "mode")}
          <select name="grid-mode" value={draft.mode} onChange={(event) => onChange({ mode: event.target.value as GridDraft["mode"] })}>
            <option value="neutral">{gridText(locale, "modeNeutral")}</option>
            <option value="long">{gridText(locale, "modeLong")}</option>
            <option value="short">{gridText(locale, "modeShort")}</option>
          </select>
        </label>
        <label>{gridText(locale, "spacing")}
          <select name="grid-spacing" value={draft.spacing} onChange={(event) => onChange({ spacing: event.target.value as GridDraft["spacing"] })}>
            <option value="arithmetic">{gridText(locale, "spacingArithmetic")}</option>
            <option value="geometric">{gridText(locale, "spacingGeometric")}</option>
          </select>
        </label>
        <label>{gridText(locale, "outsideRangeAction")}
          <select name="grid-outsideRangeAction" value={draft.outsideRangeAction} onChange={(event) => onChange({ outsideRangeAction: event.target.value as GridDraft["outsideRangeAction"] })}>
            <option value="pause">{gridText(locale, "outsidePause")}</option>
            <option value="stop">{gridText(locale, "outsideStop")}</option>
          </select>
        </label>
        {fieldSpecs.map((spec) => {
          const issue = evaluation.errors[spec.field];
          const errorId = `grid-${spec.field}-error`;
          return (
            <label key={spec.field}>{gridText(locale, spec.label)}
              <input
                name={`grid-${spec.field}`}
                type="text"
                inputMode={spec.inputMode}
                value={draft[spec.field]}
                aria-invalid={!!issue}
                aria-describedby={issue ? errorId : undefined}
                onChange={(event) => onChange({ [spec.field]: event.target.value })}
              />
              {issue && <span id={errorId} className="grid-field-error" role="alert">{gridText(locale, issue.key, issue.values)}</span>}
            </label>
          );
        })}
      </div>
      {evaluation.levels && (
        <section className="grid-level-preview" aria-label={gridText(locale, "levelPreviewTitle")}>
          <p className="grid-level-preview-head">
            <span>{gridText(locale, "levelPreviewTitle")}</span>
            <strong>{gridText(locale, "levelPreviewCount", { count: String(evaluation.levels.length) })}</strong>
          </p>
          <ol className="grid-level-list">
            {evaluation.levels.map((level, index) => (
              <li key={`${index}-${level.price}`} className="grid-level-row">
                <span className={`grid-level-side ${level.side}`}>{gridText(locale, level.side === "buy" ? "sideBuy" : "sideSell")}</span>
                <span className="grid-level-price">{level.price.toLocaleString(localeTag(locale), { maximumFractionDigits: 6 })}</span>
              </li>
            )).reverse()}
          </ol>
          <p className="field-help">{gridText(locale, "levelPreviewNote")}</p>
        </section>
      )}
      <div className="grid-worst-case" role="status" aria-live="polite">
        <p className="grid-worst-case-row">
          <span>{gridText(locale, "worstCaseTitle")}</span>
          <strong>{worstCase === undefined ? paperPortfolioText(locale, "unavailable") : formatQuoteAmount(worstCase, locale)}</strong>
        </p>
        {availableCapital && (
          <p className="grid-worst-case-row">
            <span>{paperPortfolioText(locale, "availableCapital")}</span>
            <strong>{availableCapital} USDT</strong>
          </p>
        )}
        <p className="field-help">{gridText(locale, "worstCaseHelp")}</p>
      </div>
      {allocationExceeded && <p className="paper-binding-validation" role="alert">{gridText(locale, "worstCaseExceedsAllocation")}</p>}
      <p className="field-help" role="note">{gridText(locale, "researchNote")}</p>
    </fieldset>
  );
}
