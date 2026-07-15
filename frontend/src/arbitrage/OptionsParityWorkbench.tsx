import { Beaker, RefreshCw, ShieldAlert } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { localeTag, type Locale } from "../i18n";
import { buildOptionsParityScenario, DEFAULT_OPTIONS_PARITY_SCENARIO, evaluateOptionsParity, type OptionsParityEvaluationResponse, type OptionsParityScenarioInput } from "./optionsParityClient";
import { optionsParityText as text } from "./optionsParityText";

export function OptionsParityWorkbench({ locale }: { locale: Locale }) {
  const [scenario, setScenario] = useState(DEFAULT_OPTIONS_PARITY_SCENARIO);
  const [result, setResult] = useState<OptionsParityEvaluationResponse>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const request = useRef<AbortController>();
  useEffect(() => () => request.current?.abort(), []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setError(undefined);
    try {
      const next = await evaluateOptionsParity(buildOptionsParityScenario(scenario), controller.signal);
      if (!controller.signal.aborted) setResult(next);
    } catch (cause) {
      if (!controller.signal.aborted) {
        setResult(undefined);
        setError(cause instanceof Error ? cause.message : text(locale, "unavailable"));
      }
    } finally {
      if (request.current === controller) {
        request.current = undefined;
        setBusy(false);
      }
    }
  };

  const update = <Key extends keyof OptionsParityScenarioInput>(key: Key, value: OptionsParityScenarioInput[Key]) => setScenario((current) => ({ ...current, [key]: value }));
  return (
    <section className="options-parity-workbench" aria-labelledby="options-parity-title">
      <header className="options-parity-header">
        <div>
          <h2 id="options-parity-title">
            <Beaker size={18} aria-hidden="true" /> {text(locale, "title")}
          </h2>
          <p>{text(locale, "description")}</p>
        </div>
        <span>
          <ShieldAlert size={14} aria-hidden="true" /> {text(locale, "safety")}
        </span>
      </header>
      <form className="options-parity-form" onSubmit={(event) => void submit(event)}>
        <fieldset>
          <legend>{text(locale, "identity")}</legend>
          <label htmlFor="options-underlying-asset">
            {text(locale, "underlyingAsset")}
            <input id="options-underlying-asset" name="options-underlying-asset" value={scenario.underlyingAsset} required pattern="[A-Za-z0-9]{2,15}" autoCapitalize="characters" onChange={(event) => update("underlyingAsset", event.target.value)} />
          </label>
          <label htmlFor="options-valuation-asset">
            {text(locale, "valuationAsset")}
            <input id="options-valuation-asset" name="options-valuation-asset" value={scenario.valuationAsset} required pattern="[A-Za-z0-9]{2,15}" autoCapitalize="characters" onChange={(event) => update("valuationAsset", event.target.value)} />
          </label>
          <NumericField locale={locale} name="options-strike" label={text(locale, "strikePrice")} value={scenario.strikePrice} min={0.00000001} onChange={(value) => update("strikePrice", value)} />
          <NumericField locale={locale} name="options-expiry-hours" label={text(locale, "expiryHours")} value={scenario.expiryHours} min={0.01} onChange={(value) => update("expiryHours", value)} />
        </fieldset>
        <fieldset>
          <legend>{text(locale, "prices")}</legend>
          <NumericField locale={locale} name="options-call-bid" label={text(locale, "callBid")} value={scenario.callBid} min={0.00000001} onChange={(value) => update("callBid", value)} />
          <NumericField locale={locale} name="options-call-ask" label={text(locale, "callAsk")} value={scenario.callAsk} min={scenario.callBid} onChange={(value) => update("callAsk", value)} />
          <NumericField locale={locale} name="options-put-bid" label={text(locale, "putBid")} value={scenario.putBid} min={0.00000001} onChange={(value) => update("putBid", value)} />
          <NumericField locale={locale} name="options-put-ask" label={text(locale, "putAsk")} value={scenario.putAsk} min={scenario.putBid} onChange={(value) => update("putAsk", value)} />
          <NumericField locale={locale} name="options-underlying-bid" label={text(locale, "underlyingBid")} value={scenario.underlyingBid} min={0.00000001} onChange={(value) => update("underlyingBid", value)} />
          <NumericField locale={locale} name="options-underlying-ask" label={text(locale, "underlyingAsk")} value={scenario.underlyingAsk} min={scenario.underlyingBid} onChange={(value) => update("underlyingAsk", value)} />
        </fieldset>
        <fieldset>
          <legend>{text(locale, "economics")}</legend>
          <NumericField locale={locale} name="options-target-quantity" label={text(locale, "targetQuantity")} value={scenario.targetBaseQuantity} min={0.001} onChange={(value) => update("targetBaseQuantity", value)} />
          <NumericField locale={locale} name="options-short-capacity" label={text(locale, "shortCapacity")} value={scenario.availableShortQuantity} min={scenario.targetBaseQuantity} onChange={(value) => update("availableShortQuantity", value)} />
          <NumericField locale={locale} name="options-risk-free" label={text(locale, "riskFree")} value={scenario.riskFreeRatePct} step="0.01" onChange={(value) => update("riskFreeRatePct", value)} />
          <NumericField locale={locale} name="options-dividend" label={text(locale, "dividend")} value={scenario.dividendYieldPct} step="0.01" onChange={(value) => update("dividendYieldPct", value)} />
          <NumericField locale={locale} name="options-borrow" label={text(locale, "borrow")} value={scenario.borrowRatePct} min={0} step="0.01" onChange={(value) => update("borrowRatePct", value)} />
          <NumericField locale={locale} name="options-option-fee" label={text(locale, "optionFee")} value={scenario.optionFeeBps} min={0} step="0.01" onChange={(value) => update("optionFeeBps", value)} />
          <NumericField locale={locale} name="options-underlying-fee" label={text(locale, "underlyingFee")} value={scenario.underlyingFeeBps} min={0} step="0.01" onChange={(value) => update("underlyingFeeBps", value)} />
        </fieldset>
        <p className="options-parity-notice">{text(locale, "scenarioNotice")}</p>
        <button type="submit" disabled={busy}>
          <RefreshCw size={14} aria-hidden="true" className={busy ? "spin" : undefined} /> {text(locale, busy ? "evaluating" : "evaluate")}
        </button>
      </form>
      {error && (
        <p className="trade-warn" role="alert">
          {text(locale, "unavailable")}: {error}
        </p>
      )}
      <div className="options-parity-status" role="status" aria-live="polite">
        {busy ? text(locale, "evaluating") : ""}
      </div>
      {result && <OptionsParityResults locale={locale} value={result} />}
    </section>
  );
}

export function OptionsParityResults({ locale, value }: { locale: Locale; value: OptionsParityEvaluationResponse }) {
  return (
    <div className="options-parity-results">
      <h3>{text(locale, "results")}</h3>
      {value.candidates.length === 0 ? (
        <p className="settings-note">{text(locale, "noCandidates")}</p>
      ) : (
        // biome-ignore lint/a11y/noNoninteractiveTabindex: The bounded wide table must remain horizontally keyboard-scrollable.
        <div className="options-parity-table" role="region" aria-label={text(locale, "results")} tabIndex={0}>
          <table>
            <caption>{text(locale, "results")}</caption>
            <thead>
              <tr>
                <th scope="col">{text(locale, "strategy")}</th>
                <th scope="col">{text(locale, "direction")}</th>
                <th scope="col">{text(locale, "netEdge")}</th>
                <th scope="col">{text(locale, "grossEdge")}</th>
                <th scope="col">{text(locale, "fees")}</th>
                <th scope="col">{text(locale, "edgeBps")}</th>
                <th scope="col">{text(locale, "quantity")}</th>
                <th scope="col">{text(locale, "expiry")}</th>
              </tr>
            </thead>
            <tbody>
              {value.candidates.map((candidate) => (
                <tr key={candidate.id}>
                  <th scope="row">
                    <details>
                      <summary>{candidate.strategyKind}</summary>
                      <div className="options-parity-legs">
                        <strong>{text(locale, "legs")}</strong>
                        {candidate.legs.map((leg) => (
                          <span key={`${leg.instrumentId}:${leg.side}`}>
                            {leg.role} · {text(locale, "side")}: {leg.side} · {text(locale, "average")}: {number(leg.averagePrice, locale)}
                          </span>
                        ))}
                      </div>
                    </details>
                  </th>
                  <td>{candidate.direction}</td>
                  <td className={candidate.netEdgeValue > 0 ? "positive" : "negative"}>
                    {number(candidate.netEdgeValue, locale)} {candidate.valuationAsset}
                  </td>
                  <td>{number(candidate.grossEdgeValue, locale)}</td>
                  <td>{number(candidate.feesValue + candidate.borrowCostValue, locale)}</td>
                  <td>{candidate.edgeBpsOfReferenceNotional.toFixed(2)} bps</td>
                  <td>
                    {number(candidate.baseQuantity, locale)} {candidate.underlyingAsset}
                  </td>
                  <td>{date(candidate.expiryTime, locale)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {value.rejections.length > 0 && (
        <details className="options-parity-rejections">
          <summary>
            {text(locale, "rejections")} · {value.rejections.length}
          </summary>
          <ul>
            {value.rejections.map((item, index) => (
              <li key={`${item.code}:${item.strategyKind ?? "all"}:${index}`}>
                <code>{item.code}</code> · {item.strategyKind ?? "all"} · {item.message}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function NumericField({ locale, name, label, value, min, step = "any", onChange }: { locale: Locale; name: string; label: string; value: number; min?: number; step?: string; onChange(value: number): void }) {
  return (
    <label htmlFor={name}>
      {label}
      <input id={name} name={name} type="number" value={value} min={min} step={step} inputMode="decimal" lang={localeTag(locale)} required onChange={(event) => onChange(event.currentTarget.valueAsNumber)} />
    </label>
  );
}

function number(value: number, locale: Locale): string {
  return new Intl.NumberFormat(localeTag(locale), { maximumFractionDigits: 8 }).format(value);
}

function date(value: number, locale: Locale): string {
  return new Intl.DateTimeFormat(localeTag(locale), { dateStyle: "medium", timeStyle: "short" }).format(value);
}
