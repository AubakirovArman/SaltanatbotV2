import { isIP } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeExactHttpOrigin } from "../http/exactOrigin.js";

export const RUNTIME_PROFILES = ["public-http-paper", "private-live"] as const;
export const CURRENT_RELEASE_RUNTIME_PROFILE = "public-http-paper" as const;

export type RuntimeProfileName = (typeof RUNTIME_PROFILES)[number];
export type AuthMode = "database" | "legacy";
export type TrustProxySetting = false | number | string | readonly string[];

export interface RuntimeConfig {
  readonly runtimeProfile: RuntimeProfileName;
  readonly frontend: Readonly<{
    distDir: string;
  }>;
  readonly server: Readonly<{
    host: string;
    port: number;
    publicOrigin?: string;
    allowedOrigins: readonly string[];
    trustProxy: TrustProxySetting;
  }>;
  readonly auth: Readonly<{
    mode: AuthMode;
    cookieSecure: boolean;
  }>;
  readonly security: Readonly<{
    allowInsecureTradingMutations: boolean;
  }>;
  readonly trading: Readonly<{
    enableLiveSpot: boolean;
  }>;
  readonly operations: Readonly<{
    recoveryStatusFile?: string;
    admission: Readonly<{
      maxActive: number;
      reservedControlSlots: number;
      maxQueued: number;
      queueTimeoutMs: number;
    }>;
    readiness: Readonly<{
      researchWorkerHeartbeatStaleMs: number;
      requireNotificationWorker: boolean;
      resultTtlMs: number;
      rateLimit: Readonly<{
        refillPerSecond: number;
        burst: number;
        maxBuckets: number;
      }>;
      diskPath: string;
      diskSoftFreeBytes: number;
      diskHardFreeBytes: number;
      diskSoftFreePercent: number;
      diskHardFreePercent: number;
    }>;
  }>;
}

export class RuntimeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeConfigError";
  }
}

const defaultAllowedOrigins = ["http://localhost:5173", "http://127.0.0.1:5173"] as const;
const defaultFrontendDistDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../frontend/dist");
const defaultOperationsDiskPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../data");
const namedProxyRanges = new Set(["loopback", "linklocal", "uniquelocal"]);
let configuredRuntimeConfig: RuntimeConfig | undefined;

/**
 * Parse the process-level security boundary without touching files, databases or
 * listeners. Every consumer receives the same deeply frozen typed snapshot.
 */
export function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const runtimeProfile = parseRuntimeProfile(env.RUNTIME_PROFILE);
  assertCurrentReleaseRuntimeProfile(runtimeProfile);
  return parseRuntimeConfig(env, runtimeProfile);
}

/**
 * Pure validation hook for the separately reviewed future HTTPS release.
 * It intentionally returns no runnable configuration and is never used by
 * process startup; current builds still reject `private-live` in
 * `loadRuntimeConfig`.
 */
export function validateFuturePrivateLiveBoundary(env: NodeJS.ProcessEnv): void {
  const runtimeProfile = parseRuntimeProfile(env.RUNTIME_PROFILE);
  if (runtimeProfile !== "private-live") {
    throw new RuntimeConfigError("Future private-live boundary validation requires RUNTIME_PROFILE=private-live.");
  }
  parseRuntimeConfig(env, runtimeProfile);
}

function parseRuntimeConfig(env: NodeJS.ProcessEnv, runtimeProfile: RuntimeProfileName): RuntimeConfig {
  const demoMode = parseOptionalBoolean("DEMO_MODE", env.DEMO_MODE);
  const frontendDistDir = parseFrontendDistDir(env.FRONTEND_DIST_DIR);
  const host = parseHost(env.HOST);
  const port = parsePort(env.PORT);
  const publicOrigin = parseOptionalOrigin("PUBLIC_ORIGIN", env.PUBLIC_ORIGIN);
  const allowedOrigins = parseAllowedOrigins(env.ALLOWED_ORIGINS);
  const trustProxy = parseTrustProxy(env.TRUST_PROXY);
  const authMode = parseAuthMode(env, demoMode);
  const cookieSecure = parseOptionalBoolean("COOKIE_SECURE", env.COOKIE_SECURE) ?? false;
  const allowInsecureTradingMutations = parseOptionalBoolean("ALLOW_INSECURE_TRADING_MUTATIONS", env.ALLOW_INSECURE_TRADING_MUTATIONS) ?? false;
  const enableLiveSpot = parseOptionalBoolean("ENABLE_LIVE_SPOT", env.ENABLE_LIVE_SPOT) ?? false;
  const admissionMaxActive = parseBoundedInteger("GLOBAL_ADMISSION_MAX_ACTIVE", env.GLOBAL_ADMISSION_MAX_ACTIVE, 128, 16, 4_096);
  const admissionReservedControl = parseBoundedInteger("GLOBAL_ADMISSION_RESERVED_CONTROL", env.GLOBAL_ADMISSION_RESERVED_CONTROL, 16, 1, 1_024);
  const admissionMaxQueued = parseBoundedInteger("GLOBAL_ADMISSION_MAX_QUEUED", env.GLOBAL_ADMISSION_MAX_QUEUED, 256, 1, 16_384);
  const admissionQueueTimeoutMs = parseBoundedInteger("GLOBAL_ADMISSION_QUEUE_TIMEOUT_MS", env.GLOBAL_ADMISSION_QUEUE_TIMEOUT_MS, 2_000, 100, 30_000);
  const researchWorkerHeartbeatStaleMs = parseBoundedInteger("RESEARCH_WORKER_HEARTBEAT_STALE_MS", env.RESEARCH_WORKER_HEARTBEAT_STALE_MS, 90_000, 10_000, 15 * 60_000);
  const requireNotificationWorker = parseOptionalBoolean("OPERATIONS_REQUIRE_NOTIFICATION_WORKER", env.OPERATIONS_REQUIRE_NOTIFICATION_WORKER) ?? false;
  const readinessResultTtlMs = parseBoundedInteger("READINESS_RESULT_TTL_MS", env.READINESS_RESULT_TTL_MS, 1_000, 100, 10_000);
  const readinessRateRefillPerSecond = parseBoundedInteger("READINESS_RATE_REFILL_PER_SECOND", env.READINESS_RATE_REFILL_PER_SECOND, 2, 1, 1_000);
  const readinessRateBurst = parseBoundedInteger("READINESS_RATE_BURST", env.READINESS_RATE_BURST, 10, 1, 10_000);
  const readinessRateMaxBuckets = parseBoundedInteger("READINESS_RATE_MAX_BUCKETS", env.READINESS_RATE_MAX_BUCKETS, 4_096, 256, 100_000);
  const recoveryStatusFile = parseOptionalNormalizedAbsolutePath("OPERATIONS_RECOVERY_STATUS_FILE", env.OPERATIONS_RECOVERY_STATUS_FILE);
  const operationsDiskPath = parseNormalizedAbsolutePath("OPERATIONS_DISK_PATH", env.OPERATIONS_DISK_PATH, defaultOperationsDiskPath);
  const diskSoftFreeBytes = parseBoundedInteger("OPERATIONS_DISK_SOFT_FREE_BYTES", env.OPERATIONS_DISK_SOFT_FREE_BYTES, 5 * 1_024 ** 3, 128 * 1_024 ** 2, Number.MAX_SAFE_INTEGER);
  const diskHardFreeBytes = parseBoundedInteger("OPERATIONS_DISK_HARD_FREE_BYTES", env.OPERATIONS_DISK_HARD_FREE_BYTES, 2 * 1_024 ** 3, 64 * 1_024 ** 2, Number.MAX_SAFE_INTEGER);
  const diskSoftFreePercent = parseBoundedInteger("OPERATIONS_DISK_SOFT_FREE_PERCENT", env.OPERATIONS_DISK_SOFT_FREE_PERCENT, 5, 1, 99);
  const diskHardFreePercent = parseBoundedInteger("OPERATIONS_DISK_HARD_FREE_PERCENT", env.OPERATIONS_DISK_HARD_FREE_PERCENT, 2, 1, 98);

  if (admissionReservedControl >= admissionMaxActive) {
    throw new RuntimeConfigError("GLOBAL_ADMISSION_RESERVED_CONTROL must be lower than GLOBAL_ADMISSION_MAX_ACTIVE.");
  }
  if (diskHardFreeBytes >= diskSoftFreeBytes) {
    throw new RuntimeConfigError("OPERATIONS_DISK_HARD_FREE_BYTES must be lower than OPERATIONS_DISK_SOFT_FREE_BYTES.");
  }
  if (diskHardFreePercent >= diskSoftFreePercent) {
    throw new RuntimeConfigError("OPERATIONS_DISK_HARD_FREE_PERCENT must be lower than OPERATIONS_DISK_SOFT_FREE_PERCENT.");
  }

  validateRuntimeBoundary({
    runtimeProfile,
    demoMode,
    host,
    publicOrigin,
    allowedOrigins,
    trustProxy,
    authMode,
    cookieSecure,
    allowInsecureTradingMutations,
    enableLiveSpot
  });

  return freezeRuntimeConfig({
    runtimeProfile,
    frontend: { distDir: frontendDistDir },
    server: { host, port, publicOrigin, allowedOrigins, trustProxy },
    auth: { mode: authMode, cookieSecure },
    security: { allowInsecureTradingMutations },
    trading: { enableLiveSpot },
    operations: {
      recoveryStatusFile,
      admission: {
        maxActive: admissionMaxActive,
        reservedControlSlots: admissionReservedControl,
        maxQueued: admissionMaxQueued,
        queueTimeoutMs: admissionQueueTimeoutMs
      },
      readiness: {
        researchWorkerHeartbeatStaleMs,
        requireNotificationWorker,
        resultTtlMs: readinessResultTtlMs,
        rateLimit: {
          refillPerSecond: readinessRateRefillPerSecond,
          burst: readinessRateBurst,
          maxBuckets: readinessRateMaxBuckets
        },
        diskPath: operationsDiskPath,
        diskSoftFreeBytes,
        diskHardFreeBytes,
        diskSoftFreePercent,
        diskHardFreePercent
      }
    }
  });
}

function parseFrontendDistDir(value: string | undefined): string {
  return parseNormalizedAbsolutePath("FRONTEND_DIST_DIR", value, defaultFrontendDistDir);
}

function parseNormalizedAbsolutePath(name: string, value: string | undefined, fallback: string): string {
  if (value === undefined || value === "") return fallback;
  if (value !== value.trim() || value.length > 4_096 || /[\0\r\n]/.test(value) || !path.isAbsolute(value) || path.normalize(value) !== value) {
    throw new RuntimeConfigError(`Invalid ${name}. Expected a normalized absolute filesystem path.`);
  }
  return value;
}

function parseOptionalNormalizedAbsolutePath(name: string, value: string | undefined): string | undefined {
  if (value === undefined || value === "") return undefined;
  return parseNormalizedAbsolutePath(name, value, "");
}

/** Pin configuration once, before startup opens databases/files or listeners. */
export function initializeRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const parsed = loadRuntimeConfig(env);
  if (configuredRuntimeConfig && runtimeConfigFingerprint(configuredRuntimeConfig) !== runtimeConfigFingerprint(parsed)) {
    throw new RuntimeConfigError("Runtime configuration was already initialized with different values.");
  }
  configuredRuntimeConfig ??= parsed;
  return configuredRuntimeConfig;
}

/** Lazy fallback for isolated modules/tests; production startup initializes it explicitly. */
export function getRuntimeConfig(): RuntimeConfig {
  configuredRuntimeConfig ??= loadRuntimeConfig(process.env);
  return configuredRuntimeConfig;
}

/** Test-only cache reset. Production code must never re-arm process configuration. */
export function resetRuntimeConfigForTests(): void {
  if (process.env.NODE_ENV !== "test") throw new RuntimeConfigError("Runtime configuration can only be reset in tests.");
  configuredRuntimeConfig = undefined;
}

function parseRuntimeProfile(value: string | undefined): RuntimeProfileName {
  const configured = value?.trim();
  if (!configured) return "public-http-paper";
  if (RUNTIME_PROFILES.includes(configured as RuntimeProfileName)) return configured as RuntimeProfileName;
  throw new RuntimeConfigError(`Invalid RUNTIME_PROFILE=${configured}. Expected one of: ${RUNTIME_PROFILES.join(", ")}.`);
}

function assertCurrentReleaseRuntimeProfile(runtimeProfile: RuntimeProfileName): void {
  if (runtimeProfile !== CURRENT_RELEASE_RUNTIME_PROFILE) {
    throw new RuntimeConfigError("RUNTIME_PROFILE=private-live is disabled in this pre-HTTPS release. Use RUNTIME_PROFILE=public-http-paper; live activation requires a separate future release and security review.");
  }
}

function parseAuthMode(env: NodeJS.ProcessEnv, demoMode: boolean | undefined): AuthMode {
  const configured = env.AUTH_MODE?.trim().toLowerCase();
  if (configured === "database" || configured === "legacy") return configured;
  if (configured) throw new RuntimeConfigError("Invalid AUTH_MODE. Expected database or legacy.");
  if (demoMode === true && env.AUTH_TOKEN?.trim()) return "legacy";
  return "database";
}

function parseHost(value: string | undefined): string {
  const host = value?.trim() || "127.0.0.1";
  if (!isValidHost(host)) {
    throw new RuntimeConfigError("Invalid HOST. Expected an IP address or hostname without a scheme/path.");
  }
  return host;
}

function isValidHost(host: string): boolean {
  if (isIP(host) !== 0) return true;
  if (host.length > 253 || /^[0-9.]+$/.test(host) || host.includes(":")) return false;
  const hostname = host.endsWith(".") ? host.slice(0, -1) : host;
  if (!hostname) return false;
  return hostname.split(".").every((label) => label.length >= 1 && label.length <= 63 && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label));
}

function parsePort(value: string | undefined): number {
  const raw = value?.trim();
  if (!raw) return 4180;
  if (!/^\d+$/.test(raw)) throw new RuntimeConfigError("Invalid PORT. Expected an integer from 1 to 65535.");
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new RuntimeConfigError("Invalid PORT. Expected an integer from 1 to 65535.");
  }
  return port;
}

function parseOptionalBoolean(name: string, value: string | undefined): boolean | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true") return true;
  if (normalized === "0" || normalized === "false") return false;
  throw new RuntimeConfigError(`Invalid ${name}=${value}. Expected 1, 0, true or false.`);
}

function parseBoundedInteger(name: string, value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  const raw = value?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new RuntimeConfigError(`Invalid ${name}. Expected an integer from ${minimum} to ${maximum}.`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new RuntimeConfigError(`Invalid ${name}. Expected an integer from ${minimum} to ${maximum}.`);
  }
  return parsed;
}

function parseOptionalOrigin(name: string, value: string | undefined): string | undefined {
  const raw = value?.trim();
  return raw ? parseOrigin(name, raw) : undefined;
}

function parseAllowedOrigins(value: string | undefined): readonly string[] {
  if (value === undefined) return defaultAllowedOrigins;
  if (value.trim() === "") return [];
  const entries = value.split(",").map((entry) => entry.trim());
  if (entries.length > 32) throw new RuntimeConfigError("Invalid ALLOWED_ORIGINS. At most 32 exact origins are allowed.");
  if (entries.some((entry) => !entry)) {
    throw new RuntimeConfigError("Invalid ALLOWED_ORIGINS. Empty comma-separated entries are not allowed.");
  }
  return [...new Set(entries.map((entry) => parseOrigin("ALLOWED_ORIGINS", entry)))];
}

function parseOrigin(name: string, value: string): string {
  const origin = normalizeExactHttpOrigin(value);
  if (!origin) throw invalidOrigin(name);
  return origin;
}

function invalidOrigin(name: string): RuntimeConfigError {
  return new RuntimeConfigError(`Invalid ${name}. Expected an exact http(s) origin without path, query or credentials.`);
}

function parseTrustProxy(value: string | undefined): TrustProxySetting {
  const raw = value?.trim();
  if (!raw || raw === "0" || raw.toLowerCase() === "false") return false;
  if (raw.toLowerCase() === "true") {
    throw new RuntimeConfigError("Invalid TRUST_PROXY=true. Configure an exact IP/CIDR or a named safe range such as loopback.");
  }
  if (/^\d+$/.test(raw)) {
    const hops = Number(raw);
    if (hops < 1 || hops > 255) throw new RuntimeConfigError("Invalid TRUST_PROXY hop count. Expected 1 to 255.");
    return hops;
  }
  const rawEntries = raw.split(",");
  if (rawEntries.length > 32) throw invalidTrustProxy();
  const entries = rawEntries.map((entry) => normalizeProxyEntry(entry.trim()));
  return entries.length === 1 ? entries[0] : entries;
}

function normalizeProxyEntry(entry: string): string {
  const normalizedName = entry.toLowerCase();
  if (namedProxyRanges.has(normalizedName)) return normalizedName;
  if (isIP(entry) !== 0) return entry;
  const separator = entry.lastIndexOf("/");
  if (separator <= 0) throw invalidTrustProxy();
  const address = entry.slice(0, separator);
  const prefix = entry.slice(separator + 1);
  const version = isIP(address);
  if (!version || !/^\d+$/.test(prefix)) throw invalidTrustProxy();
  const bits = Number(prefix);
  if (bits < 0 || bits > (version === 4 ? 32 : 128)) throw invalidTrustProxy();
  return entry;
}

function invalidTrustProxy(): RuntimeConfigError {
  return new RuntimeConfigError("Invalid TRUST_PROXY. Use IP/CIDR entries or loopback, linklocal, uniquelocal.");
}

interface RuntimeBoundaryInput {
  runtimeProfile: RuntimeProfileName;
  demoMode: boolean | undefined;
  host: string;
  publicOrigin?: string;
  allowedOrigins: readonly string[];
  trustProxy: TrustProxySetting;
  authMode: AuthMode;
  cookieSecure: boolean;
  allowInsecureTradingMutations: boolean;
  enableLiveSpot: boolean;
}

function validateRuntimeBoundary(input: RuntimeBoundaryInput): void {
  if (input.runtimeProfile === "public-http-paper") {
    if (input.allowInsecureTradingMutations) {
      throw new RuntimeConfigError("ALLOW_INSECURE_TRADING_MUTATIONS=true conflicts with RUNTIME_PROFILE=public-http-paper.");
    }
    if (input.enableLiveSpot) {
      throw new RuntimeConfigError("ENABLE_LIVE_SPOT=true conflicts with RUNTIME_PROFILE=public-http-paper.");
    }
    return;
  }

  if (input.demoMode === true) throw privateLiveRequirement("DEMO_MODE must be false");
  if (input.authMode !== "database") throw privateLiveRequirement("AUTH_MODE=database");
  if (!isLoopbackHost(input.host)) throw privateLiveRequirement("HOST must bind to loopback");
  if (!input.publicOrigin?.startsWith("https://")) throw privateLiveRequirement("PUBLIC_ORIGIN must be an https origin");
  if (!input.cookieSecure) throw privateLiveRequirement("COOKIE_SECURE=true");
  if (!privateLiveTrustProxyIsNarrow(input.trustProxy)) {
    throw privateLiveRequirement("TRUST_PROXY must use loopback, exact proxy IPs, or CIDRs no broader than IPv4 /28 or IPv6 /124");
  }
  if (input.allowedOrigins.some((origin) => !origin.startsWith("https://"))) {
    throw privateLiveRequirement("ALLOWED_ORIGINS must be empty or contain only https origins");
  }
  if (input.allowInsecureTradingMutations) {
    throw privateLiveRequirement("ALLOW_INSECURE_TRADING_MUTATIONS must be false");
  }
}

function privateLiveRequirement(requirement: string): RuntimeConfigError {
  return new RuntimeConfigError(`RUNTIME_PROFILE=private-live requires ${requirement}.`);
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase();
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

/** A reverse-proxy pool should need at most 16 addresses; wider subnets make a
 * compromised peer indistinguishable from the TLS terminator. */
function privateLiveTrustProxyIsNarrow(setting: TrustProxySetting): boolean {
  if (setting === false || typeof setting === "number") return false;
  const entries = Array.isArray(setting) ? setting : [setting];
  return (
    entries.length > 0 &&
    entries.every((entry) => {
      if (entry === "loopback") return true;
      if (namedProxyRanges.has(entry)) return false;
      if (isIP(entry) !== 0) return true;
      const separator = entry.lastIndexOf("/");
      if (separator <= 0) return false;
      const version = isIP(entry.slice(0, separator));
      const prefix = Number(entry.slice(separator + 1));
      return version === 4 ? prefix >= 28 : version === 6 && prefix >= 124;
    })
  );
}

function freezeRuntimeConfig(config: RuntimeConfig): RuntimeConfig {
  const allowedOrigins = Object.freeze([...config.server.allowedOrigins]);
  const trustProxy = Array.isArray(config.server.trustProxy) ? Object.freeze([...config.server.trustProxy]) : config.server.trustProxy;
  const admission = Object.freeze({ ...config.operations.admission });
  const rateLimit = Object.freeze({ ...config.operations.readiness.rateLimit });
  const readiness = Object.freeze({ ...config.operations.readiness, rateLimit });
  return Object.freeze({
    runtimeProfile: config.runtimeProfile,
    frontend: Object.freeze({ ...config.frontend }),
    server: Object.freeze({ ...config.server, allowedOrigins, trustProxy }),
    auth: Object.freeze({ ...config.auth }),
    security: Object.freeze({ ...config.security }),
    trading: Object.freeze({ ...config.trading }),
    operations: Object.freeze({
      recoveryStatusFile: config.operations.recoveryStatusFile,
      admission,
      readiness
    })
  });
}

function runtimeConfigFingerprint(config: RuntimeConfig): string {
  return JSON.stringify(config);
}
