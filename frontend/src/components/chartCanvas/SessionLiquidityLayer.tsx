import { useEffect, useMemo, useState } from "react";
import { getCandles } from "../../api/marketClient";
import { analyzeSessionLiquidity } from "../../chart/sessionLiquidity";
import type { Locale } from "../../i18n";
import { shellText } from "../../i18n/shell";
import type { Candle, DataExchange, Timeframe } from "../../types";

export function useSessionLiquidity(candles: Candle[], symbol: string, timeframe: Timeframe, exchange: DataExchange) {
  const [enabled, setEnabled] = useState(true);
  const [dailyCandles, setDailyCandles] = useState<Candle[]>([]);
  const supported = !(["1d", "1w", "1M"] as Timeframe[]).includes(timeframe);
  const snapshot = useMemo(() => supported ? analyzeSessionLiquidity(candles, dailyCandles) : undefined, [candles, dailyCandles, supported]);

  useEffect(() => {
    setDailyCandles([]);
    if (!enabled || !supported) return;
    let current = true;
    getCandles(symbol, "1d", 10, undefined, exchange).then(
      (response) => { if (current) setDailyCandles(response.candles); },
      () => undefined
    );
    return () => { current = false; };
  }, [enabled, exchange, supported, symbol]);

  return { enabled, setEnabled, snapshot, supported };
}

export function SessionLiquidityBadge({ state, decimals, locale }: {
  state: ReturnType<typeof useSessionLiquidity>;
  decimals: number;
  locale: Locale;
}) {
  if (!state.supported) return null;
  const t = (key: Parameters<typeof shellText>[1]) => shellText(locale, key);
  const price = (value: number | undefined) => value === undefined ? "—" : value.toFixed(decimals);
  const snapshot = state.snapshot;
  const summary = snapshot
    ? `VWAP ${price(snapshot.vwap)}; O ${price(snapshot.open)}; H ${price(snapshot.high)}; L ${price(snapshot.low)}; PDH ${price(snapshot.previousDayHigh)}; PDL ${price(snapshot.previousDayLow)}; ${snapshot.sweeps.length} SWP`
    : t("loading");
  return (
    <section className={`session-liquidity-badge ${state.enabled ? "" : "disabled"}`} aria-label={`${t("sessionLiquidityMap")}: ${summary}`}>
      <button type="button" aria-label={t("toggleSessionLiquidity")} aria-pressed={state.enabled} onClick={() => state.setEnabled((current) => !current)}>
        <strong>SESSION UTC</strong><span>{state.enabled ? t("on") : t("hide")}</span>
      </button>
      {state.enabled && snapshot && (
        <div className="session-liquidity-values">
          <span>VWAP <b>{price(snapshot.vwap)}</b> · ±1σ <b>{snapshot.upperBand !== undefined && snapshot.vwap !== undefined ? price(snapshot.upperBand - snapshot.vwap) : "—"}</b></span>
          <small>PDH <b>{price(snapshot.previousDayHigh)}</b> · PDL <b>{price(snapshot.previousDayLow)}</b> · {snapshot.sweeps.length} SWP</small>
        </div>
      )}
    </section>
  );
}
