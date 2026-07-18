import type { GalleryImportBundle } from "./galleryClient";
import type { StrategyIR } from "./ir";
import { irToBlocklyXml } from "./irToXml";
import { ARTIFACT_SCHEMA_VERSION, type StrategyArtifact } from "./library";
import type { PortableStrategyArtifact } from "./strategyFile";

/**
 * Import-copy model for the versioned strategy gallery (R9.3). A gallery
 * import NEVER links the local library to the server row: it creates an
 * independent, editable copy through the same portable-artifact boundary as
 * files, the wizard and GA promotions. Every copy carries a revalidation gate
 * — paper start stays locked until a local validation + backtest completes on
 * this exact copy — and publication/import never starts a robot.
 */

const MAX_IMPORT_DESCRIPTION_LENGTH = 1_600;
const MAX_IR_NAME_LENGTH = 200;

/** Draft produced from a hash-verified import bundle; the library hook stamps ids and the gate time. */
export interface GalleryImportDraft {
  artifact: PortableStrategyArtifact;
  gallery: {
    id?: string;
    version?: number;
    /** sha256 verified on the server AND in this browser before the draft exists. */
    artifactHash: string;
    title: string;
  };
}

/**
 * Structural gate before Blockly serialization: the server validated the IR at
 * publication and the hash was re-verified, but the document still crossed the
 * network — fail closed on anything that is not a plausible StrategyIR.
 * Shared by the publish preview (candidate bundles) and the import flow.
 */
export function galleryIrDocument(value: Record<string, unknown> | undefined): StrategyIR | undefined {
  if (!value) return undefined;
  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (!name || name.length > MAX_IR_NAME_LENGTH || !Array.isArray(value.inputs) || !Array.isArray(value.body)) return undefined;
  for (const input of value.inputs) {
    const entry = input as { name?: unknown; value?: unknown };
    if (!entry || typeof entry.name !== "string" || typeof entry.value !== "number" || !Number.isFinite(entry.value)) return undefined;
  }
  return value as unknown as StrategyIR;
}

/**
 * Convert a verified gallery bundle into an independent portable copy. The
 * provenance records the published id/version and content hash both
 * machine-readable (source "gallery" + parentHash) and human-readable in the
 * description, alongside the publisher's limitations note.
 */
export function galleryBundleToPortableArtifact(bundle: GalleryImportBundle, meta: { title: string; summary?: string }): GalleryImportDraft {
  const ir = galleryIrDocument(bundle.artifact.ir);
  if (!ir) throw new Error("Gallery bundle does not contain a valid strategy IR document.");
  const title = meta.title.trim() || ir.name;
  const description = [meta.summary?.trim(), galleryProvenanceNote(bundle), bundle.artifact.limitations]
    .filter((part): part is string => Boolean(part))
    .join("\n")
    .slice(0, MAX_IMPORT_DESCRIPTION_LENGTH);
  return {
    artifact: {
      kind: "strategy",
      name: title,
      description,
      xml: irToBlocklyXml(ir),
      schemaVersion: ARTIFACT_SCHEMA_VERSION,
      semanticVersion: "0.1.0",
      parameters: ir.inputs.map((input) => ({ ...input })),
      dependencies: [],
      provenance: { source: "gallery", exportedFromId: bundle.id, parentHash: bundle.artifactHash.slice(0, 128) }
    },
    gallery: { id: bundle.id, version: bundle.version, artifactHash: bundle.artifactHash, title }
  };
}

/** One bounded line of provenance evidence for the copy's description. */
export function galleryProvenanceNote(bundle: GalleryImportBundle): string {
  const artifact = bundle.artifact;
  const parts = [`gallery ${bundle.id ?? "unknown"}${bundle.version !== undefined ? ` v${bundle.version}` : ""}`, `sha256 ${bundle.artifactHash}`];
  parts.push(`engine ${artifact.engineVersion}`);
  if (artifact.generatorVersion) parts.push(`generator ${artifact.generatorVersion}`);
  if (artifact.datasetFingerprint) parts.push(`dataset ${artifact.datasetFingerprint}`);
  if (artifact.seed !== undefined) parts.push(`seed ${artifact.seed}`);
  parts.push(`metrics ${artifact.metrics.source}`);
  return parts.join(" · ");
}

/** True while the copy's paper-start gate is closed (validation + backtest still owed). */
export function galleryRevalidationPending(artifact: Pick<StrategyArtifact, "galleryImport"> | undefined): boolean {
  return artifact?.galleryImport?.revalidationRequired === true;
}

/**
 * Open the gate after a successful local validation + backtest of THIS copy.
 * A cleared or absent gate passes through untouched so callers can apply it
 * unconditionally from the backtest-completed seam.
 */
export function completeGalleryRevalidation(artifact: StrategyArtifact, now = Date.now()): StrategyArtifact {
  if (!galleryRevalidationPending(artifact)) return artifact;
  return {
    ...artifact,
    galleryImport: { ...artifact.galleryImport!, revalidationRequired: false, revalidatedAt: now },
    updatedAt: now
  };
}
