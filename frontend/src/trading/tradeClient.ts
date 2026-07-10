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

export interface LiveState {
  account?: Account;
  position?: Position | null;
  price: number;
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

export class AuthError extends Error {
  constructor(message = "Unauthorized") {
    super(message);
    this.name = "AuthError";
  }
}

export function getToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setToken(token: string) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // ignore storage failures
  }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const res = await fetch(BASE + path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
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
}

/** Verify a token (defaults to the stored one) against the backend. */
export async function checkAuth(token?: string): Promise<AuthState> {
  const use = token ?? getToken();
  const res = await fetch(`${BASE}/auth`, {
    headers: use ? { Authorization: `Bearer ${use}` } : {}
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<AuthState>;
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
/** Deliver a triggered price alert through the server notification channel (Telegram). */
export const notifyAlert = (payload: { symbol: string; price: number; direction: "above" | "below"; hitPrice?: number }) =>
  req<{ ok: boolean }>("/notify-alert", { method: "POST", body: JSON.stringify(payload) });
export const getKeys = () => req<{ binance: boolean; bybit: boolean }>("/keys");
export const saveKeys = (exchange: ExchangeId, apiKey: string, apiSecret: string) =>
  req("/keys", { method: "POST", body: JSON.stringify({ exchange, apiKey, apiSecret }) });
export const getNotify = () => req<NotifyStatus>("/notify");
export const saveNotify = (config: unknown) => req("/notify", { method: "POST", body: JSON.stringify(config) });
export const testNotify = () => req<{ ok: boolean; message: string }>("/notify/test", { method: "POST" });

export function createTradeSocket(): WebSocket {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const token = getToken();
  const query = token ? `?token=${encodeURIComponent(token)}` : "";
  return new WebSocket(`${protocol}://${window.location.host}/trade-stream${query}`);
}
