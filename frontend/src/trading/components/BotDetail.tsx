import { Play, Square, Trash2, XOctagon } from "lucide-react";
import { useState } from "react";
import type { Locale } from "../../i18n";
import { tradingLiveConfirm, tradingTerm, tradingText } from "../../i18n/trading";
import {
  deleteBot,
  sendCommand,
  startBot,
  stopBot,
  type Fill,
  type LiveState,
  type LogRow,
  type OrderJournal,
  type PendingOrder,
  type TradingBot
} from "../tradeClient";
import { BotActivity } from "./BotActivity";
import { BotCommandConsole } from "./BotCommandConsole";

interface BotDetailProps {
  bot: TradingBot;
  live?: LiveState;
  orders: PendingOrder[];
  orderJournal: OrderJournal[];
  fills: Fill[];
  logs: LogRow[];
  onChanged: () => void;
  onDeleted: () => void;
  locale: Locale;
  canControl?: boolean;
  executionDisabled?: boolean;
  storageOwnerId?: string;
}

export function BotDetail({ bot, live, orders, orderJournal, fills, logs, onChanged, onDeleted, locale, canControl = true, executionDisabled = false, storageOwnerId }: BotDetailProps) {
  const [commandOutput, setCommandOutput] = useState<string>();
  const controlsAvailable = canControl && !executionDisabled;
  const position = live?.position;
  const unrealizedPnl = position && live
    ? position.side === "long" ? position.qty * (live.price - position.entryPrice) : position.qty * (position.entryPrice - live.price)
    : 0;

  const toggle = async () => {
    try {
      if (bot.status === "running") {
        await stopBot(bot.id);
      } else if (bot.exchange !== "paper") {
        if (!window.confirm(tradingLiveConfirm(locale, bot.exchange))) return;
        const result = await startBot(bot.id, true);
        if (!result.ok && result.error) setCommandOutput(result.error);
      } else {
        const result = await startBot(bot.id);
        if (!result.ok && result.error) setCommandOutput(result.error);
      }
    } catch (error) {
      setCommandOutput(error instanceof Error ? error.message : tradingText(locale, "failedToStart"));
    }
    onChanged();
  };

  const runCommand = async (input: string, dryRun = false) => {
    if (!input.trim()) return;
    try {
      const result = await sendCommand(bot.id, input, dryRun);
      setCommandOutput(result.message);
    } catch (error) {
      setCommandOutput(error instanceof Error ? error.message : tradingText(locale, "commandFailed"));
    }
  };

  return (
    <div className="trade-detail">
      <header className="trade-detail-head">
        <div>
          <strong>{bot.name}</strong>
          <span>{bot.exchange} · {bot.market} · {bot.symbol} · {bot.timeframe} · {bot.strategyName}</span>
          {executionDisabled && bot.exchange !== "paper" && <span className="trade-runtime-badge">{tradingText(locale, "liveExecutionDisabled")}</span>}
          {live?.runtimeStatus === "requires_manual_action" && <span className="trade-runtime-badge" title={live.pauseReason ?? tradingText(locale, "operatorConfirmation")}>{tradingText(locale, "requiresAction")}</span>}
        </div>
        {controlsAvailable && (
          <div className="trade-detail-actions">
            <button type="button" className={bot.status === "running" ? "danger" : "run-button"} onClick={() => void toggle()}>
              {bot.status === "running" ? <><Square size={13} aria-hidden="true" /> {tradingText(locale, "stop")}</> : <><Play size={13} aria-hidden="true" /> {tradingText(locale, "start")}</>}
            </button>
            <button type="button" className="icon-button" aria-label={tradingText(locale, "flatten")} title={tradingText(locale, "flatten")} onClick={() => void runCommand(`exit=${bot.symbol}`)} disabled={bot.status !== "running"}><XOctagon size={15} aria-hidden="true" /></button>
            <button type="button" className="icon-button" aria-label={tradingText(locale, "deleteBot")} title={tradingText(locale, "deleteBot")} onClick={() => void deleteBot(bot.id).then(onDeleted)}><Trash2 size={15} aria-hidden="true" /></button>
          </div>
        )}
      </header>

      <section className="trade-cards" aria-label={tradingText(locale, "runtimeSummary")}>
        <MetricCard label={tradingText(locale, "balance")} value={live?.account ? live.account.balance.toFixed(2) : "—"} />
        <MetricCard label={tradingText(locale, "equity")} value={live?.account ? live.account.equity.toFixed(2) : "—"} />
        <MetricCard label={tradingText(locale, "price")} value={live?.price ? live.price.toFixed(4) : "—"} />
        <MetricCard label={tradingText(locale, "position")} value={position ? `${tradingTerm(locale, position.side)} ${position.qty.toFixed(4)}` : tradingText(locale, "flat")} tone={position ? position.side === "long" ? "up" : "down" : undefined} sub={position ? `@ ${position.entryPrice.toFixed(4)}` : undefined} />
        <MetricCard label={tradingText(locale, "unrealizedPnl")} value={unrealizedPnl.toFixed(2)} tone={unrealizedPnl >= 0 ? "up" : "down"} />
      </section>

      {bot.exchange !== "paper" && (
        <section className="trade-cards trade-risk-cards" aria-label={tradingText(locale, "liveRiskLimits")}>
          <MetricCard label={tradingText(locale, "maxPositionQuote")} value={formatLimit(bot.maxPositionQuote, locale)} />
          <MetricCard label={tradingText(locale, "maxOrderQuote")} value={formatLimit(bot.maxOrderQuote, locale)} />
          <MetricCard label={tradingText(locale, "maxDailyLossQuote")} value={formatLimit(bot.maxDailyLossQuote, locale)} />
          <MetricCard label={tradingText(locale, "maxOpenOrders")} value={bot.maxOpenOrders?.toString() ?? tradingText(locale, "notConfigured")} />
          <MetricCard label={tradingText(locale, "maxLeverage")} value={`${bot.leverage}×`} />
        </section>
      )}

      {controlsAvailable && <BotCommandConsole bot={bot} output={commandOutput} onRun={runCommand} locale={locale} storageOwnerId={storageOwnerId} />}
      <BotActivity symbol={bot.symbol} orders={orders} orderJournal={orderJournal} fills={fills} logs={logs} onCommand={runCommand} locale={locale} canControl={controlsAvailable} />
    </div>
  );
}

function formatLimit(value: number | undefined, locale: Locale): string {
  return value === undefined ? tradingText(locale, "notConfigured") : `${value.toLocaleString(locale)} USDT`;
}

function MetricCard({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "up" | "down" }) {
  return <div className="trade-card"><span className="metric-label">{label}</span><strong className={`num ${tone ?? ""}`}>{value}</strong>{sub && <span className="metric-sub">{sub}</span>}</div>;
}
