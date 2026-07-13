import { useEffect, useState } from "react";
import type { Locale } from "../i18n";
import { deleteArbitrageAlertRule, getToken, listArbitrageAlertRules, saveArbitrageAlertRule, type ArbitrageAlertRule } from "../trading/tradeClient";
import type { ArbitrageFeeProfile } from "./fees";
import { maximumRouteNonFundingCostBps } from "./fees";
import { arbitrageText } from "./text";

interface Props {
  locale: Locale;
  profile: ArbitrageFeeProfile;
  notionalUsd: number;
  thresholdBps: number;
  minimumCapacityUsd: number;
}

export function ArbitrageServerAlerts({ locale, profile, notionalUsd, thresholdBps, minimumCapacityUsd }: Props) {
  const authenticated = !!getToken();
  const [rules, setRules] = useState<ArbitrageAlertRule[]>([]);
  const [status, setStatus] = useState<string>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!authenticated) return;
    void listArbitrageAlertRules()
      .then(setRules)
      .catch(() => setRules([]));
  }, [authenticated]);

  if (!authenticated) return <p className="arb-server-hint">{arbitrageText(locale, "signInForPersistent")}</p>;

  const save = async () => {
    setSaving(true);
    setStatus(undefined);
    try {
      const rule = await saveArbitrageAlertRule({
        minimumNetEdgeBps: thresholdBps,
        minimumCapacityUsd,
        estimatedNonFundingCostBps: maximumRouteNonFundingCostBps(profile, notionalUsd),
        holdingHours: profile.expectedHoldingHours,
        cooldownSeconds: 300,
        enabled: true
      });
      setRules((current) => [rule, ...current.filter((value) => value.id !== rule.id)]);
      setStatus(arbitrageText(locale, "ruleSaved"));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Unable to save rule");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    try {
      setRules(await deleteArbitrageAlertRule(id));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Unable to delete rule");
    }
  };

  return (
    <div className="arb-server-alerts">
      <strong>{arbitrageText(locale, "persistentAlerts")}</strong>
      <p>{arbitrageText(locale, "persistentAlertHint")}</p>
      <button type="button" onClick={() => void save()} disabled={saving}>
        {arbitrageText(locale, "saveServerAlert")}
      </button>
      {status && <span role="status">{status}</span>}
      {rules.length > 0 && (
        <div className="arb-saved-rules">
          <small>
            {arbitrageText(locale, "savedRules")}: {rules.length}
          </small>
          {rules.slice(0, 5).map((rule) => (
            <div key={rule.id}>
              <span>
                ≥ {(rule.minimumNetEdgeBps / 100).toFixed(2)}% · ${rule.minimumCapacityUsd.toLocaleString()}
              </span>
              <button type="button" aria-label={arbitrageText(locale, "deleteRule")} onClick={() => void remove(rule.id)}>
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
