import { useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { getCandles } from "../../api/marketClient";
import { analyzeSessionLiquidity } from "../../chart/sessionLiquidity";
import { appendMarketSessionTail, buildMarketSessionRanges, DEFAULT_MARKET_SESSION_VISIBILITY, MARKET_SESSION_IDS, supportsMarketSessions, type MarketSessionId } from "../../chart/marketSessions";
import { analyzeMarketStructure, DEFAULT_MARKET_STRUCTURE_SETTINGS } from "../../chart/marketStructure";
import type { Locale } from "../../i18n";
import { marketStructureText } from "../../i18n/marketStructure";
import { shellText } from "../../i18n/shell";
import type { Candle, DataExchange, DataMarketType, PriceType, Timeframe } from "../../types";
import { recordBrowserMetric } from "../../performance/browserProbe";
import { structuralCandlesOf } from "../../market/candleSeries";

export function useSessionLiquidity(candles: Candle[], symbol: string, timeframe: Timeframe, exchange: DataExchange, structureCandles = candles, marketType: DataMarketType = "spot", priceType: PriceType = "last", operational = true) {
  const [enabled, setEnabled] = useState(true);
  const [dailyCandles, setDailyCandles] = useState<Candle[]>([]);
  const [marketSessionVisibility, setMarketSessionVisibility] = useState(DEFAULT_MARKET_SESSION_VISIBILITY);
  const [marketStructureSettings, setMarketStructureSettings] = useState(DEFAULT_MARKET_STRUCTURE_SETTINGS);
  const supported = !(["1d", "1w", "1M"] as Timeframe[]).includes(timeframe);
  const marketSessionsSupported = supportsMarketSessions(timeframe);
  const structuralCandles = structuralCandlesOf(candles);
  const sessionTail = operational && marketSessionsSupported ? candles.at(-1) : undefined;
  const sessionHistoryEnd = Math.max(0, structuralCandles.length - 1);
  const sessionHistoryBasisRef = useRef<CandlePrefixBasis>();
  const sessionHistoryBasis = stableCandlePrefix(structuralCandles, sessionHistoryEnd, sessionHistoryBasisRef);
  const snapshot = useMemo(() => measureChartAnalysis("chart.sessionLiquidity.ms", () => (operational && supported ? analyzeSessionLiquidity(candles, dailyCandles) : undefined)), [candles, dailyCandles, operational, supported]);
  const structuralMarketSessions = useMemo(
    () => measureChartAnalysis("chart.marketSessions.structuralMs", () => (operational && marketSessionsSupported ? buildMarketSessionRanges(sessionHistoryBasis.candles, marketSessionVisibility, sessionHistoryBasis.endExclusive) : [])),
    [marketSessionVisibility, marketSessionsSupported, operational, sessionHistoryBasis]
  );
  const marketSessions = useMemo(() => measureChartAnalysis("chart.marketSessions.ms", () => (sessionTail ? appendMarketSessionTail(structuralMarketSessions, sessionTail, marketSessionVisibility) : structuralMarketSessions)), [marketSessionVisibility, sessionTail, structuralMarketSessions]);
  const marketStructure = useMemo(() => measureChartAnalysis("chart.marketStructure.ms", () => analyzeMarketStructure(operational ? structureCandles : [], marketStructureSettings)), [marketStructureSettings, operational, structureCandles]);

  useEffect(() => {
    if (!enabled || !operational || !supported) return;
    setDailyCandles([]);
    let current = true;
    const controller = new AbortController();
    getCandles(symbol, "1d", 10, undefined, exchange, { signal: controller.signal, marketType, priceType }).then(
      (response) => {
        if (current) setDailyCandles(response.candles);
      },
      () => undefined
    );
    return () => {
      current = false;
      controller.abort();
    };
  }, [enabled, exchange, marketType, operational, priceType, supported, symbol]);

  return { enabled, setEnabled, snapshot, supported, marketSessions, marketSessionsSupported, marketSessionVisibility, setMarketSessionVisibility, marketStructure, marketStructureSettings, setMarketStructureSettings };
}

interface CandlePrefixBasis {
  candles: readonly Candle[];
  endExclusive: number;
  first?: Candle;
  middle?: Candle;
  last?: Candle;
}

function stableCandlePrefix(candles: readonly Candle[], endExclusive: number, ref: MutableRefObject<CandlePrefixBasis | undefined>): CandlePrefixBasis {
  const first = endExclusive > 0 ? candles[0] : undefined;
  const middle = endExclusive > 0 ? candles[(endExclusive - 1) >>> 1] : undefined;
  const last = endExclusive > 0 ? candles[endExclusive - 1] : undefined;
  const current = ref.current;
  if (current && current.endExclusive === endExclusive && current.first === first && current.middle === middle && current.last === last) return current;
  const next = { candles, endExclusive, first, middle, last };
  ref.current = next;
  return next;
}

function measureChartAnalysis<T>(name: string, work: () => T): T {
  if (typeof window === "undefined" || !window.__SBV2_BROWSER_PERF_PROBE__) return work();
  const startedAt = performance.now();
  try {
    return work();
  } finally {
    recordBrowserMetric(name, performance.now() - startedAt);
  }
}

export function SessionLiquidityBadge({
  state,
  decimals,
  locale,
  compact = false
}: {
  state: ReturnType<typeof useSessionLiquidity>;
  decimals: number;
  locale: Locale;
  compact?: boolean;
}) {
  const t = (key: Parameters<typeof shellText>[1]) => shellText(locale, key);
  const mt = (key: Parameters<typeof marketStructureText>[1]) => marketStructureText(locale, key);
  const price = (value: number | undefined) => (value === undefined ? "—" : value.toFixed(decimals));
  const snapshot = state.snapshot;
  const summary = !state.supported ? mt("utcMapTimeframes") : snapshot ? `VWAP ${price(snapshot.vwap)}; O ${price(snapshot.open)}; H ${price(snapshot.high)}; L ${price(snapshot.low)}; PDH ${price(snapshot.previousDayHigh)}; PDL ${price(snapshot.previousDayLow)}; ${snapshot.sweeps.length} SWP` : t("loading");
  const sessionLabels: Record<MarketSessionId, string> = { asia: t("asiaSession"), london: t("londonSession"), "new-york": t("newYorkSession") };
  const latestMarketSessions = MARKET_SESSION_IDS.flatMap((id) => state.marketSessions.filter((session) => session.id === id).slice(-1));
  const structure = state.marketStructure;
  const latestBreak = structure.breaks.at(-1);
  const openFvg = structure.fairValueGaps.filter((gap) => gap.mitigatedAt === undefined).length;
  const nextStrength = state.marketStructureSettings.swingStrength >= 5 ? 2 : state.marketStructureSettings.swingStrength + 1;
  const label = `${t("sessionLiquidityMap")}: ${summary}; ${mt("marketStructure")}`;
  const controls = (
    <>
      <button type="button" disabled={!state.supported} aria-label={state.supported ? t("toggleSessionLiquidity") : `${t("toggleSessionLiquidity")} · ${mt("utcMapTimeframes")}`} aria-pressed={state.enabled && state.supported} onClick={() => state.setEnabled((current) => !current)}>
        <strong>SESSION UTC</strong>
        <span>{!state.supported ? t("off") : state.enabled ? t("on") : t("hide")}</span>
      </button>
      {state.enabled && state.supported && snapshot && (
        <div className="session-liquidity-values">
          <span>
            VWAP <b>{price(snapshot.vwap)}</b> · ±1σ <b>{snapshot.upperBand !== undefined && snapshot.vwap !== undefined ? price(snapshot.upperBand - snapshot.vwap) : "—"}</b>
          </span>
          <small>
            PDH <b>{price(snapshot.previousDayHigh)}</b> · PDL <b>{price(snapshot.previousDayLow)}</b> · {snapshot.sweeps.length} SWP
          </small>
        </div>
      )}
      <div className="market-session-toggles" aria-label={t("marketSessions")}>
        {MARKET_SESSION_IDS.map((id) => (
          <button
            key={id}
            type="button"
            data-session={id}
            disabled={!state.marketSessionsSupported}
            aria-label={state.marketSessionsSupported ? sessionLabels[id] : `${sessionLabels[id]} · ${t("marketSessionsIntradayOnly")}`}
            aria-pressed={state.marketSessionVisibility[id]}
            onClick={() => state.setMarketSessionVisibility((current) => ({ ...current, [id]: !current[id] }))}
          >
            {id === "asia" ? "ASIA" : id === "london" ? "LON" : "NY"}
          </button>
        ))}
      </div>
      <div className="market-structure-toggles" aria-label={mt("marketStructure")}>
        <button type="button" aria-label={mt("toggleStructure")} aria-pressed={state.marketStructureSettings.showStructure} onClick={() => state.setMarketStructureSettings((current) => ({ ...current, showStructure: !current.showStructure }))}>
          STRUCT
        </button>
        <button type="button" aria-label={mt("toggleFvg")} aria-pressed={state.marketStructureSettings.showFvg} onClick={() => state.setMarketStructureSettings((current) => ({ ...current, showFvg: !current.showFvg }))}>
          FVG
        </button>
        <button type="button" aria-label={`${mt("swingStrength")}: ${state.marketStructureSettings.swingStrength}`} onClick={() => state.setMarketStructureSettings((current) => ({ ...current, swingStrength: nextStrength }))}>
          S{state.marketStructureSettings.swingStrength}
        </button>
      </div>
    </>
  );
  const semanticSummary = (
    <ul className="sr-only">
      {latestMarketSessions.map((session) => (
        <li key={`${session.id}:${session.dateKey}`}>
          {sessionLabels[session.id]} · {session.dateKey} · H {price(session.high)} · L {price(session.low)} · {t(session.active ? "sessionActive" : "sessionClosed")}
        </li>
      ))}
      <li>
        {mt("trend")}: {mt(structure.trend)}; {structure.swings.length} {mt("confirmedSwings")}; {structure.breaks.length} {mt("structureBreaks")}; {openFvg} {mt("openFvg")}
      </li>
      <li>{latestBreak ? `${mt("latestEvent")}: ${latestBreak.kind.toUpperCase()} ${mt(latestBreak.direction)} · ${price(latestBreak.price)}` : mt("noEvents")}</li>
    </ul>
  );
  return (
    <details className={`session-liquidity-badge ${compact ? "compact" : ""}`} aria-label={label}>
      <summary>
        <strong>UTC · STRUCT</strong>
        <span aria-hidden="true">⌄</span>
      </summary>
      <div className="session-liquidity-panel">{controls}</div>
      {semanticSummary}
    </details>
  );
}
