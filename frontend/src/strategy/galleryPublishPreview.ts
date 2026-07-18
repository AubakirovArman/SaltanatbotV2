import { BACKTEST_ENGINE_VERSION } from "@saltanatbotv2/backtest-core";
import { canonicalStrategyJson } from "@saltanatbotv2/strategy-generator";
import type { StrategyIR } from "./ir";
import type { GaCandidateDetail, GaOosReport, GaRunSummary } from "./gaEvolutionClient";
import {
  GALLERY_ARTIFACT_BYTE_LIMIT,
  GALLERY_ARTIFACT_SCHEMA_VERSION,
  GALLERY_MARKETS_MAXIMUM,
  GALLERY_METRIC_SUMMARY_KEYS,
  GALLERY_OOS_GAP_KEYS,
  type GalleryArtifactView,
  type GalleryMarketSummary,
  type GalleryMetricSummary,
  type GalleryOosSummary
} from "./galleryClient";
import { galleryIrDocument } from "./galleryImport";
import { canonicalStringify } from "./strategyFile";

/**
 * Client-side mirror of the backend gallery sanitizer (backend/src/gallery/
 * sanitizer.ts) so the publish dialog can show EXACTLY what will be published
 * before the user consents. Every rule here — the metric whitelist, the
 * gapPct objective keys, 12-significant-digit rounding, the limitation notes,
 * the byte bound — matches the server byte-for-byte; the server remains
 * authoritative and re-sanitizes with its own tenant-leak assertion on top.
 */

const GA_LIMITATIONS_NOTE =
  "Backtest evidence only: out-of-sample windows are historical and live results will differ. Re-validate and backtest locally after import before any paper start.";
const SELF_REPORTED_LIMITATIONS_NOTE =
  "Metrics are self-reported by the publisher and were NOT verified by the server. Re-validate and backtest locally after import before any paper start.";

const SYMBOL_PATTERN = /^[A-Z0-9]{2,40}$/;
const TIMEFRAME_PATTERN = /^[A-Za-z0-9]{1,16}$/;

/** The preview could not be assembled fail-closed; publication stays blocked. */
export class GalleryPreviewUnavailableError extends Error {}

export interface GalleryPublishPreview {
  artifact: GalleryArtifactView;
  /** Canonical JSON the sha256 covers — rendered verbatim in the dialog. */
  canonical: string;
  byteSize: number;
  withinByteLimit: boolean;
}

/** Preview for a "library" publication: compiled IR only, metrics self-reported-empty. */
export function buildLibraryGalleryPreview(ir: StrategyIR): GalleryPublishPreview {
  const artifact: GalleryArtifactView = {
    schemaVersion: GALLERY_ARTIFACT_SCHEMA_VERSION,
    ir: ir as unknown as Record<string, unknown>,
    markets: [],
    metrics: { source: "self-reported" },
    engineVersion: BACKTEST_ENGINE_VERSION,
    complexity: strategyComplexityBytes(ir),
    limitations: SELF_REPORTED_LIMITATIONS_NOTE
  };
  return assemblePreview(artifact);
}

/** Preview for a "ga-promotion" publication, built from the already-loaded run + candidate detail. */
export function buildGaPromotionGalleryPreview(run: GaRunSummary, candidate: GaCandidateDetail): GalleryPublishPreview {
  if (candidate.promotedAt === undefined) throw new GalleryPreviewUnavailableError("Only promoted GA candidates can be published.");
  if (!run.engineVersion || run.seed === undefined) throw new GalleryPreviewUnavailableError("The run is missing engine or seed provenance.");
  const ir = galleryIrDocument(candidate.ir);
  if (!ir) throw new GalleryPreviewUnavailableError("The candidate bundle is missing a valid strategy IR.");
  const markets = gaMarketSummaries(candidate);
  const inSample = meanSummary(markets.map((market) => market.inSample));
  const outOfSample = pickMetricSummary(candidate.portfolioOutOfSample) ?? meanSummary(markets.map((market) => market.outOfSample));
  const oos = candidate.oosReport ? sanitizeOosReport(candidate.oosReport) : undefined;
  const artifact: GalleryArtifactView = {
    schemaVersion: GALLERY_ARTIFACT_SCHEMA_VERSION,
    ir: ir as unknown as Record<string, unknown>,
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
    complexity: strategyComplexityBytes(ir),
    limitations: GA_LIMITATIONS_NOTE
  };
  return assemblePreview(artifact);
}

function assemblePreview(artifact: GalleryArtifactView): GalleryPublishPreview {
  const canonical = canonicalStringify(artifact);
  const byteSize = new TextEncoder().encode(canonical).byteLength;
  return { artifact, canonical, byteSize, withinByteLimit: byteSize <= GALLERY_ARTIFACT_BYTE_LIMIT };
}

/** Deterministic structural complexity — byte length of the canonical strategy JSON (mirrors ga/objectives). */
function strategyComplexityBytes(ir: StrategyIR): number {
  try {
    return canonicalStrategyJson(ir).length;
  } catch {
    throw new GalleryPreviewUnavailableError("The strategy IR contains non-canonical values.");
  }
}

function gaMarketSummaries(candidate: GaCandidateDetail): GalleryMarketSummary[] {
  if (candidate.markets.length === 0 || candidate.markets.length > GALLERY_MARKETS_MAXIMUM) {
    throw new GalleryPreviewUnavailableError("The candidate is missing per-market evaluation sections.");
  }
  return candidate.markets.map((market) => {
    const separator = market.marketId.indexOf(":");
    const symbol = separator > 0 ? market.marketId.slice(0, separator) : market.marketId;
    const timeframe = separator > 0 ? market.marketId.slice(separator + 1) : "";
    if (!SYMBOL_PATTERN.test(symbol) || !TIMEFRAME_PATTERN.test(timeframe)) {
      throw new GalleryPreviewUnavailableError("A candidate market section has an invalid symbol or timeframe.");
    }
    const inSample = pickMetricSummary(market.train);
    const outOfSample = pickMetricSummary(market.outOfSample);
    return {
      symbol,
      timeframe,
      ...(inSample ? { inSample } : {}),
      ...(outOfSample ? { outOfSample } : {})
    };
  });
}

function sanitizeOosReport(report: GaOosReport): GalleryOosSummary {
  const gapPct: GalleryOosSummary["gapPct"] = {};
  for (const key of GALLERY_OOS_GAP_KEYS) {
    const value = report.gapPct[key];
    if (typeof value === "number" && Number.isFinite(value)) gapPct[key] = roundStable(value);
  }
  return {
    gapPct,
    oosLossShare: finiteOrZero(report.oosLossShare),
    dispersion: finiteOrZero(report.dispersion),
    flags: { overfit: report.overfit === true, unstable: report.unstable === true }
  };
}

/** Copy ONLY the known numeric summary keys; `totalTrades` maps onto `tradeCount`. */
function pickMetricSummary(value: Record<string, number> | undefined): GalleryMetricSummary | undefined {
  if (!value) return undefined;
  const summary: GalleryMetricSummary = {};
  for (const key of GALLERY_METRIC_SUMMARY_KEYS) {
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
  for (const key of GALLERY_METRIC_SUMMARY_KEYS) {
    const values = present.map((summary) => summary[key]);
    if (values.every((value): value is number => typeof value === "number")) {
      mean[key] = roundStable(values.reduce((sum, value) => sum + value, 0) / values.length);
    }
  }
  return Object.keys(mean).length > 0 ? mean : undefined;
}

/** 12 significant digits — identical rounding to the backend sanitizer. */
function roundStable(value: number): number {
  if (value === 0) return 0;
  return Number.parseFloat(value.toPrecision(12));
}

function finiteOrZero(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? roundStable(value) : 0;
}
