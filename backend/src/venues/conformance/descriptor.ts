import type { VenueCapabilityManifest, VenueMarketType } from "@saltanatbotv2/contracts";
import { PUBLIC_VENUE_ADAPTER_AUTHORITY, PUBLIC_VENUE_ADAPTER_COMPATIBILITY_RANGE, PUBLIC_VENUE_ADAPTER_CONTRACT_VERSION, PUBLIC_VENUE_OPERATIONS, PublicVenuePluginError, type PublicVenueAdapterPluginDescriptor, type PublicVenueCompatibilityResult, type PublicVenueOperation, type SemanticVersion } from "./types.js";

const MAX_PLUGINS = 64;
export const MAX_PUBLIC_OPERATION_SCOPES = 24;
const MAX_OPERATION_ITEMS = 10_000;
const DEFAULT_MAX_DOCS_AGE_DAYS = 366;
const DAY_MS = 86_400_000;
const VENUE_MARKET_TYPES = ["spot", "margin", "perpetual", "future", "option", "native-spread"] as const satisfies readonly VenueMarketType[];
const CAPABILITY_BOOLEAN_KEYS = ["publicData", "spot", "margin", "perpetual", "datedFuture", "option", "nativeSpread", "topBook", "depth", "publicTrades", "funding", "borrow", "depositWithdrawal", "privateExecution", "demoEnvironment"] as const satisfies readonly (keyof VenueCapabilityManifest)[];
const CREDENTIAL_PATTERN = /api[-_ ]?key|authorization|credentials|passphrase|private[-_ ]?key|secret|signature/i;

export function definePublicVenueAdapterPlugin<const Descriptor extends PublicVenueAdapterPluginDescriptor>(descriptor: Descriptor): Descriptor {
  validatePublicVenueAdapterPlugin(descriptor);
  return descriptor;
}

export function validatePublicVenueAdapterPlugin(descriptor: PublicVenueAdapterPluginDescriptor, compatibilityOptions: { now?: number; maxOfficialDocsAgeDays?: number } = {}): void {
  nonEmptyToken(descriptor.pluginId, "pluginId", 128, /^[a-z0-9][a-z0-9._/-]*$/);
  nonEmptyToken(descriptor.venue, "venue", 64, /^[a-z0-9][a-z0-9-]*$/);
  if (descriptor.authority !== PUBLIC_VENUE_ADAPTER_AUTHORITY) {
    throw pluginError(`authority must be ${PUBLIC_VENUE_ADAPTER_AUTHORITY}`);
  }
  const compatibility = evaluatePublicVenueCompatibility(descriptor, compatibilityOptions);
  if (!compatibility.compatible) throw pluginError(compatibility.reasons.join("; "));
  validateCapabilities(descriptor.capabilities, descriptor.venue);
  validateOperations(descriptor.operations, descriptor.capabilities);

  let adapter: ReturnType<PublicVenueAdapterPluginDescriptor["createAdapter"]>;
  try {
    adapter = descriptor.createAdapter();
  } catch (error) {
    throw pluginError(`createAdapter failed: ${safeMessage(error)}`);
  }
  if (!adapter || adapter.venue !== descriptor.venue) throw pluginError("factory adapter venue must equal descriptor venue");
  let actualCapabilities: VenueCapabilityManifest;
  try {
    actualCapabilities = adapter.capabilities();
  } catch (error) {
    throw pluginError(`adapter capabilities failed: ${safeMessage(error)}`);
  }
  if (canonicalJson(actualCapabilities) !== canonicalJson(descriptor.capabilities)) {
    throw pluginError("factory adapter capabilities must exactly equal descriptor capabilities");
  }
}

export function createPublicVenuePluginRegistry(descriptors: readonly PublicVenueAdapterPluginDescriptor[]): ReadonlyMap<string, PublicVenueAdapterPluginDescriptor> {
  if (descriptors.length > MAX_PLUGINS) throw pluginError(`registry exceeds ${MAX_PLUGINS} plugins`);
  const byVenue = new Map<string, PublicVenueAdapterPluginDescriptor>();
  const pluginIds = new Set<string>();
  for (const descriptor of descriptors) {
    if (pluginIds.has(descriptor.pluginId)) throw pluginError(`duplicate pluginId ${descriptor.pluginId}`);
    if (byVenue.has(descriptor.venue)) throw pluginError(`duplicate venue ${descriptor.venue}`);
    validatePublicVenueAdapterPlugin(descriptor);
    pluginIds.add(descriptor.pluginId);
    byVenue.set(descriptor.venue, descriptor);
  }
  return byVenue;
}

export function evaluatePublicVenueCompatibility(candidate: { contractVersion: string; adapterVersion: string; officialDocsReviewedAt: string }, options: { now?: number; maxOfficialDocsAgeDays?: number } = {}): PublicVenueCompatibilityResult {
  const reasons: string[] = [];
  const contractVersion = parseSemver(candidate.contractVersion);
  const adapterVersion = parseSemver(candidate.adapterVersion);
  if (!contractVersion) reasons.push("contractVersion must be strict semantic version x.y.z");
  else if (contractVersion.major !== 1 || contractVersion.minor !== 0) {
    reasons.push(`contractVersion ${candidate.contractVersion} is outside ${PUBLIC_VENUE_ADAPTER_COMPATIBILITY_RANGE}`);
  }
  if (!adapterVersion) reasons.push("adapterVersion must be strict semantic version x.y.z");

  const reviewedAt = parseIsoDate(candidate.officialDocsReviewedAt);
  const now = options.now ?? Date.now();
  if (!Number.isSafeInteger(now) || now <= 0) reasons.push("compatibility clock must be a positive safe-integer timestamp");
  if (reviewedAt === undefined) reasons.push("officialDocsReviewedAt must be a real UTC date in YYYY-MM-DD form");
  else if (Number.isSafeInteger(now) && now > 0) {
    if (reviewedAt > now) reasons.push("officialDocsReviewedAt cannot be in the future");
    const maximumAge = boundedDocsAge(options.maxOfficialDocsAgeDays ?? DEFAULT_MAX_DOCS_AGE_DAYS);
    if (now - reviewedAt > maximumAge * DAY_MS) {
      reasons.push(`official documentation review is older than ${maximumAge} ${maximumAge === 1 ? "day" : "days"}`);
    }
  }
  return { compatible: reasons.length === 0, reasons };
}

function validateCapabilities(capabilities: VenueCapabilityManifest, venue: string) {
  try {
    const encoded = JSON.stringify(capabilities);
    if (encoded.length > 64 * 1024) throw pluginError("capability manifest exceeds 64 KiB");
  } catch (error) {
    if (error instanceof PublicVenuePluginError) throw error;
    throw pluginError("capability manifest must be bounded JSON");
  }
  if (capabilities.venue !== venue) throw pluginError("capability venue must equal descriptor venue");
  for (const key of CAPABILITY_BOOLEAN_KEYS) {
    if (typeof capabilities[key] !== "boolean") throw pluginError(`capability ${key} must be boolean`);
  }
  if (!capabilities.publicData) throw pluginError("publicData must be true");
  if (capabilities.privateExecution || capabilities.borrow || capabilities.depositWithdrawal) {
    throw pluginError("public plugin cannot advertise execution, borrow or deposit/withdrawal authority");
  }
  if (capabilities.scopes !== undefined && !Array.isArray(capabilities.scopes)) throw pluginError("capability scopes must be an array");
  const scopeKeys = new Set<string>();
  for (const scope of capabilities.scopes ?? []) {
    if (!scope || typeof scope !== "object") throw pluginError("capability scope must be an object");
    if (scope.product === "account") throw pluginError("public plugin cannot advertise account capability scopes");
    if (scope.operation !== "public-data") throw pluginError(`public plugin scope ${scope.product}/${scope.operation} exceeds read-only authority`);
    if (scope.status !== "implemented") throw pluginError("plugin scopes may advertise only implemented public data");
    if (!isVenueMarketType(scope.product)) throw pluginError(`unknown public capability product ${String(scope.product)}`);
    const key = `${scope.product}/${scope.operation}`;
    if (scopeKeys.has(key)) throw pluginError(`duplicate capability scope ${key}`);
    scopeKeys.add(key);
    requireMarketCapability(capabilities, scope.product);
  }
}

function validateOperations(operations: readonly PublicVenueAdapterPluginDescriptor["operations"][number][], capabilities: VenueCapabilityManifest) {
  if (operations.length === 0 || operations.length > PUBLIC_VENUE_OPERATIONS.length) {
    throw pluginError(`operations must contain 1-${PUBLIC_VENUE_OPERATIONS.length} unique operation descriptors`);
  }
  const operationNames = new Set<PublicVenueOperation>();
  const scopes = new Set<string>();
  const advertisedMarkets = new Set<VenueMarketType>();
  for (const operation of operations) {
    if (!PUBLIC_VENUE_OPERATIONS.includes(operation.operation)) throw pluginError(`unknown operation ${String(operation.operation)}`);
    if (operationNames.has(operation.operation)) throw pluginError(`duplicate operation ${operation.operation}`);
    operationNames.add(operation.operation);
    if (!Number.isSafeInteger(operation.maxItems) || operation.maxItems < 1 || operation.maxItems > MAX_OPERATION_ITEMS) {
      throw pluginError(`${operation.operation}.maxItems must be an integer from 1 to ${MAX_OPERATION_ITEMS}`);
    }
    if (operation.marketTypes.length === 0) throw pluginError(`${operation.operation} must advertise at least one market type`);
    for (const marketType of operation.marketTypes) {
      if (!isVenueMarketType(marketType)) throw pluginError(`unknown market type ${String(marketType)}`);
      const scope = `${operation.operation}/${marketType}`;
      if (scopes.has(scope)) throw pluginError(`duplicate operation scope ${scope}`);
      scopes.add(scope);
      advertisedMarkets.add(marketType);
      requireMarketCapability(capabilities, marketType);
      requireOperationCapability(capabilities, operation.operation, marketType);
      if (capabilities.scopes && !capabilities.scopes.some((item) => item.product === marketType && item.operation === "public-data")) {
        throw pluginError(`operation scope ${scope} is absent from capability scopes`);
      }
    }
  }
  if (scopes.size > MAX_PUBLIC_OPERATION_SCOPES) throw pluginError(`operation scopes exceed ${MAX_PUBLIC_OPERATION_SCOPES}`);
  for (const marketType of VENUE_MARKET_TYPES) {
    if (marketCapability(capabilities, marketType) && !advertisedMarkets.has(marketType)) {
      throw pluginError(`enabled market ${marketType} has no advertised operation`);
    }
  }
  if (capabilities.topBook && !operationNames.has("ticker") && !operationNames.has("tickers")) {
    throw pluginError("topBook capability has no advertised ticker operation");
  }
  if (capabilities.depth && !operationNames.has("depth")) throw pluginError("depth capability has no advertised depth operation");
  if (capabilities.funding && !operationNames.has("funding")) throw pluginError("funding capability has no advertised funding operation");
  if (capabilities.publicTrades) throw pluginError("contract 1.0.x cannot certify publicTrades; do not advertise it");
}

function requireMarketCapability(capabilities: VenueCapabilityManifest, marketType: VenueMarketType) {
  if (!marketCapability(capabilities, marketType)) throw pluginError(`market ${marketType} is not enabled by the capability manifest`);
}

function marketCapability(capabilities: VenueCapabilityManifest, marketType: VenueMarketType) {
  return marketType === "spot" ? capabilities.spot : marketType === "margin" ? capabilities.margin : marketType === "perpetual" ? capabilities.perpetual : marketType === "future" ? capabilities.datedFuture : marketType === "option" ? capabilities.option : capabilities.nativeSpread;
}

function requireOperationCapability(capabilities: VenueCapabilityManifest, operation: PublicVenueOperation, marketType: VenueMarketType) {
  if ((operation === "ticker" || operation === "tickers") && !capabilities.topBook) {
    throw pluginError(`${operation}/${marketType} requires topBook capability`);
  }
  if (operation === "depth" && !capabilities.depth) throw pluginError(`depth/${marketType} requires depth capability`);
  if (operation === "funding" && (!capabilities.funding || marketType !== "perpetual")) {
    throw pluginError("funding may be advertised only for an enabled perpetual capability");
  }
}

function parseSemver(value: string): { major: number; minor: number; patch: number } | undefined {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if (!match) return undefined;
  const [major, minor, patch] = match.slice(1).map(Number);
  if (![major, minor, patch].every(Number.isSafeInteger)) return undefined;
  return { major: major!, minor: minor!, patch: patch! };
}

function parseIsoDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value ? timestamp : undefined;
}

function isVenueMarketType(value: unknown): value is VenueMarketType {
  return typeof value === "string" && (VENUE_MARKET_TYPES as readonly string[]).includes(value);
}

function boundedDocsAge(value: number) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 3_650) throw pluginError("maxOfficialDocsAgeDays must be an integer from 1 to 3650");
  return value;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function nonEmptyToken(value: string, label: string, maximum: number, pattern: RegExp) {
  if (!value || value.length > maximum || !pattern.test(value)) throw pluginError(`${label} has invalid format`);
}

function safeMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "unknown error";
  return CREDENTIAL_PATTERN.test(message) ? "credential-like error was redacted" : message.slice(0, 200);
}

function pluginError(message: string) {
  return new PublicVenuePluginError(message);
}

export const PUBLIC_VENUE_ADAPTER_CURRENT_CONTRACT = PUBLIC_VENUE_ADAPTER_CONTRACT_VERSION satisfies SemanticVersion;
