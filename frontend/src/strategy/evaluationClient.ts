import { getCsrfToken } from "../auth/client";

/**
 * Research-jobs client for the server multi-market evaluation kind
 * ("multi-market-eval", R9.1). Follows the screener jobs client precedent:
 * bounded JSON responses, explicit error codes, abortable polling against the
 * shared /api/jobs endpoints. Submission bodies match the server payload
 * contract byte-for-byte: {kind, ir, markets, lookbackBars, split, seed}.
 */

const JOBS_API_BASE = "/api/jobs";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ERROR_CODE = /^[a-z][a-z0-9._-]{0,95}$/;
const SYMBOL = /^[A-Z0-9]{4,24}$/;
const TIMEFRAME = /^\d{1,3}[mhdw]$/;
const DATASET_FINGERPRINT = /^[0-9a-f]{64}$/;
const JOB_STATUSES = new Set(["queued", "running", "completed", "failed", "cancelled"]);

export const EVALUATION_API_MAX_RESPONSE_BYTES = 512 * 1_024;
export const EVALUATION_API_MAX_ERROR_MESSAGE_LENGTH = 512;
export const EVALUATION_API_TIMEOUT_MS = 15_000;
export const EVALUATION_RUN_POLL_INTERVAL_MS = 2_000;
export const EVALUATION_RUN_TIMEOUT_MS = 300_000;

export const EVALUATION_MAX_MARKETS = 6;
export const EVALUATION_LOOKBACK_MIN_BARS = 500;
export const EVALUATION_LOOKBACK_MAX_BARS = 20_000;
export const EVALUATION_TRAIN_FRACTION_MIN = 0.5;
export const EVALUATION_TRAIN_FRACTION_MAX = 0.9;
export const EVALUATION_EMBARGO_MIN_BARS = 0;
export const EVALUATION_EMBARGO_MAX_BARS = 500;
export const EVALUATION_DEFAULT_TRAIN_FRACTION = 0.7;
export const EVALUATION_DEFAULT_EMBARGO_BARS = 8;
export const EVALUATION_RESULT_SCHEMA_VERSION = "multi-market-eval-v1";

export class EvaluationApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    const safeStatus = boundedStatus(status);
    const safeCode = boundedCode(code, safeStatus);
    super(boundedMessage(message, safeStatus));
    this.name = "EvaluationApiError";
    this.status = safeStatus;
    this.code = safeCode;
  }
}

export interface EvaluationMarketRequest {
  symbol: string;
  timeframe: string;
}

export interface MultiMarketEvaluationRequest {
  /** Canonical Strategy IR; the server re-validates it via parseStrategyIR. */
  ir: unknown;
  markets: readonly EvaluationMarketRequest[];
  lookbackBars: number;
  split: { trainFraction: number; embargoBars: number };
  seed: number;
}

export interface EvaluationJobSnapshot {
  id: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  result?: Record<string, unknown>;
  errorCode?: string;
  errorMessage?: string;
}

export interface EvaluationWindowMetrics {
  netProfitPct: number;
  sharpe: number;
  profitFactor: number;
  maxDrawdownPct: number;
  trades: number;
  liquidated: boolean;
}

export interface EvaluationMarketResult {
  symbol: string;
  timeframe: string;
  train: EvaluationWindowMetrics;
  outOfSample: EvaluationWindowMetrics;
}

export interface MultiMarketEvaluationResult {
  schemaVersion: typeof EVALUATION_RESULT_SCHEMA_VERSION;
  engineVersion: string;
  datasetFingerprint: string;
  seed: number;
  markets: EvaluationMarketResult[];
}

export interface RunEvaluationOptions {
  signal?: AbortSignal;
  pollIntervalMs?: number;
  timeoutMs?: number;
  /** Observes every job snapshot (id + status) so callers can surface state. */
  onJob?: (snapshot: EvaluationJobSnapshot) => void;
}

/** Enqueues one multi-market evaluation job without waiting for completion. */
export function submitMultiMarketEvaluation(ownerUserId: string, request: MultiMarketEvaluationRequest, signal?: AbortSignal): Promise<EvaluationJobSnapshot> {
  const body = JSON.stringify(validEvaluationRequest(request));
  return jobRequest(JOBS_API_BASE, ownerUserId, { method: "POST", body, signal }, true);
}

export function getEvaluationJob(ownerUserId: string, jobId: string, signal?: AbortSignal): Promise<EvaluationJobSnapshot> {
  const id = validUuid(jobId, "job identifier");
  return jobRequest(`${JOBS_API_BASE}/${encodeURIComponent(id)}`, ownerUserId, { method: "GET", signal }, false);
}

/** Best-effort cancellation: active jobs stop, terminal jobs stay untouched. */
export async function cancelEvaluationJob(ownerUserId: string, jobId: string): Promise<void> {
  try {
    await jobRequest(`${JOBS_API_BASE}/${encodeURIComponent(validUuid(jobId, "job identifier"))}/cancel`, ownerUserId, { method: "POST", body: JSON.stringify({}) }, true);
  } catch {
    // The poll loop observes the authoritative terminal state; a lost cancel
    // request only means the job finishes and is pruned by retention.
  }
}

/**
 * Submits one evaluation and polls it to a terminal state. Bounded: one poll
 * every pollIntervalMs, overall deadline timeoutMs, abortable via signal.
 * Failed and cancelled jobs surface as explicit EvaluationApiError codes.
 */
export async function runMultiMarketEvaluation(ownerUserId: string, request: MultiMarketEvaluationRequest, options: RunEvaluationOptions = {}): Promise<MultiMarketEvaluationResult> {
  const pollIntervalMs = boundedPollInterval(options.pollIntervalMs);
  const timeoutMs = boundedRunTimeout(options.timeoutMs);
  const deadline = Date.now() + timeoutMs;
  let job = await submitMultiMarketEvaluation(ownerUserId, request, options.signal);
  options.onJob?.(job);
  while (job.status === "queued" || job.status === "running") {
    if (Date.now() + pollIntervalMs > deadline) {
      void cancelEvaluationJob(ownerUserId, job.id);
      throw new EvaluationApiError(0, "run_timeout", `Server evaluation did not finish within ${timeoutMs} ms.`);
    }
    await delay(pollIntervalMs, options.signal);
    job = await getEvaluationJob(ownerUserId, job.id, options.signal);
    options.onJob?.(job);
  }
  if (job.status === "cancelled") throw new EvaluationApiError(0, "run_cancelled", "Server evaluation was cancelled.");
  if (job.status === "failed") {
    throw new EvaluationApiError(0, job.errorCode ?? "run_failed", job.errorMessage ?? "Server evaluation failed.");
  }
  const parsed = parseEvaluationResult(job.result);
  if (!parsed) throw new EvaluationApiError(0, "invalid_response", "Server evaluation completed with an invalid result.");
  return parsed;
}

/**
 * Validates the completed job result against the multi-market-eval-v1 shape.
 * Metric values stay untouched: the pure ranker fails closed on non-finite
 * numbers, so honesty gates live in one place instead of two.
 */
export function parseEvaluationResult(value: unknown): MultiMarketEvaluationResult | undefined {
  const input = objectValue(value);
  if (!input || input.schemaVersion !== EVALUATION_RESULT_SCHEMA_VERSION) return undefined;
  const engineVersion = textValue(input.engineVersion);
  const dataset = objectValue(input.dataset);
  const fingerprint = typeof dataset?.fingerprint === "string" && DATASET_FINGERPRINT.test(dataset.fingerprint) ? dataset.fingerprint : undefined;
  const seed = integerValue(input.seed);
  if (!engineVersion || engineVersion.length > 120 || !fingerprint || seed === undefined) return undefined;
  if (!Array.isArray(input.markets) || input.markets.length < 1 || input.markets.length > EVALUATION_MAX_MARKETS) return undefined;
  const markets: EvaluationMarketResult[] = [];
  for (const entry of input.markets) {
    const market = objectValue(entry);
    const symbol = textValue(market?.symbol);
    const timeframe = textValue(market?.timeframe);
    const train = evaluationWindow(market?.train);
    const outOfSample = evaluationWindow(market?.outOfSample);
    if (!symbol || symbol.length > 24 || !timeframe || timeframe.length > 16 || !train || !outOfSample) return undefined;
    markets.push({ symbol, timeframe, train, outOfSample });
  }
  return { schemaVersion: EVALUATION_RESULT_SCHEMA_VERSION, engineVersion, datasetFingerprint: fingerprint, seed, markets };
}

function evaluationWindow(value: unknown): EvaluationWindowMetrics | undefined {
  const window = objectValue(value);
  if (!window) return undefined;
  // The window may embed engine metrics flattened or under a `metrics` key.
  const metrics = objectValue(window.metrics) ?? window;
  const netProfitPct = metricValue(metrics.netProfitPct);
  const sharpe = metricValue(metrics.sharpe);
  const profitFactor = metricValue(metrics.profitFactor);
  const maxDrawdownPct = metricValue(metrics.maxDrawdownPct);
  const trades = integerValue(window.tradeCount) ?? integerValue(metrics.totalTrades) ?? integerValue(metrics.trades);
  const liquidated = metrics.liquidated;
  if (netProfitPct === undefined || sharpe === undefined || profitFactor === undefined || maxDrawdownPct === undefined) return undefined;
  if (trades === undefined || trades < 0 || typeof liquidated !== "boolean") return undefined;
  return { netProfitPct, sharpe, profitFactor, maxDrawdownPct, trades, liquidated };
}

function validEvaluationRequest(request: MultiMarketEvaluationRequest): Record<string, unknown> {
  if (request.ir === undefined || request.ir === null) {
    throw new EvaluationApiError(0, "invalid_request", "Evaluation strategy IR is missing.");
  }
  if (!Array.isArray(request.markets) || request.markets.length < 1 || request.markets.length > EVALUATION_MAX_MARKETS) {
    throw new EvaluationApiError(0, "invalid_request", `Evaluation requires 1 to ${EVALUATION_MAX_MARKETS} markets.`);
  }
  const seen = new Set<string>();
  const markets = request.markets.map((market) => {
    if (!SYMBOL.test(market.symbol) || !TIMEFRAME.test(market.timeframe)) {
      throw new EvaluationApiError(0, "invalid_request", "Evaluation market symbol or timeframe is invalid.");
    }
    const key = `${market.symbol}\n${market.timeframe}`;
    if (seen.has(key)) throw new EvaluationApiError(0, "invalid_request", "Evaluation markets must be unique.");
    seen.add(key);
    return { symbol: market.symbol, timeframe: market.timeframe };
  });
  const lookbackBars = request.lookbackBars;
  if (!Number.isSafeInteger(lookbackBars) || lookbackBars < EVALUATION_LOOKBACK_MIN_BARS || lookbackBars > EVALUATION_LOOKBACK_MAX_BARS) {
    throw new EvaluationApiError(0, "invalid_request", "Evaluation lookback is out of bounds.");
  }
  const { trainFraction, embargoBars } = request.split;
  if (!Number.isFinite(trainFraction) || trainFraction < EVALUATION_TRAIN_FRACTION_MIN || trainFraction > EVALUATION_TRAIN_FRACTION_MAX) {
    throw new EvaluationApiError(0, "invalid_request", "Evaluation train fraction is out of bounds.");
  }
  if (!Number.isSafeInteger(embargoBars) || embargoBars < EVALUATION_EMBARGO_MIN_BARS || embargoBars > EVALUATION_EMBARGO_MAX_BARS) {
    throw new EvaluationApiError(0, "invalid_request", "Evaluation embargo is out of bounds.");
  }
  if (!Number.isSafeInteger(request.seed) || request.seed < 0) {
    throw new EvaluationApiError(0, "invalid_request", "Evaluation seed is invalid.");
  }
  return {
    kind: "multi-market-eval",
    ir: request.ir,
    markets,
    lookbackBars,
    split: { trainFraction, embargoBars },
    seed: request.seed
  };
}

function delay(durationMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }
    const timer = window.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, durationMs);
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(abortReason(signal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function abortReason(signal?: AbortSignal): unknown {
  return signal?.reason ?? new DOMException("Server evaluation was aborted.", "AbortError");
}

async function jobRequest(path: string, ownerUserId: string, init: RequestInit, mutation: boolean): Promise<EvaluationJobSnapshot> {
  const { status, value } = await researchApiRequest(path, ownerUserId, init, mutation);
  const snapshot = parseResearchJobEnvelope(value);
  if (!snapshot) throw new EvaluationApiError(status, "invalid_response", "Research job service returned an invalid response.");
  return snapshot;
}

/**
 * Shared owner-scoped research API transport: bounded JSON responses, CSRF on
 * mutations, per-request timeout, abort relay and explicit error codes. Also
 * reused by the GA evolution client (R9.2) so both research features keep one
 * transport honesty gate.
 */
export async function researchApiRequest(path: string, ownerUserId: string, init: RequestInit, mutation: boolean): Promise<{ status: number; value: unknown }> {
  const owner = validUuid(ownerUserId, "owner identifier");
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  headers.set("X-SBV2-Expected-User", owner);
  if (init.body !== undefined) headers.set("Content-Type", "application/json");
  if (mutation) {
    const csrf = getCsrfToken();
    if (csrf) headers.set("X-CSRF-Token", csrf);
  }

  const timeout = new AbortController();
  const timeoutId = window.setTimeout(() => timeout.abort(new DOMException("Evaluation request timed out.", "TimeoutError")), EVALUATION_API_TIMEOUT_MS);
  const relayAbort = () => timeout.abort(init.signal?.reason);
  init.signal?.addEventListener("abort", relayAbort, { once: true });
  if (init.signal?.aborted) relayAbort();
  try {
    const response = await fetch(path, {
      ...init,
      signal: timeout.signal,
      headers,
      credentials: "same-origin",
      cache: "no-store"
    });
    const value = await readBoundedJson(response);
    if (!response.ok) throw errorFromResponse(response.status, value);
    return { status: response.status, value };
  } catch (error) {
    if (timeout.signal.reason instanceof DOMException && timeout.signal.reason.name === "TimeoutError" && !init.signal?.aborted) {
      throw new EvaluationApiError(0, "request_timeout", "Research job service request timed out.");
    }
    if (error instanceof EvaluationApiError) throw error;
    if (isAbort(error) || init.signal?.aborted) throw error;
    throw new EvaluationApiError(0, "network_error", "Research job service is unavailable.");
  } finally {
    window.clearTimeout(timeoutId);
    init.signal?.removeEventListener("abort", relayAbort);
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/json")) {
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return undefined;
    }
    throw new EvaluationApiError(response.status, "invalid_response", "Research job service returned a non-JSON response.");
  }

  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && /^\d+$/.test(declaredLength) && Number(declaredLength) > EVALUATION_API_MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw oversizedResponse(response.status);
  }

  let text: string;
  try {
    text = await readBoundedText(response);
  } catch (error) {
    if (error instanceof EvaluationApiError || isAbort(error)) throw error;
    throw new EvaluationApiError(response.status, "invalid_response", "Research job service response could not be read.");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new EvaluationApiError(response.status, "invalid_response", "Research job service returned invalid JSON.");
  }
}

async function readBoundedText(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      totalBytes += result.value.byteLength;
      if (totalBytes > EVALUATION_API_MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw oversizedResponse(response.status);
      }
      chunks.push(decoder.decode(result.value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  } finally {
    reader.releaseLock();
  }
}

export function parseResearchJobEnvelope(value: unknown): EvaluationJobSnapshot | undefined {
  const input = objectValue(objectValue(value)?.job);
  if (!input || typeof input.id !== "string" || !UUID.test(input.id) || typeof input.status !== "string" || !JOB_STATUSES.has(input.status)) {
    return undefined;
  }
  const snapshot: EvaluationJobSnapshot = { id: input.id, status: input.status as EvaluationJobSnapshot["status"] };
  const result = objectValue(input.result);
  if (result) snapshot.result = result;
  if (typeof input.errorCode === "string") snapshot.errorCode = input.errorCode;
  if (typeof input.errorMessage === "string") snapshot.errorMessage = input.errorMessage;
  return snapshot;
}

function errorFromResponse(status: number, value: unknown): EvaluationApiError {
  const input = objectValue(value);
  const code = textValue(input?.code) ?? `http_${boundedStatus(status)}`;
  const message = textValue(input?.error) ?? textValue(input?.message) ?? `Research job request failed with status ${boundedStatus(status)}.`;
  return new EvaluationApiError(status, code, message);
}

function oversizedResponse(status: number): EvaluationApiError {
  return new EvaluationApiError(status, "evaluation_response_too_large", `Research job service response exceeds ${EVALUATION_API_MAX_RESPONSE_BYTES} bytes.`);
}

function validUuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new EvaluationApiError(0, "invalid_request", `Evaluation ${label} is invalid.`);
  }
  return value;
}

function boundedPollInterval(value: number | undefined): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 250 && value <= 30_000 ? value : EVALUATION_RUN_POLL_INTERVAL_MS;
}

function boundedRunTimeout(value: number | undefined): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1_000 && value <= 600_000 ? value : EVALUATION_RUN_TIMEOUT_MS;
}

function boundedStatus(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 599 ? value : 0;
}

function boundedCode(value: unknown, status: number): string {
  return typeof value === "string" && ERROR_CODE.test(value) ? value : status === 0 ? "evaluation_error" : `http_${status}`;
}

function boundedMessage(value: unknown, status: number): string {
  const fallback = status === 0 ? "Research job request failed." : `Research job request failed with status ${status}.`;
  if (typeof value !== "string") return fallback;
  const normalized = [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 || codePoint === 127 ? " " : character;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return normalized ? normalized.slice(0, EVALUATION_API_MAX_ERROR_MESSAGE_LENGTH) : fallback;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

/**
 * Engine metric numbers pass through untouched, with one JSON reality: a
 * non-finite value (e.g. profitFactor = Infinity for a window with no losing
 * trades) can only be stored as null in the durable JSONB result. null means
 * "measured, not storable" and maps to NaN so the pure ranker — the single
 * honesty gate — fails that window closed instead of the whole result.
 */
function metricValue(value: unknown): number | undefined {
  if (value === null) return Number.NaN;
  return numberValue(value);
}

function integerValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function isAbort(value: unknown): boolean {
  return typeof value === "object" && value !== null && "name" in value && value.name === "AbortError";
}
