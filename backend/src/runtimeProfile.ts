import {
  getRuntimeConfig,
  loadRuntimeConfig,
  RUNTIME_PROFILES,
  type RuntimeConfig,
  type RuntimeProfileName
} from "./config/runtimeConfig.js";

export { RUNTIME_PROFILES };
export type { RuntimeProfileName };

export interface RuntimePolicy {
  readonly runtimeProfile: RuntimeProfileName;
  readonly executionMode: "paper-only" | "live-capable";
  readonly liveBotConfigsAllowed: boolean;
  readonly credentialWritesAllowed: boolean;
  readonly privateExchangeReadsAllowed: boolean;
  readonly privateExchangeMutationsAllowed: boolean;
  readonly privateStreamsAllowed: boolean;
}

export interface RuntimeProfilePublicState {
  runtimeProfile: RuntimeProfileName;
  executionMode: RuntimePolicy["executionMode"];
  privateExchangeRequests: boolean;
  credentialWrites: boolean;
}

export const PAPER_ONLY_MODE_CODE = "PAPER_ONLY_MODE";

export class RuntimeProfileError extends Error {
  readonly code = PAPER_ONLY_MODE_CODE;

  constructor(message: string, readonly operation?: string) {
    super(message);
    this.name = "RuntimeProfileError";
  }
}

let cachedPolicy: RuntimePolicy | undefined;

/**
 * Resolve the immutable process execution boundary. The deliberately safe
 * default is public market data, research, backtests and paper execution only.
 * A future HTTPS deployment must opt in explicitly with `private-live`.
 */
export function resolveRuntimeProfile(env: NodeJS.ProcessEnv = process.env): RuntimePolicy {
  return runtimePolicyFromConfig(loadRuntimeConfig(env));
}

export function runtimePolicyFromConfig(config: Pick<RuntimeConfig, "runtimeProfile">): RuntimePolicy {
  const live = config.runtimeProfile === "private-live";
  return Object.freeze({
    runtimeProfile: config.runtimeProfile,
    executionMode: live ? "live-capable" : "paper-only",
    liveBotConfigsAllowed: live,
    credentialWritesAllowed: live,
    privateExchangeReadsAllowed: live,
    privateExchangeMutationsAllowed: live,
    privateStreamsAllowed: live
  });
}

/** Load once per process so changing an environment variable cannot re-arm it. */
export function getRuntimePolicy(): RuntimePolicy {
  cachedPolicy ??= runtimePolicyFromConfig(getRuntimeConfig());
  return cachedPolicy;
}

export function runtimeProfilePublicState(policy: RuntimePolicy = getRuntimePolicy()): RuntimeProfilePublicState {
  return {
    runtimeProfile: policy.runtimeProfile,
    executionMode: policy.executionMode,
    privateExchangeRequests: policy.privateExchangeReadsAllowed || policy.privateExchangeMutationsAllowed,
    credentialWrites: policy.credentialWritesAllowed
  };
}

export function isPaperOnlyRuntime(policy: RuntimePolicy = getRuntimePolicy()): boolean {
  return policy.executionMode === "paper-only";
}

export function assertLiveExecutionAllowed(operation = "live execution", policy: RuntimePolicy = getRuntimePolicy()): void {
  if (!policy.liveBotConfigsAllowed) throw paperOnlyError(operation);
}

export function assertCredentialWriteAllowed(operation = "exchange credential storage", policy: RuntimePolicy = getRuntimePolicy()): void {
  if (!policy.credentialWritesAllowed) throw paperOnlyError(operation);
}

export function assertPrivateExchangeAccess(
  operation = "private exchange access",
  access: "read" | "mutation" | "stream" = "mutation",
  policy: RuntimePolicy = getRuntimePolicy()
): void {
  const allowed = access === "read"
    ? policy.privateExchangeReadsAllowed
    : access === "stream"
      ? policy.privateStreamsAllowed
      : policy.privateExchangeMutationsAllowed;
  if (!allowed) throw paperOnlyError(operation);
}

export function paperOnlyError(operation: string): RuntimeProfileError {
  return new RuntimeProfileError(`${operation} is disabled while the server is in Research / Paper mode.`, operation);
}

export function paperOnlyErrorBody(operation: string): { error: string; code: typeof PAPER_ONLY_MODE_CODE } {
  const error = paperOnlyError(operation);
  return { error: error.message, code: error.code };
}

/** Test-only cache reset. Production code must never call this. */
export function resetRuntimePolicyForTests(): void {
  if (process.env.NODE_ENV !== "test") throw new Error("Runtime policy can only be reset in tests.");
  cachedPolicy = undefined;
}
