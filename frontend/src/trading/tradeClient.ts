import type { StrategyIR } from "../strategy/ir";
import type { Timeframe } from "../types";
import { getCsrfToken as getAccountCsrfToken } from "../auth/client";
import { accountTelemetrySearch, parseAccountTelemetrySnapshot, type AccountTelemetryQuery, type AccountTelemetrySnapshot } from "./accountTelemetry";

export type ExchangeId = "paper" | "binance" | "bybit";
export type MarketType = "spot" | "futures";
export type BotStatus = "stopped" | "running" | "error";

export interface TradingBot {
  id: string;
  /** Durable account binding; legacy live bots resolve to the venue default. */
  accountId?: string;
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
  maxPositionQuote?: number;
  maxOrderQuote?: number;
  maxDailyLossQuote?: number;
  maxOpenOrders?: number;
  bybitCrossCollateral?: boolean;
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
  feeAsset?: string;
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
  accountedFilledQty?: number;
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

export interface EmergencyStepResult<T> {
  state: "not_requested" | "confirmed" | "failed";
  attempted: boolean;
  initial: T[];
  remaining: T[];
  errors: string[];
}

export interface EmergencyAccountResult {
  account: string;
  exchange: ExchangeId;
  market: MarketType;
  symbols: string[];
  cancelOrders: EmergencyStepResult<{ id: string; symbol: string }>;
  flattenPositions: EmergencyStepResult<{ symbol: string; side: "long" | "short"; qty: number }>;
  ok: boolean;
}

export interface EmergencyStopStatus {
  operationId?: string;
  phase: "idle" | "stopping" | "terminal" | "partial_failure";
  ok: boolean;
  flattenRequested: boolean;
  startedAt?: number;
  completedAt?: number;
  botsStopped: number;
  accounts: EmergencyAccountResult[];
  errors: string[];
}

export interface NotifyStatus {
  telegram: { enabled: boolean; chatId: string; hasToken: boolean };
  vk: { enabled: boolean; peerId: string; hasToken: boolean };
}

export interface BybitUtaAsset {
  coin: string;
  equity: number;
  usdValue: number;
  walletBalance: number;
  borrowAmount: number;
  spotBorrow: number;
  derivativesBorrow: number;
  accruedInterest: number;
  unrealisedPnl: number;
  marginCollateral: boolean;
  collateralEnabled: boolean;
  collateralRestriction: "unknown" | "none" | "near_limit" | "restricted";
  hourlyBorrowRate: number;
  maxBorrowingAmount: number;
  availableToBorrow: number;
  borrowUsageRate: number;
  borrowable: boolean;
}

export interface BybitUtaSnapshot {
  updatedAt: number;
  account: {
    unifiedMarginStatus: number;
    marginMode: "ISOLATED_MARGIN" | "REGULAR_MARGIN" | "PORTFOLIO_MARGIN" | "UNKNOWN";
    totalEquity: number;
    totalWalletBalance: number;
    totalMarginBalance: number;
    totalAvailableBalance: number;
    totalPerpUpl: number;
    totalInitialMargin: number;
    totalMaintenanceMargin: number;
    accountImRate: number;
    accountMmRate: number;
  };
  assets: BybitUtaAsset[];
  borrowHistory: Array<{ coin: string; createdAt: number; borrowAmount: number; interestBearingAmount: number; hourlyBorrowRate: number; borrowCost: number; freeBorrowedAmount: number }>;
  risk: { level: "safe" | "warning" | "critical"; entryAllowed: boolean; reasons: string[]; maxBorrowUsageRate: number };
  limits: { maxBorrowUsageRate: number; maxAccountMmRate: number };
}

export interface BybitUtaActionResult {
  ok: true;
  status: "processing" | "success";
  snapshot: BybitUtaSnapshot;
}

export interface ArbitrageAlertRule {
  id: string;
  symbol?: string;
  spotExchange?: "binance" | "bybit";
  futuresExchange?: "binance" | "bybit";
  minimumNetEdgeBps: number;
  minimumCapacityUsd: number;
  estimatedNonFundingCostBps: number;
  holdingHours: number;
  cooldownSeconds: number;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  lastTriggeredAt?: number;
  lastDelivery?: ArbitrageAlertDeliverySummary;
}

export type ArbitrageAlertDeliveryStatus = "queued" | "sending" | "retrying" | "delivered" | "failed" | "cancelled";

export interface ArbitrageAlertDeliverySummary {
  id: string;
  opportunityId: string;
  status: ArbitrageAlertDeliveryStatus;
  attempts: number;
  queuedAt: number;
  nextAttemptAt?: number;
  deliveredAt?: number;
  lastError?: string;
}

export interface ArbitrageAlertDelivery extends ArbitrageAlertDeliverySummary {
  ruleId: string;
  symbol: string;
  maxAttempts: number;
  lastAttemptAt?: number;
  leaseUntil?: number;
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
  const csrfToken = getAccountCsrfToken() ?? getLegacyCsrfToken();
  const res = await fetch(BASE + path, {
    ...init,
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(csrfToken ? { "X-CSRF-Token": csrfToken } : {}),
      ...(init?.headers ?? {})
    }
  });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

/** Internal authenticated transport for modular trading panels. */
export const tradeApiRequest = <T>(path: string, init?: RequestInit) => req<T>(path, init);

export interface AuthState {
  ok: boolean;
  demo: boolean;
  liveTradingEnabled: boolean;
  secureTradingOrigin?: boolean;
  role?: "read-only" | "paper-trade" | "live-trade" | "admin";
  csrfToken?: string;
}

/** Verify the current trading permission; token login is a legacy/demo-only path. */
export async function checkAuth(token?: string, allowLegacyToken = true): Promise<AuthState> {
  if (token?.trim()) return createSession(token.trim());
  const legacy = allowLegacyToken ? getStoredBearerToken() : "";
  if (legacy) return createSession(legacy);
  const res = await fetch(`${BASE}/auth`, { credentials: "same-origin" });
  if (res.status === 401) throw new AuthError();
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const state = (await res.json()) as AuthState;
  if (state.csrfToken) setSession(state.csrfToken);
  return state;
}

export const getSettings = () => req<AuthState>("/settings");
export const setLiveTrading = (liveTradingEnabled: boolean) => req<{ liveTradingEnabled: boolean }>("/settings", { method: "POST", body: JSON.stringify({ liveTradingEnabled }) });
export const getEmergencyStop = () => req<EmergencyStopStatus>("/kill");
export function createEmergencyOperationId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export const killAll = (input: { operationId: string; flatten: boolean }) =>
  req<EmergencyStopStatus>("/kill", {
    method: "POST",
    body: JSON.stringify({ ...input, confirmFlatten: input.flatten ? "FLATTEN_ALL_LIVE_POSITIONS" : undefined })
  });

export const listBots = () => req<{ bots: TradingBot[] }>("/bots").then((r) => r.bots);
export const saveBot = (bot: Partial<TradingBot>) => req<{ bot: TradingBot }>("/bots", { method: "POST", body: JSON.stringify(bot) }).then((r) => r.bot);
export const deleteBot = (id: string) => req(`/bots/${id}`, { method: "DELETE" });
export const startBot = (id: string, confirmLive = false) => req<{ ok: boolean; error?: string }>(`/bots/${id}/start`, { method: "POST", body: JSON.stringify({ confirmLive }) });
export const stopBot = (id: string) => req(`/bots/${id}/stop`, { method: "POST" });
export const sendCommand = (id: string, command: string, dryRun = false) => req<{ ok: boolean; message: string }>(`/bots/${id}/command`, { method: "POST", body: JSON.stringify({ command, dryRun }) });
export const getFills = (id: string) => req<{ fills: Fill[] }>(`/bots/${id}/fills`).then((r) => r.fills);
export const getLogs = (id: string) => req<{ logs: LogRow[] }>(`/bots/${id}/logs`).then((r) => r.logs);
export const getLive = (id: string) => req<LiveState>(`/bots/${id}/live`);
export const getOrders = (id: string) => req<{ orders: PendingOrder[] }>(`/bots/${id}/orders`).then((r) => r.orders);
export const getOrderJournal = (id: string) => req<{ orders: OrderJournal[] }>(`/bots/${id}/order-journal`).then((r) => r.orders);
export const getOrderEvents = (id: string, orderId: string) => req<{ events: OrderEvent[] }>(`/bots/${id}/order-journal/${encodeURIComponent(orderId)}/events`).then((r) => r.events);
/** Deliver a triggered price alert through the server notification channel (Telegram). */
export const notifyAlert = (payload: { symbol: string; price: number; direction: "above" | "below"; hitPrice?: number }) => req<{ ok: boolean }>("/notify-alert", { method: "POST", body: JSON.stringify(payload) });
export const notifyArbitrageAlert = (payload: { symbol: string; spotExchange: "binance" | "bybit"; futuresExchange: "binance" | "bybit"; netEdgeBps: number; minimumNetEdgeBps: number }) => req<{ ok: boolean }>("/notify-arbitrage", { method: "POST", body: JSON.stringify(payload) });
export const getArbitrageAlertState = () => req<{ rules: ArbitrageAlertRule[]; deliveries?: ArbitrageAlertDelivery[] }>("/arbitrage-alerts").then((value) => ({ rules: value.rules, deliveries: value.deliveries ?? [] }));
export const listArbitrageAlertRules = () => getArbitrageAlertState().then((value) => value.rules);
export const listArbitrageAlertDeliveries = (limit = 100) => req<{ deliveries: ArbitrageAlertDelivery[] }>(`/arbitrage-alerts/deliveries?limit=${encodeURIComponent(String(limit))}`).then((value) => value.deliveries);
export const saveArbitrageAlertRule = (rule: Omit<ArbitrageAlertRule, "id" | "createdAt" | "updatedAt" | "lastTriggeredAt"> & { id?: string }) => req<{ rule: ArbitrageAlertRule }>("/arbitrage-alerts", { method: "POST", body: JSON.stringify(rule) }).then((value) => value.rule);
export const deleteArbitrageAlertRule = (id: string) => req<{ rules: ArbitrageAlertRule[] }>(`/arbitrage-alerts/${encodeURIComponent(id)}`, { method: "DELETE" }).then((value) => value.rules);
export const getAccountTelemetry = (query: AccountTelemetryQuery): Promise<AccountTelemetrySnapshot> => req<unknown>(`/account-telemetry?${accountTelemetrySearch(query)}`).then(parseAccountTelemetrySnapshot);
export const getBybitUta = () => req<{ configured: boolean; snapshot?: BybitUtaSnapshot }>("/bybit/uta");
export const borrowBybitUta = (coin: string, amount: number) => req<BybitUtaActionResult>("/bybit/uta/borrow", { method: "POST", body: JSON.stringify({ coin, amount, confirm: true }) });
export const repayBybitUta = (input: { coin: string; amount?: number; repaymentType: "ALL" | "FIXED" | "FLEXIBLE"; convertCollateral: boolean; confirmConversion?: boolean }) => req<BybitUtaActionResult>("/bybit/uta/repay", { method: "POST", body: JSON.stringify({ ...input, confirm: true }) });
export const setBybitCollateral = (coin: string, enabled: boolean) => req<BybitUtaActionResult>("/bybit/uta/collateral", { method: "POST", body: JSON.stringify({ coin, enabled, confirm: true }) });
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

function getLegacyCsrfToken(): string {
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
