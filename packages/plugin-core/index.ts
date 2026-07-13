export const PLUGIN_FILE_FORMAT = "saltanatbotv2.plugin" as const;
export const PLUGIN_FILE_VERSION = 1 as const;
export const PLUGIN_MAX_BYTES = 5_000_000;
export const PLUGIN_MAX_ARTIFACTS = 25;

export type PluginPermission = "market.read" | "chart.overlay" | "trade.intent" | "alert.emit";
export type PluginArtifactKind = "indicator" | "strategy";

export interface PluginArtifactParameter {
  name: string;
  value: number;
  defaultValue?: number;
  min?: number;
  max?: number;
  step?: number;
  optimizationEligible?: boolean;
}

export interface PluginArtifact {
  id: string;
  kind: PluginArtifactKind;
  name: string;
  description: string;
  xml: string;
  schemaVersion: number;
  semanticVersion: string;
  parameters: PluginArtifactParameter[];
  dependencies: string[];
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  license: string;
  publisher: { name: string; url?: string };
  minAppVersion: string;
  permissions: PluginPermission[];
  artifacts: PluginArtifact[];
}

export interface PluginFile {
  format: typeof PLUGIN_FILE_FORMAT;
  version: typeof PLUGIN_FILE_VERSION;
  algorithm: "SHA-256";
  checksum: string;
  manifest: PluginManifest;
}

export type PluginParseErrorCode =
  | "too_large"
  | "invalid_json"
  | "invalid_envelope"
  | "unsupported_version"
  | "checksum_mismatch"
  | "invalid_manifest"
  | "unsupported_permission"
  | "invalid_artifact"
  | "dependency_error"
  | "incompatible_app";

export interface VerifiedPlugin {
  manifest: PluginManifest;
  checksum: string;
}

export type PluginParseResult =
  | ({ ok: true } & VerifiedPlugin)
  | { ok: false; code: PluginParseErrorCode };

export interface ParsePluginOptions {
  appVersion?: string;
  maxArtifactSchemaVersion?: number;
}

type ManifestValidationResult =
  | { ok: true; manifest: PluginManifest }
  | { ok: false; code: PluginParseErrorCode };

const PERMISSIONS = new Set<PluginPermission>(["market.read", "chart.overlay", "trade.intent", "alert.emit"]);
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const ID = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const CHECKSUM = /^[a-f0-9]{64}$/;

/** Parse a strict, checksummed declarative plugin. No executable JavaScript is accepted. */
export async function parsePluginFile(raw: string, options: ParsePluginOptions = {}): Promise<PluginParseResult> {
  if (new TextEncoder().encode(raw).byteLength > PLUGIN_MAX_BYTES) return failure("too_large");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return failure("invalid_json"); }
  if (!strictRecord(parsed, ["format", "version", "algorithm", "checksum", "manifest"])) return failure("invalid_envelope");
  if (parsed.format !== PLUGIN_FILE_FORMAT || parsed.algorithm !== "SHA-256" || typeof parsed.checksum !== "string" || !CHECKSUM.test(parsed.checksum)) return failure("invalid_envelope");
  if (parsed.version !== PLUGIN_FILE_VERSION) return failure("unsupported_version");
  const manifestResult = parseManifest(parsed.manifest, options.maxArtifactSchemaVersion ?? 2);
  if (!manifestResult.ok) return manifestResult;
  const checksum = await sha256(canonicalStringify(parsed.manifest));
  if (checksum !== parsed.checksum) return failure("checksum_mismatch");
  if (options.appVersion && compareSemver(manifestResult.manifest.minAppVersion, options.appVersion) > 0) return failure("incompatible_app");
  return { ok: true, manifest: manifestResult.manifest, checksum };
}

export async function encodePluginFile(manifest: PluginManifest): Promise<string> {
  const validated = parseManifest(manifest, Number.MAX_SAFE_INTEGER);
  if (!validated.ok) throw new Error(validated.code);
  const file: PluginFile = {
    format: PLUGIN_FILE_FORMAT,
    version: PLUGIN_FILE_VERSION,
    algorithm: "SHA-256",
    checksum: await sha256(canonicalStringify(validated.manifest)),
    manifest: validated.manifest
  };
  const encoded = JSON.stringify(file, null, 2);
  if (new TextEncoder().encode(encoded).byteLength > PLUGIN_MAX_BYTES) throw new Error("too_large");
  return encoded;
}

function parseManifest(value: unknown, maxSchema: number): ManifestValidationResult {
  if (!strictRecord(value, ["id", "name", "version", "description", "license", "publisher", "minAppVersion", "permissions", "artifacts"])) return failure("invalid_manifest");
  if (!shortId(value.id, 120) || !text(value.name, 1, 100) || !text(value.description, 0, 1_000) || !text(value.license, 1, 50) || !semver(value.version) || !semver(value.minAppVersion)) return failure("invalid_manifest");
  if (!strictRecord(value.publisher, ["name", "url"], ["url"]) || !text(value.publisher.name, 1, 100) || (value.publisher.url !== undefined && !httpsUrl(value.publisher.url))) return failure("invalid_manifest");
  if (!Array.isArray(value.permissions) || value.permissions.length > PERMISSIONS.size || value.permissions.some((permission) => typeof permission !== "string" || !PERMISSIONS.has(permission as PluginPermission))) return failure("unsupported_permission");
  if (new Set(value.permissions).size !== value.permissions.length) return failure("invalid_manifest");
  if (!Array.isArray(value.artifacts) || value.artifacts.length < 1 || value.artifacts.length > PLUGIN_MAX_ARTIFACTS) return failure("invalid_manifest");
  const artifacts: PluginArtifact[] = [];
  for (const artifact of value.artifacts) {
    const parsed = parseArtifact(artifact, maxSchema);
    if (!parsed) return failure("invalid_artifact");
    artifacts.push(parsed);
  }
  if (new Set(artifacts.map((artifact) => artifact.id)).size !== artifacts.length) return failure("invalid_artifact");
  const permissions = value.permissions as PluginPermission[];
  if (artifacts.some((artifact) => artifact.kind === "indicator") && !permissions.includes("chart.overlay")) return failure("unsupported_permission");
  if (artifacts.some((artifact) => artifact.kind === "strategy") && !permissions.includes("trade.intent")) return failure("unsupported_permission");
  if (artifacts.some((artifact) => /<block\b[^>]*\btype=["']alert_message["']/i.test(artifact.xml)) && !permissions.includes("alert.emit")) return failure("unsupported_permission");
  if (!validateDependencies(artifacts)) return failure("dependency_error");
  return {
    ok: true,
    manifest: {
      id: value.id,
      name: value.name.trim(),
      version: value.version,
      description: value.description.trim(),
      license: value.license,
      publisher: { name: value.publisher.name.trim(), url: value.publisher.url as string | undefined },
      minAppVersion: value.minAppVersion,
      permissions: [...permissions],
      artifacts,
    }
  };
}

function parseArtifact(value: unknown, maxSchema: number): PluginArtifact | undefined {
  if (!strictRecord(value, ["id", "kind", "name", "description", "xml", "schemaVersion", "semanticVersion", "parameters", "dependencies"])) return undefined;
  if (!shortId(value.id, 120) || (value.kind !== "indicator" && value.kind !== "strategy") || !text(value.name, 1, 100) || !text(value.description, 0, 1_000)) return undefined;
  if (typeof value.xml !== "string" || value.xml.length < 1 || value.xml.length > 1_500_000 || !value.xml.includes("strategy_start") || /<script\b|<!doctype\b|<\?xml-stylesheet\b/i.test(value.xml)) return undefined;
  if (typeof value.schemaVersion !== "number" || !Number.isInteger(value.schemaVersion) || value.schemaVersion < 1 || value.schemaVersion > maxSchema || !semver(value.semanticVersion)) return undefined;
  if (!Array.isArray(value.parameters) || value.parameters.length > 100 || value.parameters.some((parameter) => !validParameter(parameter))) return undefined;
  if (!Array.isArray(value.dependencies) || value.dependencies.length > 100 || value.dependencies.some((dependency) => !shortId(dependency, 120))) return undefined;
  return {
    id: value.id,
    kind: value.kind,
    name: value.name.trim(),
    description: value.description.trim(),
    xml: value.xml,
    schemaVersion: value.schemaVersion,
    semanticVersion: value.semanticVersion,
    parameters: value.parameters.map((parameter) => ({ ...(parameter as PluginArtifactParameter) })),
    dependencies: [...new Set(value.dependencies as string[])]
  };
}

function validParameter(value: unknown) {
  if (!strictRecord(value, ["name", "value", "defaultValue", "min", "max", "step", "optimizationEligible"], ["defaultValue", "min", "max", "step", "optimizationEligible"])) return false;
  if (!text(value.name, 1, 100) || !finite(value.value) || !finiteOptional(value.defaultValue) || !finiteOptional(value.min) || !finiteOptional(value.max)) return false;
  if (value.step !== undefined && (!finite(value.step) || value.step <= 0)) return false;
  if (value.optimizationEligible !== undefined && typeof value.optimizationEligible !== "boolean") return false;
  if (finite(value.min) && finite(value.max) && value.min > value.max) return false;
  if (finite(value.min) && value.value < value.min || finite(value.max) && value.value > value.max) return false;
  return true;
}

function validateDependencies(artifacts: PluginArtifact[]) {
  const ids = new Set(artifacts.map((artifact) => artifact.id));
  if (artifacts.some((artifact) => artifact.dependencies.some((dependency) => dependency === artifact.id || !ids.has(dependency)))) return false;
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return false;
    if (visited.has(id)) return true;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependencies ?? []) if (!visit(dependency)) return false;
    visiting.delete(id);
    visited.add(id);
    return true;
  };
  return artifacts.every((artifact) => visit(artifact.id));
}

function strictRecord(value: unknown, allowed: string[], optional: string[] = []) : value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.every((key) => allowed.includes(key)) && allowed.every((key) => optional.includes(key) || keys.includes(key));
}

function shortId(value: unknown, max: number): value is string { return typeof value === "string" && value.length <= max && ID.test(value); }
function text(value: unknown, min: number, max: number): value is string { return typeof value === "string" && value.trim().length >= min && value.length <= max; }
function semver(value: unknown): value is string { return typeof value === "string" && SEMVER.test(value); }
function finite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
function finiteOptional(value: unknown) { return value === undefined || finite(value); }
function httpsUrl(value: unknown) { if (typeof value !== "string" || value.length > 500) return false; try { return new URL(value).protocol === "https:"; } catch { return false; } }
function failure(code: PluginParseErrorCode): PluginParseResult { return { ok: false, code }; }
function compareSemver(left: string, right: string) { const a = left.split(".").map(Number); const b = right.split(".").map(Number); for (let i = 0; i < 3; i += 1) { if (a[i] !== b[i]) return a[i] - b[i]; } return 0; }
function canonicalStringify(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(",")}]`; if (value && typeof value === "object") { const record = value as Record<string, unknown>; return `{${Object.keys(record).sort().filter((key) => record[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonicalStringify(record[key])}`).join(",")}}`; } return JSON.stringify(value); }
async function sha256(value: string) { const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)); return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""); }
