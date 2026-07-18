import { createHash } from "node:crypto";
import { BACKTEST_ENGINE_VERSION } from "@saltanatbotv2/backtest-core";
import type { StrategyIR } from "@saltanatbotv2/strategy-core";
import { GA_OBJECTIVE_KEYS, strategyComplexity, type GaObjectiveKey } from "../ga/objectives.js";
import type { GaCandidateRecord, GaRunRecord } from "../ga/repository.js";
import { parseStrategyIR } from "../trading/strategy/irSchema.js";

/**
 * Pure sanitization boundary for the versioned strategy gallery (R9.3). A
 * gallery artifact crosses tenant lines, so this module WHITELISTS every field
 * it copies — unknown keys are never carried over — and then asserts, on the
 * serialized output, that no forbidden identifier (owner id, run id, job id)
 * survived. The canonical JSON form (sorted keys, undefined dropped) matches
 * the frontend's canonicalStringify so both sides derive the same sha256 for
 * the same bundle — the "cannot change silently after import" criterion.
 */

export const GALLERY_ARTIFACT_SCHEMA_VERSION = "gallery-artifact-v1";
export const GALLERY_RATING_SCHEMA_VERSION = "gallery-rating-v1";
/** Mirrors the v18 gallery_artifacts artifact JSONB CHECK bound. */
export const GALLERY_ARTIFACT_BYTE_LIMIT = 262_144;
export const GALLERY_MARKETS_MAXIMUM = 16;

/** Inputs the publisher failed to make publishable (bad IR, unpromoted candidate, oversized bundle). */
export class GalleryPublishInvalidError extends Error {}
/** The belt-and-braces leak assertion tripped: a forbidden identifier reached the serialized output. */
export class GallerySanitizerLeakError extends Error {}

const METRIC_SUMMARY_KEYS = ["netProfitPct", "maxDrawdownPct", "sharpe", "winRatePct", "profitFactor", "tradeCount", "barCount"] as const;

export type GalleryMetricSummaryKey = (typeof METRIC_SUMMARY_KEYS)[number];
export type GalleryMetricSummary = Partial<Record<GalleryMetricSummaryKey, number>>;

export interface GalleryMarketSummary {
  symbol: string;
  timeframe: string;
  inSample?: GalleryMetricSummary;
  outOfSample?: GalleryMetricSummary;
}

export interface GalleryOosSummary {
  gapPct: Partial<Record<GaObjectiveKey, number>>;
  oosLossShare: number;
  dispersion: number;
  flags: { overfit: boolean; unstable: boolean };
}

export interface GalleryArtifactV1 {
  schemaVersion: typeof GALLERY_ARTIFACT_SCHEMA_VERSION;
  /** Structurally whitelisted StrategyIR (re-validated via parseStrategyIR). */
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

export type GallerySanitizerSource =
  | {
      type: "ga-promotion";
      /** Loaded by the caller; requires candidate.promotedAt set. */
      run: GaRunRecord;
      candidate: GaCandidateRecord;
    }
  | {
      type: "library";
      artifact: { ir: unknown; markets?: unknown; metrics?: unknown };
      /** Used ONLY for the leak assertion — never copied into the bundle. */
      ownerUserId?: string;
    };

export interface GallerySanitizedBundle {
  artifact: GalleryArtifactV1;
  /** sha256 hex over the canonical JSON of the artifact. */
  artifactHash: string;
}

const GA_LIMITATIONS_NOTE =
  "Backtest evidence only: out-of-sample windows are historical and live results will differ. Re-validate and backtest locally after import before any paper start.";
const SELF_REPORTED_LIMITATIONS_NOTE =
  "Metrics are self-reported by the publisher and were NOT verified by the server. Re-validate and backtest locally after import before any paper start.";

const SYMBOL_PATTERN = /^[A-Z0-9]{2,40}$/;
const TIMEFRAME_PATTERN = /^[A-Za-z0-9]{1,16}$/;

/**
 * Build the sanitized gallery bundle for either source. Never copies unknown
 * keys, refuses invalid inputs, enforces the 256KB bound and asserts on the
 * serialized output that no forbidden identifier leaked through.
 */
export function buildGalleryArtifactV1(source: GallerySanitizerSource): GallerySanitizedBundle {
  const artifact = source.type === "ga-promotion" ? sanitizeGaPromotion(source.run, source.candidate) : sanitizeLibraryArtifact(source.artifact);
  const canonical = canonicalJsonStringify(artifact);
  if (Buffer.byteLength(canonical, "utf8") > GALLERY_ARTIFACT_BYTE_LIMIT) {
    throw new GalleryPublishInvalidError(`Sanitized gallery artifact exceeds ${GALLERY_ARTIFACT_BYTE_LIMIT} bytes.`);
  }
  assertNoForbiddenSubstrings(canonical, forbiddenIdentifiers(source));
  return { artifact, artifactHash: sha256Hex(canonical) };
}

/** sha256 over the canonical JSON — identical on server and client for the same bundle. */
export function galleryArtifactHash(artifact: GalleryArtifactV1): string {
  return sha256Hex(canonicalJsonStringify(artifact));
}

/**
 * Canonical JSON: object keys sorted, undefined members dropped, arrays kept
 * in order. Byte-for-byte the same algorithm as the frontend's
 * canonicalStringify (frontend/src/strategy/strategyFile.ts), which is what
 * makes the client-side hash re-verification meaningful.
 */
export function canonicalJsonStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJsonStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJsonStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sanitizeGaPromotion(run: GaRunRecord, candidate: GaCandidateRecord): GalleryArtifactV1 {
  if (candidate.promotedAt === undefined) {
    throw new GalleryPublishInvalidError("Only promoted GA candidates can be published to the gallery.");
  }
  const ir = whitelistIr(candidate.ir);
  const markets = gaMarketSummaries(candidate);
  const inSample = meanSummary(markets.map((market) => market.inSample));
  const outOfSample = pickMetricSummary(gaPortfolioMetrics(candidate)) ?? meanSummary(markets.map((market) => market.outOfSample));
  const oos = sanitizeOosReport(candidate.oosReport);
  return {
    schemaVersion: GALLERY_ARTIFACT_SCHEMA_VERSION,
    ir,
    markets,
    metrics: {
      source: "ga-oos",
      ...(inSample ? { inSample } : {}),
      ...(outOfSample ? { outOfSample } : {}),
      ...(oos ? { oos } : {})
    },
    engineVersion: run.engineVersion,
    ...(run.generatorVersion ? { generatorVersion: run.generatorVersion } : {}),
    ...(run.datasetFingerprint ? { datasetFingerprint: run.datasetFingerprint } : {}),
    seed: run.seed,
    complexity: strategyComplexity(ir as unknown as StrategyIR),
    limitations: GA_LIMITATIONS_NOTE
  };
}

function sanitizeLibraryArtifact(artifact: { ir: unknown; markets?: unknown; metrics?: unknown }): GalleryArtifactV1 {
  const ir = whitelistIr(artifact.ir);
  const markets = libraryMarketSummaries(artifact.markets);
  const metrics = isRecord(artifact.metrics) ? artifact.metrics : {};
  const inSample = pickMetricSummary(metrics.inSample);
  const outOfSample = pickMetricSummary(metrics.outOfSample);
  return {
    schemaVersion: GALLERY_ARTIFACT_SCHEMA_VERSION,
    ir,
    markets,
    metrics: {
      source: "self-reported",
      ...(inSample ? { inSample } : {}),
      ...(outOfSample ? { outOfSample } : {})
    },
    engineVersion: BACKTEST_ENGINE_VERSION,
    complexity: strategyComplexity(ir as unknown as StrategyIR),
    limitations: SELF_REPORTED_LIMITATIONS_NOTE
  };
}

/**
 * Structural whitelist for the IR: parseStrategyIR only accepts strict node
 * shapes, so anything it returns contains exclusively known keys. The parsed
 * copy — never the caller's object — enters the bundle.
 */
function whitelistIr(input: unknown): Record<string, unknown> {
  const parsed = parseStrategyIR(input);
  if (!parsed.ok) throw new GalleryPublishInvalidError(`Gallery artifact IR is invalid: ${parsed.error}`);
  return parsed.ir as unknown as Record<string, unknown>;
}

/** Per-market train/OOS summaries from the candidate's stored evaluation sections. */
function gaMarketSummaries(candidate: GaCandidateRecord): GalleryMarketSummary[] {
  const sections = isRecord(candidate.metrics) && Array.isArray(candidate.metrics.markets) ? candidate.metrics.markets : undefined;
  if (!sections || sections.length === 0 || sections.length > GALLERY_MARKETS_MAXIMUM) {
    throw new GalleryPublishInvalidError("GA candidate metrics are missing per-market evaluation sections.");
  }
  return sections.map((section) => {
    if (!isRecord(section) || typeof section.symbol !== "string" || !SYMBOL_PATTERN.test(section.symbol)) {
      throw new GalleryPublishInvalidError("GA candidate market section has an invalid symbol.");
    }
    if (typeof section.timeframe !== "string" || !TIMEFRAME_PATTERN.test(section.timeframe)) {
      throw new GalleryPublishInvalidError("GA candidate market section has an invalid timeframe.");
    }
    const inSample = pickMetricSummary(section.train);
    const outOfSample = pickMetricSummary(section.outOfSample);
    return {
      symbol: section.symbol,
      timeframe: section.timeframe,
      ...(inSample ? { inSample } : {}),
      ...(outOfSample ? { outOfSample } : {})
    };
  });
}

function gaPortfolioMetrics(candidate: GaCandidateRecord): unknown {
  const portfolio = isRecord(candidate.metrics) ? candidate.metrics.portfolio : undefined;
  return isRecord(portfolio) ? portfolio.metrics : undefined;
}

/** Declared markets for a library publication: symbol/timeframe pairs only. */
function libraryMarketSummaries(input: unknown): GalleryMarketSummary[] {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > GALLERY_MARKETS_MAXIMUM) {
    throw new GalleryPublishInvalidError(`Gallery markets must be a list of at most ${GALLERY_MARKETS_MAXIMUM} entries.`);
  }
  return input.map((entry) => {
    if (!isRecord(entry) || typeof entry.symbol !== "string" || !SYMBOL_PATTERN.test(entry.symbol) || typeof entry.timeframe !== "string" || !TIMEFRAME_PATTERN.test(entry.timeframe)) {
      throw new GalleryPublishInvalidError("Gallery market entries require an uppercase symbol and a timeframe.");
    }
    return { symbol: entry.symbol, timeframe: entry.timeframe };
  });
}

/** Whitelisted copy of the GA OOS report; hostile extra keys never survive. */
function sanitizeOosReport(report: Record<string, unknown> | undefined): GalleryOosSummary | undefined {
  if (!report) return undefined;
  const gapPct: Partial<Record<GaObjectiveKey, number>> = {};
  const gaps = isRecord(report.gapPct) ? report.gapPct : {};
  for (const key of GA_OBJECTIVE_KEYS) {
    const value = gaps[key];
    if (typeof value === "number" && Number.isFinite(value)) gapPct[key] = roundStable(value);
  }
  const flags = isRecord(report.flags) ? report.flags : {};
  return {
    gapPct,
    oosLossShare: finiteOrZero(report.oosLossShare),
    dispersion: finiteOrZero(report.dispersion),
    flags: { overfit: flags.overfit === true, unstable: flags.unstable === true }
  };
}

/**
 * Copy ONLY the known numeric summary keys (finite values); `totalTrades`
 * maps onto `tradeCount`. Everything else — including adversarial keys or
 * values embedding tenant identifiers — is dropped by construction.
 */
function pickMetricSummary(value: unknown): GalleryMetricSummary | undefined {
  if (!isRecord(value)) return undefined;
  const summary: GalleryMetricSummary = {};
  for (const key of METRIC_SUMMARY_KEYS) {
    const raw = key === "tradeCount" && value[key] === undefined ? value.totalTrades : value[key];
    if (typeof raw === "number" && Number.isFinite(raw)) summary[key] = roundStable(raw);
  }
  return Object.keys(summary).length > 0 ? summary : undefined;
}

/** Mean across per-market summaries (key present in every market), for the aggregate row. */
function meanSummary(summaries: readonly (GalleryMetricSummary | undefined)[]): GalleryMetricSummary | undefined {
  const present = summaries.filter((summary): summary is GalleryMetricSummary => summary !== undefined);
  if (present.length === 0 || present.length !== summaries.length) return undefined;
  const mean: GalleryMetricSummary = {};
  for (const key of METRIC_SUMMARY_KEYS) {
    const values = present.map((summary) => summary[key]);
    if (values.every((value): value is number => typeof value === "number")) {
      mean[key] = roundStable(values.reduce((sum, value) => sum + value, 0) / values.length);
    }
  }
  return Object.keys(mean).length > 0 ? mean : undefined;
}

function forbiddenIdentifiers(source: GallerySanitizerSource): string[] {
  if (source.type === "ga-promotion") {
    return [source.run.ownerUserId, source.run.id, ...(source.run.jobId ? [source.run.jobId] : [])];
  }
  return source.ownerUserId ? [source.ownerUserId] : [];
}

/**
 * Belt and braces on top of the whitelist: if any forbidden identifier is a
 * substring of the serialized bundle (case-insensitive), refuse to publish.
 * This also intentionally rejects IR documents that embed the identifiers in
 * free-text fields such as the strategy name.
 */
export function assertNoForbiddenSubstrings(serialized: string, forbidden: readonly string[]): void {
  const haystack = serialized.toLowerCase();
  for (const needle of forbidden) {
    if (needle.length > 0 && haystack.includes(needle.toLowerCase())) {
      throw new GallerySanitizerLeakError("Sanitized gallery artifact would leak a tenant identifier; publication refused.");
    }
  }
}

export interface GalleryRating {
  schemaVersion: typeof GALLERY_RATING_SCHEMA_VERSION;
  /** 0..100 weighted composite; deliberately NOT a function of net profit alone. */
  score: number;
  /** Each component normalized to 0..1. */
  components: {
    oosStability: number;
    drawdown: number;
    reproducibility: number;
    complexity: number;
    evidenceFreshness: number;
  };
  /** Whole days since published_at (the evidence-age basis). */
  evidenceAgeDays: number;
  reproducibility: { datasetFingerprint: boolean; seed: boolean; engineVersion: boolean; generatorVersion: boolean };
}

/**
 * Documented rating weights (sum = 1). Out-of-sample stability dominates,
 * followed by drawdown and reproducibility; raw return is intentionally not a
 * component, so the rating can never be "return-only".
 */
export const GALLERY_RATING_WEIGHTS = {
  oosStability: 0.35,
  drawdown: 0.25,
  reproducibility: 0.2,
  complexity: 0.1,
  evidenceFreshness: 0.1
} as const;

const RATING_GAP_FLOOR_PCT = 50;
const RATING_DISPERSION_FLOOR = 60;
const RATING_DRAWDOWN_FLOOR_PCT = 50;
const RATING_COMPLEXITY_FLOOR_BYTES = 32_768;
const RATING_EVIDENCE_HORIZON_DAYS = 365;

/**
 * Pure display-only rating. oosStability: 1 minus the worst adverse OOS gap
 * (floor 50pct) scaled by dispersion (floor 60), zeroed when flagged overfit,
 * halved when flagged unstable, and 0 for self-reported metrics without an
 * OOS section. drawdown: linear 0..50pct. reproducibility: share of
 * {datasetFingerprint, seed, engineVersion, generatorVersion} present.
 * complexity: linear against the 32KB canonical-IR bound. evidenceFreshness:
 * linear decay over 365 days from published_at.
 */
export function computeGalleryRating(artifact: GalleryArtifactV1, options: { publishedAt: number; now?: number }): GalleryRating {
  const oosStability = oosStabilityComponent(artifact.metrics.oos);
  const drawdownPct = artifact.metrics.outOfSample?.maxDrawdownPct ?? artifact.metrics.inSample?.maxDrawdownPct;
  const drawdown = drawdownPct === undefined ? 0 : clampUnit(1 - Math.max(drawdownPct, 0) / RATING_DRAWDOWN_FLOOR_PCT);
  const reproducibility = {
    datasetFingerprint: artifact.datasetFingerprint !== undefined,
    seed: artifact.seed !== undefined,
    engineVersion: artifact.engineVersion.length > 0,
    generatorVersion: artifact.generatorVersion !== undefined
  };
  const reproducibilityScore = Object.values(reproducibility).filter(Boolean).length / 4;
  const complexity = clampUnit(1 - artifact.complexity / RATING_COMPLEXITY_FLOOR_BYTES);
  const now = options.now ?? options.publishedAt;
  const evidenceAgeDays = Math.max(0, Math.floor((now - options.publishedAt) / 86_400_000));
  const evidenceFreshness = clampUnit(1 - evidenceAgeDays / RATING_EVIDENCE_HORIZON_DAYS);
  const components = {
    oosStability: roundComponent(oosStability),
    drawdown: roundComponent(drawdown),
    reproducibility: roundComponent(reproducibilityScore),
    complexity: roundComponent(complexity),
    evidenceFreshness: roundComponent(evidenceFreshness)
  };
  const score = Math.round(
    100 *
      (GALLERY_RATING_WEIGHTS.oosStability * components.oosStability +
        GALLERY_RATING_WEIGHTS.drawdown * components.drawdown +
        GALLERY_RATING_WEIGHTS.reproducibility * components.reproducibility +
        GALLERY_RATING_WEIGHTS.complexity * components.complexity +
        GALLERY_RATING_WEIGHTS.evidenceFreshness * components.evidenceFreshness)
  );
  return {
    schemaVersion: GALLERY_RATING_SCHEMA_VERSION,
    score,
    components,
    evidenceAgeDays,
    reproducibility
  };
}

function oosStabilityComponent(oos: GalleryOosSummary | undefined): number {
  if (!oos) return 0;
  if (oos.flags.overfit) return 0;
  const worstAdverseGap = Math.max(0, ...Object.values(oos.gapPct).filter((value): value is number => typeof value === "number"));
  const gapFactor = clampUnit(1 - worstAdverseGap / RATING_GAP_FLOOR_PCT);
  const dispersionFactor = clampUnit(1 - Math.max(oos.dispersion, 0) / RATING_DISPERSION_FLOOR);
  const stability = gapFactor * dispersionFactor;
  return oos.flags.unstable ? stability / 2 : stability;
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function roundComponent(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/** 12 significant digits keeps stored JSON stable across platforms without losing signal. */
function roundStable(value: number): number {
  if (value === 0) return 0;
  return Number.parseFloat(value.toPrecision(12));
}

function finiteOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? roundStable(value) : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
