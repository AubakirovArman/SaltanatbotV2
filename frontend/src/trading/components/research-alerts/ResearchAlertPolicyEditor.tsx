import { useEffect, useId, useState } from "react";
import type { Locale } from "../../../i18n";
import { parseResearchAlertPolicyInput } from "../../researchAlertParser";
import { researchAlertFamilyText, researchAlertText as text } from "../../researchAlertText";
import { DEFAULT_RESEARCH_ALERT_POLICY, RESEARCH_ALERT_FAMILIES, type ResearchAlertFamily, type ResearchAlertPolicy, type ResearchAlertPolicyInput } from "../../researchAlertTypes";

interface Props {
  locale: Locale;
  initial?: ResearchAlertPolicy;
  busy: boolean;
  onSave: (policy: ResearchAlertPolicyInput) => Promise<void>;
  onCancel: () => void;
}

export function ResearchAlertPolicyEditor({ locale, initial, busy, onSave, onCancel }: Props) {
  const baseId = useId();
  const [draft, setDraft] = useState<ResearchAlertPolicyInput>(() => copyPolicy(initial));
  const [economicAssets, setEconomicAssets] = useState(() => initial?.economicAssetIds.join("\n") ?? "");
  const [formError, setFormError] = useState<string>();

  useEffect(() => {
    setDraft(copyPolicy(initial));
    setEconomicAssets(initial?.economicAssetIds.join("\n") ?? "");
    setFormError(undefined);
  }, [initial?.id]);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError(undefined);
    try {
      const policy = parseResearchAlertPolicyInput({ ...draft, economicAssetIds: splitEconomicAssets(economicAssets) });
      await onSave(policy);
      if (!initial) {
        setDraft(copyPolicy());
        setEconomicAssets("");
      }
    } catch (cause) {
      setFormError(`${text(locale, "validationError")}: ${message(cause)}`);
    }
  };

  const toggleFamily = (family: ResearchAlertFamily, checked: boolean) => {
    setDraft((current) => ({
      ...current,
      families: checked ? [...current.families, family] : current.families.filter((value) => value !== family)
    }));
  };

  return (
    <form className="research-alert-form" action="/api/trade/arbitrage-alerts/research" method="post" onSubmit={(event) => void submit(event)}>
      <fieldset className="research-alert-form-shell">
        <legend>{text(locale, initial ? "editLegend" : "createLegend")}</legend>

        {formError && <p className="research-alert-form-error" role="alert">{formError}</p>}

        <fieldset className="research-alert-form-group">
          <legend>{text(locale, "filtersGroup")}</legend>
          <div className="research-alert-field">
            <label htmlFor={`${baseId}-name`}>{text(locale, "name")}</label>
            <input id={`${baseId}-name`} name="research-alert-name" value={draft.name} required minLength={1} maxLength={120} autoComplete="off" onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} />
          </div>
          <label className="research-alert-check" htmlFor={`${baseId}-enabled`}>
            <input id={`${baseId}-enabled`} name="research-alert-enabled" type="checkbox" checked={draft.enabled} onChange={(event) => setDraft((current) => ({ ...current, enabled: event.target.checked }))} />
            <span>{text(locale, "enabled")}</span>
          </label>

          <fieldset className="research-alert-family-group" aria-describedby={`${baseId}-families-hint`}>
            <legend>{text(locale, "families")}</legend>
            <p id={`${baseId}-families-hint`}>{text(locale, "familiesHint")}</p>
            <div className="research-alert-family-grid">
              {RESEARCH_ALERT_FAMILIES.map((family) => (
                <label className="research-alert-check" key={family}>
                  <input name="research-alert-family" type="checkbox" value={family} checked={draft.families.includes(family)} onChange={(event) => toggleFamily(family, event.target.checked)} />
                  <span>{researchAlertFamilyText(locale, family)}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="research-alert-field">
            <label htmlFor={`${baseId}-assets`}>{text(locale, "economicAssets")}</label>
            <p id={`${baseId}-assets-hint`}>{text(locale, "economicAssetsHint")}</p>
            <textarea id={`${baseId}-assets`} name="research-alert-economic-assets" value={economicAssets} maxLength={4_096} rows={3} autoCapitalize="none" autoComplete="off" spellCheck={false} aria-describedby={`${baseId}-assets-hint`} onChange={(event) => setEconomicAssets(event.target.value)} />
          </div>
        </fieldset>

        <fieldset className="research-alert-form-group">
          <legend>{text(locale, "economicsGroup")}</legend>
          <div className="research-alert-number-grid">
            <NumberField id={`${baseId}-profit`} name="research-alert-minimum-profit" label={text(locale, "minimumProfit")} value={draft.minimumConservativeNetProfit} min={-1e15} max={1e15} onChange={(value) => setDraft((current) => ({ ...current, minimumConservativeNetProfit: value }))} />
            <NumberField id={`${baseId}-edge`} name="research-alert-minimum-edge" label={text(locale, "minimumEdge")} value={draft.minimumNetEdgeBps} min={-10_000} max={1_000_000} onChange={(value) => setDraft((current) => ({ ...current, minimumNetEdgeBps: value }))} />
            <NumberField id={`${baseId}-capacity`} name="research-alert-minimum-capacity" label={text(locale, "minimumCapacity")} value={draft.minimumCapacityValuation} min={0} max={1e15} onChange={(value) => setDraft((current) => ({ ...current, minimumCapacityValuation: value }))} />
            <div className="research-alert-field">
              <label htmlFor={`${baseId}-capital`}>{text(locale, "maximumCapital")}</label>
              <p id={`${baseId}-capital-hint`}>{text(locale, "maximumCapitalHint")}</p>
              <input
                id={`${baseId}-capital`}
                name="research-alert-maximum-capital"
                type="number"
                inputMode="decimal"
                min={Number.MIN_VALUE}
                max={1e15}
                step="any"
                value={draft.maximumRiskCapitalValuation ?? ""}
                aria-describedby={`${baseId}-capital-hint`}
                onChange={(event) => setDraft((current) => ({ ...current, maximumRiskCapitalValuation: event.target.value === "" ? undefined : event.target.valueAsNumber }))}
              />
            </div>
          </div>
        </fieldset>

        <fieldset className="research-alert-form-group">
          <legend>{text(locale, "evidenceGroup")}</legend>
          <fieldset className="research-alert-quality-group">
            <legend>{text(locale, "minimumQuality")}</legend>
            {(["fresh", "verified"] as const).map((quality) => (
              <label className="research-alert-check" key={quality}>
                <input name="research-alert-evidence-quality" type="radio" value={quality} checked={draft.minimumEvidenceQuality === quality} onChange={() => setDraft((current) => ({ ...current, minimumEvidenceQuality: quality }))} />
                <span>{text(locale, quality)}</span>
              </label>
            ))}
          </fieldset>
          <div className="research-alert-number-grid">
            <NumberField id={`${baseId}-observation-age`} name="research-alert-observation-age" label={text(locale, "observationAge")} value={draft.maximumObservationAgeMs} min={100} max={86_400_000} integer onChange={(value) => setDraft((current) => ({ ...current, maximumObservationAgeMs: value }))} />
            <NumberField id={`${baseId}-economics-age`} name="research-alert-economics-age" label={text(locale, "economicsAge")} value={draft.maximumEconomicsAgeMs} min={100} max={86_400_000} integer onChange={(value) => setDraft((current) => ({ ...current, maximumEconomicsAgeMs: value }))} />
            <NumberField id={`${baseId}-identity-age`} name="research-alert-identity-age" label={text(locale, "identityAge")} value={draft.maximumIdentityAgeMs} min={100} max={90 * 86_400_000} integer onChange={(value) => setDraft((current) => ({ ...current, maximumIdentityAgeMs: value }))} />
          </div>
        </fieldset>

        <fieldset className="research-alert-form-group">
          <legend>{text(locale, "deliveryGroup")}</legend>
          <NumberField id={`${baseId}-cooldown`} name="research-alert-cooldown" label={text(locale, "cooldown")} value={draft.cooldownSeconds} min={60} max={86_400} integer onChange={(value) => setDraft((current) => ({ ...current, cooldownSeconds: value }))} />
        </fieldset>

        <div className="research-alert-form-actions">
          <button className="research-alert-primary" type="submit" disabled={busy}>{text(locale, busy ? "saving" : initial ? "save" : "create")}</button>
          {initial && <button type="button" onClick={onCancel} disabled={busy}>{text(locale, "cancelEdit")}</button>}
        </div>
      </fieldset>
    </form>
  );
}

function NumberField({ id, name, label, value, min, max, integer = false, onChange }: { id: string; name: string; label: string; value: number; min: number; max: number; integer?: boolean; onChange: (value: number) => void }) {
  return (
    <div className="research-alert-field">
      <label htmlFor={id}>{label}</label>
      <input id={id} name={name} type="number" inputMode="decimal" value={Number.isFinite(value) ? value : ""} required min={min} max={max} step={integer ? 1 : "any"} onChange={(event) => onChange(event.target.valueAsNumber)} />
    </div>
  );
}

function copyPolicy(initial?: ResearchAlertPolicy): ResearchAlertPolicyInput {
  const source = initial ?? DEFAULT_RESEARCH_ALERT_POLICY;
  return {
    ...(initial ? { id: initial.id } : {}),
    name: source.name,
    families: [...source.families],
    economicAssetIds: [...source.economicAssetIds],
    minimumConservativeNetProfit: source.minimumConservativeNetProfit,
    minimumNetEdgeBps: source.minimumNetEdgeBps,
    minimumCapacityValuation: source.minimumCapacityValuation,
    ...(source.maximumRiskCapitalValuation !== undefined ? { maximumRiskCapitalValuation: source.maximumRiskCapitalValuation } : {}),
    minimumEvidenceQuality: source.minimumEvidenceQuality,
    maximumObservationAgeMs: source.maximumObservationAgeMs,
    maximumEconomicsAgeMs: source.maximumEconomicsAgeMs,
    maximumIdentityAgeMs: source.maximumIdentityAgeMs,
    cooldownSeconds: source.cooldownSeconds,
    enabled: source.enabled
  };
}

function splitEconomicAssets(value: string): string[] {
  return [...new Set(value.split(/[\s,]+/u).map((item) => item.trim().toLowerCase()).filter(Boolean))];
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
