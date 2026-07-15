import { AlertTriangle, RefreshCw, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { localeTag, type Locale } from "../../../i18n";
import { bybitUtaText } from "../../../i18n/bybitUta";
import { borrowBybitUta, getBybitUta, repayBybitUta, setBybitCollateral, type BybitUtaSnapshot } from "../../tradeClient";
import { BybitUtaForms } from "./BybitUtaForms";

interface Props {
  locale: Locale;
  configured: boolean;
  demo: boolean;
  liveArmed: boolean;
  secureTradingOrigin: boolean;
}

export function BybitUtaPanel({ locale, configured, demo, liveArmed, secureTradingOrigin }: Props) {
  const [snapshot, setSnapshot] = useState<BybitUtaSnapshot>();
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [status, setStatus] = useState<string>();

  const refresh = useCallback(async () => {
    if (!configured) return;
    setLoading(true);
    setError(undefined);
    try {
      const result = await getBybitUta();
      setSnapshot(result.snapshot);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : bybitUtaText(locale, "unavailable"));
    } finally {
      setLoading(false);
    }
  }, [configured, locale]);

  useEffect(() => { void refresh(); }, [refresh]);

  const action = async (operation: () => Promise<{ status: "processing" | "success"; snapshot: BybitUtaSnapshot }>) => {
    setBusy(true);
    setError(undefined);
    setStatus(undefined);
    try {
      const result = await operation();
      setSnapshot(result.snapshot);
      setStatus(bybitUtaText(locale, result.status === "processing" ? "actionProcessing" : "actionSuccess"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : bybitUtaText(locale, "unavailable"));
    } finally {
      setBusy(false);
    }
  };

  const mutationsDisabled = demo || !secureTradingOrigin || busy || !configured;
  const formatMoney = (value: number) => new Intl.NumberFormat(localeTag(locale), { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(value);
  const formatNumber = (value: number, digits = 8) => new Intl.NumberFormat(localeTag(locale), { maximumFractionDigits: digits }).format(value);
  const formatPercent = (value: number) => new Intl.NumberFormat(localeTag(locale), { style: "percent", maximumFractionDigits: 2 }).format(value);

  return (
    <section className="uta-panel" aria-labelledby="uta-panel-title">
      <div className="panel-header uta-panel-header">
        <strong id="uta-panel-title"><ShieldCheck size={15} aria-hidden="true" /> {bybitUtaText(locale, "title")}</strong>
        <button type="button" className="icon-button" onClick={() => void refresh()} disabled={!configured || loading} aria-label={bybitUtaText(locale, "refresh")} title={bybitUtaText(locale, "refresh")}>
          <RefreshCw size={14} className={loading ? "spin" : ""} aria-hidden="true" />
        </button>
      </div>
      <p className="settings-note">{bybitUtaText(locale, "description")}</p>
      {!configured && <p className="uta-notice">{bybitUtaText(locale, "notConfigured")}</p>}
      {!secureTradingOrigin && <p className="uta-notice danger"><AlertTriangle size={14} aria-hidden="true" /> {bybitUtaText(locale, "httpsRequired")}</p>}
      {error && <p className="uta-notice danger" role="alert"><AlertTriangle size={14} aria-hidden="true" /> {error}</p>}
      {status && <p className="uta-notice success" role="status">{status}</p>}

      {snapshot && (
        <>
          <dl className="uta-metrics">
            <Metric label={bybitUtaText(locale, "equity")} value={formatMoney(snapshot.account.totalEquity)} />
            <Metric label={bybitUtaText(locale, "available")} value={formatMoney(snapshot.account.totalAvailableBalance)} />
            <Metric label={bybitUtaText(locale, "initialMargin")} value={formatMoney(snapshot.account.totalInitialMargin)} />
            <Metric label={bybitUtaText(locale, "maintenanceMargin")} value={formatMoney(snapshot.account.totalMaintenanceMargin)} />
            <Metric label={bybitUtaText(locale, "imr")} value={formatPercent(snapshot.account.accountImRate)} />
            <Metric label={bybitUtaText(locale, "mmr")} value={formatPercent(snapshot.account.accountMmRate)} tone={snapshot.account.accountMmRate >= snapshot.limits.maxAccountMmRate ? "critical" : undefined} />
            <Metric label={bybitUtaText(locale, "marginMode")} value={snapshot.account.marginMode.replace("_MARGIN", "")} />
            <Metric label={bybitUtaText(locale, "risk")} value={bybitUtaText(locale, snapshot.risk.level)} tone={snapshot.risk.level} />
          </dl>
          {snapshot.risk.reasons.length > 0 && <ul className="uta-risk-reasons">{snapshot.risk.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>}

          <div className="uta-table-wrap">
            <table className="uta-table">
              <caption>{bybitUtaText(locale, "assets")}</caption>
              <thead><tr><th scope="col">{bybitUtaText(locale, "coin")}</th><th scope="col">{bybitUtaText(locale, "wallet")}</th><th scope="col">{bybitUtaText(locale, "usdValue")}</th><th scope="col">{bybitUtaText(locale, "debt")}</th><th scope="col">{bybitUtaText(locale, "interest")}</th><th scope="col">{bybitUtaText(locale, "borrowRate")}</th><th scope="col">{bybitUtaText(locale, "usage")}</th><th scope="col">{bybitUtaText(locale, "collateral")}</th></tr></thead>
              <tbody>
                {snapshot.assets.map((asset) => (
                  <tr key={asset.coin}>
                    <th scope="row">{asset.coin}</th>
                    <td>{formatNumber(asset.walletBalance)}</td>
                    <td>{formatMoney(asset.usdValue)}</td>
                    <td>{formatNumber(asset.borrowAmount)}</td>
                    <td>{formatNumber(asset.accruedInterest)}</td>
                    <td>{formatPercent(asset.hourlyBorrowRate)}</td>
                    <td>{formatPercent(asset.borrowUsageRate)}</td>
                    <td>
                      {asset.marginCollateral && !["USDT", "USDC"].includes(asset.coin) ? (
                        <button
                          type="button"
                          className={`uta-collateral-toggle ${asset.collateralEnabled ? "active" : ""}`}
                          disabled={mutationsDisabled}
                          aria-pressed={asset.collateralEnabled}
                          onClick={() => {
                            const message = bybitUtaText(locale, "confirmCollateral", { coin: asset.coin });
                            if (window.confirm(message)) void action(() => setBybitCollateral(asset.coin, !asset.collateralEnabled));
                          }}
                        >
                          {bybitUtaText(locale, asset.collateralEnabled ? "enabled" : "disabled")}
                        </button>
                      ) : <span>{asset.collateralEnabled ? bybitUtaText(locale, "enabled") : "—"}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <BybitUtaForms
            locale={locale}
            disabled={mutationsDisabled}
            liveArmed={liveArmed}
            onBorrow={(coin, amount) => action(() => borrowBybitUta(coin, amount))}
            onRepay={(input) => action(() => repayBybitUta(input))}
          />

          <div className="uta-history">
            <strong>{bybitUtaText(locale, "history")}</strong>
            {snapshot.borrowHistory.length === 0 ? <p className="settings-note">{bybitUtaText(locale, "noHistory")}</p> : (
              <table className="uta-table">
                <thead><tr><th scope="col">{bybitUtaText(locale, "time")}</th><th scope="col">{bybitUtaText(locale, "coin")}</th><th scope="col">{bybitUtaText(locale, "debt")}</th><th scope="col">{bybitUtaText(locale, "borrowRate")}</th><th scope="col">{bybitUtaText(locale, "cost")}</th></tr></thead>
                <tbody>{snapshot.borrowHistory.slice(0, 10).map((row) => <tr key={`${row.coin}-${row.createdAt}`}><td>{new Date(row.createdAt).toLocaleString(localeTag(locale))}</td><td>{row.coin}</td><td>{formatNumber(row.borrowAmount)}</td><td>{formatPercent(row.hourlyBorrowRate)}</td><td>{formatNumber(row.borrowCost)}</td></tr>)}</tbody>
              </table>
            )}
          </div>
          <small className="uta-updated">{bybitUtaText(locale, "updated")}: {new Date(snapshot.updatedAt).toLocaleString(localeTag(locale))}</small>
        </>
      )}
    </section>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: "safe" | "warning" | "critical" }) {
  return <div className={tone ? `uta-metric ${tone}` : "uta-metric"}><dt>{label}</dt><dd>{value}</dd></div>;
}
