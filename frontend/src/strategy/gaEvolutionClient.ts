import { EvaluationApiError, parseResearchJobEnvelope, researchApiRequest, type EvaluationJobSnapshot } from "./evaluationClient";

/**
 * Research-jobs client for the server GA evolution kind ("ga-evolution",
 * R9.2), sharing the multi-market evaluation transport: bounded JSON
 * responses, explicit error codes, abortable requests. Runs are driven through
 * the shared /api/jobs endpoints (enqueue start/resume, cancel-to-checkpoint);
 * owner-scoped read models and promotion live under /api/ga. Responses parse
 * leniently: unknown fields are ignored and optional evidence (frontier, OOS
 * reports) degrades to "absent" instead of failing the whole view.
 */

const JOBS_API_BASE = "/api/jobs";
const GA_API_BASE = "/api/ga";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SYMBOL = /^[A-Z0-9]{4,24}$/;
const TIMEFRAME = /^\d{1,3}[mhdw]$/;
/** Mirrors the server-side ga/routes fingerprint schema byte-for-byte. */
const CANDIDATE_FINGERPRINT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const RUN_STATUSES = new Set(["running", "checkpointed", "completed", "failed", "cancelled"]);

export const GA_RUN_POLL_INTERVAL_MS = 5_000;
export const GA_MAX_MARKETS = 4;
export const GA_LOOKBACK_MIN_BARS = 500;
export const GA_LOOKBACK_MAX_BARS = 20_000;
export const GA_TRAIN_FRACTION_MIN = 0.5;
export const GA_TRAIN_FRACTION_MAX = 0.9;
export const GA_EMBARGO_MIN_BARS = 0;
export const GA_EMBARGO_MAX_BARS = 500;
export const GA_POPULATION_MIN = 8;
export const GA_POPULATION_MAX = 64;
export const GA_GENERATIONS_MIN = 1;
export const GA_GENERATIONS_MAX = 16;
export const GA_SEED_MAX = 0xffff_ffff;
export const GA_MAX_FRONTIER_ROWS = 64;
export const GA_MAX_RUN_ROWS = 50;

/** Transport and validation errors share the research API error type. */
export { EvaluationApiError as GaEvolutionApiError };

export type GaRunStatus = "running" | "checkpointed" | "completed" | "failed" | "cancelled";
export type GaJobSnapshot = EvaluationJobSnapshot;

export interface GaEvolutionStartConfig {
  markets: readonly string[];
  timeframe: string;
  lookbackBars: number;
  split: { trainFraction: number; embargoBars: number };
  seed: number;
  population: number;
  generations: number;
}

export interface GaOosReport {
  /** Train-vs-OOS gap per objective key; positive means worse out-of-sample. */
  gapPct: Record<string, number>;
  oosLossShare?: number;
  dispersion?: number;
  overfit: boolean;
  unstable: boolean;
}

export interface GaCandidateSummary {
  fingerprint: string;
  generation?: number;
  paretoRank?: number;
  objectives: Record<string, number>;
  oosReport?: GaOosReport;
  promotedAt?: number;
}

export interface GaMutationEntry {
  field: string;
  from?: string;
  to?: string;
}

export interface GaCandidateMarketMetrics {
  marketId: string;
  train: Record<string, number>;
  outOfSample: Record<string, number>;
}

export interface GaCandidateDetail extends GaCandidateSummary {
  parentFingerprints: string[];
  lineage: string[];
  mutationLog: GaMutationEntry[];
  markets: GaCandidateMarketMetrics[];
  ir?: Record<string, unknown>;
}

export interface GaRunSummary {
  id: string;
  status: GaRunStatus;
  jobId?: string;
  seed?: number;
  markets: string[];
  timeframe?: string;
  currentGeneration?: number;
  generations?: number;
  population?: number;
  datasetFingerprint?: string;
  engineVersion?: string;
  generatorVersion?: string;
}

export interface GaRunDetail extends GaRunSummary {
  frontier: GaCandidateSummary[];
}

export interface GaPromotionBundle {
  fingerprint: string;
  ir: Record<string, unknown>;
  provenance: {
    seed?: number;
    datasetFingerprint?: string;
    engineVersion?: string;
    generatorVersion?: string;
    lineage: string[];
    oosReport?: GaOosReport;
  };
}

export type GaPromotionBlockReason = "missing_oos" | "overfit";

/**
 * Client-side mirror of the server promotion invariant: no clean out-of-sample
 * report, no promotion. The server re-checks regardless and refuses with
 * ga_promotion_requires_oos / ga_promotion_overfit.
 */
export function gaPromotionBlockReason(candidate: Pick<GaCandidateSummary, "oosReport">): GaPromotionBlockReason | undefined {
  if (!candidate.oosReport) return "missing_oos";
  if (candidate.oosReport.overfit) return "overfit";
  return undefined;
}

export function isActiveGaRunStatus(status: GaRunStatus): boolean {
  return status === "running";
}

/** Enqueues a new evolution run (job kind "ga-evolution", mode "start"). */
export function startGaEvolutionRun(ownerUserId: string, config: GaEvolutionStartConfig, signal?: AbortSignal): Promise<GaJobSnapshot> {
  const body = JSON.stringify({ kind: "ga-evolution", mode: "start", config: validStartConfig(config) });
  return jobRequest(JOBS_API_BASE, ownerUserId, { method: "POST", body, signal });
}

/** Resumes a checkpointed run from its persisted population + RNG state. */
export function resumeGaEvolutionRun(ownerUserId: string, runId: string, signal?: AbortSignal): Promise<GaJobSnapshot> {
  const body = JSON.stringify({ kind: "ga-evolution", mode: "resume", runId: validUuid(runId, "run identifier") });
  return jobRequest(JOBS_API_BASE, ownerUserId, { method: "POST", body, signal });
}

/** Best-effort cancel: the worker checkpoints the run instead of discarding it. */
export async function cancelGaEvolutionJob(ownerUserId: string, jobId: string): Promise<void> {
  try {
    await jobRequest(`${JOBS_API_BASE}/${encodeURIComponent(validUuid(jobId, "job identifier"))}/cancel`, ownerUserId, { method: "POST", body: JSON.stringify({}) });
  } catch {
    // The poll loop observes the authoritative run status; a lost cancel
    // request only means the run finishes its bounded generations.
  }
}

export async function listGaRuns(ownerUserId: string, signal?: AbortSignal): Promise<GaRunSummary[]> {
  const value = await gaRequest(`${GA_API_BASE}/runs`, ownerUserId, { method: "GET", signal });
  const entries = arrayValue(objectValue(value)?.runs) ?? [];
  const runs: GaRunSummary[] = [];
  for (const entry of entries.slice(0, GA_MAX_RUN_ROWS)) {
    const run = parseRunSummary(entry);
    if (run) runs.push(run);
  }
  return runs;
}

export async function getGaRun(ownerUserId: string, runId: string, signal?: AbortSignal): Promise<GaRunDetail> {
  const id = validUuid(runId, "run identifier");
  const value = await gaRequest(`${GA_API_BASE}/runs/${encodeURIComponent(id)}`, ownerUserId, { method: "GET", signal });
  const envelope = objectValue(value);
  const run = parseRunSummary(envelope?.run ?? envelope);
  if (!run) throw new EvaluationApiError(0, "invalid_response", "Evolution run detail is invalid.");
  // The candidate page carries objectives + oosReport + promotedAt; entries
  // missing an OOS report keep promotion disabled — fail closed, never open.
  const frontierSource = arrayValue(envelope?.candidates) ?? [];
  const frontier: GaCandidateSummary[] = [];
  for (const entry of frontierSource.slice(0, GA_MAX_FRONTIER_ROWS)) {
    const candidate = parseCandidateSummary(entry);
    if (candidate) frontier.push(candidate);
  }
  frontier.sort((left, right) => (left.paretoRank ?? Number.MAX_SAFE_INTEGER) - (right.paretoRank ?? Number.MAX_SAFE_INTEGER) || compareText(left.fingerprint, right.fingerprint));
  return { ...run, frontier };
}

export async function getGaCandidate(ownerUserId: string, runId: string, fingerprint: string, signal?: AbortSignal): Promise<GaCandidateDetail> {
  const id = validUuid(runId, "run identifier");
  const key = validFingerprint(fingerprint);
  const value = await gaRequest(`${GA_API_BASE}/runs/${encodeURIComponent(id)}/candidates/${encodeURIComponent(key)}`, ownerUserId, { method: "GET", signal });
  const envelope = objectValue(value);
  const candidate = parseCandidateDetail(envelope?.candidate ?? envelope);
  if (!candidate) throw new EvaluationApiError(0, "invalid_response", "Evolution candidate detail is invalid.");
  return candidate;
}

/**
 * Promotes a clean candidate into the owner's own library: the server stamps
 * promoted_at and returns the full artifact bundle (IR + provenance) for the
 * existing strategy library import flow.
 */
export async function promoteGaCandidate(ownerUserId: string, runId: string, fingerprint: string, signal?: AbortSignal): Promise<GaPromotionBundle> {
  const id = validUuid(runId, "run identifier");
  const key = validFingerprint(fingerprint);
  const body = JSON.stringify({ runId: id, fingerprint: key });
  const value = await gaRequest(`${GA_API_BASE}/promote`, ownerUserId, { method: "POST", body, signal });
  const envelope = objectValue(value);
  const bundle = parsePromotionBundle(envelope?.artifact ?? envelope, key);
  if (!bundle) throw new EvaluationApiError(0, "invalid_response", "Evolution promotion returned an invalid artifact bundle.");
  return bundle;
}

async function jobRequest(path: string, ownerUserId: string, init: RequestInit): Promise<GaJobSnapshot> {
  const { status, value } = await researchApiRequest(path, ownerUserId, init, true);
  const snapshot = parseResearchJobEnvelope(value);
  if (!snapshot) throw new EvaluationApiError(status, "invalid_response", "Research job service returned an invalid response.");
  return snapshot;
}

async function gaRequest(path: string, ownerUserId: string, init: RequestInit): Promise<unknown> {
  const { value } = await researchApiRequest(path, ownerUserId, init, init.method === "POST");
  return value;
}

function parseRunSummary(value: unknown): GaRunSummary | undefined {
  const input = objectValue(value);
  if (!input || typeof input.id !== "string" || !UUID.test(input.id)) return undefined;
  if (typeof input.status !== "string" || !RUN_STATUSES.has(input.status)) return undefined;
  const config = objectValue(input.config) ?? {};
  const markets = (arrayValue(config.markets) ?? []).filter((entry): entry is string => typeof entry === "string" && SYMBOL.test(entry));
  return {
    id: input.id,
    status: input.status as GaRunStatus,
    jobId: typeof input.jobId === "string" && UUID.test(input.jobId) ? input.jobId : undefined,
    seed: integerValue(input.seed) ?? integerValue(config.seed),
    markets: markets.slice(0, GA_MAX_MARKETS),
    timeframe: shortText(config.timeframe),
    currentGeneration: integerValue(input.currentGeneration),
    generations: integerValue(config.generations),
    population: integerValue(config.population),
    datasetFingerprint: shortText(input.datasetFingerprint),
    engineVersion: shortText(input.engineVersion),
    generatorVersion: shortText(input.generatorVersion)
  };
}

function parseCandidateSummary(value: unknown): GaCandidateSummary | undefined {
  const input = objectValue(value);
  const fingerprint = typeof input?.fingerprint === "string" && CANDIDATE_FINGERPRINT.test(input.fingerprint) ? input.fingerprint : undefined;
  if (!input || !fingerprint) return undefined;
  return {
    fingerprint,
    generation: integerValue(input.generation),
    paretoRank: integerValue(input.paretoRank),
    objectives: numberRecord(input.objectives),
    oosReport: parseOosReport(input.oosReport),
    promotedAt: integerValue(input.promotedAt)
  };
}

function parseCandidateDetail(value: unknown): GaCandidateDetail | undefined {
  const summary = parseCandidateSummary(value);
  const input = objectValue(value);
  if (!summary || !input) return undefined;
  return {
    ...summary,
    parentFingerprints: fingerprintList(input.parentFingerprints),
    lineage: fingerprintList(input.lineage),
    mutationLog: mutationLog(input.mutationLog),
    markets: candidateMarkets(objectValue(input.metrics)?.markets),
    ir: objectValue(input.ir)
  };
}

function parseOosReport(value: unknown): GaOosReport | undefined {
  const input = objectValue(value);
  if (!input) return undefined;
  const flags = objectValue(input.flags) ?? input;
  return {
    gapPct: numberRecord(input.gapPct),
    oosLossShare: numberValue(input.oosLossShare),
    dispersion: numberValue(input.dispersion),
    overfit: flags.overfit === true,
    unstable: flags.unstable === true
  };
}

function parsePromotionBundle(value: unknown, fallbackFingerprint: string): GaPromotionBundle | undefined {
  const input = objectValue(value);
  const ir = objectValue(input?.ir);
  if (!input || !ir) return undefined;
  const provenance = objectValue(input.provenance) ?? {};
  const declared = provenance.fingerprint;
  const fingerprint = typeof declared === "string" && CANDIDATE_FINGERPRINT.test(declared) ? declared : fallbackFingerprint;
  return {
    fingerprint,
    ir,
    provenance: {
      seed: integerValue(provenance.seed),
      datasetFingerprint: shortText(provenance.datasetFingerprint),
      engineVersion: shortText(provenance.engineVersion),
      generatorVersion: shortText(provenance.generatorVersion),
      lineage: fingerprintList(provenance.lineage),
      oosReport: parseOosReport(provenance.oosReport)
    }
  };
}

function candidateMarkets(value: unknown): GaCandidateMarketMetrics[] {
  const entries = arrayValue(value) ?? [];
  const markets: GaCandidateMarketMetrics[] = [];
  for (const entry of entries.slice(0, 8)) {
    const market = objectValue(entry);
    if (!market) continue;
    const symbol = shortText(market.symbol);
    const train = objectValue(market.train);
    const outOfSample = objectValue(market.outOfSample);
    if (!symbol || !train || !outOfSample) continue;
    markets.push({ marketId: `${symbol}:${shortText(market.timeframe) ?? ""}`, train: numberRecord(train), outOfSample: numberRecord(outOfSample) });
  }
  return markets;
}

function mutationLog(value: unknown): GaMutationEntry[] {
  const entries = arrayValue(value) ?? [];
  const log: GaMutationEntry[] = [];
  for (const entry of entries.slice(0, 64)) {
    const record = objectValue(entry);
    const field = shortText(record?.field);
    if (!record || !field) continue;
    log.push({ field, from: scalarText(record.from), to: scalarText(record.to) });
  }
  return log;
}

/** Accepts plain fingerprints and lineage-chain rows ({fingerprint, ...}). */
function fingerprintList(value: unknown): string[] {
  const entries = arrayValue(value) ?? [];
  const fingerprints: string[] = [];
  for (const entry of entries.slice(0, 64)) {
    const fingerprint = typeof entry === "string" ? entry : objectValue(entry)?.fingerprint;
    if (typeof fingerprint === "string" && CANDIDATE_FINGERPRINT.test(fingerprint)) fingerprints.push(fingerprint);
  }
  return fingerprints;
}

/**
 * Fail-closed pre-check before the body leaves the browser; the exact bounds
 * (markets 1..4, lookback, split, seed uint32, population 8..64, generations
 * 1..16, unique symbols) are re-validated by the server's strict zod schema.
 */
function validStartConfig(config: GaEvolutionStartConfig): Record<string, unknown> {
  const marketsValid = Array.isArray(config.markets)
    && config.markets.length >= 1
    && config.markets.length <= GA_MAX_MARKETS
    && new Set(config.markets).size === config.markets.length
    && config.markets.every((symbol) => SYMBOL.test(symbol));
  const numbersValid = [
    [config.lookbackBars, GA_LOOKBACK_MIN_BARS, GA_LOOKBACK_MAX_BARS],
    [config.split.embargoBars, GA_EMBARGO_MIN_BARS, GA_EMBARGO_MAX_BARS],
    [config.seed, 0, GA_SEED_MAX],
    [config.population, GA_POPULATION_MIN, GA_POPULATION_MAX],
    [config.generations, GA_GENERATIONS_MIN, GA_GENERATIONS_MAX]
  ].every(([value, min, max]) => Number.isSafeInteger(value) && value! >= min! && value! <= max!);
  const trainFraction = config.split.trainFraction;
  if (!marketsValid || !numbersValid || !TIMEFRAME.test(config.timeframe) || !Number.isFinite(trainFraction) || trainFraction < GA_TRAIN_FRACTION_MIN || trainFraction > GA_TRAIN_FRACTION_MAX) {
    throw new EvaluationApiError(0, "invalid_request", "Evolution start configuration is out of bounds.");
  }
  return {
    markets: [...config.markets],
    timeframe: config.timeframe,
    lookbackBars: config.lookbackBars,
    split: { trainFraction, embargoBars: config.split.embargoBars },
    seed: config.seed,
    population: config.population,
    generations: config.generations
  };
}

function validUuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new EvaluationApiError(0, "invalid_request", `Evolution ${label} is invalid.`);
  }
  return value;
}

function validFingerprint(value: unknown): string {
  if (typeof value !== "string" || !CANDIDATE_FINGERPRINT.test(value)) {
    throw new EvaluationApiError(0, "invalid_request", "Evolution candidate fingerprint is invalid.");
  }
  return value;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function arrayValue(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function shortText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() && value.length <= 200 ? value : undefined;
}

function scalarText(value: unknown): string | undefined {
  if (typeof value === "string") return value.slice(0, 120);
  return typeof value === "number" || typeof value === "boolean" ? String(value) : undefined;
}

/** Metric numbers pass through untouched; JSONB null means "measured, not storable" (a non-finite engine value) and maps to NaN so displays fail that cell closed instead of dropping the whole record. */
function numberRecord(value: unknown): Record<string, number> {
  const input = objectValue(value);
  const record: Record<string, number> = {};
  if (!input) return record;
  for (const [key, entry] of Object.entries(input)) {
    if (key.length > 64) continue;
    if (entry === null) record[key] = Number.NaN;
    else if (typeof entry === "number") record[key] = entry;
  }
  return record;
}

function numberValue(value: unknown): number | undefined {
  if (value === null) return Number.NaN;
  return typeof value === "number" ? value : undefined;
}

function integerValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
