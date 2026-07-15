import { useEffect, useState } from "react";
import { useAuth } from "../auth/AuthRoot";
import type { Locale } from "../i18n";
import { deleteArbitrageAlertRule, getArbitrageAlertState, getToken, saveArbitrageAlertRule, type ArbitrageAlertDelivery, type ArbitrageAlertRule } from "../trading/tradeClient";
import type { ArbitrageFeeProfile } from "./fees";
import { maximumRouteNonFundingCostBps } from "./fees";
import { arbitrageText } from "./text";
import { alertDeliveryText, deliveryStatusText } from "./alertDeliveryText";
import { localeTag } from "../i18n";

interface Props {
  locale: Locale;
  profile: ArbitrageFeeProfile;
  notionalUsd: number;
  thresholdBps: number;
  minimumCapacityUsd: number;
}

export function ArbitrageServerAlerts({ locale, profile, notionalUsd, thresholdBps, minimumCapacityUsd }: Props) {
  const accountAuth = useAuth();
  const authenticated = accountAuth.authRequired ? accountAuth.tradingAvailable : Boolean(getToken());
  const [rules, setRules] = useState<ArbitrageAlertRule[]>([]);
  const [deliveries, setDeliveries] = useState<ArbitrageAlertDelivery[]>([]);
  const [status, setStatus] = useState<string>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!authenticated) return;
    let active = true;
    const refresh = () =>
      void getArbitrageAlertState()
        .then((value) => {
          if (!active) return;
          setRules(value.rules);
          setDeliveries(value.deliveries);
        })
        .catch(() => {
          if (active) setStatus(alertDeliveryText(locale, "refreshFailed"));
        });
    refresh();
    const timer = window.setInterval(refresh, 10_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [authenticated, locale]);

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
    } catch {
      setStatus(alertDeliveryText(locale, "saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    try {
      setRules(await deleteArbitrageAlertRule(id));
      setDeliveries((current) => current.filter((delivery) => delivery.ruleId !== id));
    } catch {
      setStatus(alertDeliveryText(locale, "deleteFailed"));
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
                {rule.lastDelivery && (
                  <small className={`arb-delivery-status ${rule.lastDelivery.status}`}>
                    {deliveryStatusText(locale, rule.lastDelivery.status)} · {rule.lastDelivery.attempts} {alertDeliveryText(locale, "attempts")}
                  </small>
                )}
              </span>
              <button type="button" aria-label={arbitrageText(locale, "deleteRule")} onClick={() => void remove(rule.id)}>
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      {deliveries.length > 0 && (
        <div className="arb-deliveries" aria-live="polite">
          <small>{alertDeliveryText(locale, "recent")}</small>
          {deliveries.slice(0, 5).map((delivery) => (
            <div key={delivery.id}>
              <span>
                <strong>{delivery.symbol}</strong> · {deliveryStatusText(locale, delivery.status)} · {delivery.attempts}/{delivery.maxAttempts}
              </span>
              <time dateTime={new Date(delivery.deliveredAt ?? delivery.lastAttemptAt ?? delivery.queuedAt).toISOString()}>{new Date(delivery.deliveredAt ?? delivery.lastAttemptAt ?? delivery.queuedAt).toLocaleTimeString(localeTag(locale))}</time>
              {delivery.nextAttemptAt && (
                <small>
                  {alertDeliveryText(locale, "nextRetry")}: {new Date(delivery.nextAttemptAt).toLocaleTimeString(localeTag(locale))}
                </small>
              )}
              {delivery.lastError && <small className="error">{locale === "en" ? delivery.lastError : alertDeliveryText(locale, "deliveryFailed")}</small>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
