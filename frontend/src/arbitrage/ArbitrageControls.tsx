import type { Locale } from "../i18n";
import type { ArbitrageFeeProfile } from "./fees";
import { arbitrageText } from "./text";

interface Props {
  locale: Locale; profile: ArbitrageFeeProfile; onProfile(profile: ArbitrageFeeProfile): void;
  alertEnabled: boolean; onAlertEnabled(value: boolean): void; alertThresholdBps: number; onAlertThreshold(value: number): void;
  notionalUsd: number; onNotional(value: number): void;
}

export function ArbitrageControls(props: Props) {
  const feeFields: Array<[keyof ArbitrageFeeProfile, string]> = [
    ["binanceSpotTakerBps", "Binance spot"], ["binancePerpetualTakerBps", "Binance perpetual"],
    ["bybitSpotTakerBps", "Bybit spot"], ["bybitPerpetualTakerBps", "Bybit perpetual"],
    ["roundTripSlippageReserveBps", arbitrageText(props.locale, "slippageReserve")]
  ];
  return <details className="arb-settings">
    <summary>{arbitrageText(props.locale, "advancedSettings")}</summary>
    <div className="arb-settings-grid">
      <fieldset><legend>{arbitrageText(props.locale, "feeProfile")}</legend><p>{arbitrageText(props.locale, "feeProfileHint")}</p>
        <div className="arb-fee-grid">{feeFields.map(([key, label]) => <label key={key} htmlFor={`arb-fee-${key}`}>{label}
          <span className="arb-number-control"><input id={`arb-fee-${key}`} type="number" min="0" max="1000" step="0.1" value={props.profile[key]} onChange={(event) => props.onProfile({ ...props.profile, [key]: Math.min(1_000, Math.max(0, event.target.valueAsNumber || 0)) })} /><span>bp</span></span>
        </label>)}</div>
      </fieldset>
      <fieldset><legend>{arbitrageText(props.locale, "alertSettings")}</legend><p>{arbitrageText(props.locale, "alertHint")}</p>
        <label className="arb-check"><input type="checkbox" checked={props.alertEnabled} onChange={(event) => props.onAlertEnabled(event.target.checked)} /> {arbitrageText(props.locale, "enableAlerts")}</label>
        <label htmlFor="arb-alert-threshold">{arbitrageText(props.locale, "alertThreshold")}
          <span className="arb-number-control"><input id="arb-alert-threshold" type="number" min="-100" max="100" step="0.01" value={props.alertThresholdBps / 100} onChange={(event) => props.onAlertThreshold((event.target.valueAsNumber || 0) * 100)} /><span>%</span></span>
        </label>
      </fieldset>
      <fieldset><legend>{arbitrageText(props.locale, "simulation")}</legend><p>{arbitrageText(props.locale, "simulationHint")}</p>
        <label htmlFor="arb-notional">{arbitrageText(props.locale, "notional")}
          <span className="arb-number-control"><span>$</span><input id="arb-notional" type="number" min="10" max="1000000" step="100" value={props.notionalUsd} onChange={(event) => props.onNotional(Math.min(1_000_000, Math.max(10, event.target.valueAsNumber || 10)))} /></span>
        </label>
      </fieldset>
    </div>
  </details>;
}
