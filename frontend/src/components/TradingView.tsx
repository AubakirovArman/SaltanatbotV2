import {
  AlertTriangle,
  BookOpen,
  Bookmark,
  Bot,
  KeyRound,
  Pencil,
  Play,
  Plus,
  Save,
  Send,
  Settings2,
  Square,
  Terminal,
  Trash2,
  XOctagon
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { compileXmlToIr } from "../strategy/compileArtifact";
import type { StrategyArtifact } from "../strategy/library";
import type { CatalogResponse } from "../types";
import {
  checkAuth,
  createTradeSocket,
  deleteBot,
  getFills,
  getKeys,
  getLive,
  getLogs,
  getNotify,
  getOrders,
  getSettings,
  killAll,
  listBots,
  saveBot,
  saveKeys,
  saveNotify,
  sendCommand,
  setLiveTrading,
  setToken,
  startBot,
  stopBot,
  testNotify,
  type AuthState,
  type ExchangeId,
  type Fill,
  type LiveState,
  type LogRow,
  type NotifyStatus,
  type PendingOrder,
  type TradeEvent,
  type TradingBot
} from "../trading/tradeClient";
import { COMMAND_REFERENCE } from "../trading/commandReference";
import { loadSavedCommands, newCommandId, persistSavedCommands, type SavedCommand } from "../trading/savedCommands";

interface TradingViewProps {
  strategies: StrategyArtifact[];
  catalog?: CatalogResponse;
}

type CenterView = { kind: "empty" } | { kind: "bot"; id: string } | { kind: "new" } | { kind: "settings" };

export function TradingView({ strategies, catalog }: TradingViewProps) {
  const [bots, setBots] = useState<TradingBot[]>([]);
  const [view, setView] = useState<CenterView>({ kind: "empty" });
  const [live, setLive] = useState<Record<string, LiveState>>({});
  const [orders, setOrders] = useState<Record<string, PendingOrder[]>>({});
  const [fills, setFills] = useState<Record<string, Fill[]>>({});
  const [logs, setLogs] = useState<Record<string, LogRow[]>>({});
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const liveRef = useRef(live);
  liveRef.current = live;

  const refreshBots = useCallback(() => {
    listBots().then(setBots).catch(() => undefined);
  }, []);

  // Verify the stored access token before showing the trading surface.
  useEffect(() => {
    checkAuth()
      .then((state) => setAuth(state))
      .catch(() => setAuth(null))
      .finally(() => setAuthChecked(true));
  }, []);

  const authed = !!auth?.ok;

  useEffect(() => {
    if (!authed) return;
    refreshBots();
    const socket = createTradeSocket();
    socket.onmessage = (event) => {
      const data = JSON.parse(event.data) as TradeEvent;
      if (data.type === "fill" && data.fill) {
        setFills((current) => ({ ...current, [data.botId]: [data.fill!, ...(current[data.botId] ?? [])].slice(0, 200) }));
      }
      if (data.type === "log" && data.log) {
        setLogs((current) => ({ ...current, [data.botId]: [{ botId: data.botId, ...data.log! } as LogRow, ...(current[data.botId] ?? [])].slice(0, 200) }));
      }
      if (data.type === "bot") {
        refreshBots();
        if (data.account || data.position !== undefined) {
          setLive((current) => ({ ...current, [data.botId]: { ...current[data.botId], account: data.account ?? current[data.botId]?.account, position: data.position ?? current[data.botId]?.position, price: current[data.botId]?.price ?? 0 } }));
        }
      }
    };
    return () => socket.close();
  }, [authed, refreshBots]);

  // Poll the live state of the selected running bot for price / equity / uPnL.
  const selectedId = view.kind === "bot" ? view.id : undefined;
  const selectedBot = bots.find((bot) => bot.id === selectedId);
  useEffect(() => {
    if (!selectedId || selectedBot?.status !== "running") return;
    let alive = true;
    const poll = () => {
      getLive(selectedId).then((state) => alive && setLive((current) => ({ ...current, [selectedId]: state }))).catch(() => undefined);
      getOrders(selectedId).then((rows) => alive && setOrders((current) => ({ ...current, [selectedId]: rows }))).catch(() => undefined);
    };
    poll();
    const id = window.setInterval(poll, 2000);
    return () => { alive = false; window.clearInterval(id); };
  }, [selectedId, selectedBot?.status]);

  const openBot = (id: string) => {
    setView({ kind: "bot", id });
    getFills(id).then((rows) => setFills((current) => ({ ...current, [id]: rows }))).catch(() => undefined);
    getLogs(id).then((rows) => setLogs((current) => ({ ...current, [id]: rows }))).catch(() => undefined);
    getLive(id).then((state) => setLive((current) => ({ ...current, [id]: state }))).catch(() => undefined);
    getOrders(id).then((rows) => setOrders((current) => ({ ...current, [id]: rows }))).catch(() => undefined);
  };

  if (!authChecked) {
    return <section className="trading trade-gate-wrap"><p className="empty-note">Checking access…</p></section>;
  }
  if (!authed) {
    return (
      <section className="trading trade-gate-wrap">
        <TokenGate onAuthed={(state) => { setAuth(state); setAuthChecked(true); }} />
      </section>
    );
  }

  return (
    <section className="trading">
      <aside className="trade-sidebar">
        <div className="trade-sidebar-actions">
          <button type="button" className="run-button" onClick={() => setView({ kind: "new" })}>
            <Plus size={14} aria-hidden="true" /> New bot
          </button>
          <button type="button" className={`icon-button ${view.kind === "settings" ? "active" : ""}`} title="Settings" onClick={() => setView({ kind: "settings" })}>
            <Settings2 size={15} aria-hidden="true" />
          </button>
        </div>
        <div className="trade-bot-list">
          {bots.length === 0 && <p className="empty-note">No bots yet. Create one from a saved strategy.</p>}
          {bots.map((bot) => {
            const pos = live[bot.id]?.position;
            return (
              <button type="button" key={bot.id} className={`trade-bot-row ${selectedId === bot.id ? "active" : ""}`} onClick={() => openBot(bot.id)}>
                <span className={`status-dot ${bot.status}`}><i /></span>
                <span className="trade-bot-id">
                  <strong>{bot.name}</strong>
                  <small><span className={`ex-badge ${bot.exchange}`}>{bot.exchange}</span> {bot.symbol} · {bot.timeframe}</small>
                </span>
                <span className="trade-bot-meta">
                  {bot.status === "running"
                    ? (pos ? <em className={pos.side === "long" ? "up" : "down"}>{pos.side === "long" ? "▲" : "▼"} {pos.side}</em> : <em className="live-text">live</em>)
                    : <em className="off-text">off</em>}
                </span>
              </button>
            );
          })}
        </div>
      </aside>

      <div className="trade-content">
        {view.kind === "empty" && <EmptyCenter onNew={() => setView({ kind: "new" })} />}
        {view.kind === "new" && (
          <CreateBotForm
            strategies={strategies}
            catalog={catalog}
            onCreated={(bot) => { refreshBots(); openBot(bot.id); }}
          />
        )}
        {view.kind === "settings" && <SettingsPanel />}
        {view.kind === "bot" && selectedBot && (
          <BotDetail
            bot={selectedBot}
            live={live[selectedBot.id]}
            orders={orders[selectedBot.id] ?? []}
            fills={fills[selectedBot.id] ?? []}
            logs={logs[selectedBot.id] ?? []}
            onChanged={refreshBots}
            onDeleted={() => { refreshBots(); setView({ kind: "empty" }); }}
          />
        )}
      </div>
    </section>
  );
}

function TokenGate({ onAuthed }: { onAuthed: (state: AuthState) => void }) {
  const [token, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async () => {
    if (!token.trim()) return;
    setBusy(true);
    setError(undefined);
    try {
      const state = await checkAuth(token.trim());
      setToken(token.trim());
      onAuthed(state);
    } catch {
      setError("Invalid access token.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="trade-gate">
      <KeyRound size={26} aria-hidden="true" />
      <h2>Trading is locked</h2>
      <p>
        The Trade tab controls real orders, so it needs the access token. Find it in the backend
        console on first run (or set it via the <code>AUTH_TOKEN</code> env var).
      </p>
      <input
        type="password"
        value={token}
        placeholder="Access token"
        autoFocus
        onChange={(event) => setInput(event.target.value)}
        onKeyDown={(event) => event.key === "Enter" && submit()}
      />
      {error && <span className="trade-gate-error">{error}</span>}
      <button type="button" className="run-button" onClick={submit} disabled={busy || !token.trim()}>
        {busy ? "Checking…" : "Unlock"}
      </button>
    </div>
  );
}

function EmptyCenter({ onNew }: { onNew: () => void }) {
  return (
    <div className="trade-empty">
      <Bot size={22} aria-hidden="true" />
      <strong>Live &amp; paper trading</strong>
      <p>Run a saved strategy on paper, Binance or Bybit. Signals become Antares-style commands that open and close positions automatically.</p>
      <button type="button" className="run-button" onClick={onNew}><Plus size={14} aria-hidden="true" /> New bot</button>
    </div>
  );
}

function CreateBotForm({ strategies, catalog, onCreated }: { strategies: StrategyArtifact[]; catalog?: CatalogResponse; onCreated: (bot: TradingBot) => void }) {
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
    if (!strategy) { setError("Pick a strategy"); return; }
    const compiled = compileXmlToIr(strategy.xml);
    if (!compiled.ir || compiled.errors.length) {
      setError(compiled.errors[0] ?? "Strategy has errors");
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
      setError(cause instanceof Error ? cause.message : "Failed to create bot");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="trade-form">
      <div className="trade-form-title">
        <Bot size={16} aria-hidden="true" />
        <strong>New trading bot</strong>
        <span>Run a strategy live or on paper</span>
      </div>

      <fieldset className="form-section">
        <legend>Strategy</legend>
        <label>From strategy
          <select value={strategyId} onChange={(e) => setStrategyId(e.target.value)}>
            {runnable.length === 0 && <option value="">No saved strategies — build one first</option>}
            {runnable.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        <label>Bot name<input value={name} placeholder={strategy?.name ?? "Bot"} onChange={(e) => setName(e.target.value)} /></label>
      </fieldset>

      <fieldset className="form-section">
        <legend>Market</legend>
        <div className="form-grid">
          <label>Symbol
            <select value={symbol} onChange={(e) => setSymbol(e.target.value)}>
              {(catalog?.instruments ?? []).map((item) => <option key={item.symbol} value={item.symbol}>{item.symbol}</option>)}
            </select>
          </label>
          <label>Interval
            <select value={timeframe} onChange={(e) => setTimeframe(e.target.value as TradingBot["timeframe"])}>
              {(catalog?.timeframes ?? []).map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </label>
        </div>
        <p className="field-help">The bot evaluates the strategy on every closed {timeframe} candle — same signals as the backtest.</p>
      </fieldset>

      <fieldset className="form-section">
        <legend>Execution</legend>
        <div className="form-grid">
          <label>Exchange
            <select value={exchange} onChange={(e) => setExchange(e.target.value as ExchangeId)}>
              <option value="paper">Paper (simulated)</option>
              <option value="binance">Binance</option>
              <option value="bybit">Bybit</option>
            </select>
          </label>
          <label>Type
            <select value={market} onChange={(e) => setMarket(e.target.value as "spot" | "futures")}>
              <option value="futures">Futures</option>
              <option value="spot">Spot</option>
            </select>
          </label>
        </div>
        <div className="form-grid">
          <label>Sizing
            <select value={sizeMode} onChange={(e) => setSizeMode(e.target.value as TradingBot["sizeMode"])}>
              <option value="quote">Quote (USDT)</option>
              <option value="base">Base units</option>
              <option value="equity_pct">% equity</option>
              <option value="risk_pct">% risk</option>
            </select>
          </label>
          <label>Amount<input type="number" value={sizeValue} min={0} step={1} onChange={(e) => setSizeValue(Number(e.target.value) || 0)} /></label>
          <label>Leverage<input type="number" value={leverage} min={1} max={125} step={1} onChange={(e) => setLeverage(Number(e.target.value) || 1)} /></label>
        </div>
        <label className="check-row">
          <input type="checkbox" checked={notifyMarkers} onChange={(e) => setNotifyMarkers(e.target.checked)} />
          Send a notification on signal markers
        </label>
      </fieldset>

      {exchange !== "paper" && (
        <div className="trade-warn"><AlertTriangle size={13} aria-hidden="true" /> Real trading uses your saved API keys and real funds. Add keys in Settings and test on paper first.</div>
      )}
      {error && <div className="strategy-warnings"><span><AlertTriangle size={12} aria-hidden="true" /> {error}</span></div>}
      <button type="button" className="run-button form-submit" onClick={create} disabled={busy || !strategy}>{busy ? "Creating…" : "Create bot"}</button>
    </div>
  );
}

function BotDetail({ bot, live, orders, fills, logs, onChanged, onDeleted }: {
  bot: TradingBot;
  live?: LiveState;
  orders: PendingOrder[];
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
    const next = editor.id
      ? saved.map((item) => (item.id === editor.id ? { ...item, name: editor.name.trim(), command: editor.command.trim() } : item))
      : [{ id: newCommandId(), name: editor.name.trim(), command: editor.command.trim() }, ...saved];
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
          <span>{bot.exchange} · {bot.market} · {bot.symbol} · {bot.timeframe} · {bot.strategyName}</span>
        </div>
        <div className="trade-detail-actions">
          <button type="button" className={bot.status === "running" ? "danger" : "run-button"} onClick={toggle}>
            {bot.status === "running" ? <><Square size={13} aria-hidden="true" /> Stop</> : <><Play size={13} aria-hidden="true" /> Start</>}
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
          <strong><Terminal size={13} aria-hidden="true" /> Command console</strong>
          <span className="console-toggles">
            <button type="button" className={`link-button ${showSaved ? "on" : ""}`} onClick={() => { setShowSaved((v) => !v); setShowRef(false); }}>
              <Bookmark size={13} aria-hidden="true" /> Saved
            </button>
            <button type="button" className={`link-button ${showRef ? "on" : ""}`} onClick={() => { setShowRef((v) => !v); setShowSaved(false); }}>
              <BookOpen size={13} aria-hidden="true" /> Reference
            </button>
          </span>
        </div>
        <div className="trade-console-input">
          <input
            value={command}
            placeholder="action=openposition;side=buy;openpro=25;lev=5"
            onChange={(e) => setCommand(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") runCommand(command); }}
            disabled={bot.status !== "running"}
          />
          <button type="button" title="Save command" className="console-save" onClick={() => command.trim() && openEditor(undefined, command)} disabled={!command.trim()}><Save size={14} aria-hidden="true" /></button>
          <button type="button" className="console-dry" title="Dry run (preview without executing)" onClick={() => runCommand(command, true)} disabled={bot.status !== "running" || !command.trim()}>Dry</button>
          <button type="button" onClick={() => runCommand(command)} disabled={bot.status !== "running"}><Send size={14} aria-hidden="true" /></button>
        </div>
        {cmdOut && <div className="trade-console-out num">{cmdOut}</div>}

        {editor && (
          <div className="cmd-editor">
            <input className="cmd-editor-name" placeholder="Command name" value={editor.name} onChange={(e) => setEditor({ ...editor, name: e.target.value })} />
            <textarea className="cmd-editor-body" rows={3} placeholder="Antares command (use :: to chain)" value={editor.command} onChange={(e) => setEditor({ ...editor, command: e.target.value })} />
            <div className="cmd-editor-actions">
              <button type="button" className="run-button" onClick={saveEditor} disabled={!editor.name.trim() || !editor.command.trim()}>Save</button>
              <button type="button" onClick={() => setEditor(null)}>Cancel</button>
            </div>
          </div>
        )}

        {showSaved && (
          <div className="cmd-reference">
            <div className="cmd-saved-head">
              <span className="cmd-group-title">My commands</span>
              <button type="button" className="link-button" onClick={() => openEditor(undefined, "")}><Plus size={12} aria-hidden="true" /> New</button>
            </div>
            {saved.length === 0 && <p className="empty-note">No saved commands. Build one, then press the save icon.</p>}
            {saved.map((item) => (
              <div className="cmd-saved-row" key={item.id}>
                <button type="button" className="cmd-example" title={item.command} onClick={() => setCommand(item.command.replaceAll("{sym}", bot.symbol))}>
                  <strong>{item.name}</strong>
                  <code>{item.command.replaceAll("{sym}", bot.symbol)}</code>
                </button>
                <button type="button" className="icon-button" title="Edit" onClick={() => openEditor(item.id, item.command, item.name)}><Pencil size={13} aria-hidden="true" /></button>
                <button type="button" className="icon-button" title="Delete" onClick={() => removeSaved(item.id)}><Trash2 size={13} aria-hidden="true" /></button>
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
                    <button
                      type="button"
                      className="cmd-example"
                      title={item.command}
                      onClick={() => setCommand(item.command.replaceAll("{sym}", bot.symbol))}
                    >
                      <strong>{item.label}</strong>
                      <code>{item.command.replaceAll("{sym}", bot.symbol)}</code>
                    </button>
                    <button type="button" className="icon-button" title="Edit & save a copy" onClick={() => openEditor(undefined, item.command.replaceAll("{sym}", bot.symbol), item.label)}><Pencil size={13} aria-hidden="true" /></button>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>

      {orders.length > 0 && (
        <div className="trade-orders">
          <div className="panel-header small"><strong>Open orders</strong><span>{orders.length}</span></div>
          <div className="trade-order-list">
            {orders.map((order) => (
              <div className="trade-order-row" key={order.id}>
                <span className={`order-type ${order.type.includes("stop") ? "down" : order.type.includes("tp") ? "up" : ""}`}>{order.type.replace("_", " ")}</span>
                <span className={order.side === "buy" ? "up" : "down"}>{order.side}</span>
                <span className="num">{order.qty}</span>
                <span className="num">{order.price ?? order.trgPrice ?? "—"}</span>
                <button type="button" className="order-cancel" title="Cancel order" onClick={() => runCommand(`action=cancelorder;by=id;orderid=${order.id};symbol=${bot.symbol}`)}>×</button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="trade-journal">
        <div className="panel-header small"><strong>Journal</strong><span>{fills.length} fills</span></div>
        <div className="trade-fill-table">
          <div className="trade-fill-row head"><span>Time</span><span>Side</span><span>Qty</span><span>Price</span><span>PnL</span><span>Reason</span></div>
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

function SettingsPanel() {
  const [keys, setKeys] = useState<{ binance: boolean; bybit: boolean }>({ binance: false, bybit: false });
  const [notifyStatus, setNotifyStatus] = useState<NotifyStatus>();
  const [settings, setSettings] = useState<AuthState>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getKeys().then(setKeys).catch(() => undefined);
    getNotify().then(setNotifyStatus).catch(() => undefined);
    getSettings().then(setSettings).catch(() => undefined);
  }, []);

  const toggleLive = async (next: boolean) => {
    setBusy(true);
    try {
      await setLiveTrading(next);
      setSettings((s) => (s ? { ...s, liveTradingEnabled: next } : s));
    } catch {
      // ignore
    } finally {
      setBusy(false);
    }
  };

  const kill = async () => {
    if (!window.confirm("Stop ALL bots and disarm live trading now?")) return;
    setBusy(true);
    try {
      await killAll();
      setSettings((s) => (s ? { ...s, liveTradingEnabled: false } : s));
    } catch {
      // ignore
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="trade-settings">
      <div className="panel-header"><strong><AlertTriangle size={14} aria-hidden="true" /> Live trading</strong></div>
      {settings?.demo ? (
        <p className="settings-note">Running in demo mode — only paper trading is available.</p>
      ) : (
        <>
          <p className="settings-note">
            Live trading places real orders with your exchange keys. It is disarmed by default; arm it only
            when you intend to trade for real. The kill switch stops every bot and disarms instantly.
          </p>
          <label className="live-arm-row">
            <input
              type="checkbox"
              checked={settings?.liveTradingEnabled ?? false}
              disabled={busy}
              onChange={(event) => toggleLive(event.target.checked)}
            />
            <span>Arm live trading{settings?.liveTradingEnabled ? " — ARMED" : ""}</span>
          </label>
          <button type="button" className="kill-switch" onClick={kill} disabled={busy}>
            <XOctagon size={14} aria-hidden="true" /> Kill switch — stop all bots
          </button>
        </>
      )}

      <div className="panel-header"><strong><KeyRound size={14} aria-hidden="true" /> Exchange API keys</strong></div>
      <p className="settings-note">Keys are stored encrypted on the server (never sent back to the browser). Use read+trade permissions, no withdrawals. IP-whitelist recommended.</p>
      <KeyForm exchange="binance" configured={keys.binance} onSaved={() => getKeys().then(setKeys)} />
      <KeyForm exchange="bybit" configured={keys.bybit} onSaved={() => getKeys().then(setKeys)} />

      <div className="panel-header"><strong>Notifications</strong></div>
      <NotifyForm status={notifyStatus} onSaved={() => getNotify().then(setNotifyStatus)} />
    </div>
  );
}

function KeyForm({ exchange, configured, onSaved }: { exchange: ExchangeId; configured: boolean; onSaved: () => void }) {
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [saved, setSaved] = useState(false);
  const save = async () => {
    await saveKeys(exchange, apiKey, apiSecret);
    setApiKey(""); setApiSecret(""); setSaved(true); onSaved();
    window.setTimeout(() => setSaved(false), 1800);
  };
  return (
    <div className="key-form">
      <div className="key-form-head"><strong>{exchange}</strong>{configured && <span className="badge-ok">configured</span>}{saved && <span className="badge-ok">saved</span>}</div>
      <input placeholder="API key" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
      <input placeholder="API secret" type="password" value={apiSecret} onChange={(e) => setApiSecret(e.target.value)} />
      <button type="button" onClick={save} disabled={!apiKey || !apiSecret}>Save keys</button>
    </div>
  );
}

function NotifyForm({ status, onSaved }: { status?: NotifyStatus; onSaved: () => void }) {
  const [tgEnabled, setTgEnabled] = useState(false);
  const [tgToken, setTgToken] = useState("");
  const [tgChat, setTgChat] = useState("");
  const [testMsg, setTestMsg] = useState<string>();

  useEffect(() => {
    if (status) { setTgEnabled(status.telegram.enabled); setTgChat(status.telegram.chatId); }
  }, [status]);

  const save = async () => {
    await saveNotify({ telegram: { enabled: tgEnabled, token: tgToken || undefined, chatId: tgChat } });
    setTgToken("");
    onSaved();
  };
  const test = async () => {
    const res = await testNotify();
    setTestMsg(res.ok ? "Sent ✓" : res.message);
  };

  return (
    <div className="key-form">
      <label className="check-row"><input type="checkbox" checked={tgEnabled} onChange={(e) => setTgEnabled(e.target.checked)} /> Telegram {status?.telegram.hasToken && <span className="badge-ok">token set</span>}</label>
      <input placeholder="Bot token (from @BotFather)" value={tgToken} onChange={(e) => setTgToken(e.target.value)} />
      <input placeholder="Chat ID" value={tgChat} onChange={(e) => setTgChat(e.target.value)} />
      <div className="key-form-actions">
        <button type="button" onClick={save}>Save</button>
        <button type="button" onClick={test}>Send test</button>
      </div>
      {testMsg && <div className="trade-console-out">{testMsg}</div>}
      <p className="settings-note">VK and other channels can be added the same way. Notifications fire on start/stop, position open/close, errors and signal markers.</p>
    </div>
  );
}
