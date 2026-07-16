import { createHmac } from "node:crypto";
import WebSocket from "ws";
import type { ExchangeOrderSnapshot, PrivateOrderSubscription } from "../types.js";
import type { ExchangeKeys } from "./binance.js";
import { normalizeBinanceOrderStatus, normalizeBybitOrderStatus } from "./orderStatus.js";
import { assertPrivateExchangeAccess, getRuntimePolicy, type RuntimePolicy } from "../../runtimeProfile.js";
import { type SignedRequestAuthorizer, withSignedRequestAuthorization } from "./signedRequestGate.js";

interface StreamCallbacks {
  onSnapshot(snapshot: ExchangeOrderSnapshot): void;
  onConnection(connected: boolean, message: string): void;
}

export interface PrivateStreamDependencies {
  createSocket?: (url: string) => WebSocket;
  createHmac?: typeof createHmac;
  fetch?: typeof fetch;
  now?: () => number;
  random?: () => number;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
  setInterval?: typeof setInterval;
  clearInterval?: typeof clearInterval;
  runtimePolicy?: RuntimePolicy;
}

export interface PrivateOrderStreamContext {
  authorizer: SignedRequestAuthorizer;
  signal: AbortSignal;
}

type Dependencies = Required<PrivateStreamDependencies>;

export async function subscribeBinanceOrders(
  keys: ExchangeKeys,
  callbacks: StreamCallbacks,
  context: PrivateOrderStreamContext,
  dependencies: PrivateStreamDependencies = {}
): Promise<PrivateOrderSubscription> {
  assertPrivateExchangeAccess("Binance private order stream", "stream", dependencies.runtimePolicy ?? getRuntimePolicy());
  requireKeys("Binance", keys);
  requireStreamContext(context);
  const deps = resolveDependencies(dependencies);
  let socket: WebSocket | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let keepaliveTimer: ReturnType<typeof setInterval> | undefined;
  let managementInFlight: Promise<void> | undefined;
  let keepaliveInFlight = false;
  let closed = false;
  let online = false;
  let listenKeyAllocated = false;
  let attempts = 0;
  let generation = 0;

  const active = () => !closed && !context.signal.aborted;
  const setOnline = (next: boolean, message: string) => {
    if (!active()) return;
    if (online !== next || message) callbacks.onConnection(next, message);
    online = next;
  };

  const currentSocket = (candidate: WebSocket, candidateGeneration: number) =>
    active() && socket === candidate && generation === candidateGeneration;

  const scheduleReconnect = (message = "Binance private stream disconnected; REST polling fallback active.") => {
    if (!active() || reconnectTimer) return;
    setOnline(false, message);
    const delay = reconnectDelay(++attempts, deps.random);
    reconnectTimer = deps.setTimeout(() => {
      reconnectTimer = undefined;
      void openFreshSocket().catch((error) => {
        if (!active()) return;
        callbacks.onConnection(false, `Binance listenKey refresh failed: ${messageOf(error)}; REST polling fallback active.`);
        scheduleReconnect();
      });
    }, delay);
  };

  const bindSocket = (candidate: WebSocket, candidateGeneration: number) => {
    candidate.on("open", () => {
      if (!currentSocket(candidate, candidateGeneration)) {
        candidate.close();
        return;
      }
      attempts = 0;
      setOnline(true, "Binance private order stream connected; reconciling missed updates.");
    });
    candidate.on("message", (raw) => {
      if (!currentSocket(candidate, candidateGeneration)) return;
      const payload = safeJson(raw.toString());
      if (isRecord(payload) && payload.e === "listenKeyExpired") {
        setOnline(false, "Binance listenKey expired; rotating credentials and using REST polling fallback.");
        generation += 1;
        socket = undefined;
        candidate.close();
        scheduleReconnect();
        return;
      }
      const snapshot = parseBinanceOrderUpdate(payload);
      if (snapshot) callbacks.onSnapshot(snapshot);
    });
    candidate.on("error", () => {
      if (!currentSocket(candidate, candidateGeneration)) return;
      generation += 1;
      socket = undefined;
      candidate.close();
      scheduleReconnect();
    });
    candidate.on("close", () => {
      if (!currentSocket(candidate, candidateGeneration)) return;
      socket = undefined;
      scheduleReconnect();
    });
  };

  const openFreshSocket = (): Promise<void> => {
    if (!active()) return Promise.reject(abortError(context.signal));
    if (managementInFlight) return managementInFlight;
    const attempt = withSignedRequestAuthorization(
      context.authorizer,
      { venue: "binance", market: "futures", method: "POST", path: "/fapi/v1/listenKey", payload: {} },
      async () => {
        assertStreamActive(context.signal, closed);
        const response = await deps.fetch("https://fapi.binance.com/fapi/v1/listenKey", {
          method: "POST",
          headers: { "X-MBX-APIKEY": keys.apiKey },
          signal: context.signal
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = (await response.json()) as { listenKey?: unknown };
        if (typeof payload.listenKey !== "string" || !payload.listenKey) throw new Error("missing listenKey");
        listenKeyAllocated = true;
        assertStreamActive(context.signal, closed);
        const candidateGeneration = generation + 1;
        const candidate = deps.createSocket(`wss://fstream.binance.com/private/ws/${payload.listenKey}`);
        generation = candidateGeneration;
        socket = candidate;
        bindSocket(candidate, candidateGeneration);
      }
    );
    const tracked = attempt.finally(() => {
      if (managementInFlight === tracked) managementInFlight = undefined;
    });
    managementInFlight = tracked;
    return tracked;
  };

  const keepalive = async () => {
    if (!active() || keepaliveInFlight || managementInFlight) return;
    keepaliveInFlight = true;
    try {
      await withSignedRequestAuthorization(
        context.authorizer,
        { venue: "binance", market: "futures", method: "PUT", path: "/fapi/v1/listenKey", payload: {} },
        async () => {
          assertStreamActive(context.signal, closed);
          const response = await deps.fetch("https://fapi.binance.com/fapi/v1/listenKey", {
            method: "PUT",
            headers: { "X-MBX-APIKEY": keys.apiKey },
            signal: context.signal
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
        }
      );
    } catch (error) {
      if (!active()) return;
      callbacks.onConnection(false, `Binance listenKey keepalive failed: ${messageOf(error)}; rotating credentials and using REST polling fallback.`);
      const current = socket;
      generation += 1;
      socket = undefined;
      current?.close();
      scheduleReconnect();
    } finally {
      keepaliveInFlight = false;
    }
  };

  const teardown = (releaseListenKey: boolean) => {
    if (closed) return;
    closed = true;
    online = false;
    generation += 1;
    if (reconnectTimer) deps.clearTimeout(reconnectTimer);
    if (keepaliveTimer) deps.clearInterval(keepaliveTimer);
    reconnectTimer = undefined;
    keepaliveTimer = undefined;
    context.signal.removeEventListener("abort", close);
    const current = socket;
    socket = undefined;
    current?.close();
    const shouldReleaseListenKey = releaseListenKey && listenKeyAllocated && !context.signal.aborted;
    listenKeyAllocated = false;
    if (!shouldReleaseListenKey) return;
    void withSignedRequestAuthorization(
      context.authorizer,
      { venue: "binance", market: "futures", method: "DELETE", path: "/fapi/v1/listenKey", payload: {} },
      async () => {
        if (context.signal.aborted) throw abortError(context.signal);
        await deps.fetch("https://fapi.binance.com/fapi/v1/listenKey", {
          method: "DELETE",
          headers: { "X-MBX-APIKEY": keys.apiKey },
          signal: context.signal
        });
      }
    ).catch(() => undefined);
  };
  const close = () => teardown(true);

  context.signal.addEventListener("abort", close, { once: true });
  try {
    assertStreamActive(context.signal, closed);
    await openFreshSocket();
    assertStreamActive(context.signal, closed);
  } catch (error) {
    teardown(listenKeyAllocated);
    throw error;
  }
  keepaliveTimer = deps.setInterval(() => {
    void keepalive();
  }, 50 * 60_000);

  return {
    connected: () => active() && online,
    close
  };
}

export async function subscribeBybitOrders(
  keys: ExchangeKeys,
  callbacks: StreamCallbacks,
  context: PrivateOrderStreamContext,
  dependencies: PrivateStreamDependencies = {}
): Promise<PrivateOrderSubscription> {
  assertPrivateExchangeAccess("Bybit private order stream", "stream", dependencies.runtimePolicy ?? getRuntimePolicy());
  requireKeys("Bybit", keys);
  requireStreamContext(context);
  const deps = resolveDependencies(dependencies);
  let socket: WebSocket | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let connectInFlight: Promise<void> | undefined;
  let closed = false;
  let online = false;
  let attempts = 0;
  let generation = 0;

  const active = () => !closed && !context.signal.aborted;
  const setOnline = (next: boolean, message: string) => {
    if (!active()) return;
    if (online !== next || message) callbacks.onConnection(next, message);
    online = next;
  };
  const clearHeartbeat = () => {
    if (heartbeatTimer) deps.clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
  };

  const currentSocket = (candidate: WebSocket, candidateGeneration: number) =>
    active() && socket === candidate && generation === candidateGeneration;

  const sendOnCurrent = (candidate: WebSocket, candidateGeneration: number, frame: string): boolean => {
    if (!currentSocket(candidate, candidateGeneration) || candidate.readyState !== WebSocket.OPEN) return false;
    candidate.send(frame);
    return true;
  };

  const scheduleReconnect = (message = "Bybit private stream disconnected; REST polling fallback active.") => {
    clearHeartbeat();
    if (!active() || reconnectTimer) return;
    setOnline(false, message);
    const delay = reconnectDelay(++attempts, deps.random);
    reconnectTimer = deps.setTimeout(() => {
      reconnectTimer = undefined;
      void openSocket().catch((error) => {
        if (!active()) return;
        callbacks.onConnection(false, `Bybit private stream authorization failed: ${messageOf(error)}; REST polling fallback active.`);
        scheduleReconnect();
      });
    }, delay);
  };

  const bindSocket = (candidate: WebSocket, candidateGeneration: number, expires: number, authFrame: string) => {
    let authSent = false;
    let subscribeSent = false;
    let subscribed = false;
    const invalidate = (message: string) => {
      if (!currentSocket(candidate, candidateGeneration)) return;
      generation += 1;
      socket = undefined;
      candidate.close();
      scheduleReconnect(message);
    };
    candidate.on("open", () => {
      if (!currentSocket(candidate, candidateGeneration)) {
        candidate.close();
        return;
      }
      if (deps.now() >= expires) {
        generation += 1;
        socket = undefined;
        candidate.close();
        scheduleReconnect("Bybit private stream authorization expired before socket open; REST polling fallback active.");
        return;
      }
      if (!authSent) authSent = sendOnCurrent(candidate, candidateGeneration, authFrame);
    });
    candidate.on("message", (raw) => {
      if (!currentSocket(candidate, candidateGeneration)) return;
      const payload = safeJson(raw.toString());
      if (!isRecord(payload)) return;
      if (payload.op === "auth") {
        if (payload.success === true) {
          if (authSent && !subscribeSent) {
            subscribeSent = sendOnCurrent(candidate, candidateGeneration, JSON.stringify({ op: "subscribe", args: ["order", "execution"] }));
          }
        }
        else {
          callbacks.onConnection(false, "Bybit private stream authentication failed; REST polling fallback active.");
          invalidate("Bybit private stream authentication failed; REST polling fallback active.");
        }
        return;
      }
      if (payload.op === "subscribe") {
        if (payload.success === true && subscribeSent && !subscribed) {
          subscribed = true;
          attempts = 0;
          setOnline(true, "Bybit private order stream connected; reconciling missed updates.");
          clearHeartbeat();
          heartbeatTimer = deps.setInterval(() => {
            sendOnCurrent(candidate, candidateGeneration, JSON.stringify({ op: "ping" }));
          }, 20_000);
        } else if (payload.success === false) {
          invalidate("Bybit private stream subscription failed; REST polling fallback active.");
        }
        return;
      }
      if (!subscribed) return;
      for (const snapshot of [...parseBybitOrderUpdates(payload), ...parseBybitExecutionUpdates(payload)]) callbacks.onSnapshot(snapshot);
    });
    candidate.on("error", () => {
      if (!currentSocket(candidate, candidateGeneration)) return;
      invalidate("Bybit private stream failed; REST polling fallback active.");
    });
    candidate.on("close", () => {
      if (!currentSocket(candidate, candidateGeneration)) return;
      socket = undefined;
      scheduleReconnect();
    });
  };

  const openSocket = (): Promise<void> => {
    if (!active()) return Promise.reject(abortError(context.signal));
    if (connectInFlight) return connectInFlight;
    const expires = deps.now() + 10_000;
    const attempt = withSignedRequestAuthorization(
      context.authorizer,
      { venue: "bybit", market: "futures", method: "POST", path: "/v5/private/ws/auth", payload: { expires } },
      () => {
        assertStreamActive(context.signal, closed);
        const signature = deps.createHmac("sha256", keys.apiSecret).update("GET/realtime" + expires).digest("hex");
        const authFrame = JSON.stringify({ op: "auth", args: [keys.apiKey, expires, signature] });
        const candidateGeneration = generation + 1;
        const candidate = deps.createSocket("wss://stream.bybit.com/v5/private");
        generation = candidateGeneration;
        socket = candidate;
        bindSocket(candidate, candidateGeneration, expires, authFrame);
      }
    );
    const tracked = attempt.finally(() => {
      if (connectInFlight === tracked) connectInFlight = undefined;
    });
    connectInFlight = tracked;
    return tracked;
  };

  const close = () => {
    if (closed) return;
    closed = true;
    online = false;
    generation += 1;
    clearHeartbeat();
    if (reconnectTimer) deps.clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    context.signal.removeEventListener("abort", close);
    const current = socket;
    socket = undefined;
    current?.close();
  };

  context.signal.addEventListener("abort", close, { once: true });
  try {
    assertStreamActive(context.signal, closed);
    await openSocket();
    assertStreamActive(context.signal, closed);
  } catch (error) {
    close();
    throw error;
  }

  return {
    connected: () => active() && online,
    close
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

function reconnectDelay(attempt: number, random: () => number) {
  return Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5)) + Math.floor(random() * 500);
}

function resolveDependencies(dependencies: PrivateStreamDependencies): Dependencies {
  return {
    createSocket: dependencies.createSocket ?? ((url) => new WebSocket(url, { maxPayload: 2 * 1024 * 1024 })),
    createHmac: dependencies.createHmac ?? createHmac,
    fetch: dependencies.fetch ?? globalThis.fetch,
    now: dependencies.now ?? Date.now,
    random: dependencies.random ?? Math.random,
    setTimeout: dependencies.setTimeout ?? globalThis.setTimeout,
    clearTimeout: dependencies.clearTimeout ?? globalThis.clearTimeout,
    setInterval: dependencies.setInterval ?? globalThis.setInterval,
    clearInterval: dependencies.clearInterval ?? globalThis.clearInterval,
    runtimePolicy: dependencies.runtimePolicy ?? getRuntimePolicy()
  };
}

function requireKeys(exchange: string, keys: ExchangeKeys) {
  if (!keys.apiKey || !keys.apiSecret) throw new Error(`${exchange} API keys are not set`);
}

function requireStreamContext(context: PrivateOrderStreamContext): void {
  if (
    typeof context !== "object"
    || context === null
    || typeof context.authorizer !== "object"
    || context.authorizer === null
    || typeof context.authorizer.consume !== "function"
    || typeof context.signal !== "object"
    || context.signal === null
    || typeof context.signal.aborted !== "boolean"
    || typeof context.signal.addEventListener !== "function"
    || typeof context.signal.removeEventListener !== "function"
  ) {
    throw new Error("Private order stream requires an authorizer and AbortSignal");
  }
}

function assertStreamActive(signal: AbortSignal, closed: boolean): void {
  if (!closed && !signal.aborted) return;
  throw abortError(signal);
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException("Private order stream stopped", "AbortError");
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
