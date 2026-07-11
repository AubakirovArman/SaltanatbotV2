import { BookOpen, Bookmark, Pencil, Play, Plus, Save, Send, Square, Terminal, Trash2, XOctagon } from "lucide-react";
import { useEffect, useState } from "react";
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
import { COMMAND_REFERENCE } from "../commandReference";
import { loadSavedCommands, newCommandId, persistSavedCommands, type SavedCommand } from "../savedCommands";

export function BotDetail({
  bot,
  live,
  orders,
  orderJournal,
  fills,
  logs,
  onChanged,
  onDeleted
}: {
  bot: TradingBot;
  live?: LiveState;
  orders: PendingOrder[];
  orderJournal: OrderJournal[];
  fills: Fill[];
  logs: LogRow[];
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const [command, setCommand] = useState("");
  const [cmdOut, setCmdOut] = useState<string>();
  const [showRef, setShowRef] = useState(false);
  const [showSaved, setShowSaved] = useState(false);
  const [saved, setSaved] = useState<SavedCommand[]>([]);
  const [editor, setEditor] = useState<{ id?: string; name: string; command: string } | null>(null);
  const position = live?.position;

  useEffect(() => setSaved(loadSavedCommands()), []);

  const openEditor = (id: string | undefined, cmd: string, name = "") => {
    setShowSaved(true);
    setEditor({ id, name, command: cmd });
  };
  const saveEditor = () => {
    if (!editor) return;
    const next = editor.id ? saved.map((item) => (item.id === editor.id ? { ...item, name: editor.name.trim(), command: editor.command.trim() } : item)) : [{ id: newCommandId(), name: editor.name.trim(), command: editor.command.trim() }, ...saved];
    setSaved(next);
    persistSavedCommands(next);
    setEditor(null);
  };
  const removeSaved = (id: string) => {
    const next = saved.filter((item) => item.id !== id);
    setSaved(next);
    persistSavedCommands(next);
  };
  const uPnl = position && live ? (position.side === "long" ? position.qty * (live.price - position.entryPrice) : position.qty * (position.entryPrice - live.price)) : 0;

  const toggle = async () => {
    try {
      if (bot.status === "running") {
        await stopBot(bot.id);
      } else if (bot.exchange !== "paper") {
        if (!window.confirm(`Start LIVE trading on ${bot.exchange} with REAL funds?`)) return;
        const res = await startBot(bot.id, true);
        if (!res.ok && res.error) setCmdOut(res.error);
      } else {
        const res = await startBot(bot.id);
        if (!res.ok && res.error) setCmdOut(res.error);
      }
    } catch (error) {
      setCmdOut(error instanceof Error ? error.message : "Failed to start");
    }
    onChanged();
  };

  const runCommand = async (input: string, dryRun = false) => {
    if (!input.trim()) return;
    try {
      const res = await sendCommand(bot.id, input, dryRun);
      setCmdOut(res.message);
      if (input === command && !dryRun) setCommand("");
    } catch (error) {
      setCmdOut(error instanceof Error ? error.message : "Command failed");
    }
  };

  return (
    <div className="trade-detail">
      <div className="trade-detail-head">
        <div>
          <strong>{bot.name}</strong>
          <span>
            {bot.exchange} · {bot.market} · {bot.symbol} · {bot.timeframe} · {bot.strategyName}
          </span>
          {live?.runtimeStatus === "requires_manual_action" && (
            <span className="trade-runtime-badge" title={live.pauseReason ?? "Operator confirmation required"}>
              Requires action
            </span>
          )}
        </div>
        <div className="trade-detail-actions">
          <button type="button" className={bot.status === "running" ? "danger" : "run-button"} onClick={toggle}>
            {bot.status === "running" ? (
              <>
                <Square size={13} aria-hidden="true" /> Stop
              </>
            ) : (
              <>
                <Play size={13} aria-hidden="true" /> Start
              </>
            )}
          </button>
          <button type="button" className="icon-button" title="Flatten (close position)" onClick={() => runCommand(`exit=${bot.symbol}`)} disabled={bot.status !== "running"}>
            <XOctagon size={15} aria-hidden="true" />
          </button>
          <button type="button" className="icon-button" title="Delete bot" onClick={() => deleteBot(bot.id).then(onDeleted)}>
            <Trash2 size={15} aria-hidden="true" />
          </button>
        </div>
      </div>

      <div className="trade-cards">
        <Card label="Balance" value={live?.account ? live.account.balance.toFixed(2) : "—"} />
        <Card label="Equity" value={live?.account ? live.account.equity.toFixed(2) : "—"} />
        <Card label="Price" value={live?.price ? live.price.toFixed(4) : "—"} />
        <Card label="Position" value={position ? `${position.side} ${position.qty.toFixed(4)}` : "flat"} tone={position ? (position.side === "long" ? "up" : "down") : undefined} sub={position ? `@ ${position.entryPrice.toFixed(4)}` : undefined} />
        <Card label="Unreal. PnL" value={uPnl.toFixed(2)} tone={uPnl >= 0 ? "up" : "down"} />
      </div>

      <div className="trade-console">
        <div className="panel-header small">
          <strong>
            <Terminal size={13} aria-hidden="true" /> Command console
          </strong>
          <span className="console-toggles">
            <button
              type="button"
              className={`link-button ${showSaved ? "on" : ""}`}
              onClick={() => {
                setShowSaved((v) => !v);
                setShowRef(false);
              }}
            >
              <Bookmark size={13} aria-hidden="true" /> Saved
            </button>
            <button
              type="button"
              className={`link-button ${showRef ? "on" : ""}`}
              onClick={() => {
                setShowRef((v) => !v);
                setShowSaved(false);
              }}
            >
              <BookOpen size={13} aria-hidden="true" /> Reference
            </button>
          </span>
        </div>
        <div className="trade-console-input">
          <input
            value={command}
            placeholder="action=openposition;side=buy;openpro=25;lev=5"
            onChange={(e) => setCommand(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") runCommand(command);
            }}
            disabled={bot.status !== "running"}
          />
          <button type="button" title="Save command" className="console-save" onClick={() => command.trim() && openEditor(undefined, command)} disabled={!command.trim()}>
            <Save size={14} aria-hidden="true" />
          </button>
          <button type="button" className="console-dry" title="Dry run (preview without executing)" onClick={() => runCommand(command, true)} disabled={bot.status !== "running" || !command.trim()}>
            Dry
          </button>
          <button type="button" onClick={() => runCommand(command)} disabled={bot.status !== "running"}>
            <Send size={14} aria-hidden="true" />
          </button>
        </div>
        {cmdOut && <div className="trade-console-out num">{cmdOut}</div>}

        {editor && (
          <div className="cmd-editor">
            <input className="cmd-editor-name" placeholder="Command name" value={editor.name} onChange={(e) => setEditor({ ...editor, name: e.target.value })} />
            <textarea className="cmd-editor-body" rows={3} placeholder="Antares command (use :: to chain)" value={editor.command} onChange={(e) => setEditor({ ...editor, command: e.target.value })} />
            <div className="cmd-editor-actions">
              <button type="button" className="run-button" onClick={saveEditor} disabled={!editor.name.trim() || !editor.command.trim()}>
                Save
              </button>
              <button type="button" onClick={() => setEditor(null)}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {showSaved && (
          <div className="cmd-reference">
            <div className="cmd-saved-head">
              <span className="cmd-group-title">My commands</span>
              <button type="button" className="link-button" onClick={() => openEditor(undefined, "")}>
                <Plus size={12} aria-hidden="true" /> New
              </button>
            </div>
            {saved.length === 0 && <p className="empty-note">No saved commands. Build one, then press the save icon.</p>}
            {saved.map((item) => (
              <div className="cmd-saved-row" key={item.id}>
                <button type="button" className="cmd-example" title={item.command} onClick={() => setCommand(item.command.replaceAll("{sym}", bot.symbol))}>
                  <strong>{item.name}</strong>
                  <code>{item.command.replaceAll("{sym}", bot.symbol)}</code>
                </button>
                <button type="button" className="icon-button" title="Edit" onClick={() => openEditor(item.id, item.command, item.name)}>
                  <Pencil size={13} aria-hidden="true" />
                </button>
                <button type="button" className="icon-button" title="Delete" onClick={() => removeSaved(item.id)}>
                  <Trash2 size={13} aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>
        )}

        {showRef && (
          <div className="cmd-reference">
            {COMMAND_REFERENCE.map((group) => (
              <div className="cmd-group" key={group.title}>
                <span className="cmd-group-title">{group.title}</span>
                {group.items.map((item) => (
                  <div className="cmd-saved-row" key={item.label}>
                    <button type="button" className="cmd-example" title={item.command} onClick={() => setCommand(item.command.replaceAll("{sym}", bot.symbol))}>
                      <strong>{item.label}</strong>
                      <code>{item.command.replaceAll("{sym}", bot.symbol)}</code>
                    </button>
                    <button type="button" className="icon-button" title="Edit & save a copy" onClick={() => openEditor(undefined, item.command.replaceAll("{sym}", bot.symbol), item.label)}>
                      <Pencil size={13} aria-hidden="true" />
                    </button>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>

      {orders.length > 0 && (
        <div className="trade-orders">
          <div className="panel-header small">
            <strong>Open orders</strong>
            <span>{orders.length}</span>
          </div>
          <div className="trade-order-list">
            {orders.map((order) => (
              <div className="trade-order-row" key={order.id}>
                <span className={`order-type ${order.type.includes("stop") ? "down" : order.type.includes("tp") ? "up" : ""}`}>{order.type.replace("_", " ")}</span>
                <span className={order.side === "buy" ? "up" : "down"}>{order.side}</span>
                <span className="num">{order.qty}</span>
                <span className="num">{order.price ?? order.trgPrice ?? "—"}</span>
                <button type="button" className="order-cancel" title="Cancel order" onClick={() => runCommand(`action=cancelorder;by=id;orderid=${order.id};symbol=${bot.symbol}`)}>
                  ×
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {orderJournal.length > 0 && (
        <div className="trade-orders trade-order-journal">
          <div className="panel-header small">
            <strong>Order journal</strong>
            <span>{orderJournal.length}</span>
          </div>
          <div className="trade-fill-table">
            <div className="trade-journal-row head">
              <span>Time</span>
              <span>Status</span>
              <span>Action</span>
              <span>Side</span>
              <span>Qty</span>
              <span>Reason</span>
            </div>
            {orderJournal.slice(0, 40).map((order) => (
              <div className="trade-journal-row" key={order.id}>
                <span>{new Date(order.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
                <span className={order.status === "accepted" ? "up" : order.status === "rejected" ? "down" : ""}>{order.status}</span>
                <span>{order.action}</span>
                <span className={order.side === "buy" ? "up" : order.side === "sell" ? "down" : ""}>{order.side ?? "flat"}</span>
                <span>{order.qty ?? "-"}</span>
                <span className="reason">{order.reason.replace("signal:", "")}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="trade-journal">
        <div className="panel-header small">
          <strong>Journal</strong>
          <span>{fills.length} fills</span>
        </div>
        <div className="trade-fill-table">
          <div className="trade-fill-row head">
            <span>Time</span>
            <span>Side</span>
            <span>Qty</span>
            <span>Price</span>
            <span>PnL</span>
            <span>Reason</span>
          </div>
          {fills.slice(0, 60).map((fill) => (
            <div className="trade-fill-row" key={fill.id}>
              <span>{new Date(fill.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
              <span className={fill.side === "buy" ? "up" : "down"}>{fill.side}</span>
              <span>{fill.qty}</span>
              <span>{fill.price}</span>
              <span className={fill.realizedPnl >= 0 ? "up" : "down"}>{fill.kind === "open" ? "—" : fill.realizedPnl.toFixed(2)}</span>
              <span className="reason">{fill.reason.replace("signal:", "")}</span>
            </div>
          ))}
          {fills.length === 0 && <p className="empty-note">No fills yet.</p>}
        </div>
        <div className="trade-logs">
          {logs.slice(0, 30).map((log, index) => (
            <div key={index} className={`trade-log ${log.level}`}>
              <time>{new Date(log.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time>
              {log.message}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
function Card({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "up" | "down" }) {
  return (
    <div className="trade-card">
      <span className="metric-label">{label}</span>
      <strong className={`num ${tone ?? ""}`}>{value}</strong>
      {sub && <span className="metric-sub">{sub}</span>}
    </div>
  );
}
