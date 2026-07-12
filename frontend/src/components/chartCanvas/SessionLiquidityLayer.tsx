import { useEffect, useMemo, useState } from "react";
import { getCandles } from "../../api/marketClient";
import { analyzeSessionLiquidity } from "../../chart/sessionLiquidity";
import { buildMarketSessionRanges, DEFAULT_MARKET_SESSION_VISIBILITY, MARKET_SESSION_IDS, supportsMarketSessions, type MarketSessionId } from "../../chart/marketSessions";
import { analyzeMarketStructure, DEFAULT_MARKET_STRUCTURE_SETTINGS } from "../../chart/marketStructure";
import type { Locale } from "../../i18n";
import { marketStructureText } from "../../i18n/marketStructure";
import { shellText } from "../../i18n/shell";
import type { Candle, DataExchange, Timeframe } from "../../types";

export function useSessionLiquidity(candles: Candle[], symbol: string, timeframe: Timeframe, exchange: DataExchange) {
  const [enabled, setEnabled] = useState(true);
  const [dailyCandles, setDailyCandles] = useState<Candle[]>([]);
  const [marketSessionVisibility, setMarketSessionVisibility] = useState(DEFAULT_MARKET_SESSION_VISIBILITY);
  const [marketStructureSettings, setMarketStructureSettings] = useState(DEFAULT_MARKET_STRUCTURE_SETTINGS);
  const supported = !(["1d", "1w", "1M"] as Timeframe[]).includes(timeframe);
  const marketSessionsSupported = supportsMarketSessions(timeframe);
  const snapshot = useMemo(() => supported ? analyzeSessionLiquidity(candles, dailyCandles) : undefined, [candles, dailyCandles, supported]);
  const marketSessions = useMemo(() => marketSessionsSupported ? buildMarketSessionRanges(candles, marketSessionVisibility) : [], [candles, marketSessionVisibility, marketSessionsSupported]);
  const marketStructure = useMemo(() => analyzeMarketStructure(candles, marketStructureSettings), [candles, marketStructureSettings]);

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

  return { enabled, setEnabled, snapshot, supported, marketSessions, marketSessionsSupported, marketSessionVisibility, setMarketSessionVisibility, marketStructure, marketStructureSettings, setMarketStructureSettings };
}

export function SessionLiquidityBadge({ state, decimals, locale }: {
  state: ReturnType<typeof useSessionLiquidity>;
  decimals: number;
  locale: Locale;
}) {
  const t = (key: Parameters<typeof shellText>[1]) => shellText(locale, key);
  const mt = (key: Parameters<typeof marketStructureText>[1]) => marketStructureText(locale, key);
  const price = (value: number | undefined) => value === undefined ? "—" : value.toFixed(decimals);
  const snapshot = state.snapshot;
  const summary = !state.supported ? mt("utcMapTimeframes") : snapshot
    ? `VWAP ${price(snapshot.vwap)}; O ${price(snapshot.open)}; H ${price(snapshot.high)}; L ${price(snapshot.low)}; PDH ${price(snapshot.previousDayHigh)}; PDL ${price(snapshot.previousDayLow)}; ${snapshot.sweeps.length} SWP`
    : t("loading");
  const sessionLabels: Record<MarketSessionId, string> = { asia: t("asiaSession"), london: t("londonSession"), "new-york": t("newYorkSession") };
  const latestMarketSessions = MARKET_SESSION_IDS.flatMap((id) => state.marketSessions.filter((session) => session.id === id).slice(-1));
  const structure = state.marketStructure;
  const latestBreak = structure.breaks.at(-1);
  const openFvg = structure.fairValueGaps.filter((gap) => gap.mitigatedAt === undefined).length;
  const nextStrength = state.marketStructureSettings.swingStrength >= 5 ? 2 : state.marketStructureSettings.swingStrength + 1;
  return (
    <section className="session-liquidity-badge" aria-label={`${t("sessionLiquidityMap")}: ${summary}; ${mt("marketStructure")}`}>
      <button type="button" disabled={!state.supported} aria-label={state.supported ? t("toggleSessionLiquidity") : `${t("toggleSessionLiquidity")} · ${mt("utcMapTimeframes")}`} aria-pressed={state.enabled && state.supported} onClick={() => state.setEnabled((current) => !current)}>
        <strong>SESSION UTC</strong><span>{!state.supported ? t("off") : state.enabled ? t("on") : t("hide")}</span>
      </button>
      {state.enabled && state.supported && snapshot && (
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
      <div className="market-structure-toggles" aria-label={mt("marketStructure")}>
        <button type="button" aria-label={mt("toggleStructure")} aria-pressed={state.marketStructureSettings.showStructure} onClick={() => state.setMarketStructureSettings((current) => ({ ...current, showStructure: !current.showStructure }))}>STRUCT</button>
        <button type="button" aria-label={mt("toggleFvg")} aria-pressed={state.marketStructureSettings.showFvg} onClick={() => state.setMarketStructureSettings((current) => ({ ...current, showFvg: !current.showFvg }))}>FVG</button>
        <button type="button" aria-label={`${mt("swingStrength")}: ${state.marketStructureSettings.swingStrength}`} onClick={() => state.setMarketStructureSettings((current) => ({ ...current, swingStrength: nextStrength }))}>S{state.marketStructureSettings.swingStrength}</button>
      </div>
      <ul className="sr-only">
        {latestMarketSessions.map((session) => <li key={`${session.id}:${session.dateKey}`}>{sessionLabels[session.id]} · {session.dateKey} · H {price(session.high)} · L {price(session.low)} · {t(session.active ? "sessionActive" : "sessionClosed")}</li>)}
        <li>{mt("trend")}: {mt(structure.trend)}; {structure.swings.length} {mt("confirmedSwings")}; {structure.breaks.length} {mt("structureBreaks")}; {openFvg} {mt("openFvg")}</li>
        <li>{latestBreak ? `${mt("latestEvent")}: ${latestBreak.kind.toUpperCase()} ${mt(latestBreak.direction)} · ${price(latestBreak.price)}` : mt("noEvents")}</li>
      </ul>
    </section>
  );
}
