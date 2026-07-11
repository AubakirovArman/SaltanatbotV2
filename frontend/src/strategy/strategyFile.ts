import { ARTIFACT_SCHEMA_VERSION, type ArtifactParameter, type StrategyArtifact, type StrategyArtifactKind } from "./library";

export const STRATEGY_FILE_FORMAT = "saltanatbotv2.strategy";
export const STRATEGY_FILE_VERSION = 2;
const MAX_STRATEGY_FILE_BYTES = 2_000_000;

export interface PortableStrategyArtifact {
  kind: StrategyArtifactKind;
  name: string;
  description: string;
  xml: string;
  code?: string;
  schemaVersion: number;
  semanticVersion: string;
  contentHash?: string;
  irHash?: string;
  parameters: ArtifactParameter[];
  dependencies: string[];
  provenance: { source: string; exportedFromId?: string; parentHash?: string };
}

export interface StrategyFile {
  format: typeof STRATEGY_FILE_FORMAT;
  version: typeof STRATEGY_FILE_VERSION;
  algorithm: "SHA-256";
  checksum: string;
  exportedAt: number;
  artifact: PortableStrategyArtifact;
}

export async function encodeStrategyFile(artifact: StrategyArtifact, now = Date.now()): Promise<string> {
  const portable = toPortable(artifact);
  const file: StrategyFile = {
    format: STRATEGY_FILE_FORMAT,
    version: STRATEGY_FILE_VERSION,
    algorithm: "SHA-256",
    checksum: await sha256(canonicalStringify(portable)),
    exportedAt: now,
    artifact: portable
  };
  return JSON.stringify(file, null, 2);
}

/** Parse, validate and checksum-verify a portable strategy. Legacy v1 is migrated but never treated as verified v2. */
export async function parseStrategyFile(raw: string): Promise<PortableStrategyArtifact | undefined> {
  if (new TextEncoder().encode(raw).byteLength > MAX_STRATEGY_FILE_BYTES) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return undefined; }
  if (!parsed || typeof parsed !== "object") return undefined;
  const value = parsed as Record<string, unknown>;
  if (value.format !== STRATEGY_FILE_FORMAT) return undefined;
  if (value.version === 1) return parseLegacy(value);
  if (value.version !== STRATEGY_FILE_VERSION || value.algorithm !== "SHA-256" || typeof value.checksum !== "string") return undefined;
  const artifact = parsePortable(value.artifact);
  if (!artifact || await sha256(canonicalStringify(value.artifact)) !== value.checksum) return undefined;
  return artifact;
}

export async function downloadStrategyFile(artifact: StrategyArtifact) {
  const json = await encodeStrategyFile(artifact);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${slugify(artifact.name) || "strategy"}.strategy`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function toPortable(artifact: StrategyArtifact): PortableStrategyArtifact {
  return {
    kind: artifact.kind,
    name: artifact.name,
    description: artifact.description ?? "",
    xml: artifact.xml,
    code: artifact.code,
    schemaVersion: artifact.schemaVersion ?? ARTIFACT_SCHEMA_VERSION,
    semanticVersion: artifact.semanticVersion ?? "0.1.0",
    contentHash: artifact.hash,
    irHash: artifact.irHash,
    parameters: artifact.parameters?.map((input) => ({ ...input })) ?? [],
    dependencies: [...(artifact.dependencies ?? [])],
    provenance: { source: artifact.provenance?.source ?? "local", exportedFromId: artifact.id, parentHash: artifact.hash }
  };
}

function parsePortable(value: unknown): PortableStrategyArtifact | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = value as Partial<PortableStrategyArtifact>;
  if ((item.kind !== "strategy" && item.kind !== "indicator") || typeof item.name !== "string" || typeof item.xml !== "string" || !item.xml.includes("strategy_start")) return undefined;
  const schemaVersion = item.schemaVersion;
  if (typeof schemaVersion !== "number" || !Number.isInteger(schemaVersion) || schemaVersion < 1 || schemaVersion > ARTIFACT_SCHEMA_VERSION || typeof item.semanticVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(item.semanticVersion)) return undefined;
  if (item.xml.length > 1_500_000 || (item.code?.length ?? 0) > 500_000) return undefined;
  if (item.contentHash !== undefined && (typeof item.contentHash !== "string" || item.contentHash.length > 128)) return undefined;
  if (item.irHash !== undefined && (typeof item.irHash !== "string" || item.irHash.length > 128)) return undefined;
  const parameters = Array.isArray(item.parameters) ? item.parameters.filter(validParameter).map((input) => ({ ...input })) : [];
  if (!Array.isArray(item.parameters) || parameters.length !== item.parameters.length || parameters.length > 100) return undefined;
  if (!Array.isArray(item.dependencies) || item.dependencies.length > 100 || item.dependencies.some((id) => typeof id !== "string" || id.length > 200)) return undefined;
  const provenance = parseProvenance(item.provenance);
  if (!provenance) return undefined;
  return {
    kind: item.kind,
    name: item.name.trim() || "Imported strategy",
    description: typeof item.description === "string" ? item.description : "",
    xml: item.xml,
    code: typeof item.code === "string" ? item.code : undefined,
    schemaVersion,
    semanticVersion: item.semanticVersion,
    contentHash: item.contentHash,
    irHash: typeof item.irHash === "string" ? item.irHash : undefined,
    parameters,
    dependencies: [...new Set(item.dependencies as string[])],
    provenance
  };
}

function parseLegacy(value: Record<string, unknown>): PortableStrategyArtifact | undefined {
  if (typeof value.xml !== "string" || !value.xml.includes("strategy_start")) return undefined;
  return {
    kind: "strategy",
    name: typeof value.name === "string" && value.name.trim() ? value.name : "Imported strategy",
    description: typeof value.description === "string" ? value.description : "",
    xml: value.xml,
    schemaVersion: 1,
    semanticVersion: "0.1.0",
    parameters: [],
    dependencies: [],
    provenance: { source: "legacy-v1" }
  };
}

function validParameter(value: unknown): value is ArtifactParameter {
  if (!value || typeof value !== "object") return false;
  const input = value as Partial<ArtifactParameter>;
  return typeof input.name === "string" && input.name.length > 0 && input.name.length <= 100
    && typeof input.value === "number" && Number.isFinite(input.value)
    && finiteOptional(input.defaultValue) && finiteOptional(input.min) && finiteOptional(input.max)
    && (input.step === undefined || (Number.isFinite(input.step) && input.step > 0))
    && (input.min === undefined || input.max === undefined || input.min <= input.max)
    && (input.min === undefined || input.value >= input.min)
    && (input.max === undefined || input.value <= input.max)
    && (input.optimizationEligible === undefined || typeof input.optimizationEligible === "boolean");
}

function finiteOptional(value: number | undefined) {
  return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

function parseProvenance(value: unknown): PortableStrategyArtifact["provenance"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const provenance = value as Record<string, unknown>;
  if (typeof provenance.source !== "string" || provenance.source.length < 1 || provenance.source.length > 80) return undefined;
  if (provenance.exportedFromId !== undefined && (typeof provenance.exportedFromId !== "string" || provenance.exportedFromId.length > 200)) return undefined;
  if (provenance.parentHash !== undefined && (typeof provenance.parentHash !== "string" || provenance.parentHash.length > 128)) return undefined;
  return {
    source: provenance.source,
    exportedFromId: provenance.exportedFromId as string | undefined,
    parentHash: provenance.parentHash as string | undefined
  };
}

function canonicalStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().filter((key) => record[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonicalStringify(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function slugify(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}
