export const PLUGIN_FILE_FORMAT = "saltanatbotv2.plugin" as const;
export const PLUGIN_FILE_VERSION = 1 as const;
export const PLUGIN_SIGNED_FILE_VERSION = 2 as const;
export const PLUGIN_ROTATED_FILE_VERSION = 3 as const;
export const PLUGIN_SIGNATURE_SCHEME = "ECDSA-P256-SHA256" as const;
export const PLUGIN_MAX_BYTES = 5_000_000;
export const PLUGIN_MAX_ARTIFACTS = 25;
export const PLUGIN_MAX_KEY_TRANSITIONS = 8;

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

export interface PluginPublicKey {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
}

export interface PluginFileSignature {
  scheme: typeof PLUGIN_SIGNATURE_SCHEME;
  key: PluginPublicKey;
  keyFingerprint: string;
  value: string;
}

export interface PluginKeyTransition {
  sequence: number;
  previousKey: PluginPublicKey;
  previousKeyFingerprint: string;
  nextKey: PluginPublicKey;
  nextKeyFingerprint: string;
  previousSignature: string;
  nextSignature: string;
}

export interface VerifiedPluginKeyTransition {
  sequence: number;
  previousKeyFingerprint: string;
  nextKeyFingerprint: string;
}

export type VerifiedPluginSignature = Omit<PluginFileSignature, "value"> & {
  keyTransitions?: VerifiedPluginKeyTransition[];
};

export interface UnsignedPluginFile {
  format: typeof PLUGIN_FILE_FORMAT;
  version: typeof PLUGIN_FILE_VERSION;
  algorithm: "SHA-256";
  checksum: string;
  manifest: PluginManifest;
}

export interface SignedPluginFile {
  format: typeof PLUGIN_FILE_FORMAT;
  version: typeof PLUGIN_SIGNED_FILE_VERSION;
  algorithm: "SHA-256";
  checksum: string;
  signature: PluginFileSignature;
  manifest: PluginManifest;
}

export interface RotatedPluginFile {
  format: typeof PLUGIN_FILE_FORMAT;
  version: typeof PLUGIN_ROTATED_FILE_VERSION;
  algorithm: "SHA-256";
  checksum: string;
  keyTransitions: PluginKeyTransition[];
  signature: PluginFileSignature;
  manifest: PluginManifest;
}

export type PluginFile = UnsignedPluginFile | SignedPluginFile | RotatedPluginFile;

export type PluginParseErrorCode =
  | "too_large"
  | "invalid_json"
  | "invalid_envelope"
  | "unsupported_version"
  | "checksum_mismatch"
  | "invalid_signature"
  | "invalid_manifest"
  | "unsupported_permission"
  | "invalid_artifact"
  | "dependency_error"
  | "incompatible_app";

export interface VerifiedPlugin {
  manifest: PluginManifest;
  checksum: string;
  signature?: VerifiedPluginSignature;
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
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const SIGNATURE_CONTEXT = "saltanatbotv2.plugin-signature.v1\n";
const KEY_TRANSITION_CONTEXT = "saltanatbotv2.plugin-key-transition.v1\n";

/** Parse a strict, checksummed declarative plugin. No executable JavaScript is accepted. */
export async function parsePluginFile(raw: string, options: ParsePluginOptions = {}): Promise<PluginParseResult> {
  if (new TextEncoder().encode(raw).byteLength > PLUGIN_MAX_BYTES) return failure("too_large");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return failure("invalid_json"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return failure("invalid_envelope");
  const envelope = parsed as Record<string, unknown>;
  if (envelope.version === PLUGIN_FILE_VERSION) {
    if (!strictRecord(envelope, ["format", "version", "algorithm", "checksum", "manifest"])) return failure("invalid_envelope");
  } else if (envelope.version === PLUGIN_SIGNED_FILE_VERSION) {
    if (!strictRecord(envelope, ["format", "version", "algorithm", "checksum", "signature", "manifest"])) return failure("invalid_envelope");
  } else if (envelope.version === PLUGIN_ROTATED_FILE_VERSION) {
    if (!strictRecord(envelope, ["format", "version", "algorithm", "checksum", "keyTransitions", "signature", "manifest"])) return failure("invalid_envelope");
  } else {
    return failure("unsupported_version");
  }
  if (envelope.format !== PLUGIN_FILE_FORMAT || envelope.algorithm !== "SHA-256" || typeof envelope.checksum !== "string" || !CHECKSUM.test(envelope.checksum)) return failure("invalid_envelope");
  const manifestResult = parseManifest(envelope.manifest, options.maxArtifactSchemaVersion ?? 2);
  if (!manifestResult.ok) return manifestResult;
  const checksum = await sha256(canonicalStringify(envelope.manifest));
  if (checksum !== envelope.checksum) return failure("checksum_mismatch");
  let signature = envelope.version === PLUGIN_SIGNED_FILE_VERSION || envelope.version === PLUGIN_ROTATED_FILE_VERSION ? await verifySignature(envelope.signature, checksum) : undefined;
  if ((envelope.version === PLUGIN_SIGNED_FILE_VERSION || envelope.version === PLUGIN_ROTATED_FILE_VERSION) && !signature) return failure("invalid_signature");
  if (envelope.version === PLUGIN_ROTATED_FILE_VERSION && signature) {
    const keyTransitions = await verifyPluginKeyTransitions(envelope.keyTransitions, signature.keyFingerprint);
    if (!keyTransitions) return failure("invalid_signature");
    signature = { ...signature, keyTransitions };
  }
  if (options.appVersion && compareSemver(manifestResult.manifest.minAppVersion, options.appVersion) > 0) return failure("incompatible_app");
  return { ok: true, manifest: manifestResult.manifest, checksum, signature };
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
  return boundedEncoding(file);
}

export async function encodeSignedPluginFile(manifest: PluginManifest, signer: { publicKey: PluginPublicKey; privateKey: CryptoKey; keyTransitions?: PluginKeyTransition[] }): Promise<string> {
  const validated = parseManifest(manifest, Number.MAX_SAFE_INTEGER);
  if (!validated.ok) throw new Error(validated.code);
  const publicKey = pluginPublicKey(signer.publicKey);
  const checksum = await sha256(canonicalStringify(validated.manifest));
  const keyFingerprint = await pluginKeyFingerprint(publicKey);
  const keyTransitions = signer.keyTransitions ?? [];
  if (keyTransitions.length && !await verifyPluginKeyTransitions(keyTransitions, keyFingerprint)) throw new Error("invalid_signature");
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signer.privateKey, signaturePayload(checksum));
  const fileSignature: PluginFileSignature = { scheme: PLUGIN_SIGNATURE_SCHEME, key: publicKey, keyFingerprint, value: base64UrlEncode(new Uint8Array(signature)) };
  if (!await verifySignature(fileSignature, checksum)) throw new Error("invalid_signature");
  const file: SignedPluginFile | RotatedPluginFile = keyTransitions.length ? {
    format: PLUGIN_FILE_FORMAT,
    version: PLUGIN_ROTATED_FILE_VERSION,
    algorithm: "SHA-256",
    checksum,
    keyTransitions,
    signature: fileSignature,
    manifest: validated.manifest
  } : {
    format: PLUGIN_FILE_FORMAT,
    version: PLUGIN_SIGNED_FILE_VERSION,
    algorithm: "SHA-256",
    checksum,
    signature: fileSignature,
    manifest: validated.manifest
  };
  return boundedEncoding(file);
}

export async function createPluginSigningKeyPair(): Promise<{ publicKey: PluginPublicKey; privateKey: CryptoKey; keyFingerprint: string; keyTransitions: PluginKeyTransition[] }> {
  const generated = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const publicKey = pluginPublicKeyFromJwk(await crypto.subtle.exportKey("jwk", generated.publicKey));
  const privateJwk = await crypto.subtle.exportKey("jwk", generated.privateKey);
  const privateKey = await crypto.subtle.importKey("jwk", privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  return { publicKey, privateKey, keyFingerprint: await pluginKeyFingerprint(publicKey), keyTransitions: [] };
}

export async function rotatePluginSigningKeyPair(current: { publicKey: PluginPublicKey; privateKey: CryptoKey; keyTransitions?: PluginKeyTransition[] }): Promise<{ publicKey: PluginPublicKey; privateKey: CryptoKey; keyFingerprint: string; keyTransitions: PluginKeyTransition[] }> {
  const previousKey = pluginPublicKey(current.publicKey);
  const previousKeyFingerprint = await pluginKeyFingerprint(previousKey);
  const existing = current.keyTransitions ?? [];
  if (existing.length) {
    if (!await verifyPluginKeyTransitions(existing, previousKeyFingerprint)) throw new Error("invalid_signature");
    if (existing.length >= PLUGIN_MAX_KEY_TRANSITIONS) throw new Error("key_rotation_limit");
  }
  const generated = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const nextKey = pluginPublicKeyFromJwk(await crypto.subtle.exportKey("jwk", generated.publicKey));
  const nextKeyFingerprint = await pluginKeyFingerprint(nextKey);
  const sequence = existing.length + 1;
  const payload = keyTransitionPayload({ sequence, previousKey, previousKeyFingerprint, nextKey, nextKeyFingerprint });
  const previousSignature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, current.privateKey, payload);
  const nextSignature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, generated.privateKey, payload);
  const transition: PluginKeyTransition = {
    sequence,
    previousKey,
    previousKeyFingerprint,
    nextKey,
    nextKeyFingerprint,
    previousSignature: base64UrlEncode(new Uint8Array(previousSignature)),
    nextSignature: base64UrlEncode(new Uint8Array(nextSignature))
  };
  const keyTransitions = [...existing, transition];
  if (!await verifyPluginKeyTransitions(keyTransitions, nextKeyFingerprint)) throw new Error("invalid_signature");
  const privateJwk = await crypto.subtle.exportKey("jwk", generated.privateKey);
  const privateKey = await crypto.subtle.importKey("jwk", privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  return { publicKey: nextKey, privateKey, keyFingerprint: nextKeyFingerprint, keyTransitions };
}

export async function pluginKeyFingerprint(key: PluginPublicKey): Promise<string> {
  return sha256(canonicalStringify(pluginPublicKey(key)));
}

export async function verifyPluginKeyTransitions(value: unknown, expectedFinalFingerprint: string): Promise<VerifiedPluginKeyTransition[] | undefined> {
  try {
    if (!Array.isArray(value) || value.length < 1 || value.length > PLUGIN_MAX_KEY_TRANSITIONS || !CHECKSUM.test(expectedFinalFingerprint)) return;
    const verified: VerifiedPluginKeyTransition[] = [];
    const fingerprints = new Set<string>();
    let expectedPreviousFingerprint: string | undefined;
    for (let index = 0; index < value.length; index += 1) {
      const entry = value[index];
      if (!strictRecord(entry, ["sequence", "previousKey", "previousKeyFingerprint", "nextKey", "nextKeyFingerprint", "previousSignature", "nextSignature"])) return;
      if (entry.sequence !== index + 1 || typeof entry.previousKeyFingerprint !== "string" || !CHECKSUM.test(entry.previousKeyFingerprint) || typeof entry.nextKeyFingerprint !== "string" || !CHECKSUM.test(entry.nextKeyFingerprint)) return;
      if (typeof entry.previousSignature !== "string" || typeof entry.nextSignature !== "string" || !BASE64URL.test(entry.previousSignature) || !BASE64URL.test(entry.nextSignature)) return;
      const previousKey = pluginPublicKey(entry.previousKey);
      const nextKey = pluginPublicKey(entry.nextKey);
      if (await pluginKeyFingerprint(previousKey) !== entry.previousKeyFingerprint || await pluginKeyFingerprint(nextKey) !== entry.nextKeyFingerprint) return;
      if (entry.previousKeyFingerprint === entry.nextKeyFingerprint || expectedPreviousFingerprint && entry.previousKeyFingerprint !== expectedPreviousFingerprint) return;
      if (index === 0) fingerprints.add(entry.previousKeyFingerprint);
      if (fingerprints.has(entry.nextKeyFingerprint)) return;
      fingerprints.add(entry.nextKeyFingerprint);
      const payload = keyTransitionPayload({ sequence: entry.sequence, previousKey, previousKeyFingerprint: entry.previousKeyFingerprint, nextKey, nextKeyFingerprint: entry.nextKeyFingerprint });
      if (!await verifyRawSignature(previousKey, entry.previousSignature, payload) || !await verifyRawSignature(nextKey, entry.nextSignature, payload)) return;
      verified.push({ sequence: entry.sequence, previousKeyFingerprint: entry.previousKeyFingerprint, nextKeyFingerprint: entry.nextKeyFingerprint });
      expectedPreviousFingerprint = entry.nextKeyFingerprint;
    }
    if (expectedPreviousFingerprint !== expectedFinalFingerprint) return;
    return verified;
  } catch {
    return;
  }
}

async function verifySignature(value: unknown, checksum: string): Promise<VerifiedPluginSignature | undefined> {
  try {
    if (!strictRecord(value, ["scheme", "key", "keyFingerprint", "value"])) return;
    if (value.scheme !== PLUGIN_SIGNATURE_SCHEME || typeof value.keyFingerprint !== "string" || !CHECKSUM.test(value.keyFingerprint) || typeof value.value !== "string" || !BASE64URL.test(value.value)) return;
    const key = pluginPublicKey(value.key);
    if (await pluginKeyFingerprint(key) !== value.keyFingerprint) return;
    if (!await verifyRawSignature(key, value.value, signaturePayload(checksum))) return;
    return { scheme: PLUGIN_SIGNATURE_SCHEME, key, keyFingerprint: value.keyFingerprint };
  } catch {
    return;
  }
}

async function verifyRawSignature(key: PluginPublicKey, value: string, payload: Uint8Array<ArrayBuffer>) {
  const signature = base64UrlDecode(value);
  if (signature.byteLength !== 64) return false;
  const cryptoKey = await crypto.subtle.importKey("jwk", { ...key, ext: true, key_ops: ["verify"] }, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, cryptoKey, signature, payload);
}

function pluginPublicKey(value: unknown): PluginPublicKey {
  if (!strictRecord(value, ["kty", "crv", "x", "y"]) || value.kty !== "EC" || value.crv !== "P-256" || typeof value.x !== "string" || typeof value.y !== "string") throw new Error("invalid_signature");
  return validatedPluginPublicKey(value.x, value.y);
}

function pluginPublicKeyFromJwk(value: JsonWebKey) {
  if (value.kty !== "EC" || value.crv !== "P-256" || typeof value.x !== "string" || typeof value.y !== "string") throw new Error("invalid_signature");
  return validatedPluginPublicKey(value.x, value.y);
}

function validatedPluginPublicKey(x: string, y: string): PluginPublicKey {
  if (!BASE64URL.test(x) || !BASE64URL.test(y) || base64UrlDecode(x).byteLength !== 32 || base64UrlDecode(y).byteLength !== 32) throw new Error("invalid_signature");
  return { kty: "EC", crv: "P-256", x, y };
}

function signaturePayload(checksum: string) {
  return new TextEncoder().encode(`${SIGNATURE_CONTEXT}${checksum}`);
}

function keyTransitionPayload(value: { sequence: number; previousKey: PluginPublicKey; previousKeyFingerprint: string; nextKey: PluginPublicKey; nextKeyFingerprint: string }) {
  return new TextEncoder().encode(`${KEY_TRANSITION_CONTEXT}${canonicalStringify(value)}`);
}

function boundedEncoding(file: PluginFile) {
  const encoded = JSON.stringify(file, null, 2);
  if (new TextEncoder().encode(encoded).byteLength > PLUGIN_MAX_BYTES) throw new Error("too_large");
  return encoded;
}

function base64UrlEncode(value: Uint8Array) {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const decoded = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) decoded[index] = binary.charCodeAt(index);
  return decoded;
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
