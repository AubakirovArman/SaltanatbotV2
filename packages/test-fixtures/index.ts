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
  const {
    startTime = 0,
    intervalMs = 60_000,
    spread = 1,
    volume = 1_000,
    source,
    final,
  } = options;
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
    ...(final === undefined ? {} : { final }),
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
    headers: responseHeaders,
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

export function scriptedFetch(
  routes: readonly FetchFixtureRoute[],
  fallback?: (request: FetchFixtureRequest) => Response | Promise<Response>,
): typeof fetch {
  return async (input, init) => {
    const request = { url: input instanceof Request ? input.url : String(input), init };
    const route = routes.find((candidate) => routeMatches(candidate, request));
    if (route) return route.respond(request);
    if (fallback) return fallback(request);
    throw new Error(`Unexpected fixture request: ${request.url}`);
  };
}
