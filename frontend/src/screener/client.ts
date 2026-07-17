import { parseScreenerDefinitionV1, parseScreenerPresetListV1, parseScreenerPresetV1, parseScreenerRunRequestV1, parseScreenerRunResultV1, type ScreenerDefinitionV1, type ScreenerPresetListV1, type ScreenerPresetV1, type ScreenerRunRequestV1, type ScreenerRunResultV1 } from "@saltanatbotv2/contracts";
import { getCsrfToken } from "../auth/client";

const SCREENER_API_BASE = "/api/screener";
const JOBS_API_BASE = "/api/jobs";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLIENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const CLIENT_REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const ERROR_CODE = /^[a-z][a-z0-9._-]{0,95}$/;
const JOB_STATUSES = new Set(["queued", "running", "completed", "failed", "cancelled"]);

export const SCREENER_API_MAX_RESPONSE_BYTES = 512 * 1_024;
export const SCREENER_API_MAX_ERROR_MESSAGE_LENGTH = 512;
export const SCREENER_API_TIMEOUT_MS = 15_000;
export const SCREENER_RUN_POLL_INTERVAL_MS = 2_000;
export const SCREENER_RUN_TIMEOUT_MS = 120_000;

export class ScreenerApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    const safeStatus = boundedStatus(status);
    const safeCode = boundedCode(code, safeStatus);
    super(boundedMessage(message, safeStatus));
    this.name = "ScreenerApiError";
    this.status = safeStatus;
    this.code = safeCode;
  }
}

export interface CreateScreenerPresetInput {
  clientId: string;
  definition: ScreenerDefinitionV1;
}

export interface UpdateScreenerPresetInput {
  expectedRevision: number;
  definition: ScreenerDefinitionV1;
}

export interface RunScreenerOptions {
  clientRequestId: string;
  signal?: AbortSignal;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

interface ScreenerJobSnapshot {
  id: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  result?: Record<string, unknown>;
  errorCode?: string;
  errorMessage?: string;
}

export function listScreenerPresets(ownerUserId: string, signal?: AbortSignal): Promise<ScreenerPresetListV1> {
  return request(`${SCREENER_API_BASE}/presets`, ownerUserId, { method: "GET", signal }, false, parseScreenerPresetListV1);
}

export function createScreenerPreset(ownerUserId: string, input: CreateScreenerPresetInput, signal?: AbortSignal): Promise<ScreenerPresetV1> {
  const clientId = validClientId(input.clientId);
  const definition = validDefinition(input.definition);
  return mutate(`${SCREENER_API_BASE}/presets`, ownerUserId, "POST", { clientId, definition }, signal);
}

export function updateScreenerPreset(ownerUserId: string, presetId: string, input: UpdateScreenerPresetInput, signal?: AbortSignal): Promise<ScreenerPresetV1> {
  const id = validUuid(presetId, "preset identifier");
  const expectedRevision = validRevision(input.expectedRevision);
  const definition = validDefinition(input.definition);
  return mutate(`${SCREENER_API_BASE}/presets/${encodeURIComponent(id)}`, ownerUserId, "PUT", { expectedRevision, definition }, signal);
}

export function archiveScreenerPreset(ownerUserId: string, presetId: string, expectedRevision: number, signal?: AbortSignal): Promise<ScreenerPresetV1> {
  const id = validUuid(presetId, "preset identifier");
  return mutate(`${SCREENER_API_BASE}/presets/${encodeURIComponent(id)}/archive`, ownerUserId, "POST", { expectedRevision: validRevision(expectedRevision) }, signal);
}

/**
 * Enqueues a screener run as a compute job and polls it to completion.
 * Bounded: one poll every pollIntervalMs, overall deadline timeoutMs, abortable
 * through options.signal. A completed job must carry a valid run result.
 */
export async function runScreener(ownerUserId: string, runRequest: ScreenerRunRequestV1, options: RunScreenerOptions): Promise<ScreenerRunResultV1> {
  const clientRequestId = validClientRequestId(options.clientRequestId);
  const request_ = validRunRequest(runRequest);
  const pollIntervalMs = boundedPollInterval(options.pollIntervalMs);
  const timeoutMs = boundedRunTimeout(options.timeoutMs);
  const deadline = Date.now() + timeoutMs;
  let job = await request(JOBS_API_BASE, ownerUserId, { method: "POST", body: JSON.stringify({ kind: "screener", clientRequestId, request: request_ }), signal: options.signal }, true, parseJobEnvelope);
  while (job.status === "queued" || job.status === "running") {
    if (Date.now() + pollIntervalMs > deadline) {
      void cancelScreenerJob(ownerUserId, job.id);
      throw new ScreenerApiError(0, "run_timeout", `Screener run did not finish within ${timeoutMs} ms.`);
    }
    await delay(pollIntervalMs, options.signal);
    job = await request(`${JOBS_API_BASE}/${encodeURIComponent(job.id)}`, ownerUserId, { method: "GET", signal: options.signal }, false, parseJobEnvelope);
  }
  if (job.status === "cancelled") throw new ScreenerApiError(0, "run_cancelled", "Screener run was cancelled.");
  if (job.status === "failed") {
    throw new ScreenerApiError(0, job.errorCode ?? "run_failed", job.errorMessage ?? "Screener run failed.");
  }
  try {
    return parseScreenerRunResultV1(job.result);
  } catch {
    throw new ScreenerApiError(0, "invalid_response", "Screener run completed with an invalid result.");
  }
}

async function cancelScreenerJob(ownerUserId: string, jobId: string): Promise<void> {
  try {
    await request(`${JOBS_API_BASE}/${encodeURIComponent(jobId)}/cancel`, ownerUserId, { method: "POST", body: JSON.stringify({}) }, true, () => undefined);
  } catch {
    // Best-effort cancellation: the deadline error already reached the caller
    // and the server prunes abandoned jobs through compute-job retention.
  }
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
  return signal?.reason ?? new DOMException("Screener run was aborted.", "AbortError");
}

function mutate(path: string, ownerUserId: string, method: "POST" | "PUT", body: Record<string, unknown>, signal?: AbortSignal): Promise<ScreenerPresetV1> {
  return request(path, ownerUserId, { method, body: JSON.stringify(body), signal }, true, parsePresetEnvelope);
}

async function request<T>(path: string, ownerUserId: string, init: RequestInit, mutation: boolean, parser: (value: unknown) => T): Promise<T> {
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
  const timeoutId = window.setTimeout(() => timeout.abort(new DOMException("Screener request timed out.", "TimeoutError")), SCREENER_API_TIMEOUT_MS);
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
    try {
      return parser(value);
    } catch (error) {
      if (error instanceof ScreenerApiError) throw error;
      throw new ScreenerApiError(response.status, "invalid_response", "Screener service returned an invalid response.");
    }
  } catch (error) {
    if (timeout.signal.reason instanceof DOMException && timeout.signal.reason.name === "TimeoutError" && !init.signal?.aborted) {
      throw new ScreenerApiError(0, "request_timeout", "Screener service request timed out.");
    }
    if (error instanceof ScreenerApiError) throw error;
    if (isAbort(error) || init.signal?.aborted) throw error;
    throw new ScreenerApiError(0, "network_error", "Screener service is unavailable.");
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
    throw new ScreenerApiError(response.status, "invalid_response", "Screener service returned a non-JSON response.");
  }

  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && /^\d+$/.test(declaredLength) && Number(declaredLength) > SCREENER_API_MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw oversizedResponse(response.status);
  }

  let text: string;
  try {
    text = await readBoundedText(response);
  } catch (error) {
    if (error instanceof ScreenerApiError || isAbort(error)) throw error;
    throw new ScreenerApiError(response.status, "invalid_response", "Screener service response could not be read.");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ScreenerApiError(response.status, "invalid_response", "Screener service returned invalid JSON.");
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
      if (totalBytes > SCREENER_API_MAX_RESPONSE_BYTES) {
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

function parsePresetEnvelope(value: unknown): ScreenerPresetV1 {
  const input = objectValue(value);
  if (!input || Object.keys(input).length !== 1 || !("preset" in input)) {
    throw new Error("screener preset envelope is invalid");
  }
  return parseScreenerPresetV1(input.preset);
}

function parseJobEnvelope(value: unknown): ScreenerJobSnapshot {
  const input = objectValue(objectValue(value)?.job);
  if (!input || typeof input.id !== "string" || !UUID.test(input.id) || typeof input.status !== "string" || !JOB_STATUSES.has(input.status)) {
    throw new Error("screener job envelope is invalid");
  }
  const snapshot: ScreenerJobSnapshot = { id: input.id, status: input.status as ScreenerJobSnapshot["status"] };
  const result = objectValue(input.result);
  if (result) snapshot.result = result;
  if (typeof input.errorCode === "string") snapshot.errorCode = input.errorCode;
  if (typeof input.errorMessage === "string") snapshot.errorMessage = input.errorMessage;
  return snapshot;
}

function errorFromResponse(status: number, value: unknown): ScreenerApiError {
  const input = objectValue(value);
  const code = textValue(input?.code) ?? `http_${boundedStatus(status)}`;
  const message = textValue(input?.error) ?? textValue(input?.message) ?? `Screener request failed with status ${boundedStatus(status)}.`;
  return new ScreenerApiError(status, code, message);
}

function oversizedResponse(status: number): ScreenerApiError {
  return new ScreenerApiError(status, "screener_response_too_large", `Screener service response exceeds ${SCREENER_API_MAX_RESPONSE_BYTES} bytes.`);
}

function validDefinition(value: unknown): ScreenerDefinitionV1 {
  try {
    return parseScreenerDefinitionV1(value);
  } catch {
    throw new ScreenerApiError(0, "invalid_request", "Screener definition is invalid.");
  }
}

function validRunRequest(value: unknown): ScreenerRunRequestV1 {
  try {
    return parseScreenerRunRequestV1(value);
  } catch {
    throw new ScreenerApiError(0, "invalid_request", "Screener run request is invalid.");
  }
}

function validClientId(value: unknown): string {
  if (typeof value !== "string" || !CLIENT_ID.test(value)) {
    throw new ScreenerApiError(0, "invalid_request", "Screener client identifier is invalid.");
  }
  return value;
}

function validClientRequestId(value: unknown): string {
  if (typeof value !== "string" || !CLIENT_REQUEST_ID.test(value)) {
    throw new ScreenerApiError(0, "invalid_request", "Screener run request identifier is invalid.");
  }
  return value;
}

function validRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new ScreenerApiError(0, "invalid_request", "Screener preset revision is invalid.");
  }
  return value;
}

function validUuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new ScreenerApiError(0, "invalid_request", `Screener ${label} is invalid.`);
  }
  return value;
}

function boundedPollInterval(value: number | undefined): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 250 && value <= 30_000 ? value : SCREENER_RUN_POLL_INTERVAL_MS;
}

function boundedRunTimeout(value: number | undefined): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1_000 && value <= SCREENER_RUN_TIMEOUT_MS ? value : SCREENER_RUN_TIMEOUT_MS;
}

function boundedStatus(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 599 ? value : 0;
}

function boundedCode(value: unknown, status: number): string {
  return typeof value === "string" && ERROR_CODE.test(value) ? value : status === 0 ? "screener_error" : `http_${status}`;
}

function boundedMessage(value: unknown, status: number): string {
  const fallback = status === 0 ? "Screener request failed." : `Screener request failed with status ${status}.`;
  if (typeof value !== "string") return fallback;
  const normalized = [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 || codePoint === 127 ? " " : character;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return normalized ? normalized.slice(0, SCREENER_API_MAX_ERROR_MESSAGE_LENGTH) : fallback;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isAbort(value: unknown): boolean {
  return typeof value === "object" && value !== null && "name" in value && value.name === "AbortError";
}
