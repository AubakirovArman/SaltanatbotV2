import { Play, Square, Trash2, XOctagon } from "lucide-react";
import { useState } from "react";
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
}

export function BotDetail({ bot, live, orders, orderJournal, fills, logs, onChanged, onDeleted }: BotDetailProps) {
  const [commandOutput, setCommandOutput] = useState<string>();
  const position = live?.position;
  const unrealizedPnl = position && live
    ? position.side === "long" ? position.qty * (live.price - position.entryPrice) : position.qty * (position.entryPrice - live.price)
    : 0;

  const toggle = async () => {
    try {
      if (bot.status === "running") {
        await stopBot(bot.id);
      } else if (bot.exchange !== "paper") {
        if (!window.confirm(`Start LIVE trading on ${bot.exchange} with REAL funds?`)) return;
        const result = await startBot(bot.id, true);
        if (!result.ok && result.error) setCommandOutput(result.error);
      } else {
        const result = await startBot(bot.id);
        if (!result.ok && result.error) setCommandOutput(result.error);
      }
    } catch (error) {
      setCommandOutput(error instanceof Error ? error.message : "Failed to start");
    }
    onChanged();
  };

  const runCommand = async (input: string, dryRun = false) => {
    if (!input.trim()) return;
    try {
      const result = await sendCommand(bot.id, input, dryRun);
      setCommandOutput(result.message);
    } catch (error) {
      setCommandOutput(error instanceof Error ? error.message : "Command failed");
    }
  };

  return (
    <div className="trade-detail">
      <header className="trade-detail-head">
        <div>
          <strong>{bot.name}</strong>
          <span>{bot.exchange} · {bot.market} · {bot.symbol} · {bot.timeframe} · {bot.strategyName}</span>
          {live?.runtimeStatus === "requires_manual_action" && <span className="trade-runtime-badge" title={live.pauseReason ?? "Operator confirmation required"}>Requires action</span>}
        </div>
        <div className="trade-detail-actions">
          <button type="button" className={bot.status === "running" ? "danger" : "run-button"} onClick={() => void toggle()}>
            {bot.status === "running" ? <><Square size={13} aria-hidden="true" /> Stop</> : <><Play size={13} aria-hidden="true" /> Start</>}
          </button>
          <button type="button" className="icon-button" title="Flatten (close position)" onClick={() => void runCommand(`exit=${bot.symbol}`)} disabled={bot.status !== "running"}><XOctagon size={15} aria-hidden="true" /></button>
          <button type="button" className="icon-button" title="Delete bot" onClick={() => void deleteBot(bot.id).then(onDeleted)}><Trash2 size={15} aria-hidden="true" /></button>
        </div>
      </header>

      <section className="trade-cards" aria-label="Bot runtime summary">
        <MetricCard label="Balance" value={live?.account ? live.account.balance.toFixed(2) : "—"} />
        <MetricCard label="Equity" value={live?.account ? live.account.equity.toFixed(2) : "—"} />
        <MetricCard label="Price" value={live?.price ? live.price.toFixed(4) : "—"} />
        <MetricCard label="Position" value={position ? `${position.side} ${position.qty.toFixed(4)}` : "flat"} tone={position ? position.side === "long" ? "up" : "down" : undefined} sub={position ? `@ ${position.entryPrice.toFixed(4)}` : undefined} />
        <MetricCard label="Unreal. PnL" value={unrealizedPnl.toFixed(2)} tone={unrealizedPnl >= 0 ? "up" : "down"} />
      </section>

      <BotCommandConsole bot={bot} output={commandOutput} onRun={runCommand} />
      <BotActivity symbol={bot.symbol} orders={orders} orderJournal={orderJournal} fills={fills} logs={logs} onCommand={runCommand} />
    </div>
  );
}

function MetricCard({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "up" | "down" }) {
  return <div className="trade-card"><span className="metric-label">{label}</span><strong className={`num ${tone ?? ""}`}>{value}</strong>{sub && <span className="metric-sub">{sub}</span>}</div>;
}
