import { useEffect, useMemo, useState } from "react";
import { getCandles } from "../../api/marketClient";
import { analyzeSessionLiquidity } from "../../chart/sessionLiquidity";
import { buildMarketSessionRanges, DEFAULT_MARKET_SESSION_VISIBILITY, MARKET_SESSION_IDS, supportsMarketSessions, type MarketSessionId } from "../../chart/marketSessions";
import type { Locale } from "../../i18n";
import { shellText } from "../../i18n/shell";
import type { Candle, DataExchange, Timeframe } from "../../types";

export function useSessionLiquidity(candles: Candle[], symbol: string, timeframe: Timeframe, exchange: DataExchange) {
  const [enabled, setEnabled] = useState(true);
  const [dailyCandles, setDailyCandles] = useState<Candle[]>([]);
  const [marketSessionVisibility, setMarketSessionVisibility] = useState(DEFAULT_MARKET_SESSION_VISIBILITY);
  const supported = !(["1d", "1w", "1M"] as Timeframe[]).includes(timeframe);
  const marketSessionsSupported = supportsMarketSessions(timeframe);
  const snapshot = useMemo(() => supported ? analyzeSessionLiquidity(candles, dailyCandles) : undefined, [candles, dailyCandles, supported]);
  const marketSessions = useMemo(() => marketSessionsSupported ? buildMarketSessionRanges(candles, marketSessionVisibility) : [], [candles, marketSessionVisibility, marketSessionsSupported]);

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

  return { enabled, setEnabled, snapshot, supported, marketSessions, marketSessionsSupported, marketSessionVisibility, setMarketSessionVisibility };
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
  const sessionLabels: Record<MarketSessionId, string> = { asia: t("asiaSession"), london: t("londonSession"), "new-york": t("newYorkSession") };
  const latestMarketSessions = MARKET_SESSION_IDS.flatMap((id) => state.marketSessions.filter((session) => session.id === id).slice(-1));
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
      <div className="market-session-toggles" aria-label={t("marketSessions")}>
        {MARKET_SESSION_IDS.map((id) => (
          <button key={id} type="button" data-session={id} disabled={!state.marketSessionsSupported} aria-label={state.marketSessionsSupported ? sessionLabels[id] : `${sessionLabels[id]} · ${t("marketSessionsIntradayOnly")}`} aria-pressed={state.marketSessionVisibility[id]} onClick={() => state.setMarketSessionVisibility((current) => ({ ...current, [id]: !current[id] }))}>
            {id === "asia" ? "ASIA" : id === "london" ? "LON" : "NY"}
          </button>
        ))}
      </div>
      <ul className="sr-only">
        {latestMarketSessions.map((session) => <li key={`${session.id}:${session.dateKey}`}>{sessionLabels[session.id]} · {session.dateKey} · H {price(session.high)} · L {price(session.low)} · {t(session.active ? "sessionActive" : "sessionClosed")}</li>)}
      </ul>
    </section>
  );
}
