import { getCsrfToken } from "../auth/client";
import {
  parsePaperPortfolioDetail,
  parsePaperPortfolioList,
  parsePaperPortfolioMutation
} from "./paperPortfolioParser";
import type {
  PaperMoney,
  PaperPortfolioDetail,
  PaperPortfolioListResponse,
  PaperPortfolioMutationResult,
  PaperRobotAction
} from "./paperPortfolioTypes";

const BASE = "/api/trade/paper-portfolios";

export class PaperPortfolioApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
    this.name = "PaperPortfolioApiError";
  }
}

export interface PaperMutationOptions {
  idempotencyKey: string;
  signal?: AbortSignal;
}

export interface PaperPortfolioRevisionInput {
  expectedPortfolioRevision: number;
  expectedLedgerEpoch: number;
}

export function listPaperPortfolios(ownerUserId: string, signal?: AbortSignal): Promise<PaperPortfolioListResponse> {
  return request("", ownerUserId, { signal }).then((value) => parsePaperPortfolioList(value, ownerUserId));
}

export function getPaperPortfolio(ownerUserId: string, portfolioId: string, signal?: AbortSignal): Promise<PaperPortfolioDetail> {
  return request(`/${segment(portfolioId)}`, ownerUserId, { signal })
    .then((value) => parsePaperPortfolioDetail(value, ownerUserId, portfolioId));
}

export function createPaperPortfolio(
  ownerUserId: string,
  input: { name: string; initialCapital: PaperMoney; currency?: "USDT" },
  options: PaperMutationOptions
): Promise<PaperPortfolioMutationResult> {
  return mutate("", ownerUserId, {
    method: "POST",
    body: { name: input.name, initialCapital: input.initialCapital, currency: input.currency ?? "USDT" }
  }, options);
}

export function renamePaperPortfolio(
  ownerUserId: string,
  portfolioId: string,
  input: PaperPortfolioRevisionInput & { name: string },
  options: PaperMutationOptions
): Promise<PaperPortfolioMutationResult> {
  return mutate(`/${segment(portfolioId)}`, ownerUserId, { method: "PATCH", body: input }, options);
}

export function setDefaultPaperPortfolio(
  ownerUserId: string,
  portfolioId: string,
  input: PaperPortfolioRevisionInput,
  options: PaperMutationOptions
): Promise<PaperPortfolioMutationResult> {
  return mutate(`/${segment(portfolioId)}/default`, ownerUserId, { method: "POST", body: input }, options);
}

export function archivePaperPortfolio(
  ownerUserId: string,
  portfolioId: string,
  input: PaperPortfolioRevisionInput & { confirmName: string },
  options: PaperMutationOptions
): Promise<PaperPortfolioMutationResult> {
  return mutate(`/${segment(portfolioId)}/archive`, ownerUserId, {
    method: "POST",
    body: { ...input, confirm: "ARCHIVE_PAPER_PORTFOLIO" }
  }, options);
}

export function resetPaperPortfolio(
  ownerUserId: string,
  portfolioId: string,
  input: PaperPortfolioRevisionInput & { confirmName: string; initialCapital?: PaperMoney },
  options: PaperMutationOptions
): Promise<PaperPortfolioMutationResult> {
  return mutate(`/${segment(portfolioId)}/reset`, ownerUserId, {
    method: "POST",
    body: { ...input, confirm: "RESET_PAPER_PORTFOLIO" }
  }, options);
}

export function runPaperRobotAction(
  ownerUserId: string,
  portfolioId: string,
  botId: string,
  input: PaperPortfolioRevisionInput & { expectedBotRevision: number; action: PaperRobotAction },
  options: PaperMutationOptions
): Promise<PaperPortfolioMutationResult> {
  return mutate(`/${segment(portfolioId)}/robots/${segment(botId)}/actions`, ownerUserId, {
    method: "POST",
    body: { ...input, confirm: true }
  }, options);
}

/**
 * Opaque research source for a durable multi-leg paper intent. The opportunity
 * payload is passed through unmodified; the server re-validates it fail-closed
 * before any plan is built. It never carries credentials.
 */
export interface PaperMultiLegSubmitSource {
  type: "n-leg" | "route-family";
  opportunity: Record<string, unknown>;
  family?: string;
}

/** Per-leg deterministic paper failure-injection overrides; absent fields keep server defaults. */
export interface PaperMultiLegFillScenarioInput {
  fillRatioBps?: number;
  compensationFillRatioBps?: number;
  compensationPrice?: number;
  compensationFeeBps?: number;
}

/** Submits the "paper-multi-leg.submit" payload kind through the fenced executor path. */
export function submitPaperMultiLegIntent(
  ownerUserId: string,
  portfolioId: string,
  input: { source: PaperMultiLegSubmitSource; fillScenario?: PaperMultiLegFillScenarioInput[] },
  options: PaperMutationOptions
): Promise<PaperPortfolioMutationResult> {
  return mutate(`/${segment(portfolioId)}/multi-leg`, ownerUserId, {
    method: "POST",
    body: {
      kind: "paper-multi-leg.submit",
      source: input.source,
      ...(input.fillScenario ? { fillScenario: input.fillScenario } : {})
    }
  }, options);
}

/** Submits the owner-level "paper-multi-leg.kill-switch" payload kind through the fenced executor path. */
export function setPaperMultiLegKillSwitch(
  ownerUserId: string,
  input: { enabled: boolean },
  options: PaperMutationOptions
): Promise<{ enabled: boolean }> {
  const key = requiredHeader(options.idempotencyKey, "Idempotency-Key");
  return request("/multi-leg/kill-switch", ownerUserId, {
    method: "POST",
    body: JSON.stringify({ kind: "paper-multi-leg.kill-switch", enabled: input.enabled }),
    headers: { "Idempotency-Key": key },
    signal: options.signal
  }).then((value) => {
    const item = asRecord(value);
    return { enabled: typeof item?.enabled === "boolean" ? item.enabled : input.enabled };
  });
}

export function createPaperIdempotencyKey(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function mutate(
  path: string,
  ownerUserId: string,
  init: { method: "POST" | "PATCH"; body: object },
  options: PaperMutationOptions
): Promise<PaperPortfolioMutationResult> {
  const key = requiredHeader(options.idempotencyKey, "Idempotency-Key");
  return request(path, ownerUserId, {
    method: init.method,
    body: JSON.stringify(init.body),
    headers: { "Idempotency-Key": key },
    signal: options.signal
  }).then((value) => parsePaperPortfolioMutation(value, ownerUserId));
}

async function request(path: string, ownerUserId: string, init: RequestInit = {}): Promise<unknown> {
  const expectedOwner = requiredHeader(ownerUserId, "X-SBV2-Expected-User");
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  headers.set("X-SBV2-Expected-User", expectedOwner);
  if (init.body !== undefined) headers.set("Content-Type", "application/json");
  const csrf = getCsrfToken();
  if (csrf) headers.set("X-CSRF-Token", csrf);

  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      ...init,
      headers,
      credentials: "same-origin",
      cache: "no-store"
    });
  } catch (cause) {
    if (isAbort(cause)) throw cause;
    throw new PaperPortfolioApiError(0, "network_error", "Paper portfolio service is unavailable.", cause);
  }

  const body = await readJson(response);
  if (!response.ok) {
    const item = asRecord(body);
    throw new PaperPortfolioApiError(
      response.status,
      textValue(item?.code) ?? `http_${response.status}`,
      textValue(item?.message) ?? textValue(item?.error) ?? `HTTP ${response.status}`,
      item?.details
    );
  }
  return body;
}

async function readJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    if (response.ok) throw new PaperPortfolioApiError(response.status, "invalid_response", "Paper portfolio service returned a non-JSON response.");
    return {};
  }
  try {
    return await response.json();
  } catch {
    throw new PaperPortfolioApiError(response.status, "invalid_response", "Paper portfolio service returned invalid JSON.");
  }
}

function requiredHeader(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized || /[\r\n]/.test(normalized)) throw new Error(`${name} is required`);
  return normalized;
}

function segment(value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error("Paper portfolio identifier is required");
  return encodeURIComponent(normalized);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function textValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isAbort(value: unknown): boolean {
  return typeof value === "object" && value !== null && "name" in value && value.name === "AbortError";
}
