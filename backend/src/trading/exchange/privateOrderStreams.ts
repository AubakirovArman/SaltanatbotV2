import { createHmac } from "node:crypto";
import WebSocket from "ws";
import type { ExchangeOrderSnapshot, PrivateOrderSubscription } from "../types.js";
import type { ExchangeKeys } from "./binance.js";
import { normalizeBinanceOrderStatus, normalizeBybitOrderStatus } from "./orderStatus.js";

interface StreamCallbacks {
  onSnapshot(snapshot: ExchangeOrderSnapshot): void;
  onConnection(connected: boolean, message: string): void;
}

export interface PrivateStreamDependencies {
  createSocket?: (url: string) => WebSocket;
  fetch?: typeof fetch;
  now?: () => number;
  random?: () => number;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
}

type Dependencies = Required<PrivateStreamDependencies>;

export async function subscribeBinanceOrders(
  keys: ExchangeKeys,
  callbacks: StreamCallbacks,
  dependencies: PrivateStreamDependencies = {}
): Promise<PrivateOrderSubscription> {
  requireKeys("Binance", keys);
  const deps = resolveDependencies(dependencies);
  let listenKey = await createBinanceListenKey(keys, deps);
  let socket: WebSocket | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let keepaliveTimer: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  let online = false;
  let attempts = 0;

  const setOnline = (next: boolean, message: string) => {
    if (online !== next || message) callbacks.onConnection(next, message);
    online = next;
  };
  const scheduleReconnect = () => {
    if (closed || reconnectTimer) return;
    setOnline(false, "Binance private stream disconnected; REST polling fallback active.");
    const delay = reconnectDelay(++attempts, deps.random);
    reconnectTimer = deps.setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, delay);
  };
  const rotateListenKey = async () => {
    try {
      listenKey = await createBinanceListenKey(keys, deps);
      socket?.close();
    } catch (error) {
      callbacks.onConnection(false, `Binance listenKey refresh failed: ${messageOf(error)}; REST polling fallback active.`);
      scheduleReconnect();
    }
  };
  const connect = () => {
    if (closed) return;
    socket = deps.createSocket(`wss://fstream.binance.com/private/ws/${listenKey}`);
    socket.on("open", () => {
      attempts = 0;
      setOnline(true, "Binance private order stream connected; reconciling missed updates.");
    });
    socket.on("message", (raw) => {
      const payload = safeJson(raw.toString());
      if (isRecord(payload) && payload.e === "listenKeyExpired") {
        setOnline(false, "Binance listenKey expired; rotating credentials and using REST polling fallback.");
        void rotateListenKey();
        return;
      }
      const snapshot = parseBinanceOrderUpdate(payload);
      if (snapshot) callbacks.onSnapshot(snapshot);
    });
    socket.on("error", () => {
      scheduleReconnect();
      socket?.close();
    });
    socket.on("close", () => scheduleReconnect());
  };

  keepaliveTimer = deps.setInterval(async () => {
    try {
      const response = await deps.fetch("https://fapi.binance.com/fapi/v1/listenKey", {
        method: "PUT",
        headers: { "X-MBX-APIKEY": keys.apiKey }
      });
      if (!response.ok) await rotateListenKey();
    } catch {
      await rotateListenKey();
    }
  }, 50 * 60_000);
  connect();

  return {
    connected: () => online,
    close: () => {
      closed = true;
      online = false;
      if (reconnectTimer) deps.clearTimeout(reconnectTimer);
      if (keepaliveTimer) deps.clearInterval(keepaliveTimer);
      socket?.close();
      void deps.fetch("https://fapi.binance.com/fapi/v1/listenKey", {
        method: "DELETE",
        headers: { "X-MBX-APIKEY": keys.apiKey }
      }).catch(() => undefined);
    }
  };
}

export async function subscribeBybitOrders(
  keys: ExchangeKeys,
  callbacks: StreamCallbacks,
  dependencies: PrivateStreamDependencies = {}
): Promise<PrivateOrderSubscription> {
  requireKeys("Bybit", keys);
  const deps = resolveDependencies(dependencies);
  let socket: WebSocket | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  let online = false;
  let attempts = 0;

  const setOnline = (next: boolean, message: string) => {
    if (online !== next || message) callbacks.onConnection(next, message);
    online = next;
  };
  const clearHeartbeat = () => {
    if (heartbeatTimer) deps.clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
  };
  const scheduleReconnect = () => {
    clearHeartbeat();
    if (closed || reconnectTimer) return;
    setOnline(false, "Bybit private stream disconnected; REST polling fallback active.");
    const delay = reconnectDelay(++attempts, deps.random);
    reconnectTimer = deps.setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, delay);
  };
  const connect = () => {
    if (closed) return;
    socket = deps.createSocket("wss://stream.bybit.com/v5/private");
    socket.on("open", () => {
      const expires = deps.now() + 10_000;
      const signature = createHmac("sha256", keys.apiSecret).update(`GET/realtime${expires}`).digest("hex");
      socket?.send(JSON.stringify({ op: "auth", args: [keys.apiKey, expires, signature] }));
    });
    socket.on("message", (raw) => {
      const payload = safeJson(raw.toString());
      if (!isRecord(payload)) return;
      if (payload.op === "auth") {
        if (payload.success === true) socket?.send(JSON.stringify({ op: "subscribe", args: ["order", "execution"] }));
        else {
          callbacks.onConnection(false, "Bybit private stream authentication failed; REST polling fallback active.");
          socket?.close();
        }
        return;
      }
      if (payload.op === "subscribe" && payload.success === true) {
        attempts = 0;
        setOnline(true, "Bybit private order stream connected; reconciling missed updates.");
        clearHeartbeat();
        heartbeatTimer = deps.setInterval(() => {
          if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ op: "ping" }));
        }, 20_000);
        return;
      }
      for (const snapshot of [...parseBybitOrderUpdates(payload), ...parseBybitExecutionUpdates(payload)]) callbacks.onSnapshot(snapshot);
    });
    socket.on("error", () => scheduleReconnect());
    socket.on("close", () => scheduleReconnect());
  };
  connect();

  return {
    connected: () => online,
    close: () => {
      closed = true;
      online = false;
      clearHeartbeat();
      if (reconnectTimer) deps.clearTimeout(reconnectTimer);
      socket?.close();
    }
  };
}

export function parseBinanceOrderUpdate(payload: unknown): ExchangeOrderSnapshot | undefined {
  if (!isRecord(payload) || payload.e !== "ORDER_TRADE_UPDATE" || !isRecord(payload.o)) return undefined;
  const order = payload.o;
  const id = stringValue(order.i);
  const qty = numberValue(order.q);
  const filledQty = numberValue(order.z);
  const updatedAt = numberValue(order.T ?? payload.T ?? payload.E);
  if (!id || qty === undefined || filledQty === undefined || updatedAt === undefined) return undefined;
  const execution = binanceExecution(order, updatedAt);
  return {
    id,
    clientId: stringValue(order.c),
    status: normalizeBinanceOrderStatus(stringValue(order.X) ?? ""),
    qty,
    filledQty,
    avgFillPrice: positiveNumber(order.ap),
    updatedAt,
    ...(execution ? { execution } : {})
  };
}

export function parseBybitOrderUpdates(payload: unknown): ExchangeOrderSnapshot[] {
  if (!isRecord(payload) || typeof payload.topic !== "string" || !payload.topic.startsWith("order") || !Array.isArray(payload.data)) return [];
  const snapshots: ExchangeOrderSnapshot[] = [];
  for (const value of payload.data) {
    if (!isRecord(value)) continue;
    const id = stringValue(value.orderId);
    const qty = numberValue(value.qty);
    const filledQty = numberValue(value.cumExecQty);
    const updatedAt = numberValue(value.updatedTime ?? payload.creationTime);
    if (!id || qty === undefined || filledQty === undefined || updatedAt === undefined) continue;
    const execution = bybitExecution(value, updatedAt);
    snapshots.push({
      id,
      clientId: stringValue(value.orderLinkId) || undefined,
      status: normalizeBybitOrderStatus(stringValue(value.orderStatus) ?? ""),
      qty,
      filledQty,
      avgFillPrice: positiveNumber(value.avgPrice),
      updatedAt,
      ...(execution ? { execution } : {})
    });
  }
  return snapshots;
}

export function parseBybitExecutionUpdates(payload: unknown): ExchangeOrderSnapshot[] {
  if (!isRecord(payload) || typeof payload.topic !== "string" || !payload.topic.startsWith("execution") || !Array.isArray(payload.data)) return [];
  const snapshots: ExchangeOrderSnapshot[] = [];
  for (const value of payload.data) {
    if (!isRecord(value)) continue;
    const id = stringValue(value.orderId);
    const qty = numberValue(value.orderQty);
    const leavesQty = numberValue(value.leavesQty);
    const updatedAt = numberValue(value.execTime ?? payload.creationTime);
    if (!id || qty === undefined || leavesQty === undefined || updatedAt === undefined) continue;
    const filledQty = Math.max(0, qty - leavesQty);
    const execution = bybitExecution(value, updatedAt);
    snapshots.push({
      id,
      clientId: stringValue(value.orderLinkId) || undefined,
      status: filledQty + Number.EPSILON >= qty ? "filled" : "partially_filled",
      qty,
      filledQty,
      updatedAt,
      ...(execution ? { execution } : {})
    });
  }
  return snapshots;
}

async function createBinanceListenKey(keys: ExchangeKeys, deps: Dependencies) {
  const response = await deps.fetch("https://fapi.binance.com/fapi/v1/listenKey", {
    method: "POST",
    headers: { "X-MBX-APIKEY": keys.apiKey }
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = await response.json() as { listenKey?: unknown };
  if (typeof payload.listenKey !== "string" || !payload.listenKey) throw new Error("missing listenKey");
  return payload.listenKey;
}

function reconnectDelay(attempt: number, random: () => number) {
  return Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5)) + Math.floor(random() * 500);
}

function resolveDependencies(dependencies: PrivateStreamDependencies): Dependencies {
  return {
    createSocket: dependencies.createSocket ?? ((url) => new WebSocket(url, { maxPayload: 2 * 1024 * 1024 })),
    fetch: dependencies.fetch ?? globalThis.fetch,
    now: dependencies.now ?? Date.now,
    random: dependencies.random ?? Math.random,
    setTimeout: dependencies.setTimeout ?? globalThis.setTimeout,
    clearTimeout: dependencies.clearTimeout ?? globalThis.clearTimeout,
    setInterval: dependencies.setInterval ?? globalThis.setInterval,
    clearInterval: dependencies.clearInterval ?? globalThis.clearInterval
  };
}

function requireKeys(exchange: string, keys: ExchangeKeys) {
  if (!keys.apiKey || !keys.apiSecret) throw new Error(`${exchange} API keys are not set`);
}

function safeJson(value: string): unknown {
  try { return JSON.parse(value); } catch { return undefined; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringValue(value: unknown) {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function numberValue(value: unknown) {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function positiveNumber(value: unknown) {
  const parsed = numberValue(value);
  return parsed !== undefined && parsed > 0 ? parsed : undefined;
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function binanceExecution(order: Record<string, unknown>, fallbackTime: number) {
  if (stringValue(order.x)?.toUpperCase() !== "TRADE") return undefined;
  const id = stringValue(order.t);
  const qty = positiveNumber(order.l);
  const price = positiveNumber(order.L);
  const symbol = stringValue(order.s);
  if (!id || !symbol || qty === undefined || price === undefined) return undefined;
  return {
    id: `binance:${symbol}:${id}`,
    qty,
    price,
    fee: Math.abs(numberValue(order.n) ?? 0),
    feeAsset: stringValue(order.N) || undefined,
    realizedPnl: numberValue(order.rp) ?? 0,
    side: normalizeSide(order.S),
    ts: numberValue(order.T) ?? fallbackTime
  };
}

function bybitExecution(value: Record<string, unknown>, fallbackTime: number) {
  const id = stringValue(value.execId);
  const qty = positiveNumber(value.execQty);
  const price = positiveNumber(value.execPrice);
  if (!id || qty === undefined || price === undefined) return undefined;
  return {
    id: `bybit:${id}`,
    qty,
    price,
    fee: Math.abs(numberValue(value.execFee) ?? 0),
    feeAsset: stringValue(value.feeCurrency) || stringValue(value.feeAsset) || undefined,
    realizedPnl: numberValue(value.closedPnl) ?? numberValue(value.execPnl) ?? 0,
    side: normalizeSide(value.side),
    ts: numberValue(value.execTime) ?? fallbackTime
  };
}

function normalizeSide(value: unknown): "buy" | "sell" | undefined {
  const normalized = stringValue(value)?.toLowerCase();
  return normalized === "buy" || normalized === "sell" ? normalized : undefined;
}
