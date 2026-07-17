import { Plus, X } from "lucide-react";
import { useState } from "react";
import { SCREENER_FILTER_KINDS_V1, SCREENER_FILTER_LIMIT_V1, type ScreenerFilterKindV1, type ScreenerMaCrossStateV1, type ScreenerMacdConditionV1, type ScreenerMaTypeV1, type ScreenerThresholdConditionV1 } from "@saltanatbotv2/contracts";
import type { Locale } from "../i18n";
import { screenerText, type ScreenerMessageKey } from "../i18n/screener";
import { createFilterDraft, type ScreenerFilterDraft } from "./definitionForm";

interface Props {
  locale: Locale;
  filters: ScreenerFilterDraft[];
  disabled: boolean;
  onChange(filters: ScreenerFilterDraft[]): void;
}

const KIND_TEXT: Record<ScreenerFilterKindV1, ScreenerMessageKey> = {
  price: "kindPrice",
  "quote-volume-24h": "kindQuoteVolume",
  "change-24h-percent": "kindChangePercent",
  rsi: "kindRsi",
  "ma-cross": "kindMaCross",
  macd: "kindMacd",
  "atr-percent": "kindAtrPercent"
};

const CROSS_STATES: readonly ScreenerMaCrossStateV1[] = ["fast-above", "fast-below", "crossed-up", "crossed-down"];
const CROSS_STATE_TEXT: Record<ScreenerMaCrossStateV1, ScreenerMessageKey> = {
  "fast-above": "stateFastAbove",
  "fast-below": "stateFastBelow",
  "crossed-up": "crossedUp",
  "crossed-down": "crossedDown"
};
const MACD_CONDITIONS: readonly ScreenerMacdConditionV1[] = ["histogram-above-zero", "histogram-below-zero", "crossed-up", "crossed-down"];
const MACD_CONDITION_TEXT: Record<ScreenerMacdConditionV1, ScreenerMessageKey> = {
  "histogram-above-zero": "histogramAboveZero",
  "histogram-below-zero": "histogramBelowZero",
  "crossed-up": "crossedUp",
  "crossed-down": "crossedDown"
};

export function TechnicalFilters({ locale, filters, disabled, onChange }: Props) {
  const [nextKind, setNextKind] = useState<ScreenerFilterKindV1>("rsi");
  const full = filters.length >= SCREENER_FILTER_LIMIT_V1;
  const patch = (id: string, changes: Partial<ScreenerFilterDraft>) => {
    onChange(filters.map((draft) => (draft.id === id ? { ...draft, ...changes } : draft)));
  };

  return (
    <fieldset className="arb-filters tech-screener-filters" disabled={disabled}>
      <legend>{screenerText(locale, "filters")}</legend>
      {filters.map((draft, index) => (
        <FilterRow key={draft.id} locale={locale} draft={draft} index={index + 1} onPatch={(changes) => patch(draft.id, changes)} onRemove={() => onChange(filters.filter((item) => item.id !== draft.id))} />
      ))}
      <div className="tech-screener-add-filter">
        <label htmlFor="tech-add-filter-kind">
          {screenerText(locale, "addFilterKind")}
          <select id="tech-add-filter-kind" value={nextKind} onChange={(event) => setNextKind(event.target.value as ScreenerFilterKindV1)}>
            {SCREENER_FILTER_KINDS_V1.map((kind) => (
              <option key={kind} value={kind}>
                {screenerText(locale, KIND_TEXT[kind])}
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="arb-refresh" disabled={full} title={full ? screenerText(locale, "filterLimit", { limit: String(SCREENER_FILTER_LIMIT_V1) }) : undefined} onClick={() => onChange([...filters, createFilterDraft(nextKind)])}>
          <Plus size={15} aria-hidden="true" />
          {screenerText(locale, "addFilter")}
        </button>
      </div>
      {full && <small className="tech-screener-filter-limit">{screenerText(locale, "filterLimit", { limit: String(SCREENER_FILTER_LIMIT_V1) })}</small>}
    </fieldset>
  );
}

function FilterRow({ locale, draft, index, onPatch, onRemove }: { locale: Locale; draft: ScreenerFilterDraft; index: number; onPatch(changes: Partial<ScreenerFilterDraft>): void; onRemove(): void }) {
  const field = (suffix: string) => `tech-filter-${draft.id}-${suffix}`;
  return (
    <div className="tech-screener-filter-row" role="group" aria-label={`${screenerText(locale, "filterRow", { index: String(index) })} · ${screenerText(locale, KIND_TEXT[draft.kind])}`}>
      <span className="tech-screener-filter-kind">{screenerText(locale, KIND_TEXT[draft.kind])}</span>
      {(draft.kind === "price" || draft.kind === "change-24h-percent") && (
        <>
          <DecimalField locale={locale} id={field("min")} textKey="minimum" value={draft.min} onValue={(min) => onPatch({ min })} />
          <DecimalField locale={locale} id={field("max")} textKey="maximum" value={draft.max} onValue={(max) => onPatch({ max })} />
        </>
      )}
      {draft.kind === "quote-volume-24h" && <DecimalField locale={locale} id={field("min")} textKey="minimum" value={draft.min} onValue={(min) => onPatch({ min })} />}
      {(draft.kind === "rsi" || draft.kind === "atr-percent") && (
        <>
          <PeriodField locale={locale} id={field("period")} textKey="period" value={draft.period} onValue={(period) => onPatch({ period })} />
          <label htmlFor={field("condition")}>
            {screenerText(locale, "condition")}
            <select id={field("condition")} value={draft.condition} onChange={(event) => onPatch({ condition: event.target.value as ScreenerThresholdConditionV1 })}>
              <option value="above">{screenerText(locale, "above")}</option>
              <option value="below">{screenerText(locale, "below")}</option>
            </select>
          </label>
          <DecimalField locale={locale} id={field("value")} textKey="value" value={draft.value} onValue={(value) => onPatch({ value })} />
        </>
      )}
      {draft.kind === "ma-cross" && (
        <>
          <MaTypeField locale={locale} id={field("fast-type")} textKey="fastType" value={draft.fastType} onValue={(fastType) => onPatch({ fastType })} />
          <PeriodField locale={locale} id={field("fast-period")} textKey="fastPeriod" value={draft.fastPeriod} onValue={(fastPeriod) => onPatch({ fastPeriod })} />
          <MaTypeField locale={locale} id={field("slow-type")} textKey="slowType" value={draft.slowType} onValue={(slowType) => onPatch({ slowType })} />
          <PeriodField locale={locale} id={field("slow-period")} textKey="slowPeriod" value={draft.slowPeriod} onValue={(slowPeriod) => onPatch({ slowPeriod })} />
          <label htmlFor={field("state")}>
            {screenerText(locale, "crossState")}
            <select id={field("state")} value={draft.state} onChange={(event) => onPatch({ state: event.target.value as ScreenerMaCrossStateV1 })}>
              {CROSS_STATES.map((state) => (
                <option key={state} value={state}>
                  {screenerText(locale, CROSS_STATE_TEXT[state])}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      {draft.kind === "macd" && (
        <>
          <PeriodField locale={locale} id={field("fast")} textKey="macdFast" value={draft.fast} onValue={(fast) => onPatch({ fast })} />
          <PeriodField locale={locale} id={field("slow")} textKey="macdSlow" value={draft.slow} onValue={(slow) => onPatch({ slow })} />
          <PeriodField locale={locale} id={field("signal")} textKey="macdSignal" value={draft.signal} onValue={(signal) => onPatch({ signal })} />
          <label htmlFor={field("macd-condition")}>
            {screenerText(locale, "condition")}
            <select id={field("macd-condition")} value={draft.macdCondition} onChange={(event) => onPatch({ macdCondition: event.target.value as ScreenerMacdConditionV1 })}>
              {MACD_CONDITIONS.map((condition) => (
                <option key={condition} value={condition}>
                  {screenerText(locale, MACD_CONDITION_TEXT[condition])}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      <button type="button" className="tech-screener-remove-filter" aria-label={screenerText(locale, "removeFilter", { index: String(index) })} title={screenerText(locale, "removeFilter", { index: String(index) })} onClick={onRemove}>
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  );
}

function DecimalField({ locale, id, textKey, value, onValue }: { locale: Locale; id: string; textKey: ScreenerMessageKey; value: string; onValue(value: string): void }) {
  return (
    <label htmlFor={id}>
      {screenerText(locale, textKey)}
      <input id={id} type="text" inputMode="decimal" maxLength={24} value={value} onChange={(event) => onValue(event.target.value)} />
    </label>
  );
}

function PeriodField({ locale, id, textKey, value, onValue }: { locale: Locale; id: string; textKey: ScreenerMessageKey; value: string; onValue(value: string): void }) {
  return (
    <label htmlFor={id}>
      {screenerText(locale, textKey)}
      <input id={id} type="number" min="1" max="500" step="1" value={value} onChange={(event) => onValue(event.target.value)} />
    </label>
  );
}

function MaTypeField({ locale, id, textKey, value, onValue }: { locale: Locale; id: string; textKey: ScreenerMessageKey; value: ScreenerMaTypeV1; onValue(value: ScreenerMaTypeV1): void }) {
  return (
    <label htmlFor={id}>
      {screenerText(locale, textKey)}
      <select id={id} value={value} onChange={(event) => onValue(event.target.value as ScreenerMaTypeV1)}>
        <option value="ema">EMA</option>
        <option value="sma">SMA</option>
      </select>
    </label>
  );
}
