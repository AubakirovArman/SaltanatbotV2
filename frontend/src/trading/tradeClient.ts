import type { StrategyIR } from "../strategy/ir";
import type { Timeframe } from "../types";

export type ExchangeId = "paper" | "binance" | "bybit";
export type MarketType = "spot" | "futures";
export type BotStatus = "stopped" | "running" | "error";

export interface TradingBot {
  id: string;
  name: string;
  strategyName: string;
  ir: StrategyIR;
  symbol: string;
  timeframe: Timeframe;
  exchange: ExchangeId;
  market: MarketType;
  sizeMode: "quote" | "base" | "equity_pct" | "risk_pct";
  sizeValue: number;
  leverage: number;
  notifyMarkers: boolean;
  status: BotStatus;
  createdAt: number;
  updatedAt: number;
}

export interface Fill {
  id: string;
  botId: string;
  symbol: string;
  side: "buy" | "sell";
  qty: number;
  price: number;
  fee: number;
  realizedPnl: number;
  kind: "open" | "close";
  reason: string;
  orderId?: string;
  clientId?: string;
  ts: number;
}

export interface LogRow {
  botId: string;
  level: "info" | "warn" | "error";
  message: string;
  ts: number;
}

export interface Account {
  balance: number;
  equity: number;
  currency: string;
}

export interface Position {
  symbol: string;
  side: "long" | "short";
  qty: number;
  entryPrice: number;
  leverage: number;
  stopPrice?: number;
  targetPrice?: number;
  openedAt: number;
}

export interface PendingOrder {
  id: string;
  clientId?: string;
  symbol: string;
  side: "buy" | "sell";
  type: "market" | "limit" | "stop_market" | "stop_limit" | "tp_market" | "tp_limit";
  qty: number;
  price?: number;
  trgPrice?: number;
  reduceOnly: boolean;
  tif: string;
  createdAt: number;
}

export interface OrderJournal {
  id: string;
  botId: string;
  exchange: ExchangeId;
  market: MarketType;
  symbol: string;
  action: string;
  side?: "buy" | "sell";
  type: string;
  qty?: number;
  reduceOnly?: boolean;
  reason: string;
  clientId?: string;
  exchangeOrderId?: string;
  status: "intent" | "accepted" | "partially_filled" | "filled" | "cancelled" | "replaced" | "expired" | "rejected" | "unknown";
  message?: string;
  filledQty?: number;
  avgFillPrice?: number;
  barTime?: number;
  ts: number;
  updatedAt: number;
}

export interface OrderEvent {
  id: string;
  orderId: string;
  botId: string;
  type: "intent" | "result" | "fill" | "reconcile" | "update";
  data: unknown;
  ts: number;
}

export interface LiveState {
  account?: Account;
  position?: Position | null;
  price: number;
  paused?: boolean;
  runtimeStatus?: "running" | "requires_manual_action";
  pauseReason?: string;
}

export interface TradeEvent {
  type: "bot" | "fill" | "log" | "signal";
  botId: string;
  bot?: TradingBot;
  fill?: Fill;
  log?: { level: string; message: string; ts: number };
  signal?: { dir: "up" | "down"; label: string; price: number; ts: number };
  account?: Account;
  position?: Position | null;
}

export interface NotifyStatus {
  telegram: { enabled: boolean; chatId: string; hasToken: boolean };
  vk: { enabled: boolean; peerId: string; hasToken: boolean };
}

const BASE = "/api/trade";
const TOKEN_KEY = "sbv2:token";
const SESSION_KEY = "sbv2:session";
const CSRF_KEY = "sbv2:csrf";

export class AuthError extends Error {
  constructor(message = "Unauthorized") {
    super(message);
    this.name = "AuthError";
  }
}

export function getToken(): string {
  try {
    if (sessionStorage.getItem(SESSION_KEY)) return "session";
    const sessionToken = sessionStorage.getItem(TOKEN_KEY);
    if (sessionToken) return sessionToken;
    const legacy = localStorage.getItem(TOKEN_KEY) ?? "";
    if (legacy) {
      sessionStorage.setItem(TOKEN_KEY, legacy);
      localStorage.removeItem(TOKEN_KEY);
    }
    return legacy;
  } catch {
    return "";
  }
}

export function setToken(token: string) {
  try {
    sessionStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(TOKEN_KEY);
    if (token) sessionStorage.setItem(SESSION_KEY, "1");
    else {
      sessionStorage.removeItem(SESSION_KEY);
      sessionStorage.removeItem(CSRF_KEY);
    }
  } catch {
    // ignore storage failures
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getStoredBearerToken();
  const csrfToken = getCsrfToken();
  const res = await fetch(BASE + path, {
    ...init,
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
      ...(init?.headers ?? {})
    }
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export interface AuthState {
  ok: boolean;
  demo: boolean;
  liveTradingEnabled: boolean;
  role?: "read-only" | "paper-trade" | "live-trade" | "admin";
  csrfToken?: string;
}

/** Verify a token (defaults to the stored one) against the backend. */
export async function checkAuth(token?: string): Promise<AuthState> {
  if (token?.trim()) return createSession(token.trim());
  const legacy = getStoredBearerToken();
  if (legacy) return createSession(legacy);
  const res = await fetch(`${BASE}/auth`, { credentials: "same-origin" });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const state = (await res.json()) as AuthState;
  if (state.csrfToken) setSession(state.csrfToken);
  return state;
}

export const getSettings = () => req<AuthState>("/settings");
export const setLiveTrading = (liveTradingEnabled: boolean) =>
  req<{ liveTradingEnabled: boolean }>("/settings", { method: "POST", body: JSON.stringify({ liveTradingEnabled }) });
export const killAll = () => req<{ ok: boolean }>("/kill", { method: "POST" });

export const listBots = () => req<{ bots: TradingBot[] }>("/bots").then((r) => r.bots);
export const saveBot = (bot: Partial<TradingBot>) =>
  req<{ bot: TradingBot }>("/bots", { method: "POST", body: JSON.stringify(bot) }).then((r) => r.bot);
export const deleteBot = (id: string) => req(`/bots/${id}`, { method: "DELETE" });
export const startBot = (id: string, confirmLive = false) =>
  req<{ ok: boolean; error?: string }>(`/bots/${id}/start`, { method: "POST", body: JSON.stringify({ confirmLive }) });
export const stopBot = (id: string) => req(`/bots/${id}/stop`, { method: "POST" });
export const sendCommand = (id: string, command: string, dryRun = false) =>
  req<{ ok: boolean; message: string }>(`/bots/${id}/command`, { method: "POST", body: JSON.stringify({ command, dryRun }) });
export const getFills = (id: string) => req<{ fills: Fill[] }>(`/bots/${id}/fills`).then((r) => r.fills);
export const getLogs = (id: string) => req<{ logs: LogRow[] }>(`/bots/${id}/logs`).then((r) => r.logs);
export const getLive = (id: string) => req<LiveState>(`/bots/${id}/live`);
export const getOrders = (id: string) => req<{ orders: PendingOrder[] }>(`/bots/${id}/orders`).then((r) => r.orders);
export const getOrderJournal = (id: string) => req<{ orders: OrderJournal[] }>(`/bots/${id}/order-journal`).then((r) => r.orders);
export const getOrderEvents = (id: string, orderId: string) =>
  req<{ events: OrderEvent[] }>(`/bots/${id}/order-journal/${encodeURIComponent(orderId)}/events`).then((r) => r.events);
/** Deliver a triggered price alert through the server notification channel (Telegram). */
export const notifyAlert = (payload: { symbol: string; price: number; direction: "above" | "below"; hitPrice?: number }) =>
  req<{ ok: boolean }>("/notify-alert", { method: "POST", body: JSON.stringify(payload) });
export const getKeys = () => req<{ binance: boolean; bybit: boolean }>("/keys");
export const saveKeys = (exchange: ExchangeId, apiKey: string, apiSecret: string) =>
  req("/keys", { method: "POST", body: JSON.stringify({ exchange, apiKey, apiSecret }) });
export const getNotify = () => req<NotifyStatus>("/notify");
export const saveNotify = (config: unknown) => req("/notify", { method: "POST", body: JSON.stringify(config) });
export const testNotify = () => req<{ ok: boolean; message: string }>("/notify/test", { method: "POST" });

export async function createTradeSocket(): Promise<WebSocket> {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const ticket = await req<{ ticket: string }>("/ws-ticket", { method: "POST" });
  return new WebSocket(`${protocol}://${window.location.host}/trade-stream`, [`sbv2.ticket.${base64Url(ticket.ticket)}`]);
}

function base64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function createSession(token: string): Promise<AuthState> {
  const res = await fetch(`${BASE}/session`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token })
  });
  if (res.status === 401) {
    setToken("");
    throw new AuthError();
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const state = (await res.json()) as AuthState;
  if (state.csrfToken) setSession(state.csrfToken);
  return state;
}

function setSession(csrfToken: string) {
  try {
    localStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(TOKEN_KEY);
    sessionStorage.setItem(SESSION_KEY, "1");
    sessionStorage.setItem(CSRF_KEY, csrfToken);
  } catch {
    // ignore storage failures
  }
}

function getCsrfToken(): string {
  try {
    return sessionStorage.getItem(CSRF_KEY) ?? "";
  } catch {
    return "";
  }
}

function getStoredBearerToken(): string {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}
