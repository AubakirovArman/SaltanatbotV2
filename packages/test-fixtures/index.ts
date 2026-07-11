import type { Candle } from "@saltanatbotv2/contracts";

export interface CandleFixtureOptions {
  startTime?: number;
  intervalMs?: number;
  spread?: number;
  volume?: number;
  source?: string;
  final?: boolean;
}

export function candleFromClose(index: number, close: number, options: CandleFixtureOptions = {}): Candle {
  const { startTime = 0, intervalMs = 60_000, spread = 1, volume = 1_000, source, final } = options;
  if (!Number.isSafeInteger(index) || index < 0) throw new Error(`Candle index must be a non-negative integer: ${index}`);
  if (!Number.isFinite(close) || close <= 0) throw new Error(`Candle close must be positive and finite: ${close}`);
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new Error(`Candle interval must be positive: ${intervalMs}`);
  if (!Number.isFinite(spread) || spread < 0) throw new Error(`Candle spread must be non-negative: ${spread}`);
  return {
    time: startTime + index * intervalMs,
    open: close,
    high: close + spread,
    low: Math.max(0, close - spread),
    close,
    volume,
    ...(source === undefined ? {} : { source }),
    ...(final === undefined ? {} : { final })
  };
}

export function candlesFromCloses(closes: readonly number[], options: CandleFixtureOptions = {}): Candle[] {
  return closes.map((close, index) => candleFromClose(index, close, options));
}

export function jsonResponse(payload: unknown, status = 200, headers: HeadersInit = {}): Response {
  const responseHeaders = new Headers(headers);
  if (!responseHeaders.has("content-type")) responseHeaders.set("content-type", "application/json");
  return new Response(JSON.stringify(payload), {
    status,
    headers: responseHeaders
  });
}

export function textResponse(body: string, status: number, headers: HeadersInit = {}): Response {
  return new Response(body, { status, headers });
}

export interface FetchFixtureRequest {
  url: string;
  init?: RequestInit;
}

export interface FetchFixtureRoute {
  match: string | RegExp | ((request: FetchFixtureRequest) => boolean);
  respond: (request: FetchFixtureRequest) => Response | Promise<Response>;
}

function routeMatches(route: FetchFixtureRoute, request: FetchFixtureRequest) {
  if (typeof route.match === "string") return request.url.includes(route.match);
  if (route.match instanceof RegExp) return route.match.test(request.url);
  return route.match(request);
}

export function scriptedFetch(routes: readonly FetchFixtureRoute[], fallback?: (request: FetchFixtureRequest) => Response | Promise<Response>): typeof fetch {
  return async (input, init) => {
    const request = { url: input instanceof Request ? input.url : String(input), init };
    const route = routes.find((candidate) => routeMatches(candidate, request));
    if (route) return route.respond(request);
    if (fallback) return fallback(request);
    throw new Error(`Unexpected fixture request: ${request.url}`);
  };
}

export type ScriptedExchangeOutcome<TOrder, TResult> = TResult | Error | ((order: TOrder, callIndex: number) => TResult | Promise<TResult>);

export interface ScriptedExchangeOptions<TOrder, TResult, TAccount, TPosition, TPending, TSnapshot> {
  id?: string;
  market?: string;
  executions?: readonly ScriptedExchangeOutcome<TOrder, TResult>[];
  account: TAccount;
  position: TPosition;
  orders?: readonly TPending[];
  snapshots?: readonly TSnapshot[];
}

/** Transport-neutral structural fake exchange; unexpected submissions fail closed. */
export function scriptedExchange<TOrder, TResult, TAccount, TPosition, TPending = never, TSnapshot = never>(options: ScriptedExchangeOptions<TOrder, TResult, TAccount, TPosition, TPending, TSnapshot>) {
  const outcomes = [...(options.executions ?? [])];
  const calls: TOrder[] = [];
  const handlers = new Set<(snapshot: TSnapshot) => void>();
  const connections = new Set<(connected: boolean, message: string) => void>();
  let connected = true;
  let account = structuredClone(options.account);
  let position = structuredClone(options.position);
  let orders = structuredClone([...(options.orders ?? [])]);

  return {
    id: options.id ?? "fake",
    market: options.market ?? "spot",
    calls,
    async execute(order: TOrder): Promise<TResult> {
      const index = calls.length;
      calls.push(structuredClone(order));
      const outcome = outcomes.shift();
      if (outcome === undefined) throw new Error(`Unexpected fake-exchange submission #${index + 1}`);
      if (outcome instanceof Error) throw outcome;
      if (typeof outcome === "function") {
        const handler = outcome as (submitted: TOrder, callIndex: number) => TResult | Promise<TResult>;
        return structuredClone(await handler(order, index));
      }
      return structuredClone(outcome);
    },
    async account(): Promise<TAccount> {
      return structuredClone(account);
    },
    async position(_symbol: string): Promise<TPosition> {
      return structuredClone(position);
    },
    async orders(_symbol: string): Promise<TPending[]> {
      return structuredClone(orders);
    },
    setAccount(next: TAccount) {
      account = structuredClone(next);
    },
    setPosition(next: TPosition) {
      position = structuredClone(next);
    },
    setOrders(next: readonly TPending[]) {
      orders = structuredClone([...next]);
    },
    async subscribeOrderUpdates(onSnapshot: (snapshot: TSnapshot) => void, onConnection?: (isConnected: boolean, message: string) => void) {
      handlers.add(onSnapshot);
      if (onConnection) connections.add(onConnection);
      onConnection?.(connected, connected ? "Fake exchange stream connected." : "Fake exchange stream disconnected.");
      for (const snapshot of options.snapshots ?? []) onSnapshot(structuredClone(snapshot));
      return {
        connected: () => connected,
        close: () => {
          handlers.delete(onSnapshot);
          if (onConnection) connections.delete(onConnection);
        }
      };
    },
    emit(snapshot: TSnapshot) {
      for (const handler of handlers) handler(structuredClone(snapshot));
    },
    disconnect(message = "Fake exchange stream disconnected.") {
      connected = false;
      for (const handler of connections) handler(false, message);
    },
    reconnect(message = "Fake exchange stream reconnected.") {
      connected = true;
      for (const handler of connections) handler(true, message);
    }
  };
}
