/**
 * Shared REST helper for exchange calls.
 *
 * Exchanges (Binance, Bybit) throttle aggressively: HTTP 429 means "too many
 * requests" and 418 (Binance) means "you kept hammering after a 429 — you are
 * now IP-banned for a while". Both send a `Retry-After` header we should honour.
 * This wraps `fetch` with capped exponential backoff + jitter so transient
 * throttling recovers on its own instead of surfacing as a hard failure.
 */

import { readBoundedText } from "../http/boundedResponse.js";

const RETRY_STATUS = new Set([429, 418]);
const MAX_RETRY_ERROR_BODY_BYTES = 64 * 1024;

export interface FetchWithRetryOptions extends RequestInit {
  /** Maximum retry attempts after the first try (default 3). */
  maxRetries?: number;
  /** Upper bound for any single backoff wait, in ms (default 8000). */
  maxDelayMs?: number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * `fetch` with retry on 429/418. Non-throttle responses (including other HTTP
 * errors) are returned as-is for the caller to interpret — we only retry the
 * rate-limit statuses and network errors. Never blocks the event loop; each
 * wait is an awaited timer.
 */
export async function fetchWithRetry(
  url: string | URL,
  options: FetchWithRetryOptions = {}
): Promise<Response> {
  const { maxRetries = 3, maxDelayMs = 8000, ...init } = options;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const response = await fetch(url, init);
      if (!RETRY_STATUS.has(response.status) || attempt === maxRetries) {
        return response;
      }
      // Drain only a small bounded body so a throttled upstream cannot force an
      // unbounded allocation before the retry delay.
      await readBoundedText(response, MAX_RETRY_ERROR_BODY_BYTES, () => new Error("rate-limit response is too large")).catch(() => undefined);
      await sleep(backoffDelay(attempt, maxDelayMs, response.headers.get("retry-after")));
    } catch (error) {
      // Network-level failure (DNS, reset, abort). Retry unless we are out of budget.
      lastError = error;
      if (attempt === maxRetries) throw error;
      await sleep(backoffDelay(attempt, maxDelayMs, null));
    }
  }

  // Unreachable in practice (the loop returns or throws), but satisfies the type.
  throw lastError ?? new Error("fetchWithRetry: exhausted retries");
}

/** Honour `Retry-After` (seconds) when present, else exponential backoff + jitter. */
function backoffDelay(attempt: number, maxDelayMs: number, retryAfter: string | null): number {
  const headerMs = parseRetryAfter(retryAfter);
  if (headerMs !== undefined) return Math.min(headerMs, maxDelayMs);
  const base = Math.min(maxDelayMs, 500 * 2 ** attempt);
  return base + Math.floor(Math.random() * 300);
}

/** `Retry-After` may be an integer number of seconds or an HTTP date. */
function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}
