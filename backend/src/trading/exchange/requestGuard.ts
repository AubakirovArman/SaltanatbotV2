const MAX_BLOCK_MS = 15 * 60_000;

export class ExchangeRateLimitError extends Error {
  constructor(
    readonly exchange: string,
    readonly retryAt: number,
    readonly status?: number,
  ) {
    super(`${exchange} request circuit is open until ${new Date(retryAt).toISOString()}`);
    this.name = "ExchangeRateLimitError";
  }
}

export class ExchangeClockSkewError extends Error {
  constructor(
    readonly exchange: string,
    readonly estimatedOffsetMs?: number,
  ) {
    const offset = estimatedOffsetMs === undefined ? "" : ` (estimated local offset ${estimatedOffsetMs}ms)`;
    super(`${exchange} rejected the signed timestamp${offset}; synchronize the host clock before trading`);
    this.name = "ExchangeClockSkewError";
  }
}

function parseRetryAfter(value: string | null, now: number) {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : undefined;
}

function estimateClockOffset(dateHeader: string | null, now: number) {
  if (!dateHeader) return undefined;
  const exchangeTime = Date.parse(dateHeader);
  return Number.isFinite(exchangeTime) ? now - exchangeTime : undefined;
}

export class ExchangeRequestGuard {
  private blockedUntil = 0;

  constructor(
    private readonly exchange: string,
    private readonly now: () => number = Date.now,
  ) {}

  assertAvailable() {
    const now = this.now();
    if (this.blockedUntil > now) throw new ExchangeRateLimitError(this.exchange, this.blockedUntil);
    if (this.blockedUntil !== 0) this.blockedUntil = 0;
  }

  observeHttpResponse(response: Pick<Response, "status"> & { headers?: Pick<Headers, "get"> }) {
    if (response.status !== 418 && response.status !== 429) return;
    const now = this.now();
    const fallback = response.status === 418 ? 60_000 : 1_000;
    const delay = Math.min(parseRetryAfter(response.headers?.get("retry-after") ?? null, now) ?? fallback, MAX_BLOCK_MS);
    this.blockedUntil = Math.max(this.blockedUntil, now + delay);
  }

  detectClockSkew(code: number | undefined, message: string, dateHeader: string | null) {
    const normalized = message.toLowerCase();
    const isClockSkew =
      code === -1021 ||
      code === 10002 ||
      normalized.includes("timestamp for this request") ||
      normalized.includes("request time exceeds") ||
      normalized.includes("recv_window");
    if (isClockSkew) {
      throw new ExchangeClockSkewError(this.exchange, estimateClockOffset(dateHeader, this.now()));
    }
  }

  getState() {
    return { blockedUntil: this.blockedUntil };
  }
}

const sharedGuards = {
  binance: new ExchangeRequestGuard("Binance"),
  bybit: new ExchangeRequestGuard("Bybit"),
};

export function getExchangeRequestGuard(exchange: keyof typeof sharedGuards) {
  return sharedGuards[exchange];
}
