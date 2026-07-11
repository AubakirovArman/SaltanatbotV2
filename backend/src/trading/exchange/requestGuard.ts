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
  private usedWeight = 0;
  private windowStartedAt: number;
  private capacity: number;
  private readonly windowMs: number;
  private readonly reserveRatio: number;

  constructor(
    private readonly exchange: string,
    private readonly now: () => number = Date.now,
    options: { capacity?: number; windowMs?: number; reserveRatio?: number } = {},
  ) {
    this.capacity = Math.max(1, options.capacity ?? 1_000);
    this.windowMs = Math.max(100, options.windowMs ?? 60_000);
    this.reserveRatio = Math.max(0.1, Math.min(1, options.reserveRatio ?? 0.9));
    this.windowStartedAt = this.now();
  }

  assertAvailable(weight = 1) {
    const now = this.now();
    if (this.blockedUntil > now) throw new ExchangeRateLimitError(this.exchange, this.blockedUntil);
    if (this.blockedUntil !== 0) this.blockedUntil = 0;
    this.resetBudgetWindow(now);
    const cost = Math.max(0, Number.isFinite(weight) ? weight : 1);
    if (this.usedWeight + cost > this.capacity * this.reserveRatio) {
      this.blockedUntil = Math.max(this.blockedUntil, this.windowStartedAt + this.windowMs);
      throw new ExchangeRateLimitError(this.exchange, this.blockedUntil);
    }
    this.usedWeight += cost;
  }

  observeHttpResponse(response: Pick<Response, "status"> & { headers?: Pick<Headers, "get"> }) {
    this.observeBudgetHeaders(response.headers);
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

  getBudgetState() {
    return {
      capacity: this.capacity,
      usedWeight: this.usedWeight,
      availableWeight: Math.max(0, this.capacity * this.reserveRatio - this.usedWeight),
      windowStartedAt: this.windowStartedAt,
      windowMs: this.windowMs,
      reserveRatio: this.reserveRatio
    };
  }

  private resetBudgetWindow(now: number) {
    if (now - this.windowStartedAt < this.windowMs) return;
    this.windowStartedAt = now;
    this.usedWeight = 0;
  }

  private observeBudgetHeaders(headers: Pick<Headers, "get"> | undefined) {
    if (!headers) return;
    const now = this.now();
    this.resetBudgetWindow(now);
    const binanceUsed = finiteHeader(headers.get("x-mbx-used-weight-1m"));
    if (binanceUsed !== undefined) this.usedWeight = Math.max(this.usedWeight, binanceUsed);

    const bybitLimit = finiteHeader(headers.get("x-bapi-limit"));
    const bybitRemaining = finiteHeader(headers.get("x-bapi-limit-status"));
    if (bybitLimit !== undefined && bybitLimit > 0) {
      this.capacity = bybitLimit;
      if (bybitRemaining !== undefined) this.usedWeight = Math.max(0, bybitLimit - bybitRemaining);
    }
    const bybitReset = finiteHeader(headers.get("x-bapi-limit-reset-timestamp"));
    if (bybitReset !== undefined && bybitReset > now) {
      this.windowStartedAt = Math.max(0, bybitReset - this.windowMs);
    }
  }
}

function finiteHeader(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

const sharedGuards = {
  binance: new ExchangeRequestGuard("Binance", Date.now, { capacity: 2_400, windowMs: 60_000, reserveRatio: 0.9 }),
  bybit: new ExchangeRequestGuard("Bybit", Date.now, { capacity: 120, windowMs: 60_000, reserveRatio: 0.85 }),
};

export function getExchangeRequestGuard(exchange: keyof typeof sharedGuards) {
  return sharedGuards[exchange];
}
