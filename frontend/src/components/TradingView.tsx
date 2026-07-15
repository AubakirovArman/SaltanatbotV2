import { GitFork, LayoutDashboard, Plus, Search, Settings2 } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { MarketOpportunityEnvelope } from "@saltanatbotv2/arbitrage-sdk";
import { MARKET_OPPORTUNITY_HANDOFF_EVENT, consumeMarketOpportunityHandoff, type MarketOpportunityHandoffRecord } from "../arbitrage/marketOpportunityHandoff";
import { useAuth } from "../auth/AuthRoot";
import type { Locale } from "../i18n";
import { automationText } from "../i18n/automation";
import { tradingTerm, tradingText } from "../i18n/trading";
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
import { TradeTokenGate } from "../trading/components/TradeAccess";
import { PortfolioCenter } from "../trading/components/PortfolioCenter";
import { TradingSettings } from "../trading/components/TradingSettings";
import { tradingHealthText } from "../trading/tradingHealthText";
import { localeTag } from "../i18n";
import { loadPaperMultiLegPanel } from "../trading/loadPaperMultiLegPanel";
import { paperMultiLegText } from "../trading/paperMultiLegText";
import { notifyRunningBotsChanged } from "../trading/sessionEvents";
import { OpportunityResearchPanel } from "../trading/components/OpportunityResearchPanel";
import "../styles/trading.css";

const PaperMultiLegPanel = lazy(loadPaperMultiLegPanel);

interface TradingViewProps {
  strategies: StrategyArtifact[];
  catalog?: CatalogResponse;
  locale: Locale;
  portfolioRequest?: number;
}

type CenterView = { kind: "portfolio" } | { kind: "bot"; id: string } | { kind: "new" } | { kind: "settings" } | { kind: "paper-multi-leg" } | { kind: "opportunity" };
type SocketHealth = "connecting" | "connected" | "degraded";

export function TradingView({ strategies, catalog, locale, portfolioRequest = 0 }: TradingViewProps) {
  const accountAuth = useAuth();
  const [bots, setBots] = useState<TradingBot[]>([]);
  const [view, setView] = useState<CenterView>({ kind: "portfolio" });
  const [live, setLive] = useState<Record<string, LiveState>>({});
  const [orders, setOrders] = useState<Record<string, PendingOrder[]>>({});
  const [orderJournal, setOrderJournal] = useState<Record<string, OrderJournal[]>>({});
  const [fills, setFills] = useState<Record<string, Fill[]>>({});
  const [logs, setLogs] = useState<Record<string, LogRow[]>>({});
  const [auth, setAuth] = useState<AuthState | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [socketHealth, setSocketHealth] = useState<SocketHealth>("connecting");
  const [socketError, setSocketError] = useState<string>();
  const [lastRefreshAt, setLastRefreshAt] = useState<number>();
  const [dataError, setDataError] = useState<string>();
  const [clock, setClock] = useState(Date.now());
  const [opportunityHandoff, setOpportunityHandoff] = useState<MarketOpportunityHandoffRecord>();
  const opportunity: MarketOpportunityEnvelope | undefined = opportunityHandoff?.opportunity;
  const liveRef = useRef(live);
  const previousPortfolioRequest = useRef(portfolioRequest);
  liveRef.current = live;

  useEffect(() => {
    if (portfolioRequest === previousPortfolioRequest.current) return;
    previousPortfolioRequest.current = portfolioRequest;
    setView({ kind: "portfolio" });
  }, [portfolioRequest]);

  const refreshBots = useCallback(async () => {
    try {
      setBots(await listBots());
      notifyRunningBotsChanged();
      setLastRefreshAt(Date.now());
      setDataError(undefined);
    } catch (cause) {
      setDataError(cause instanceof Error ? cause.message : "Bot list unavailable");
    }
  }, []);

  // Database sessions use account permissions; token login remains demo-only.
  useEffect(() => {
    if (accountAuth.authRequired && !accountAuth.tradingAvailable) {
      setAuth(null);
      setAuthChecked(true);
      return;
    }
    setAuthChecked(false);
    checkAuth(undefined, !accountAuth.authRequired)
      .then((state) => setAuth(state))
      .catch(() => setAuth(null))
      .finally(() => setAuthChecked(true));
  }, [accountAuth.authRequired, accountAuth.tradingAvailable]);

  const authed = !!auth?.ok;
  const canUsePaperMultiLeg = auth?.role === "paper-trade" || auth?.role === "live-trade" || auth?.role === "admin";

  const acceptOpportunityHandoff = useCallback(() => {
    const record = consumeMarketOpportunityHandoff();
    if (!record) return;
    setOpportunityHandoff(record);
    setView({ kind: "opportunity" });
  }, []);

  useEffect(() => {
    if (!authed) return;
    acceptOpportunityHandoff();
    window.addEventListener(MARKET_OPPORTUNITY_HANDOFF_EVENT, acceptOpportunityHandoff);
    return () => window.removeEventListener(MARKET_OPPORTUNITY_HANDOFF_EVENT, acceptOpportunityHandoff);
  }, [acceptOpportunityHandoff, authed]);

  useEffect(() => {
    if (!authed) return;
    const timer = window.setInterval(() => setClock(Date.now()), 2_000);
    return () => window.clearInterval(timer);
  }, [authed]);

  useEffect(() => {
    if (!authed) return;
    void refreshBots();
    let socket: WebSocket | undefined;
    let closed = false;
    let reconnectTimer: number | undefined;
    let attempts = 0;
    const scheduleReconnect = () => {
      if (closed || reconnectTimer !== undefined) return;
      setSocketHealth("degraded");
      setSocketError(tradingHealthText(locale, "socketClosed"));
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = undefined;
        void connect();
      }, Math.min(10_000, 750 * 2 ** Math.min(attempts, 4)));
    };
    const connect = async () => {
      setSocketHealth("connecting");
      try {
        const next = await createTradeSocket();
        if (closed) {
          next.close();
          return;
        }
        socket = next;
        next.onopen = () => {
          attempts = 0;
          setSocketHealth("connected");
          setSocketError(undefined);
        };
        next.onmessage = (event) => {
          let data: TradeEvent;
          try {
            data = parseTradeEvent(event.data);
          } catch (cause) {
            setSocketHealth("degraded");
            setSocketError(`${tradingHealthText(locale, "invalidEvent")}: ${cause instanceof Error ? cause.message : "unknown error"}`);
            return;
          }
          setLastRefreshAt(Date.now());
          if (data.type === "fill" && data.fill) {
            setFills((current) => ({ ...current, [data.botId]: [data.fill!, ...(current[data.botId] ?? [])].slice(0, 200) }));
          }
          if (data.type === "log" && data.log) {
            setLogs((current) => ({ ...current, [data.botId]: [{ botId: data.botId, ...data.log! } as LogRow, ...(current[data.botId] ?? [])].slice(0, 200) }));
          }
          if (data.type === "bot") {
            void refreshBots();
            if (data.account || data.position !== undefined) {
              setLive((current) => ({ ...current, [data.botId]: { ...current[data.botId], account: data.account ?? current[data.botId]?.account, position: data.position ?? current[data.botId]?.position, price: current[data.botId]?.price ?? 0 } }));
            }
          }
        };
        next.onerror = () => {
          setSocketHealth("degraded");
        };
        next.onclose = () => {
          attempts += 1;
          scheduleReconnect();
        };
      } catch (cause) {
        attempts += 1;
        setSocketError(cause instanceof Error ? cause.message : tradingHealthText(locale, "socketClosed"));
        scheduleReconnect();
      }
    };
    void connect();
    return () => {
      closed = true;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [authed, locale, refreshBots]);

  // Poll the live state of the selected running bot for price / equity / uPnL.
  const selectedId = view.kind === "bot" ? view.id : undefined;
  const selectedBot = bots.find((bot) => bot.id === selectedId);
  useEffect(() => {
    if (!selectedId || selectedBot?.status !== "running") return;
    let alive = true;
    let timer: number | undefined;
    const poll = async () => {
      const results = await Promise.allSettled([getLive(selectedId), getOrders(selectedId), getOrderJournal(selectedId)] as const);
      if (!alive) return;
      const [liveResult, ordersResult, journalResult] = results;
      if (liveResult.status === "fulfilled") {
        const value = liveResult.value;
        setLive((current) => ({ ...current, [selectedId]: value }));
      }
      if (ordersResult.status === "fulfilled") {
        const value = ordersResult.value;
        setOrders((current) => ({ ...current, [selectedId]: value }));
      }
      if (journalResult.status === "fulfilled") {
        const value = journalResult.value;
        setOrderJournal((current) => ({ ...current, [selectedId]: value }));
      }
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failures.length === 0) {
        setLastRefreshAt(Date.now());
        setDataError(undefined);
      } else {
        setDataError(failures.map((failure) => failure.reason instanceof Error ? failure.reason.message : String(failure.reason)).join(" · "));
      }
      timer = window.setTimeout(() => void poll(), 2_000);
    };
    void poll();
    return () => {
      alive = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [selectedId, selectedBot?.status]);

  const openBot = (id: string) => {
    setView({ kind: "bot", id });
    void Promise.allSettled([getFills(id), getLogs(id), getLive(id), getOrders(id), getOrderJournal(id)] as const).then((results) => {
      const [fillsResult, logsResult, liveResult, ordersResult, journalResult] = results;
      if (fillsResult.status === "fulfilled") {
        const value = fillsResult.value;
        setFills((current) => ({ ...current, [id]: value }));
      }
      if (logsResult.status === "fulfilled") {
        const value = logsResult.value;
        setLogs((current) => ({ ...current, [id]: value }));
      }
      if (liveResult.status === "fulfilled") {
        const value = liveResult.value;
        setLive((current) => ({ ...current, [id]: value }));
      }
      if (ordersResult.status === "fulfilled") {
        const value = ordersResult.value;
        setOrders((current) => ({ ...current, [id]: value }));
      }
      if (journalResult.status === "fulfilled") {
        const value = journalResult.value;
        setOrderJournal((current) => ({ ...current, [id]: value }));
      }
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failures.length === 0) {
        setLastRefreshAt(Date.now());
        setDataError(undefined);
      } else {
        setDataError(failures.map((failure) => failure.reason instanceof Error ? failure.reason.message : String(failure.reason)).join(" · "));
      }
    });
  };

  const stale = selectedBot?.status === "running" && (!lastRefreshAt || clock - lastRefreshAt > 7_000);
  const healthError = [socketError, dataError].filter((value, index, values): value is string => !!value && values.indexOf(value) === index).join(" · ") || undefined;

  if (!authChecked) {
    return (
      <section className="trading trade-gate-wrap">
        <p className="empty-note">{tradingText(locale, "checkingAccess")}</p>
      </section>
    );
  }
  if (!authed) {
    if (accountAuth.authRequired) {
      return (
        <section className="trading trade-gate-wrap">
          <div className="trade-gate">
            <h2>{tradingText(locale, "tradingLocked")}</h2>
            <p>{tradingText(locale, "permissionPrompt")}</p>
            <button type="button" className="run-button" onClick={accountAuth.openAccount}>
              {tradingText(locale, "accountAccess")}
            </button>
          </div>
        </section>
      );
    }
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
      <aside className="trade-sidebar" aria-label={automationText(locale, "robotsNavigation")}>
        <div className="trade-sidebar-actions">
          <button type="button" className="run-button" onClick={() => setView({ kind: "new" })}>
            <Plus size={14} aria-hidden="true" /> {tradingText(locale, "newBot")}
          </button>
          <button type="button" className={`icon-button ${view.kind === "settings" ? "active" : ""}`} title={tradingText(locale, "settings")} aria-label={tradingText(locale, "settings")} onClick={() => setView({ kind: "settings" })}>
            <Settings2 size={15} aria-hidden="true" />
          </button>
        </div>
        <nav className="trade-bot-nav" aria-label={automationText(locale, "robotsNavigation")}>
          <ul className="trade-bot-list">
            <li>
              <button type="button" className={`trade-bot-row ${view.kind === "portfolio" ? "active" : ""}`} onClick={() => setView({ kind: "portfolio" })}>
                <LayoutDashboard size={17} aria-hidden="true" />
                <span className="trade-bot-id">
                  <strong>{automationText(locale, "overview")}</strong>
                  <small>{automationText(locale, "running")}: {bots.filter((bot) => bot.status === "running").length}</small>
                </span>
                <span aria-hidden="true">›</span>
              </button>
            </li>
            {canUsePaperMultiLeg && (
              <li>
                <button type="button" className={`trade-bot-row ${view.kind === "paper-multi-leg" ? "active" : ""}`} onClick={() => setView({ kind: "paper-multi-leg" })}>
                  <GitFork size={17} aria-hidden="true" />
                  <span className="trade-bot-id">
                    <strong>{paperMultiLegText(locale, "sidebar")}</strong>
                    <small>{paperMultiLegText(locale, "paperOnly")}</small>
                  </span>
                  <span aria-hidden="true">›</span>
                </button>
              </li>
            )}
            {opportunity && (
              <li>
                <button type="button" className={`trade-bot-row ${view.kind === "opportunity" ? "active" : ""}`} onClick={() => setView({ kind: "opportunity" })}>
                  <Search size={17} aria-hidden="true" />
                  <span className="trade-bot-id">
                    <strong>{opportunity.source.opportunityId}</strong>
                    <small>{opportunity.family} · research</small>
                  </span>
                  <span aria-hidden="true">›</span>
                </button>
              </li>
            )}
            {bots.length === 0 && <li><p className="empty-note">{tradingText(locale, "noBots")}</p></li>}
            {bots.map((bot) => {
              const pos = live[bot.id]?.position;
              return (
                <li key={bot.id}>
                  <button type="button" className={`trade-bot-row ${selectedId === bot.id ? "active" : ""}`} onClick={() => openBot(bot.id)}>
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
                            {pos.side === "long" ? "▲" : "▼"} {tradingTerm(locale, pos.side)}
                          </em>
                        ) : (
                          <em className="live-text">{tradingText(locale, "live")}</em>
                        )
                      ) : (
                        <em className="off-text">{tradingText(locale, "off")}</em>
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>
      </aside>

      <div className="trade-content">
        <div className={`trade-data-health ${stale || healthError ? "degraded" : socketHealth}`} role={stale || healthError ? "alert" : "status"}>
          <strong>{stale ? tradingHealthText(locale, "stale") : healthError ? tradingHealthText(locale, "degraded") : tradingHealthText(locale, socketHealth === "connected" ? "live" : socketHealth === "connecting" ? "connecting" : "degraded")}</strong>
          {healthError && <span>{tradingHealthText(locale, "loadFailed")}: {healthError}</span>}
          {lastRefreshAt && <small>{tradingHealthText(locale, "lastUpdate")}: {new Date(lastRefreshAt).toLocaleTimeString(localeTag(locale))}</small>}
        </div>
        {view.kind === "portfolio" && (
          <PortfolioCenter
            bots={bots}
            locale={locale}
            canReadAccounts={auth?.role === "admin"}
            onNew={() => setView({ kind: "new" })}
            onOpenBot={openBot}
            onOpenSettings={() => setView({ kind: "settings" })}
          />
        )}
        {view.kind === "new" && (
          <CreateBotForm
            strategies={strategies}
            catalog={catalog}
            locale={locale}
            canReadAccounts={auth?.role === "admin"}
            onCreated={(bot) => {
              refreshBots();
              openBot(bot.id);
            }}
          />
        )}
        {view.kind === "settings" && <TradingSettings locale={locale} />}
        {view.kind === "paper-multi-leg" && (
          <Suspense fallback={<p className="empty-note" role="status">{paperMultiLegText(locale, "refreshing")}</p>}>
            <PaperMultiLegPanel locale={locale} />
          </Suspense>
        )}
        {view.kind === "opportunity" && opportunity && opportunityHandoff && (
          <OpportunityResearchPanel
            opportunity={opportunity}
            expiresAt={opportunityHandoff.expiresAt}
            now={clock}
            locale={locale}
            canOpenPaperJournal={canUsePaperMultiLeg}
            onOpenPaperJournal={() => setView({ kind: "paper-multi-leg" })}
            onClear={() => {
              setOpportunityHandoff(undefined);
              setView({ kind: "portfolio" });
            }}
          />
        )}
        {view.kind === "bot" && selectedBot && (
          <BotDetail
            bot={selectedBot}
            live={live[selectedBot.id]}
            orders={orders[selectedBot.id] ?? []}
            orderJournal={orderJournal[selectedBot.id] ?? []}
            fills={fills[selectedBot.id] ?? []}
            logs={logs[selectedBot.id] ?? []}
            locale={locale}
            onChanged={refreshBots}
            onDeleted={() => {
              refreshBots();
              setView({ kind: "portfolio" });
            }}
          />
        )}
      </div>
    </section>
  );
}

export function parseTradeEvent(value: unknown): TradeEvent {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (!parsed || typeof parsed !== "object") throw new Error("event must be an object");
  const event = parsed as Partial<TradeEvent>;
  if ((event.type !== "bot" && event.type !== "fill" && event.type !== "log" && event.type !== "signal") || typeof event.botId !== "string" || !event.botId) throw new Error("event type or botId is invalid");
  return event as TradeEvent;
}
