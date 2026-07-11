import { ChevronLeft, ChevronRight, WandSparkles, X } from "lucide-react";
import { useState } from "react";
import type { Locale } from "../../i18n";
import { strategyText } from "../../i18n/strategy";
import { ARTIFACT_SCHEMA_VERSION } from "../library";
import type { PortableStrategyArtifact } from "../strategyFile";
import { buildWizardXml, DEFAULT_WIZARD_SPEC, type StrategyWizardSpec } from "../wizard";

export function StrategyWizard({ locale, onClose, onCreate }: { locale: Locale; onClose: () => void; onCreate: (artifact: PortableStrategyArtifact) => void }) {
  const t = (key: Parameters<typeof strategyText>[1]) => strategyText(locale, key);
  const [step, setStep] = useState(0);
  const [spec, setSpec] = useState<StrategyWizardSpec>(DEFAULT_WIZARD_SPEC);
  const numberField = (key: keyof StrategyWizardSpec, label: string, min: number, stepValue = 1) => (
    <label>{label}<input type="number" min={min} step={stepValue} value={spec[key] as number} onChange={(event) => setSpec((current) => ({ ...current, [key]: Number(event.target.value) }))} /></label>
  );
  return (
    <div className="gallery-backdrop" role="dialog" aria-modal="true" aria-labelledby="wizard-title" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="strategy-wizard">
        <header><div><strong id="wizard-title"><WandSparkles size={15} aria-hidden="true" /> {t("strategyWizard")}</strong><span>{t("wizardStep")} {step + 1}/3</span></div><button type="button" onClick={onClose} aria-label={t("closeWizard")}><X size={15} aria-hidden="true" /></button></header>
        <div className="wizard-progress" aria-hidden="true"><i style={{ inlineSize: `${((step + 1) / 3) * 100}%` }} /></div>
        <div className="wizard-body">
          {step === 0 && <><label>{t("artifactName")}<input value={spec.name} onChange={(event) => setSpec((current) => ({ ...current, name: event.target.value }))} /></label><label>{t("direction")}<select value={spec.direction} onChange={(event) => setSpec((current) => ({ ...current, direction: event.target.value as StrategyWizardSpec["direction"] }))}><option value="long">{t("long")}</option><option value="short">{t("short")}</option></select></label></>}
          {step === 1 && <><label>{t("entrySignal")}<select value={spec.signal} onChange={(event) => setSpec((current) => ({ ...current, signal: event.target.value as StrategyWizardSpec["signal"] }))}><option value="ema-cross">EMA cross</option><option value="rsi-threshold">RSI threshold</option><option value="price-breakout">Price breakout</option></select></label>{spec.signal === "ema-cross" && <>{numberField("fastPeriod", t("fastPeriod"), 1)}{numberField("slowPeriod", t("slowPeriod"), 2)}</>}{spec.signal === "rsi-threshold" && <>{numberField("rsiPeriod", "RSI period", 2)}{numberField("rsiThreshold", "RSI threshold", 0, 0.1)}</>}{spec.signal === "price-breakout" && numberField("breakoutLookback", t("lookback"), 1)}</>}
          {step === 2 && <>{numberField("stopPct", t("stopPercent"), 0.01, 0.1)}{numberField("targetPct", t("targetPercent"), 0.01, 0.1)}<pre>{spec.name}\n{spec.direction} · {spec.signal}\nSL {spec.stopPct}% · TP {spec.targetPct}%</pre></>}
        </div>
        <footer><button type="button" disabled={step === 0} onClick={() => setStep((value) => Math.max(0, value - 1))}><ChevronLeft size={14} aria-hidden="true" /> {t("back")}</button>{step < 2 ? <button type="button" disabled={!spec.name.trim()} onClick={() => setStep((value) => Math.min(2, value + 1))}>{t("next")} <ChevronRight size={14} aria-hidden="true" /></button> : <button type="button" onClick={() => onCreate({ kind: "strategy", name: spec.name, description: t("wizardDescription"), xml: buildWizardXml(spec), schemaVersion: ARTIFACT_SCHEMA_VERSION, semanticVersion: "0.1.0", parameters: [], dependencies: [], provenance: { source: "wizard" } })}>{t("createEditableStrategy")}</button>}</footer>
      </section>
    </div>
  );
}
