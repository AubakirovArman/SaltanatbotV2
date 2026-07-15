import { abortError, throwIfAborted } from "../sharedAbortableWork.js";
import { readBoundedText } from "../../http/boundedResponse.js";
import type { AccountTelemetryEvidence, AccountTelemetryIssue, AccountTelemetryIssueCode, AccountTelemetryVenue } from "./types.js";

export const ACCOUNT_TELEMETRY_TTL_MS = 30_000;

export function evidence(source: string, asOf: number, now: number, timestampQuality: AccountTelemetryEvidence["timestampQuality"], ttlMs = ACCOUNT_TELEMETRY_TTL_MS): AccountTelemetryEvidence {
  const validTimestamp = Number.isSafeInteger(asOf) && asOf > 0 && asOf <= now + 5_000;
  const validUntil = validTimestamp ? asOf + ttlMs : 0;
  return {
    source,
    version: "account-telemetry-v1",
    asOf: validTimestamp ? asOf : 0,
    validUntil,
    timestampQuality,
    fresh: validTimestamp && validUntil >= now
  };
}

export function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid(`${label} must be an object`);
  return value as Record<string, unknown>;
}

export function array(value: unknown, label: string, maximum: number): unknown[] {
  if (!Array.isArray(value)) throw invalid(`${label} must be an array`);
  if (value.length > maximum) throw invalid(`${label} exceeds the bounded row limit`);
  return value;
}

export function text(value: unknown, label: string, pattern = /^[A-Za-z0-9:._/@-]{1,120}$/): string {
  if (typeof value !== "string" || !pattern.test(value)) throw invalid(`${label} is invalid`);
  return value;
}

export function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw invalid(`${label} must be boolean`);
  return value;
}

export function decimal(value: unknown, label: string, options: { allowNegative?: boolean; maximum?: number } = {}): number {
  if (typeof value !== "string" && typeof value !== "number") throw invalid(`${label} must be decimal`);
  if (typeof value === "string" && !/^-?(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)$/.test(value)) throw invalid(`${label} must be decimal`);
  const parsed = Number(value);
  const minimum = options.allowNegative ? -(options.maximum ?? 1e18) : 0;
  const maximum = options.maximum ?? 1e18;
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) throw invalid(`${label} is outside the supported range`);
  return parsed;
}

export function optionalDecimal(value: unknown, label: string, options?: { allowNegative?: boolean; maximum?: number }): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return decimal(value, label, options);
}

export function safeInteger(value: unknown, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) throw invalid(`${label} must be a non-negative safe integer`);
  return parsed;
}

export function rateBps(value: unknown, label: string): number {
  return decimal(value, label, { allowNegative: true, maximum: 1 }) * 10_000;
}

export function annualizedHourlyRateBps(hourlyRate: number): number {
  return Number((hourlyRate * 24 * 365 * 10_000).toFixed(12));
}

export function issue(venue: AccountTelemetryVenue, dimension: AccountTelemetryIssue["dimension"], error: unknown, subject?: string): AccountTelemetryIssue {
  return {
    venue,
    dimension,
    code: issueCode(error),
    ...(subject ? { subject } : {}),
    message: safeMessage(error)
  };
}

export function invalid(message: string): Error {
  const error = new Error(message);
  error.name = "TelemetryValidationError";
  return error;
}

export function safeMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : "Telemetry upstream unavailable";
  return raw
    .replace(/(signature|api[_-]?key|secret|token)=?[^\s&]*/gi, "$1=[redacted]")
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 240);
}

export function issueCode(error: unknown): AccountTelemetryIssueCode {
  if (!(error instanceof Error)) return "unavailable";
  if (error.name === "AbortError") return "cancelled";
  if (error.name === "TelemetryTimeoutError") return "timeout";
  if (error.name === "TelemetryValidationError") return "invalid-response";
  const code = (error as Error & { status?: number }).status;
  if (code === 418 || code === 429) return "rate-limit";
  return "unavailable";
}

export async function settleBounded<T>(tasks: readonly (() => Promise<T>)[], concurrency = 3): Promise<PromiseSettledResult<T>[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new Error("concurrency must be a positive safe integer");
  const results = new Array<PromiseSettledResult<T>>(tasks.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= tasks.length) return;
      try {
        results[index] = { status: "fulfilled", value: await tasks[index]!() };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

export async function boundedFetchJson(
  fetcher: typeof fetch,
  url: string,
  signal: AbortSignal,
  maxBytes: number,
  timeoutMs: number,
  now: () => number = Date.now,
  onResponse?: (response: Response) => void,
  headers: Readonly<Record<string, string>> = {}
): Promise<{ payload: unknown; receivedAt: number }> {
  const controller = new AbortController();
  const parentAbort = () => controller.abort(signal.reason ?? abortError());
  if (signal.aborted) parentAbort();
  else signal.addEventListener("abort", parentAbort, { once: true });
  const timer = setTimeout(() => {
    const timeout = new Error("Account telemetry request timed out");
    timeout.name = "TelemetryTimeoutError";
    controller.abort(timeout);
  }, timeoutMs);
  try {
    const response = await fetcher(url, { signal: controller.signal, headers: { Accept: "application/json", ...headers } });
    onResponse?.(response);
    const receivedAt = now();
    const body = await readBoundedText(response, maxBytes, () => invalid("Telemetry upstream response is too large"));
    throwIfAborted(controller.signal);
    if (!response.ok) {
      const error = new Error(`Telemetry upstream returned HTTP ${response.status}`) as Error & { status: number };
      error.status = response.status;
      throw error;
    }
    try {
      return { payload: JSON.parse(body) as unknown, receivedAt };
    } catch {
      throw invalid("Telemetry upstream returned malformed JSON");
    }
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason ?? error;
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", parentAbort);
  }
}
