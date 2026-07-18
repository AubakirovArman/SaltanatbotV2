import { browserSha256 } from "../security/browserSha256";
import { EvaluationApiError, researchApiRequest } from "./evaluationClient";
import { canonicalStringify } from "./strategyFile";

/**
 * Owner-scoped client for the versioned strategy gallery (R9.3), sharing the
 * research API transport: bounded JSON responses, CSRF on mutations, explicit
 * error codes, abortable requests. Responses parse leniently — unknown fields
 * are ignored and optional evidence degrades to "absent" — with ONE strict
 * exception: an import bundle is hashed CLIENT-side over the canonical JSON of
 * the artifact exactly as served, and a mismatch against the declared
 * artifact_hash refuses the import ("не может незаметно измениться после
 * импорта"). The canonical form matches the backend's canonicalJsonStringify
 * byte-for-byte, so both sides derive the same sha256 for the same bundle.
 */

const GALLERY_API_BASE = "/api/gallery";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const SYMBOL = /^[A-Z0-9]{2,40}$/;
const TIMEFRAME = /^[A-Za-z0-9]{1,16}$/;

export const GALLERY_ARTIFACT_SCHEMA_VERSION = "gallery-artifact-v1";
/** Mirrors the v18 gallery_artifacts artifact JSONB CHECK bound. */
export const GALLERY_ARTIFACT_BYTE_LIMIT = 262_144;
export const GALLERY_TITLE_MAX_LENGTH = 120;
export const GALLERY_SUMMARY_MAX_LENGTH = 2_000;
export const GALLERY_REVOKE_REASON_MAX_LENGTH = 400;
/** Bounded feed page: entries carry full artifacts within the 512KB response bound. */
export const GALLERY_LIST_LIMIT = 20;
export const GALLERY_MARKETS_MAXIMUM = 16;

/** Whitelisted metric-summary keys — identical to the backend sanitizer's list. */
export const GALLERY_METRIC_SUMMARY_KEYS = ["netProfitPct", "maxDrawdownPct", "sharpe", "winRatePct", "profitFactor", "tradeCount", "barCount"] as const;
/** Objective keys the sanitizer keeps inside oos.gapPct (mirrors GA_OBJECTIVE_KEYS). */
export const GALLERY_OOS_GAP_KEYS = ["netProfitPct", "maxDrawdownPct", "sharpe", "complexity"] as const;

/** Transport and validation errors share the research API error type. */
export { EvaluationApiError as GalleryApiError };

export type GalleryVisibility = "private" | "unlisted" | "public";
export type GalleryStatus = "active" | "revoked";
export type GalleryMetricSummaryKey = (typeof GALLERY_METRIC_SUMMARY_KEYS)[number];
export type GalleryMetricSummary = Partial<Record<GalleryMetricSummaryKey, number>>;

const VISIBILITIES = new Set<string>(["private", "unlisted", "public"]);
const STATUSES = new Set<string>(["active", "revoked"]);
const METRIC_SOURCES = new Set<string>(["ga-oos", "self-reported"]);

export interface GalleryMarketSummary {
  symbol: string;
  timeframe: string;
  inSample?: GalleryMetricSummary;
  outOfSample?: GalleryMetricSummary;
}

export interface GalleryOosSummary {
  gapPct: Partial<Record<(typeof GALLERY_OOS_GAP_KEYS)[number], number>>;
  oosLossShare: number;
  dispersion: number;
  flags: { overfit: boolean; unstable: boolean };
}

export interface GalleryArtifactView {
  schemaVersion: typeof GALLERY_ARTIFACT_SCHEMA_VERSION;
  ir: Record<string, unknown>;
  markets: GalleryMarketSummary[];
  metrics: {
    /** "ga-oos" = server-evaluated out-of-sample evidence; "self-reported" = unverified publisher claims. */
    source: "ga-oos" | "self-reported";
    inSample?: GalleryMetricSummary;
    outOfSample?: GalleryMetricSummary;
    oos?: GalleryOosSummary;
  };
  engineVersion: string;
  generatorVersion?: string;
  datasetFingerprint?: string;
  seed?: number;
  complexity: number;
  limitations: string;
}

export interface GalleryRatingView {
  /** 0..100 weighted composite; by construction never a function of net profit alone. */
  score: number;
  components: {
    oosStability: number;
    drawdown: number;
    reproducibility: number;
    complexity: number;
    evidenceFreshness: number;
  };
  evidenceAgeDays: number;
  reproducibility: { datasetFingerprint: boolean; seed: boolean; engineVersion: boolean; generatorVersion: boolean };
}

/** Feed-card projection of a bundle: everything except the IR itself. */
export type GalleryArtifactSummaryView = Omit<GalleryArtifactView, "ir">;

export interface GalleryEntry {
  id: string;
  version: number;
  title: string;
  summary: string;
  visibility: GalleryVisibility;
  status: GalleryStatus;
  publishedAt?: number;
  revokedAt?: number;
  revokeReason?: string;
  artifactHash: string;
  rating?: GalleryRatingView;
  /** Typed lenient view for cards; absent when the row omitted the artifact. */
  artifact?: GalleryArtifactView;
  /** IR-free card projection served by list endpoints instead of the full artifact. */
  artifactSummary?: GalleryArtifactSummaryView;
}

export interface GalleryImportBundle {
  id?: string;
  version?: number;
  /** The artifact EXACTLY as served — the value the verified hash covers. */
  raw: Record<string, unknown>;
  artifact: GalleryArtifactView;
  /** Server-declared sha256, re-verified client-side before this bundle is returned. */
  artifactHash: string;
}

export type GalleryPublishSource =
  | { type: "ga-promotion"; runId: string; fingerprint: string }
  | { type: "library"; artifact: { ir: Record<string, unknown> } };

export interface GalleryPublishRequest {
  source: GalleryPublishSource;
  title: string;
  summary: string;
  visibility: GalleryVisibility;
}

export interface GalleryPublishAck {
  id?: string;
  version?: number;
  artifactHash?: string;
}

/** sha256 hex over the canonical JSON — identical on server and client for the same bundle. */
export function galleryArtifactHash(artifact: unknown): Promise<string> {
  return browserSha256(canonicalStringify(artifact));
}

export async function listGalleryFeed(ownerUserId: string, signal?: AbortSignal): Promise<GalleryEntry[]> {
  const value = await galleryRequest(`${GALLERY_API_BASE}?limit=${GALLERY_LIST_LIMIT}`, ownerUserId, { method: "GET", signal });
  return parseEntryList(value);
}

export async function listGalleryOwn(ownerUserId: string, signal?: AbortSignal): Promise<GalleryEntry[]> {
  const value = await galleryRequest(`${GALLERY_API_BASE}?scope=own&limit=${GALLERY_LIST_LIMIT}`, ownerUserId, { method: "GET", signal });
  return parseEntryList(value);
}

export async function getGalleryEntry(ownerUserId: string, id: string, version?: number, signal?: AbortSignal): Promise<GalleryEntry> {
  const path = `${GALLERY_API_BASE}/${encodeURIComponent(validUuid(id))}${versionQuery(version)}`;
  const value = await galleryRequest(path, ownerUserId, { method: "GET", signal });
  const envelope = objectValue(value);
  const entry = parseEntry(envelope?.entry ?? envelope?.artifact ?? envelope);
  if (!entry) throw new EvaluationApiError(0, "invalid_response", "Gallery entry response is invalid.");
  return entry;
}

export async function publishGalleryArtifact(ownerUserId: string, request: GalleryPublishRequest, signal?: AbortSignal): Promise<GalleryPublishAck> {
  const body = JSON.stringify(validPublishRequest(request));
  const value = await galleryRequest(`${GALLERY_API_BASE}/publish`, ownerUserId, { method: "POST", body, signal });
  const envelope = objectValue(value);
  const ack = objectValue(envelope?.entry ?? envelope?.artifact) ?? envelope ?? {};
  return {
    id: typeof ack.id === "string" && UUID.test(ack.id) ? ack.id : undefined,
    version: positiveInteger(ack.version),
    artifactHash: typeof ack.artifactHash === "string" && SHA256_HEX.test(ack.artifactHash) ? ack.artifactHash : undefined
  };
}

export async function setGalleryVisibility(ownerUserId: string, id: string, visibility: GalleryVisibility, signal?: AbortSignal): Promise<void> {
  if (!VISIBILITIES.has(visibility)) throw new EvaluationApiError(0, "invalid_request", "Gallery visibility is invalid.");
  const body = JSON.stringify({ visibility });
  await galleryRequest(`${GALLERY_API_BASE}/${encodeURIComponent(validUuid(id))}/visibility`, ownerUserId, { method: "POST", body, signal });
}

export async function revokeGalleryEntry(ownerUserId: string, id: string, reason: string, signal?: AbortSignal): Promise<void> {
  const trimmed = reason.trim();
  if (!trimmed || trimmed.length > GALLERY_REVOKE_REASON_MAX_LENGTH) {
    throw new EvaluationApiError(0, "invalid_request", "Gallery revoke reason is required and bounded.");
  }
  const body = JSON.stringify({ reason: trimmed });
  await galleryRequest(`${GALLERY_API_BASE}/${encodeURIComponent(validUuid(id))}/revoke`, ownerUserId, { method: "POST", body, signal });
}

/**
 * Fetch the full import bundle and RE-VERIFY the hash client-side: the sha256
 * of the canonical JSON of the artifact exactly as served must equal the
 * declared artifact_hash. The server verifies the same invariant before
 * responding; the client repeats it so a tampered or stale transport layer can
 * never swap content silently.
 */
export async function importGalleryArtifact(ownerUserId: string, id: string, version?: number, signal?: AbortSignal): Promise<GalleryImportBundle> {
  const path = `${GALLERY_API_BASE}/${encodeURIComponent(validUuid(id))}/import${versionQuery(version)}`;
  const value = await galleryRequest(path, ownerUserId, { method: "GET", signal });
  const envelope = objectValue(value);
  const raw = objectValue(envelope?.artifact ?? envelope?.bundle);
  const declared = envelope?.artifactHash;
  if (!raw || typeof declared !== "string" || !SHA256_HEX.test(declared)) {
    throw new EvaluationApiError(0, "invalid_response", "Gallery import bundle is invalid.");
  }
  const computed = await galleryArtifactHash(raw);
  if (computed !== declared) {
    throw new EvaluationApiError(0, "gallery_hash_mismatch", "Gallery artifact content does not match its published hash; import refused.");
  }
  const artifact = parseArtifactView(raw);
  if (!artifact) throw new EvaluationApiError(0, "invalid_response", "Gallery import bundle artifact is not a valid gallery artifact.");
  return {
    id: typeof envelope?.id === "string" && UUID.test(envelope.id) ? envelope.id : undefined,
    version: positiveInteger(envelope?.version),
    raw,
    artifact,
    artifactHash: declared
  };
}

async function galleryRequest(path: string, ownerUserId: string, init: RequestInit): Promise<unknown> {
  const { value } = await researchApiRequest(path, ownerUserId, init, init.method === "POST");
  return value;
}

function validPublishRequest(request: GalleryPublishRequest): Record<string, unknown> {
  const title = request.title.trim();
  const summary = request.summary.trim();
  if (!title || title.length > GALLERY_TITLE_MAX_LENGTH || summary.length > GALLERY_SUMMARY_MAX_LENGTH || !VISIBILITIES.has(request.visibility)) {
    throw new EvaluationApiError(0, "invalid_request", "Gallery publication metadata is out of bounds.");
  }
  if (request.source.type === "ga-promotion") {
    return { source: { type: "ga-promotion", runId: validUuid(request.source.runId), fingerprint: request.source.fingerprint }, title, summary, visibility: request.visibility };
  }
  const ir = objectValue(request.source.artifact.ir);
  if (!ir) throw new EvaluationApiError(0, "invalid_request", "Gallery publication requires a compiled strategy IR.");
  return { source: { type: "library", artifact: { ir } }, title, summary, visibility: request.visibility };
}

function parseEntryList(value: unknown): GalleryEntry[] {
  const envelope = objectValue(value);
  const source = arrayValue(envelope?.entries) ?? arrayValue(envelope?.artifacts) ?? arrayValue(value) ?? [];
  const entries: GalleryEntry[] = [];
  for (const item of source.slice(0, GALLERY_LIST_LIMIT)) {
    const entry = parseEntry(item);
    if (entry) entries.push(entry);
  }
  return entries;
}

function parseEntry(value: unknown): GalleryEntry | undefined {
  const input = objectValue(value);
  if (!input || typeof input.id !== "string" || !UUID.test(input.id)) return undefined;
  const version = positiveInteger(input.version);
  const artifactHash = typeof input.artifactHash === "string" && SHA256_HEX.test(input.artifactHash) ? input.artifactHash : undefined;
  const visibility = typeof input.visibility === "string" && VISIBILITIES.has(input.visibility) ? (input.visibility as GalleryVisibility) : undefined;
  const status = typeof input.status === "string" && STATUSES.has(input.status) ? (input.status as GalleryStatus) : undefined;
  if (version === undefined || !artifactHash || !visibility || !status) return undefined;
  return {
    id: input.id,
    version,
    title: boundedText(input.title, GALLERY_TITLE_MAX_LENGTH) ?? "",
    summary: boundedText(input.summary, GALLERY_SUMMARY_MAX_LENGTH) ?? "",
    visibility,
    status,
    publishedAt: integerValue(input.publishedAt),
    revokedAt: integerValue(input.revokedAt),
    revokeReason: boundedText(input.revokeReason, GALLERY_REVOKE_REASON_MAX_LENGTH),
    artifactHash,
    rating: parseRating(input.rating),
    artifact: parseArtifactView(input.artifact),
    artifactSummary: parseArtifactSummaryView(input.artifactSummary)
  };
}

/** A summary is a bundle minus its IR; reuse the full parser with a stub IR and drop it again. */
function parseArtifactSummaryView(value: unknown): GalleryArtifactSummaryView | undefined {
  const input = objectValue(value);
  if (!input) return undefined;
  const view = parseArtifactView({ ...input, ir: {} });
  if (!view) return undefined;
  const { ir: _ir, ...summary } = view;
  return summary;
}

/** Lenient typed view of a stored bundle; refuses only structurally unusable documents. */
export function parseArtifactView(value: unknown): GalleryArtifactView | undefined {
  const input = objectValue(value);
  const ir = objectValue(input?.ir);
  if (!input || input.schemaVersion !== GALLERY_ARTIFACT_SCHEMA_VERSION || !ir) return undefined;
  const metrics = objectValue(input.metrics) ?? {};
  const source = typeof metrics.source === "string" && METRIC_SOURCES.has(metrics.source) ? (metrics.source as "ga-oos" | "self-reported") : "self-reported";
  const engineVersion = boundedText(input.engineVersion, 200) ?? "";
  const complexity = integerValue(input.complexity);
  if (!engineVersion || complexity === undefined) return undefined;
  return {
    schemaVersion: GALLERY_ARTIFACT_SCHEMA_VERSION,
    ir,
    markets: parseMarkets(input.markets),
    metrics: {
      source,
      inSample: parseMetricSummary(metrics.inSample),
      outOfSample: parseMetricSummary(metrics.outOfSample),
      oos: parseOosSummary(metrics.oos)
    },
    engineVersion,
    generatorVersion: boundedText(input.generatorVersion, 200),
    datasetFingerprint: boundedText(input.datasetFingerprint, 200),
    seed: integerValue(input.seed),
    complexity,
    limitations: boundedText(input.limitations, 1_000) ?? ""
  };
}

function parseMarkets(value: unknown): GalleryMarketSummary[] {
  const entries = arrayValue(value) ?? [];
  const markets: GalleryMarketSummary[] = [];
  for (const entry of entries.slice(0, GALLERY_MARKETS_MAXIMUM)) {
    const input = objectValue(entry);
    if (!input || typeof input.symbol !== "string" || !SYMBOL.test(input.symbol)) continue;
    if (typeof input.timeframe !== "string" || !TIMEFRAME.test(input.timeframe)) continue;
    markets.push({
      symbol: input.symbol,
      timeframe: input.timeframe,
      inSample: parseMetricSummary(input.inSample),
      outOfSample: parseMetricSummary(input.outOfSample)
    });
  }
  return markets;
}

function parseMetricSummary(value: unknown): GalleryMetricSummary | undefined {
  const input = objectValue(value);
  if (!input) return undefined;
  const summary: GalleryMetricSummary = {};
  for (const key of GALLERY_METRIC_SUMMARY_KEYS) {
    const entry = input[key];
    if (typeof entry === "number" && Number.isFinite(entry)) summary[key] = entry;
  }
  return Object.keys(summary).length > 0 ? summary : undefined;
}

function parseOosSummary(value: unknown): GalleryOosSummary | undefined {
  const input = objectValue(value);
  if (!input) return undefined;
  const gaps = objectValue(input.gapPct) ?? {};
  const gapPct: GalleryOosSummary["gapPct"] = {};
  for (const key of GALLERY_OOS_GAP_KEYS) {
    const entry = gaps[key];
    if (typeof entry === "number" && Number.isFinite(entry)) gapPct[key] = entry;
  }
  const flags = objectValue(input.flags) ?? {};
  return {
    gapPct,
    oosLossShare: finiteNumber(input.oosLossShare) ?? 0,
    dispersion: finiteNumber(input.dispersion) ?? 0,
    flags: { overfit: flags.overfit === true, unstable: flags.unstable === true }
  };
}

function parseRating(value: unknown): GalleryRatingView | undefined {
  const input = objectValue(value);
  const components = objectValue(input?.components);
  const score = input === undefined ? undefined : finiteNumber(input.score);
  if (!input || !components || score === undefined) return undefined;
  const reproducibility = objectValue(input.reproducibility) ?? {};
  return {
    score: Math.min(100, Math.max(0, Math.round(score))),
    components: {
      oosStability: unitComponent(components.oosStability),
      drawdown: unitComponent(components.drawdown),
      reproducibility: unitComponent(components.reproducibility),
      complexity: unitComponent(components.complexity),
      evidenceFreshness: unitComponent(components.evidenceFreshness)
    },
    evidenceAgeDays: integerValue(input.evidenceAgeDays) ?? 0,
    reproducibility: {
      datasetFingerprint: reproducibility.datasetFingerprint === true,
      seed: reproducibility.seed === true,
      engineVersion: reproducibility.engineVersion === true,
      generatorVersion: reproducibility.generatorVersion === true
    }
  };
}

function versionQuery(version?: number): string {
  if (version === undefined) return "";
  const bounded = positiveInteger(version);
  if (bounded === undefined) throw new EvaluationApiError(0, "invalid_request", "Gallery version is invalid.");
  return `?version=${bounded}`;
}

function validUuid(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new EvaluationApiError(0, "invalid_request", "Gallery identifier is invalid.");
  }
  return value;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function arrayValue(value: unknown): unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function boundedText(value: unknown, maximumLength: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maximumLength ? value : undefined;
}

function integerValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  const parsed = integerValue(value);
  return parsed !== undefined && parsed >= 1 ? parsed : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function unitComponent(value: unknown): number {
  const parsed = finiteNumber(value);
  return parsed === undefined ? 0 : Math.min(1, Math.max(0, parsed));
}
