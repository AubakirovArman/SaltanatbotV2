import { Plus, Settings2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Locale } from "../i18n";
import { tradingText } from "../i18n/trading";
import type { StrategyArtifact } from "../strategy/library";
import type { CatalogResponse } from "../types";
import {
  checkAuth,
  createTradeSocket,
  getFills,
  getLive,
  getLogs,
  getOrders,
  getOrderJournal,
  listBots,
  type AuthState,
  type Fill,
  type LiveState,
  type LogRow,
  type OrderJournal,
  type PendingOrder,
  type TradeEvent,
  type TradingBot
} from "../trading/tradeClient";
import { BotDetail } from "../trading/components/BotDetail";
import { CreateBotForm } from "../trading/components/CreateBotForm";
import { EmptyTradingState, TradeTokenGate } from "../trading/components/TradeAccess";
import { TradingSettings } from "../trading/components/TradingSettings";

interface TradingViewProps {
  strategies: StrategyArtifact[];
  catalog?: CatalogResponse;
  locale: Locale;
}

type CenterView = { kind: "empty" } | { kind: "bot"; id: string } | { kind: "new" } | { kind: "settings" };

export function TradingView({ strategies, catalog, locale }: TradingViewProps) {
  const [bots, setBots] = useState<TradingBot[]>([]);
  const [view, setView] = useState<CenterView>({ kind: "empty" });
  const [live, setLive] = useState<Record<string, LiveState>>({});
  const [orders, setOrders] = useState<Record<string, PendingOrder[]>>({});
  const [orderJournal, setOrderJournal] = useState<Record<string, OrderJournal[]>>({});
  const [fills, setFills] = useState<Record<string, Fill[]>>({});
  const [logs, setLogs] = useState<Record<string, LogRow[]>>({});
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const liveRef = useRef(live);
  liveRef.current = live;

  const refreshBots = useCallback(() => {
    listBots()
      .then(setBots)
      .catch(() => undefined);
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
    let socket: WebSocket | undefined;
    let closed = false;
    const connect = async () => {
      const next = await createTradeSocket();
      if (closed) {
        next.close();
        return;
      }
      socket = next;
      next.onmessage = (event) => {
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
    };
    void connect().catch(() => undefined);
    return () => {
      closed = true;
      socket?.close();
    };
  }, [authed, refreshBots]);

  // Poll the live state of the selected running bot for price / equity / uPnL.
  const selectedId = view.kind === "bot" ? view.id : undefined;
  const selectedBot = bots.find((bot) => bot.id === selectedId);
  useEffect(() => {
    if (!selectedId || selectedBot?.status !== "running") return;
    let alive = true;
    const poll = () => {
      getLive(selectedId)
        .then((state) => alive && setLive((current) => ({ ...current, [selectedId]: state })))
        .catch(() => undefined);
      getOrders(selectedId)
        .then((rows) => alive && setOrders((current) => ({ ...current, [selectedId]: rows })))
        .catch(() => undefined);
      getOrderJournal(selectedId)
        .then((rows) => alive && setOrderJournal((current) => ({ ...current, [selectedId]: rows })))
        .catch(() => undefined);
    };
    poll();
    const id = window.setInterval(poll, 2000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [selectedId, selectedBot?.status]);

  const openBot = (id: string) => {
    setView({ kind: "bot", id });
    getFills(id)
      .then((rows) => setFills((current) => ({ ...current, [id]: rows })))
      .catch(() => undefined);
    getLogs(id)
      .then((rows) => setLogs((current) => ({ ...current, [id]: rows })))
      .catch(() => undefined);
    getLive(id)
      .then((state) => setLive((current) => ({ ...current, [id]: state })))
      .catch(() => undefined);
    getOrders(id)
      .then((rows) => setOrders((current) => ({ ...current, [id]: rows })))
      .catch(() => undefined);
    getOrderJournal(id)
      .then((rows) => setOrderJournal((current) => ({ ...current, [id]: rows })))
      .catch(() => undefined);
  };

  if (!authChecked) {
    return (
      <section className="trading trade-gate-wrap">
        <p className="empty-note">{tradingText(locale, "checkingAccess")}</p>
      </section>
    );
  }
  if (!authed) {
    return (
      <section className="trading trade-gate-wrap">
        <TradeTokenGate
          locale={locale}
          onAuthed={(state) => {
            setAuth(state);
            setAuthChecked(true);
          }}
        />
      </section>
    );
  }

  return (
    <section className="trading">
      <aside className="trade-sidebar">
        <div className="trade-sidebar-actions">
          {!(bots.length === 0 && view.kind === "empty") && (
            <button type="button" className="run-button" onClick={() => setView({ kind: "new" })}>
              <Plus size={14} aria-hidden="true" /> {tradingText(locale, "newBot")}
            </button>
          )}
          <button type="button" className={`icon-button ${view.kind === "settings" ? "active" : ""}`} title={tradingText(locale, "settings")} aria-label={tradingText(locale, "settings")} onClick={() => setView({ kind: "settings" })}>
            <Settings2 size={15} aria-hidden="true" />
          </button>
        </div>
        <div className="trade-bot-list">
          {bots.length === 0 && <p className="empty-note">{tradingText(locale, "noBots")}</p>}
          {bots.map((bot) => {
            const pos = live[bot.id]?.position;
            return (
              <button type="button" key={bot.id} className={`trade-bot-row ${selectedId === bot.id ? "active" : ""}`} onClick={() => openBot(bot.id)}>
                <span className={`status-dot ${bot.status}`}>
                  <i />
                </span>
                <span className="trade-bot-id">
                  <strong>{bot.name}</strong>
                  <small>
                    <span className={`ex-badge ${bot.exchange}`}>{bot.exchange}</span> {bot.symbol} · {bot.timeframe}
                  </small>
                </span>
                <span className="trade-bot-meta">
                  {bot.status === "running" ? (
                    pos ? (
                      <em className={pos.side === "long" ? "up" : "down"}>
                        {pos.side === "long" ? "▲" : "▼"} {pos.side}
                      </em>
                    ) : (
                      <em className="live-text">live</em>
                    )
                  ) : (
                    <em className="off-text">off</em>
                  )}
                </span>
              </button>
            );
          })}
        </div>
      </aside>

      <div className="trade-content">
        {view.kind === "empty" && <EmptyTradingState locale={locale} onNew={() => setView({ kind: "new" })} />}
        {view.kind === "new" && (
          <CreateBotForm
            strategies={strategies}
            catalog={catalog}
            locale={locale}
            onCreated={(bot) => {
              refreshBots();
              openBot(bot.id);
            }}
          />
        )}
        {view.kind === "settings" && <TradingSettings />}
        {view.kind === "bot" && selectedBot && (
          <BotDetail
            bot={selectedBot}
            live={live[selectedBot.id]}
            orders={orders[selectedBot.id] ?? []}
            orderJournal={orderJournal[selectedBot.id] ?? []}
            fills={fills[selectedBot.id] ?? []}
            logs={logs[selectedBot.id] ?? []}
            onChanged={refreshBots}
            onDeleted={() => {
              refreshBots();
              setView({ kind: "empty" });
            }}
          />
        )}
      </div>
    </section>
  );
}
