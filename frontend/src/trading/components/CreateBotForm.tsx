import { AlertTriangle, Bot } from "lucide-react";
import { useMemo, useState } from "react";
import type { Locale } from "../../i18n";
import { tradingText } from "../../i18n/trading";
import { compileXmlToIr } from "../../strategy/compileArtifact";
import type { StrategyArtifact } from "../../strategy/library";
import type { CatalogResponse } from "../../types";
import { saveBot, type ExchangeId, type TradingBot } from "../tradeClient";

interface CreateBotFormProps {
  strategies: StrategyArtifact[];
  catalog?: CatalogResponse;
  locale: Locale;
  onCreated: (bot: TradingBot) => void;
}

export function CreateBotForm({ strategies, catalog, locale, onCreated }: CreateBotFormProps) {
  const runnable = useMemo(() => strategies.filter((item) => item.kind === "strategy"), [strategies]);
  const [strategyId, setStrategyId] = useState(runnable[0]?.id ?? "");
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("BTCUSDT");
  const [timeframe, setTimeframe] = useState<TradingBot["timeframe"]>("1m");
  const [exchange, setExchange] = useState<ExchangeId>("paper");
  const [market, setMarket] = useState<"spot" | "futures">("futures");
  const [sizeMode, setSizeMode] = useState<TradingBot["sizeMode"]>("quote");
  const [sizeValue, setSizeValue] = useState(100);
  const [leverage, setLeverage] = useState(3);
  const [notifyMarkers, setNotifyMarkers] = useState(true);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const strategy = runnable.find((item) => item.id === strategyId);

  const create = async () => {
    if (!strategy) {
      setError(tradingText(locale, "pickStrategy"));
      return;
    }
    const compiled = compileXmlToIr(strategy.xml);
    if (!compiled.ir || compiled.errors.length) {
      setError(compiled.errors[0] ?? tradingText(locale, "strategyErrors"));
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const bot = await saveBot({
        name: name.trim() || strategy.name,
        strategyName: strategy.name,
        ir: compiled.ir,
        symbol,
        timeframe,
        exchange,
        market,
        sizeMode,
        sizeValue,
        leverage,
        notifyMarkers
      });
      onCreated(bot);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : tradingText(locale, "createFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="trade-form" onSubmit={(event) => { event.preventDefault(); void create(); }}>
      <div className="trade-form-title">
        <Bot size={16} aria-hidden="true" />
        <strong>{tradingText(locale, "newTradingBot")}</strong>
        <span>{tradingText(locale, "runStrategy")}</span>
      </div>

      <fieldset className="form-section">
        <legend>{tradingText(locale, "strategy")}</legend>
        <label>{tradingText(locale, "fromStrategy")}
          <select name="strategy" value={strategyId} required onChange={(event) => setStrategyId(event.target.value)}>
            {runnable.length === 0 && <option value="">{tradingText(locale, "noStrategies")}</option>}
            {runnable.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        <label>{tradingText(locale, "botName")}
          <input name="bot-name" value={name} placeholder={strategy?.name ?? "Bot"} onChange={(event) => setName(event.target.value)} />
        </label>
      </fieldset>

      <fieldset className="form-section">
        <legend>{tradingText(locale, "market")}</legend>
        <div className="form-grid">
          <label>{tradingText(locale, "symbol")}
            <select name="symbol" value={symbol} onChange={(event) => setSymbol(event.target.value)}>
              {(catalog?.instruments ?? []).map((item) => <option key={item.symbol} value={item.symbol}>{item.symbol}</option>)}
            </select>
          </label>
          <label>{tradingText(locale, "interval")}
            <select name="timeframe" value={timeframe} onChange={(event) => setTimeframe(event.target.value as TradingBot["timeframe"])}>
              {(catalog?.timeframes ?? []).map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </label>
        </div>
        <p className="field-help">The bot evaluates the strategy on every closed {timeframe} candle — same signals as the backtest.</p>
      </fieldset>

      <fieldset className="form-section">
        <legend>{tradingText(locale, "execution")}</legend>
        <div className="form-grid">
          <label>{tradingText(locale, "exchange")}
            <select name="exchange" value={exchange} onChange={(event) => setExchange(event.target.value as ExchangeId)}>
              <option value="paper">Paper (simulated)</option><option value="binance">Binance</option><option value="bybit">Bybit</option>
            </select>
          </label>
          <label>{tradingText(locale, "marketType")}
            <select name="market" value={market} onChange={(event) => setMarket(event.target.value as "spot" | "futures")}>
              <option value="futures">Futures</option><option value="spot">Spot</option>
            </select>
          </label>
        </div>
        <div className="form-grid">
          <label>{tradingText(locale, "sizing")}
            <select name="size-mode" value={sizeMode} onChange={(event) => setSizeMode(event.target.value as TradingBot["sizeMode"])}>
              <option value="quote">Quote (USDT)</option><option value="base">Base units</option><option value="equity_pct">% equity</option><option value="risk_pct">% risk</option>
            </select>
          </label>
          <label>{tradingText(locale, "amount")}
            <input name="amount" type="number" value={sizeValue} min={0} step={1} onChange={(event) => setSizeValue(event.target.valueAsNumber || 0)} />
          </label>
          <label>{tradingText(locale, "leverage")}
            <input name="leverage" type="number" value={leverage} min={1} max={125} step={1} onChange={(event) => setLeverage(event.target.valueAsNumber || 1)} />
          </label>
        </div>
        <label className="check-row">
          <input name="notify-markers" type="checkbox" checked={notifyMarkers} onChange={(event) => setNotifyMarkers(event.target.checked)} />
          {tradingText(locale, "notifyMarkers")}
        </label>
      </fieldset>

      {exchange !== "paper" && <div className="trade-warn"><AlertTriangle size={13} aria-hidden="true" /> Real trading uses your saved API keys and real funds. Add keys in Settings and test on paper first.</div>}
      {error && <div className="strategy-warnings" role="alert"><span><AlertTriangle size={12} aria-hidden="true" /> {error}</span></div>}
      <button type="submit" className="run-button form-submit" disabled={busy}>{tradingText(locale, busy ? "creating" : "createBot")}</button>
    </form>
  );
}
