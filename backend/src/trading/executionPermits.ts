import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { RuntimePolicy } from "../runtimeProfile.js";
import { canonicalExecutionValue, classifySignedExchangeRequest, signedExchangeRequestDigest, type ExecutionCapability, type ExecutionRiskEffect, type SignedExchangeMarket, type SignedExchangeRequest, type SignedExchangeVenue, type SignedExecutionAction } from "./executionCapabilities.js";
import type { AuthRole } from "./types.js";

declare const executionPermitTokenBrand: unique symbol;
const handedOffExecutionPermitBrand: unique symbol = Symbol("handed-off-execution-permit");

export type ExecutionPermitToken = string & { readonly [executionPermitTokenBrand]: true };

export type ExecutionPermitOperation =
  | { readonly kind: "bot"; readonly botId: string; readonly runId: string }
  | { readonly kind: "manual"; readonly requestId: string }
  | { readonly kind: "emergency"; readonly operationId: string }
  | { readonly kind: "reconciliation"; readonly operationId: string }
  | { readonly kind: "telemetry"; readonly operationId: string };

export interface ExecutionRiskProof {
  readonly kind: "venue-enforced-reduce-only" | "bounded-existing-exposure";
  readonly evidenceDigest: string;
}

export interface ExecutionPermitBinding {
  readonly ownerUserId: string;
  readonly actorUserId?: string;
  readonly sessionIdHash?: string;
  readonly accountId: string;
  readonly accountRevision: number;
  readonly credentialRevision: number;
  readonly authorizationRevision: number;
  readonly authorizationRole: AuthRole;
  readonly authorizationEpoch: number;
  readonly liveArmEpoch: number;
  readonly operation: ExecutionPermitOperation;
  readonly venue: SignedExchangeVenue;
  readonly market: SignedExchangeMarket;
  readonly symbol?: string;
  readonly capability: ExecutionCapability;
  readonly action: SignedExecutionAction;
  readonly riskEffect: ExecutionRiskEffect;
  readonly riskProof?: ExecutionRiskProof;
  readonly intentId: string;
  readonly intentDigest: string;
  readonly signedRequestDigest: string;
  readonly rulesFingerprint: string | null;
}

export interface ExecutionPermitClaims extends ExecutionPermitBinding {
  readonly permitId: string;
  readonly nonce: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
}

export interface ExecutionPermitIssueRequest extends ExecutionPermitBinding {
  readonly signedRequest: SignedExchangeRequest;
  readonly ttlMs?: number;
}

export interface IssuedExecutionPermit {
  readonly token: ExecutionPermitToken;
  readonly claims: Readonly<ExecutionPermitClaims>;
}

export interface HandedOffExecutionPermit {
  readonly token: ExecutionPermitToken;
  readonly permitId: string;
  readonly [handedOffExecutionPermitBrand]: true;
}

export type ExecutionPermitPhase = "issue" | "handoff" | "consume";
export type ExecutionPermitCurrentStateValidator = (claims: Readonly<ExecutionPermitClaims>, phase: ExecutionPermitPhase) => boolean;

export interface ExecutionPermitBrokerOptions {
  readonly runtimePolicy: RuntimePolicy;
  readonly validateCurrent: ExecutionPermitCurrentStateValidator;
  readonly now?: () => number;
  readonly monotonicNow?: () => number;
  readonly defaultTtlMs?: number;
  readonly maxTtlMs?: number;
  readonly maxActive?: number;
  readonly maxActivePerOwner?: number;
  readonly maxTombstones?: number;
  readonly maxTombstonesPerOwner?: number;
}

export const EXECUTION_PERMIT_ERROR_CODES = [
  "PERMIT_INVALID",
  "PERMIT_POLICY_DENIED",
  "PERMIT_CAPABILITY_MISMATCH",
  "PERMIT_FORGED",
  "PERMIT_EXPIRED",
  "PERMIT_REUSED",
  "PERMIT_HANDOFF_REQUIRED",
  "PERMIT_CONTEXT_MISMATCH",
  "PERMIT_CURRENT_STATE_CHANGED",
  "PERMIT_DUPLICATE_STEP",
  "PERMIT_CAPACITY",
  "PERMIT_REVOKED"
] as const;

export type ExecutionPermitErrorCode = (typeof EXECUTION_PERMIT_ERROR_CODES)[number];

export class ExecutionPermitError extends Error {
  constructor(
    readonly code: ExecutionPermitErrorCode,
    message: string
  ) {
    super(message);
    this.name = "ExecutionPermitError";
  }
}

type PermitState = "issued" | "handed_off" | "consumed" | "expired" | "revoked";

interface StoredPermit {
  readonly claims: Readonly<ExecutionPermitClaims>;
  readonly bindingDigest: string;
  readonly deadline: number;
  state: PermitState;
  terminalAt?: number;
}

const ACTIVE_STATES = new Set<PermitState>(["issued", "handed_off"]);
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const OPAQUE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Process-local, fail-closed execution authority. The raw 256-bit token is
 * returned to the caller but never retained by the broker: the registry key is
 * only SHA-256(token). A process restart therefore revokes every outstanding
 * permit by construction.
 */
export class ExecutionPermitBroker {
  private readonly entries = new Map<string, StoredPermit>();
  private readonly runtimePolicy: RuntimePolicy;
  private readonly validateCurrent: ExecutionPermitCurrentStateValidator;
  private readonly now: () => number;
  private readonly monotonicNow: () => number;
  private readonly defaultTtlMs: number;
  private readonly maxTtlMs: number;
  private readonly maxActive: number;
  private readonly maxActivePerOwner: number;
  private readonly maxTombstones: number;
  private readonly maxTombstonesPerOwner: number;

  constructor(options: ExecutionPermitBrokerOptions) {
    this.runtimePolicy = options.runtimePolicy;
    this.validateCurrent = options.validateCurrent;
    this.now = options.now ?? Date.now;
    this.monotonicNow = options.monotonicNow ?? (() => Number(process.hrtime.bigint() / 1_000_000n));
    this.maxTtlMs = positiveInteger(options.maxTtlMs ?? 30_000, "maxTtlMs");
    this.defaultTtlMs = positiveInteger(options.defaultTtlMs ?? 5_000, "defaultTtlMs");
    if (this.defaultTtlMs > this.maxTtlMs) throw invalid("defaultTtlMs must not exceed maxTtlMs");
    this.maxActive = positiveInteger(options.maxActive ?? 4_096, "maxActive");
    this.maxActivePerOwner = positiveInteger(options.maxActivePerOwner ?? 128, "maxActivePerOwner");
    this.maxTombstones = nonNegativeInteger(options.maxTombstones ?? 8_192, "maxTombstones");
    this.maxTombstonesPerOwner = nonNegativeInteger(options.maxTombstonesPerOwner ?? 256, "maxTombstonesPerOwner");
  }

  issue(request: ExecutionPermitIssueRequest): IssuedExecutionPermit {
    this.prune();
    assertRuntimePolicy(request, this.runtimePolicy);
    const classification = classifySignedExchangeRequest(request.signedRequest);
    const digest = signedExchangeRequestDigest(request.signedRequest);
    assertClassificationMatches(request, classification, digest);
    validateBinding(request, classification.requiresRulesFingerprint, classification.requiresReduceOnlyProof);
    assertOperationPolicy(request);
    const expectation = executionPermitExpectation(request);
    const exactBindingDigest = executionPermitBindingDigest(expectation);
    this.assertNewStep(exactBindingDigest);
    this.assertCapacity(request.ownerUserId);

    const ttlMs = positiveInteger(request.ttlMs ?? this.defaultTtlMs, "ttlMs");
    if (ttlMs > this.maxTtlMs) throw invalid(`ttlMs must not exceed ${this.maxTtlMs}`);
    const issuedAt = this.now();
    if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) throw invalid("wall clock must return a non-negative safe integer");
    const monotonic = this.monotonicNow();
    if (!Number.isFinite(monotonic) || monotonic < 0) throw invalid("monotonic clock must return a non-negative finite number");

    const token = randomBytes(32).toString("base64url") as ExecutionPermitToken;
    const claims = freezeClaims({
      ...expectation,
      permitId: randomUUID(),
      nonce: randomBytes(32).toString("base64url"),
      issuedAt,
      expiresAt: issuedAt + ttlMs
    });
    if (!this.isCurrent(claims, "issue")) throw currentStateChanged();
    const key = tokenHash(token);
    this.entries.set(key, {
      claims,
      bindingDigest: exactBindingDigest,
      deadline: monotonic + ttlMs,
      state: "issued"
    });
    return Object.freeze({ token, claims });
  }

  handoff(token: ExecutionPermitToken, expected: ExecutionPermitBinding): HandedOffExecutionPermit {
    const entry = this.lookup(token);
    this.assertUsable(entry, "handoff");
    if (entry.state !== "issued") {
      if (entry.state === "consumed") throw reused();
      throw new ExecutionPermitError("PERMIT_CONTEXT_MISMATCH", "Execution permit has already crossed the engine-to-adapter boundary.");
    }
    if (!safeDigestEqual(entry.bindingDigest, executionPermitBindingDigest(expected))) {
      this.terminate(entry, "revoked");
      throw new ExecutionPermitError("PERMIT_CONTEXT_MISMATCH", "Execution permit does not match the exact prepared step.");
    }
    entry.state = "handed_off";
    return Object.freeze({
      token,
      permitId: entry.claims.permitId,
      [handedOffExecutionPermitBrand]: true as const
    });
  }

  /**
   * Atomically consumes the permit. A transport should normally use
   * consumeAndInvoke(), which guarantees its callback is not reached on any
   * validation failure.
   */
  consume(handoff: HandedOffExecutionPermit, signedRequest: SignedExchangeRequest): Readonly<ExecutionPermitClaims> {
    if (!isHandedOffExecutionPermit(handoff)) {
      throw new ExecutionPermitError("PERMIT_HANDOFF_REQUIRED", "Execution permit did not cross the engine-to-adapter boundary.");
    }
    const entry = this.lookup(handoff.token);
    if (entry.claims.permitId !== handoff.permitId) {
      this.terminate(entry, "revoked");
      throw new ExecutionPermitError("PERMIT_CONTEXT_MISMATCH", "Execution permit handoff identity does not match.");
    }
    if (entry.state === "consumed") throw reused();
    if (entry.state === "issued") throw new ExecutionPermitError("PERMIT_HANDOFF_REQUIRED", "Execution permit did not cross the engine-to-adapter boundary.");
    this.assertUsable(entry, "consume");
    if (entry.state !== "handed_off") throw revoked();

    let classification: ReturnType<typeof classifySignedExchangeRequest>;
    let digest: string;
    try {
      classification = classifySignedExchangeRequest(signedRequest);
      digest = signedExchangeRequestDigest(signedRequest);
    } catch (error) {
      this.terminate(entry, "revoked");
      throw new ExecutionPermitError("PERMIT_CONTEXT_MISMATCH", `Signed request is not the permitted request: ${messageOf(error)}`);
    }
    const claims = entry.claims;
    if (
      signedRequest.venue !== claims.venue ||
      signedRequest.market !== claims.market ||
      classification.symbol !== claims.symbol ||
      classification.capability !== claims.capability ||
      classification.action !== claims.action ||
      classification.riskEffect !== claims.riskEffect ||
      !safeDigestEqual(digest, claims.signedRequestDigest)
    ) {
      this.terminate(entry, "revoked");
      throw new ExecutionPermitError("PERMIT_CONTEXT_MISMATCH", "Signed request does not match the exact execution permit claims.");
    }

    // This synchronous transition happens before the caller is allowed to
    // invoke fetch/socket I/O. Callback failure never makes the permit reusable.
    this.terminate(entry, "consumed");
    return claims;
  }

  consumeAndInvoke<T>(handoff: HandedOffExecutionPermit, signedRequest: SignedExchangeRequest, invokeNetwork: (claims: Readonly<ExecutionPermitClaims>) => T): T {
    const claims = this.consume(handoff, signedRequest);
    return invokeNetwork(claims);
  }

  revokeOwner(ownerUserId: string): number {
    return this.revokeWhere((claims) => claims.ownerUserId === ownerUserId);
  }

  revokeAccount(ownerUserId: string, accountId: string): number {
    return this.revokeWhere((claims) => claims.ownerUserId === ownerUserId && claims.accountId === accountId);
  }

  revokeOperation(ownerUserId: string, operation: ExecutionPermitOperation): number {
    const digest = canonicalExecutionValue(operation);
    return this.revokeWhere((claims) => claims.ownerUserId === ownerUserId && canonicalExecutionValue(claims.operation) === digest);
  }

  stats(): { active: number; handedOff: number; tombstones: number; owners: Readonly<Record<string, number>> } {
    this.prune();
    let active = 0;
    let handedOff = 0;
    let tombstones = 0;
    const owners: Record<string, number> = {};
    for (const entry of this.entries.values()) {
      if (ACTIVE_STATES.has(entry.state)) {
        active += 1;
        if (entry.state === "handed_off") handedOff += 1;
        owners[entry.claims.ownerUserId] = (owners[entry.claims.ownerUserId] ?? 0) + 1;
      } else {
        tombstones += 1;
      }
    }
    return { active, handedOff, tombstones, owners: Object.freeze(owners) };
  }

  private lookup(token: ExecutionPermitToken): StoredPermit {
    if (typeof token !== "string" || !OPAQUE_TOKEN_PATTERN.test(token)) throw forged();
    const entry = this.entries.get(tokenHash(token));
    if (!entry) throw forged();
    return entry;
  }

  private assertUsable(entry: StoredPermit, phase: "handoff" | "consume"): void {
    if (entry.state === "consumed") throw reused();
    if (entry.state === "expired") throw expired();
    if (entry.state === "revoked") throw revoked();
    if (this.monotonicNow() >= entry.deadline) {
      this.terminate(entry, "expired");
      throw expired();
    }
    if (!this.isCurrent(entry.claims, phase)) {
      this.terminate(entry, "revoked");
      throw currentStateChanged();
    }
  }

  private isCurrent(claims: Readonly<ExecutionPermitClaims>, phase: ExecutionPermitPhase): boolean {
    try {
      return this.validateCurrent(claims, phase) === true;
    } catch {
      return false;
    }
  }

  private assertCapacity(ownerUserId: string): void {
    let active = 0;
    let ownerActive = 0;
    for (const entry of this.entries.values()) {
      if (!ACTIVE_STATES.has(entry.state)) continue;
      active += 1;
      if (entry.claims.ownerUserId === ownerUserId) ownerActive += 1;
    }
    if (active >= this.maxActive) throw new ExecutionPermitError("PERMIT_CAPACITY", "Global execution permit capacity is exhausted.");
    if (ownerActive >= this.maxActivePerOwner) throw new ExecutionPermitError("PERMIT_CAPACITY", "Owner execution permit capacity is exhausted.");
  }

  private assertNewStep(exactBindingDigest: string): void {
    for (const entry of this.entries.values()) {
      if (safeDigestEqual(entry.bindingDigest, exactBindingDigest)) {
        throw new ExecutionPermitError("PERMIT_DUPLICATE_STEP", "An execution permit already exists for this exact signed step.");
      }
    }
  }

  private revokeWhere(predicate: (claims: Readonly<ExecutionPermitClaims>) => boolean): number {
    let revokedCount = 0;
    for (const entry of this.entries.values()) {
      if (!ACTIVE_STATES.has(entry.state) || !predicate(entry.claims)) continue;
      this.terminate(entry, "revoked", false);
      revokedCount += 1;
    }
    this.trimTombstones();
    return revokedCount;
  }

  private prune(): void {
    const monotonic = this.monotonicNow();
    for (const entry of this.entries.values()) {
      if (ACTIVE_STATES.has(entry.state) && monotonic >= entry.deadline) this.terminate(entry, "expired", false);
    }
    this.trimTombstones();
  }

  private terminate(entry: StoredPermit, state: "consumed" | "expired" | "revoked", trim = true): void {
    entry.state = state;
    entry.terminalAt = this.monotonicNow();
    if (trim) this.trimTombstones();
  }

  private trimTombstones(): void {
    const terminal = [...this.entries.entries()].filter(([, entry]) => !ACTIVE_STATES.has(entry.state)).sort((left, right) => (left[1].terminalAt ?? 0) - (right[1].terminalAt ?? 0));
    const ownerCounts = new Map<string, number>();
    for (const [, entry] of terminal) ownerCounts.set(entry.claims.ownerUserId, (ownerCounts.get(entry.claims.ownerUserId) ?? 0) + 1);
    for (const [key, entry] of terminal) {
      const ownerCount = ownerCounts.get(entry.claims.ownerUserId) ?? 0;
      if (ownerCount <= this.maxTombstonesPerOwner) continue;
      this.entries.delete(key);
      ownerCounts.set(entry.claims.ownerUserId, ownerCount - 1);
    }
    const remaining = terminal.filter(([key]) => this.entries.has(key));
    for (let index = 0; index < remaining.length - this.maxTombstones; index += 1) {
      const key = remaining[index]?.[0];
      if (key) this.entries.delete(key);
    }
  }
}

export function executionPermitExpectation(claims: ExecutionPermitClaims | ExecutionPermitIssueRequest): ExecutionPermitBinding {
  return Object.freeze({
    ownerUserId: claims.ownerUserId,
    ...(claims.actorUserId === undefined ? {} : { actorUserId: claims.actorUserId }),
    ...(claims.sessionIdHash === undefined ? {} : { sessionIdHash: claims.sessionIdHash }),
    accountId: claims.accountId,
    accountRevision: claims.accountRevision,
    credentialRevision: claims.credentialRevision,
    authorizationRevision: claims.authorizationRevision,
    authorizationRole: claims.authorizationRole,
    authorizationEpoch: claims.authorizationEpoch,
    liveArmEpoch: claims.liveArmEpoch,
    operation: Object.freeze({ ...claims.operation }) as ExecutionPermitOperation,
    venue: claims.venue,
    market: claims.market,
    ...(claims.symbol === undefined ? {} : { symbol: claims.symbol }),
    capability: claims.capability,
    action: claims.action,
    riskEffect: claims.riskEffect,
    ...(claims.riskProof === undefined ? {} : { riskProof: Object.freeze({ ...claims.riskProof }) }),
    intentId: claims.intentId,
    intentDigest: claims.intentDigest,
    signedRequestDigest: claims.signedRequestDigest,
    rulesFingerprint: claims.rulesFingerprint
  });
}

function assertClassificationMatches(request: ExecutionPermitIssueRequest, classification: ReturnType<typeof classifySignedExchangeRequest>, digest: string): void {
  if (
    request.venue !== request.signedRequest.venue ||
    request.market !== request.signedRequest.market ||
    request.symbol !== classification.symbol ||
    request.capability !== classification.capability ||
    request.action !== classification.action ||
    request.riskEffect !== classification.riskEffect ||
    !safeDigestEqual(request.signedRequestDigest, digest)
  ) {
    throw new ExecutionPermitError("PERMIT_CAPABILITY_MISMATCH", "Prepared execution claims do not match the classified signed request.");
  }
}

function assertRuntimePolicy(request: ExecutionPermitIssueRequest, policy: RuntimePolicy): void {
  if (policy.executionMode === "paper-only" || request.capability === "public-read") {
    throw new ExecutionPermitError("PERMIT_POLICY_DENIED", "Private execution permits are unavailable in Research / Paper mode.");
  }
  if (request.capability === "private-read") {
    if (!policy.privateExchangeReadsAllowed) throw new ExecutionPermitError("PERMIT_POLICY_DENIED", "Private exchange reads are disabled.");
    if (request.action === "private.stream.manage" && !policy.privateStreamsAllowed) {
      throw new ExecutionPermitError("PERMIT_POLICY_DENIED", "Private exchange streams are disabled.");
    }
    return;
  }
  if (!policy.privateExchangeMutationsAllowed) throw new ExecutionPermitError("PERMIT_POLICY_DENIED", "Private exchange mutations are disabled.");
}

function assertOperationPolicy(request: ExecutionPermitIssueRequest): void {
  switch (request.operation.kind) {
    case "bot":
    case "manual":
      return;
    case "telemetry":
      if (request.capability === "private-read") return;
      throw new ExecutionPermitError("PERMIT_POLICY_DENIED", "Telemetry operations permit only private reads.");
    case "emergency":
    case "reconciliation":
      if (request.capability === "private-read" || request.capability === "cancel") return;
      if (request.capability === "reduce-only" && request.riskEffect === "reduce" && request.riskProof) return;
      throw new ExecutionPermitError("PERMIT_POLICY_DENIED", `${request.operation.kind === "emergency" ? "Emergency" : "Reconciliation"} operations permit only private reads, cancellation and proven reduce-only execution.`);
  }
}

function validateBinding(binding: ExecutionPermitIssueRequest, requiresRulesFingerprint: boolean, requiresReduceOnlyProof: boolean): void {
  boundedId(binding.ownerUserId, "ownerUserId", 160);
  boundedId(binding.accountId, "accountId", 160);
  if (binding.actorUserId !== undefined) boundedId(binding.actorUserId, "actorUserId", 160);
  if (binding.sessionIdHash !== undefined && !DIGEST_PATTERN.test(binding.sessionIdHash)) throw invalid("sessionIdHash must be SHA-256");
  validateOperation(binding.operation);
  validateActorSessionBinding(binding);
  positiveInteger(binding.accountRevision, "accountRevision");
  nonNegativeInteger(binding.credentialRevision, "credentialRevision");
  positiveInteger(binding.authorizationRevision, "authorizationRevision");
  requireAuthorizationRole(binding.authorizationRole);
  nonNegativeInteger(binding.authorizationEpoch, "authorizationEpoch");
  nonNegativeInteger(binding.liveArmEpoch, "liveArmEpoch");
  boundedId(binding.intentId, "intentId", 160);
  requireDigest(binding.intentDigest, "intentDigest");
  requireDigest(binding.signedRequestDigest, "signedRequestDigest");
  if (requiresRulesFingerprint) requireDigest(binding.rulesFingerprint, "rulesFingerprint");
  else if (binding.rulesFingerprint !== null) throw invalid("rulesFingerprint must be null for a request that does not use instrument rules");
  if (requiresReduceOnlyProof) validateRiskProof(binding.riskProof);
  else if (binding.riskProof !== undefined) throw invalid("riskProof is allowed only for a reduce-only request");
}

function validateOperation(operation: ExecutionPermitOperation): void {
  if (operation.kind === "bot") {
    boundedId(operation.botId, "botId", 160);
    boundedId(operation.runId, "runId", 160);
    return;
  }
  if (["manual", "emergency", "reconciliation", "telemetry"].includes(operation.kind)) {
    const id = "requestId" in operation ? operation.requestId : operation.operationId;
    boundedId(id, `${operation.kind} operation id`, 160);
    return;
  }
  throw invalid("Unknown execution permit operation");
}

function validateActorSessionBinding(binding: ExecutionPermitBinding): void {
  const hasActor = binding.actorUserId !== undefined;
  const hasSession = binding.sessionIdHash !== undefined;
  if (hasActor !== hasSession) throw invalid("actorUserId and sessionIdHash must be supplied together");
  if (hasActor && binding.actorUserId !== binding.ownerUserId) throw invalid("Delegated execution actors are not supported; actorUserId must match ownerUserId");
  if (binding.operation.kind === "manual" && !hasActor) throw invalid("Manual execution requires a current owner session context");
}

function isHandedOffExecutionPermit(value: unknown): value is HandedOffExecutionPermit {
  return typeof value === "object" && value !== null && (value as Partial<HandedOffExecutionPermit>)[handedOffExecutionPermitBrand] === true;
}

function validateRiskProof(proof: ExecutionRiskProof | undefined): void {
  if (!proof || !["venue-enforced-reduce-only", "bounded-existing-exposure"].includes(proof.kind)) {
    throw invalid("Reduce-only execution requires an explicit risk proof");
  }
  requireDigest(proof.evidenceDigest, "riskProof.evidenceDigest");
}

function requireAuthorizationRole(value: AuthRole): void {
  if (!["read-only", "paper-trade", "live-trade", "admin"].includes(value)) throw invalid("authorizationRole is invalid");
}

function freezeClaims(claims: ExecutionPermitClaims): Readonly<ExecutionPermitClaims> {
  Object.freeze(claims.operation);
  if (claims.riskProof) Object.freeze(claims.riskProof);
  return Object.freeze(claims);
}

export function executionPermitBindingDigest(binding: ExecutionPermitBinding): string {
  return createHash("sha256").update("saltanatbotv2:execution-permit-binding:v1\0").update(canonicalExecutionValue(binding)).digest("hex");
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function safeDigestEqual(left: string, right: string): boolean {
  if (!DIGEST_PATTERN.test(left) || !DIGEST_PATTERN.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw invalid(`${label} must be a positive safe integer`);
  return value;
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw invalid(`${label} must be a non-negative safe integer`);
  return value;
}

function boundedId(value: string, label: string, maxLength: number): void {
  if (typeof value !== "string" || value.length < 1 || value.length > maxLength || value.trim() !== value || hasControlCharacters(value)) {
    throw invalid(`${label} is invalid`);
  }
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function requireDigest(value: string | null, label: string): void {
  if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) throw invalid(`${label} must be a lowercase SHA-256 digest`);
}

function invalid(message: string): ExecutionPermitError {
  return new ExecutionPermitError("PERMIT_INVALID", message);
}

function forged(): ExecutionPermitError {
  return new ExecutionPermitError("PERMIT_FORGED", "Execution permit is unknown or forged.");
}

function expired(): ExecutionPermitError {
  return new ExecutionPermitError("PERMIT_EXPIRED", "Execution permit has expired.");
}

function reused(): ExecutionPermitError {
  return new ExecutionPermitError("PERMIT_REUSED", "Execution permit has already been consumed.");
}

function revoked(): ExecutionPermitError {
  return new ExecutionPermitError("PERMIT_REVOKED", "Execution permit has been revoked.");
}

function currentStateChanged(): ExecutionPermitError {
  return new ExecutionPermitError("PERMIT_CURRENT_STATE_CHANGED", "Execution authorization changed after the permit was issued.");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
