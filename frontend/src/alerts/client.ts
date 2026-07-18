import { ALERT_EVENT_PAGE_SCHEMA_V1, parseAlertEventPageV1, parseAlertEventV1, parseAlertRuleDocumentV1, parseAlertRuleListV1, parseAlertRuleRecordV1, parseNotificationOutboxItemV1, type AlertEventV1, type AlertRuleDocumentV1, type AlertRuleListV1, type AlertRuleRecordV1, type NotificationOutboxItemV1 } from "@saltanatbotv2/contracts";
import { getCsrfToken } from "../auth/client";

const ALERT_API_BASE = "/api/alerts";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLIENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const ERROR_CODE = /^[a-z][a-z0-9._-]{0,95}$/;
const OPAQUE_CURSOR = /^[A-Za-z0-9_-]{1,256}$/;

export const ALERT_API_MAX_RESPONSE_BYTES = 512 * 1_024;
export const ALERT_API_MAX_ERROR_MESSAGE_LENGTH = 512;
export const ALERT_API_TIMEOUT_MS = 15_000;

export class AlertApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    const safeStatus = boundedStatus(status);
    const safeCode = boundedCode(code, safeStatus);
    super(boundedMessage(message, safeStatus));
    this.name = "AlertApiError";
    this.status = safeStatus;
    this.code = safeCode;
  }
}

export interface CreateAlertRuleInput {
  clientId: string;
  definition: AlertRuleDocumentV1;
}

export interface UpdateAlertRuleInput {
  expectedRevision: number;
  definition: AlertRuleDocumentV1;
}

export interface AlertEventList {
  events: AlertEventV1[];
  nextCursor?: string;
  hasMore?: boolean;
  generatedAt?: string;
  researchOnly: true;
  executionPermission: false;
}

export interface AlertOutboxList {
  items: NotificationOutboxItemV1[];
  researchOnly: true;
  executionPermission: false;
}

export type AlertBindingStatus = "pending" | "active" | "revoked";

/** Owner-scoped public projection of a Telegram notification binding. */
export interface AlertBindingRecord {
  id: string;
  status: AlertBindingStatus;
  revision: number;
  /** Hashed recipient display handle (fingerprint prefix); never a chat id. */
  recipientHandle: string;
  createdAt: string;
  activatedAt?: string;
  revokedAt?: string;
}

export interface AlertBindingList {
  bindings: AlertBindingRecord[];
  researchOnly: true;
  executionPermission: false;
}

/** One-consume binding code. The raw code is returned exactly once. */
export interface AlertBindingCodeGrant {
  code: string;
  expiresAt: string;
}

export function listAlertRules(ownerUserId: string, signal?: AbortSignal): Promise<AlertRuleListV1> {
  return request(ALERT_API_BASE, ownerUserId, { method: "GET", signal }, false, parseAlertRuleListV1);
}

export function listAlertEvents(ownerUserId: string, options: { ruleId?: string; limit?: number; cursor?: string; since?: string } = {}, signal?: AbortSignal): Promise<AlertEventList> {
  const query = new URLSearchParams();
  if (options.ruleId !== undefined) query.set("ruleId", validUuid(options.ruleId, "rule identifier"));
  if (options.cursor !== undefined) query.set("cursor", validCursor(options.cursor));
  if (options.since !== undefined) query.set("since", validSince(options.since));
  query.set("limit", String(validLimit(options.limit)));
  return request(`${ALERT_API_BASE}/events?${query}`, ownerUserId, { method: "GET", signal }, false, parseEventList);
}

export function listAlertOutbox(ownerUserId: string, limit = 50, signal?: AbortSignal): Promise<AlertOutboxList> {
  return request(`${ALERT_API_BASE}/outbox?limit=${validLimit(limit)}`, ownerUserId, { method: "GET", signal }, false, parseOutboxList);
}

export function createAlertRule(ownerUserId: string, input: CreateAlertRuleInput, signal?: AbortSignal): Promise<AlertRuleRecordV1> {
  const clientId = validClientId(input.clientId);
  const definition = validDefinition(input.definition);
  return mutate(ALERT_API_BASE, ownerUserId, "POST", { clientId, definition }, signal);
}

export function updateAlertRule(ownerUserId: string, ruleId: string, input: UpdateAlertRuleInput, signal?: AbortSignal): Promise<AlertRuleRecordV1> {
  const id = validUuid(ruleId, "rule identifier");
  const expectedRevision = validRevision(input.expectedRevision);
  const definition = validDefinition(input.definition);
  return mutate(`${ALERT_API_BASE}/${encodeURIComponent(id)}`, ownerUserId, "PUT", { expectedRevision, definition }, signal);
}

export function archiveAlertRule(ownerUserId: string, ruleId: string, expectedRevision: number, signal?: AbortSignal): Promise<AlertRuleRecordV1> {
  return revisionMutation(ownerUserId, ruleId, "archive", expectedRevision, signal);
}

export function rearmAlertRule(ownerUserId: string, ruleId: string, expectedRevision: number, signal?: AbortSignal): Promise<AlertRuleRecordV1> {
  return revisionMutation(ownerUserId, ruleId, "rearm", expectedRevision, signal);
}

export function listAlertBindings(ownerUserId: string, signal?: AbortSignal): Promise<AlertBindingList> {
  return request(`${ALERT_API_BASE}/bindings`, ownerUserId, { method: "GET", signal }, false, parseBindingList);
}

export function createAlertBindingCode(ownerUserId: string, signal?: AbortSignal): Promise<AlertBindingCodeGrant> {
  return request(`${ALERT_API_BASE}/bindings/codes`, ownerUserId, { method: "POST", body: JSON.stringify({}), signal }, true, parseBindingCodeGrant);
}

export function revokeAlertBinding(ownerUserId: string, bindingId: string, expectedRevision: number, signal?: AbortSignal): Promise<AlertBindingRecord> {
  const id = validUuid(bindingId, "binding identifier");
  const body = JSON.stringify({ expectedRevision: validRevision(expectedRevision) });
  return request(`${ALERT_API_BASE}/bindings/${encodeURIComponent(id)}/revoke`, ownerUserId, { method: "POST", body, signal }, true, parseBindingEnvelope);
}

function revisionMutation(ownerUserId: string, ruleId: string, action: "archive" | "rearm", expectedRevision: number, signal?: AbortSignal): Promise<AlertRuleRecordV1> {
  const id = validUuid(ruleId, "rule identifier");
  return mutate(`${ALERT_API_BASE}/${encodeURIComponent(id)}/${action}`, ownerUserId, "POST", { expectedRevision: validRevision(expectedRevision) }, signal);
}

function mutate(path: string, ownerUserId: string, method: "POST" | "PUT", body: Record<string, unknown>, signal?: AbortSignal): Promise<AlertRuleRecordV1> {
  return request(path, ownerUserId, { method, body: JSON.stringify(body), signal }, true, parseRuleEnvelope);
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
  const timeoutId = window.setTimeout(() => timeout.abort(new DOMException("Alert request timed out.", "TimeoutError")), ALERT_API_TIMEOUT_MS);
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
      if (error instanceof AlertApiError) throw error;
      throw new AlertApiError(response.status, "invalid_response", "Alert service returned an invalid response.");
    }
  } catch (error) {
    if (timeout.signal.reason instanceof DOMException && timeout.signal.reason.name === "TimeoutError" && !init.signal?.aborted) {
      throw new AlertApiError(0, "request_timeout", "Alert service request timed out.");
    }
    if (error instanceof AlertApiError) throw error;
    if (isAbort(error) || init.signal?.aborted) throw error;
    throw new AlertApiError(0, "network_error", "Alert service is unavailable.");
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
    throw new AlertApiError(response.status, "invalid_response", "Alert service returned a non-JSON response.");
  }

  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null && /^\d+$/.test(declaredLength) && Number(declaredLength) > ALERT_API_MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw oversizedResponse(response.status);
  }

  let text: string;
  try {
    text = await readBoundedText(response);
  } catch (error) {
    if (error instanceof AlertApiError || isAbort(error)) throw error;
    throw new AlertApiError(response.status, "invalid_response", "Alert service response could not be read.");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AlertApiError(response.status, "invalid_response", "Alert service returned invalid JSON.");
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
      if (totalBytes > ALERT_API_MAX_RESPONSE_BYTES) {
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

function parseRuleEnvelope(value: unknown): AlertRuleRecordV1 {
  const input = objectValue(value);
  if (!input || Object.keys(input).length !== 1 || !("rule" in input)) {
    throw new Error("alert rule envelope is invalid");
  }
  return parseAlertRuleRecordV1(input.rule);
}

function parseEventList(value: unknown): AlertEventList {
  if (objectValue(value)?.schemaVersion === ALERT_EVENT_PAGE_SCHEMA_V1) return parseAlertEventPageV1(value);
  // Explicit compatibility fallback for a pre-cursor server. The hook treats a
  // saturated legacy window as incomplete instead of claiming lossless delivery.
  const input = collectionEnvelope(value, "events", ["nextCursor", "hasMore", "generatedAt"]);
  if (!Array.isArray(input.events) || input.events.length > 200) throw new Error("alert event list is invalid");
  const events = input.events.map(parseAlertEventV1);
  if (new Set(events.map(({ id }) => id)).size !== events.length) throw new Error("alert event list contains duplicates");
  const nextCursor = input.nextCursor === undefined ? undefined : validCursor(input.nextCursor);
  const hasMore = input.hasMore === undefined ? undefined : input.hasMore === true ? true : input.hasMore === false ? false : invalidBoolean("hasMore");
  if (hasMore && !nextCursor) throw new Error("alert event page is missing its next cursor");
  const generatedAt = input.generatedAt === undefined ? undefined : validTimestamp(input.generatedAt, "generatedAt");
  return {
    events,
    ...(nextCursor ? { nextCursor } : {}),
    ...(hasMore !== undefined ? { hasMore } : {}),
    ...(generatedAt ? { generatedAt } : {}),
    researchOnly: true,
    executionPermission: false
  };
}

function parseOutboxList(value: unknown): AlertOutboxList {
  const input = collectionEnvelope(value, "items");
  if (!Array.isArray(input.items) || input.items.length > 200) throw new Error("alert outbox list is invalid");
  const items = input.items.map(parseNotificationOutboxItemV1);
  if (new Set(items.map(({ id }) => id)).size !== items.length) throw new Error("alert outbox list contains duplicates");
  return { items, researchOnly: true, executionPermission: false };
}

const BINDING_HANDLE = /^[0-9a-f]{8,64}$/;
const BINDING_CODE = /^[A-Za-z0-9._-]{8,128}$/;

/**
 * Binding parsers validate every consumed field strictly but tolerate unknown
 * envelope keys: the projection is additive server-side and the UI must fail
 * closed on bad data without breaking on forward-compatible fields.
 */
function parseBindingList(value: unknown): AlertBindingList {
  const input = objectValue(value);
  if (!input || !Array.isArray(input.bindings) || input.bindings.length > 100) throw new Error("alert binding list is invalid");
  if ("researchOnly" in input && input.researchOnly !== true) throw new Error("alert binding list is not research-only");
  if ("executionPermission" in input && input.executionPermission !== false) throw new Error("alert binding list claims execution permission");
  const bindings = input.bindings.map(parseBinding);
  if (new Set(bindings.map(({ id }) => id)).size !== bindings.length) throw new Error("alert binding list contains duplicates");
  return { bindings, researchOnly: true, executionPermission: false };
}

function parseBindingEnvelope(value: unknown): AlertBindingRecord {
  const input = objectValue(value);
  return parseBinding(input && "binding" in input ? input.binding : value);
}

function parseBinding(value: unknown): AlertBindingRecord {
  const input = objectValue(value);
  if (!input || typeof input.id !== "string" || !UUID.test(input.id)) throw new Error("alert binding is invalid");
  if (input.status !== "pending" && input.status !== "active" && input.status !== "revoked") throw new Error("alert binding status is invalid");
  if (typeof input.revision !== "number" || !Number.isSafeInteger(input.revision) || input.revision < 1) throw new Error("alert binding revision is invalid");
  if (typeof input.recipientHandle !== "string" || !BINDING_HANDLE.test(input.recipientHandle)) throw new Error("alert binding recipient handle is invalid");
  const createdAt = bindingTimestamp(input.createdAt, "createdAt");
  const activatedAt = input.activatedAt === undefined || input.activatedAt === null ? undefined : bindingTimestamp(input.activatedAt, "activatedAt");
  const revokedAt = input.revokedAt === undefined || input.revokedAt === null ? undefined : bindingTimestamp(input.revokedAt, "revokedAt");
  return {
    id: input.id,
    status: input.status,
    revision: input.revision,
    recipientHandle: input.recipientHandle,
    createdAt,
    ...(activatedAt ? { activatedAt } : {}),
    ...(revokedAt ? { revokedAt } : {})
  };
}

function parseBindingCodeGrant(value: unknown): AlertBindingCodeGrant {
  const input = objectValue(value);
  if (!input || typeof input.code !== "string" || !BINDING_CODE.test(input.code)) throw new Error("alert binding code grant is invalid");
  return { code: input.code, expiresAt: bindingTimestamp(input.expiresAt, "expiresAt") };
}

function bindingTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(`alert binding ${label} is invalid`);
  }
  return value;
}

function collectionEnvelope(value: unknown, collection: "events" | "items", optional: readonly string[] = []): Record<string, unknown> {
  const input = objectValue(value);
  const allowed = new Set([collection, "researchOnly", "executionPermission", ...optional]);
  if (!input || Object.keys(input).some((key) => !allowed.has(key)) || !(collection in input) || input.researchOnly !== true || input.executionPermission !== false) {
    throw new Error("alert collection envelope is invalid");
  }
  return input;
}

function errorFromResponse(status: number, value: unknown): AlertApiError {
  const input = objectValue(value);
  const code = textValue(input?.code) ?? `http_${boundedStatus(status)}`;
  const message = textValue(input?.error) ?? textValue(input?.message) ?? `Alert request failed with status ${boundedStatus(status)}.`;
  return new AlertApiError(status, code, message);
}

function oversizedResponse(status: number): AlertApiError {
  return new AlertApiError(status, "alert_response_too_large", `Alert service response exceeds ${ALERT_API_MAX_RESPONSE_BYTES} bytes.`);
}

function validDefinition(value: unknown): AlertRuleDocumentV1 {
  try {
    return parseAlertRuleDocumentV1(value);
  } catch {
    throw new AlertApiError(0, "invalid_request", "Alert definition is invalid.");
  }
}

function validClientId(value: unknown): string {
  if (typeof value !== "string" || !CLIENT_ID.test(value)) {
    throw new AlertApiError(0, "invalid_request", "Alert client identifier is invalid.");
  }
  return value;
}

function validRevision(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new AlertApiError(0, "invalid_request", "Alert revision is invalid.");
  }
  return value;
}

function validLimit(value: unknown): number {
  const limit = value ?? 50;
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw new AlertApiError(0, "invalid_request", "Alert result limit is invalid.");
  }
  return limit;
}

function validUuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new AlertApiError(0, "invalid_request", `Alert ${label} is invalid.`);
  }
  return value;
}

function validCursor(value: unknown): string {
  if (typeof value !== "string" || !OPAQUE_CURSOR.test(value)) {
    throw new AlertApiError(0, "invalid_request", "Alert event cursor is invalid.");
  }
  return value;
}

function validSince(value: unknown): string {
  try {
    return validTimestamp(value, "since");
  } catch {
    throw new AlertApiError(0, "invalid_request", "Alert event start timestamp is invalid.");
  }
}

function validTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) || new Date(Date.parse(value)).toISOString() !== value) {
    throw new Error(`alert event page ${label} is invalid`);
  }
  return value;
}

function invalidBoolean(label: string): never {
  throw new Error(`alert event page ${label} is invalid`);
}

function boundedStatus(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 599 ? value : 0;
}

function boundedCode(value: unknown, status: number): string {
  return typeof value === "string" && ERROR_CODE.test(value) ? value : status === 0 ? "alert_error" : `http_${status}`;
}

function boundedMessage(value: unknown, status: number): string {
  const fallback = status === 0 ? "Alert request failed." : `Alert request failed with status ${status}.`;
  if (typeof value !== "string") return fallback;
  const normalized = [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 || codePoint === 127 ? " " : character;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return normalized ? normalized.slice(0, ALERT_API_MAX_ERROR_MESSAGE_LENGTH) : fallback;
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
