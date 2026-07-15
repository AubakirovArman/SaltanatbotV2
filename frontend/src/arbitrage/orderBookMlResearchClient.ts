import {
  parseResearchDeleteResponse,
  parseResearchHealthResponse,
  parseResearchIngestResponse,
  parseResearchModelResponse,
  parseResearchPredictionResponse,
  parseResearchSessionResponse,
  parseResearchSessionsResponse,
  parseResearchStatusResponse,
  parseResearchTrainingResponse,
  type ResearchDeleteResult,
  type ResearchIngestResult
} from "./orderBookMlResearchParsers";
import type { CreateResearchSessionInput, ResearchHealth, ResearchModelSummary, ResearchPredictionResult, ResearchSession, ResearchStatus, ResearchTrainingResult, SequencedL2SnapshotInput, TrainResearchModelInput } from "./orderBookMlResearchTypes";

const BASE = "/api/orderbook-ml/research";
const TOKEN_KEY = "sbv2:token";
const CSRF_KEY = "sbv2:csrf";

export class OrderBookMlResearchApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "OrderBookMlResearchApiError";
  }
}

export async function fetchOrderBookMlResearchHealth(signal?: AbortSignal): Promise<ResearchHealth> {
  return parseResearchHealthResponse(await request("/health", { signal }));
}

export async function fetchOrderBookMlResearchStatus(signal?: AbortSignal): Promise<ResearchStatus> {
  return parseResearchStatusResponse(await request("/status", { signal }));
}

export async function listOrderBookMlResearchSessions(signal?: AbortSignal): Promise<ResearchSession[]> {
  return parseResearchSessionsResponse(await request("/sessions", { signal }));
}

export async function fetchOrderBookMlResearchSession(sessionId: string, signal?: AbortSignal): Promise<ResearchSession> {
  return parseResearchSessionResponse(await request(`/sessions/${encodeURIComponent(validSessionId(sessionId))}`, { signal }));
}

export async function createOrderBookMlResearchSession(input: CreateResearchSessionInput, signal?: AbortSignal): Promise<ResearchSession> {
  validateCreateInput(input);
  return parseResearchSessionResponse(await request("/sessions", jsonRequest("POST", input, signal)));
}

export async function deleteOrderBookMlResearchSession(sessionId: string, signal?: AbortSignal): Promise<ResearchDeleteResult> {
  return parseResearchDeleteResponse(await request(`/sessions/${encodeURIComponent(validSessionId(sessionId))}`, jsonRequest("DELETE", undefined, signal)));
}

export async function uploadOrderBookMlResearchSnapshots(sessionId: string, snapshots: readonly SequencedL2SnapshotInput[], signal?: AbortSignal): Promise<ResearchIngestResult> {
  if (!Array.isArray(snapshots) || snapshots.length < 1 || snapshots.length > 250) throw new Error("Snapshot upload must contain 1..250 already-validated snapshots");
  return parseResearchIngestResponse(await request(`/sessions/${encodeURIComponent(validSessionId(sessionId))}/snapshots`, jsonRequest("POST", { snapshots }, signal)));
}

export async function trainOrderBookMlResearchModel(sessionId: string, input: TrainResearchModelInput, signal?: AbortSignal): Promise<ResearchTrainingResult> {
  validateTrainingInput(input);
  return parseResearchTrainingResponse(await request(`/sessions/${encodeURIComponent(validSessionId(sessionId))}/models`, jsonRequest("POST", input, signal)));
}

export async function fetchOrderBookMlResearchModel(sessionId: string, modelId: string, signal?: AbortSignal): Promise<ResearchModelSummary> {
  return parseResearchModelResponse(await request(`/sessions/${encodeURIComponent(validSessionId(sessionId))}/models/${encodeURIComponent(validModelId(modelId))}`, { signal }));
}

export async function predictOrderBookMlResearchModel(sessionId: string, modelId: string, snapshots: readonly SequencedL2SnapshotInput[], signal?: AbortSignal): Promise<ResearchPredictionResult> {
  if (!Array.isArray(snapshots) || snapshots.length < 1 || snapshots.length > 2) throw new Error("Inference requires 1..2 already-validated snapshots");
  const requestedModelId = validModelId(modelId);
  const requestSnapshots = snapshots.map(cloneSnapshot);
  const result = parseResearchPredictionResponse(await request(`/sessions/${encodeURIComponent(validSessionId(sessionId))}/predictions`, jsonRequest("POST", { modelId: requestedModelId, snapshots: requestSnapshots }, signal)));
  assertOrderBookMlPredictionBinding(result, requestedModelId, requestSnapshots);
  return result;
}

/** Reject a structurally valid response that is not bound to this exact inference request. */
export function assertOrderBookMlPredictionBinding(result: ResearchPredictionResult, requestedModelId: string, snapshots: readonly SequencedL2SnapshotInput[]): void {
  const current = snapshots.at(-1);
  if (!current) throw new Error("Invalid order-book ML prediction binding: current snapshot is missing");
  const prediction = result.prediction;
  if (prediction.modelId !== requestedModelId) throw new Error("Invalid order-book ML prediction binding: modelId does not match the request");
  if (prediction.instrumentId !== current.instrumentId || prediction.symbol !== current.symbol) throw new Error("Invalid order-book ML prediction binding: instrument scope does not match the current snapshot");
  if (prediction.anchorSequence !== current.sequence || prediction.anchorExchangeTs !== current.exchangeTs) throw new Error("Invalid order-book ML prediction binding: anchor does not match the current snapshot");
  if (result.provenance.snapshots !== snapshots.length || result.provenance.normalizerVersion !== current.normalizerVersion) throw new Error("Invalid order-book ML prediction binding: provenance does not match the request");
  const value = prediction.predictedReturnBps;
  // The backend permits flat for a non-zero value inside its configured flat
  // threshold. Up/down must still agree with the sign, and zero is always flat.
  if ((prediction.direction === "up" && value <= 0) || (prediction.direction === "down" && value >= 0) || (value === 0 && prediction.direction !== "flat")) {
    throw new Error("Invalid order-book ML prediction binding: direction contradicts predictedReturnBps");
  }
}

async function request(path: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    credentials: "same-origin",
    headers: { ...authHeaders(init.method), ...(init.headers ?? {}) }
  });
  const value = await response.json().catch(() => undefined);
  if (!response.ok) throw apiError(response.status, value);
  return value;
}

function jsonRequest(method: "POST" | "DELETE", body: unknown, signal?: AbortSignal): RequestInit {
  return {
    method,
    signal,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  };
}

function authHeaders(method: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  try {
    const token = sessionStorage.getItem(TOKEN_KEY) ?? localStorage.getItem(TOKEN_KEY);
    const csrf = sessionStorage.getItem(CSRF_KEY);
    if (token) headers.Authorization = `Bearer ${token}`;
    if (csrf && method && !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase())) headers["X-CSRF-Token"] = csrf;
  } catch {
    // Same-origin session cookies still authenticate when browser storage is unavailable.
  }
  return headers;
}

function apiError(status: number, value: unknown): OrderBookMlResearchApiError {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const raw = (value as Record<string, unknown>).error;
    if (typeof raw === "string") return new OrderBookMlResearchApiError(status, status === 401 ? "unauthorized" : "request-failed", raw);
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const record = raw as Record<string, unknown>;
      const code = typeof record.code === "string" && record.code ? record.code : "request-failed";
      const message = typeof record.message === "string" && record.message ? record.message : `Order-book ML research request failed (${status})`;
      return new OrderBookMlResearchApiError(status, code, message);
    }
  }
  return new OrderBookMlResearchApiError(status, status === 401 ? "unauthorized" : "request-failed", `Order-book ML research request failed (${status})`);
}

function validSessionId(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new Error("Research session id is invalid");
  return value;
}

function validModelId(value: string): string {
  if (!/^ob-ridge:[a-f0-9]{64}$/.test(value)) throw new Error("Research model id is invalid");
  return value;
}

function validateCreateInput(input: CreateResearchSessionInput) {
  if (input.name !== undefined && (!input.name.trim() || input.name.trim().length > 80)) throw new Error("Research session name must contain 1..80 characters");
  const quality = input.qualityPolicy;
  if (
    quality.schemaVersion !== "orderbook-quality-policy-v1" ||
    !boundedInteger(quality.maximumAgeMs, 0, 60_000) ||
    !boundedInteger(quality.maximumFutureSkewMs, 0, 5_000) ||
    !boundedInteger(quality.maximumInputDepth, 10, 100) ||
    !boundedInteger(quality.normalizedDepth, 10, 100) ||
    quality.normalizedDepth > quality.maximumInputDepth
  ) {
    throw new Error("Research quality policy is invalid");
  }
  const labels = input.labelPolicy;
  if (labels.horizonsMs.length < 1 || labels.horizonsMs.length > 3 || labels.horizonsMs.some((value, index) => !boundedInteger(value, 1, 300_000) || (index > 0 && value <= labels.horizonsMs[index - 1]!)) || !boundedInteger(labels.maximumAlignmentDelayMs, 0, 60_000)) {
    throw new Error("Research label policy is invalid");
  }
}

function validateTrainingInput(input: TrainResearchModelInput) {
  if (!boundedInteger(input.horizonMs, 1, 300_000) || !boundedInteger(input.minimumRowsPerSplit, 5, 500)) throw new Error("Research training horizon or split minimum is invalid");
  if (input.ridgeLambda !== undefined && !boundedNumber(input.ridgeLambda, Number.MIN_VALUE, 1_000_000)) throw new Error("Ridge lambda is invalid");
  if (input.trainFraction !== undefined && !boundedNumber(input.trainFraction, 0.4, 0.8)) throw new Error("Training fraction is invalid");
  if (input.validationFraction !== undefined && !boundedNumber(input.validationFraction, 0.1, 0.3)) throw new Error("Validation fraction is invalid");
  if ((input.trainFraction ?? 0.6) + (input.validationFraction ?? 0.2) > 0.9) throw new Error("Training and validation fractions exceed 0.9");
  if (input.flatThresholdBps !== undefined && !boundedNumber(input.flatThresholdBps, 0, 1_000_000)) throw new Error("Flat threshold is invalid");
  if (input.outOfDistributionZScore !== undefined && !boundedNumber(input.outOfDistributionZScore, 1, 100)) throw new Error("Out-of-distribution threshold is invalid");
}

function boundedInteger(value: number, minimum: number, maximum: number) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function boundedNumber(value: number, minimum: number, maximum: number) {
  return Number.isFinite(value) && value >= minimum && value <= maximum;
}

function cloneSnapshot(snapshot: SequencedL2SnapshotInput): SequencedL2SnapshotInput {
  return { ...snapshot, bids: snapshot.bids.map(([price, quantity]) => [price, quantity] as const), asks: snapshot.asks.map(([price, quantity]) => [price, quantity] as const) };
}
