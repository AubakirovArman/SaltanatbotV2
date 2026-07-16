import type { Pool } from "pg";
import { roleAllows } from "../auth.js";
import { PostgresExecutionStepLedgerRepository } from "../database/executionStepLedger.js";
import type { ExecutionStepLedgerRepository } from "../database/executionStepLedgerTypes.js";
import type { IdentityService, ExecutionAuthorizationSnapshot } from "../identity/service.js";
import type { RuntimePolicy } from "../runtimeProfile.js";
import { classifySignedExchangeRequest, normalizeSignedExchangeRequest, signedExchangeRequestDigest, type SignedExchangeRequest } from "./executionCapabilities.js";
import { ExecutionPermitBroker, ExecutionPermitError, executionPermitExpectation, type ExecutionPermitBinding, type ExecutionPermitBrokerOptions, type ExecutionPermitClaims, type ExecutionPermitOperation, type ExecutionRiskProof, type HandedOffExecutionPermit, type IssuedExecutionPermit } from "./executionPermits.js";
import { ExecutionStepDispatchLedger, requiresDurableExecutionStep, type DurableExecutionStepReservation } from "./executionStepDispatchLedger.js";
import { getTradingAccountAuthorizationStateForOwner, getTradingOwnerAuthorityForOwner, type TradingAccountAuthorizationState, type TradingOwnerAuthorityState } from "./tradingAccountStore.js";
import type { AuthRole } from "./types.js";

const executionAuthorityHandoffBrand: unique symbol = Symbol("execution-authority-handoff");

export interface ExecutionSessionAuthorizationSnapshot {
  ownerUserId: string;
  actorUserId: string;
  sessionIdHash: string;
}

export interface ExecutionAuthoritySource {
  loadAuthorization(ownerUserId: string): Promise<ExecutionAuthorizationSnapshot | undefined>;
  loadSessionAuthorization(sessionIdHash: string): Promise<ExecutionSessionAuthorizationSnapshot | undefined>;
  isAuthorizationCurrent(snapshot: ExecutionAuthorizationSnapshot): boolean;
  loadAccount(ownerUserId: string, accountId: string): TradingAccountAuthorizationState | undefined;
  loadOwnerAuthority(ownerUserId: string): TradingOwnerAuthorityState;
}

export interface ExecutionStepPermitRequest {
  ownerUserId: string;
  actorUserId?: string;
  sessionIdHash?: string;
  accountId: string;
  operation: ExecutionPermitOperation;
  signedRequest: SignedExchangeRequest;
  intentId: string;
  intentDigest: string;
  rulesFingerprint: string | null;
  riskProof?: ExecutionRiskProof;
  ttlMs?: number;
}

export interface ExecutionPermitHandoff {
  claims: Readonly<ExecutionPermitClaims>;
  permit: HandedOffExecutionPermit;
  durableReservation?: DurableExecutionStepReservation;
  readonly [executionAuthorityHandoffBrand]: true;
}

export interface ExecutionAuthorityOptions extends Omit<ExecutionPermitBrokerOptions, "runtimePolicy" | "validateCurrent"> {
  executionStepLedger?: ExecutionStepLedgerRepository;
}

interface AuthorityIssuedPermit {
  readonly claims: Readonly<ExecutionPermitClaims>;
  readonly durableReservation?: DurableExecutionStepReservation;
}

/**
 * Resolves every mutable authority claim from its system of record before a
 * permit is issued. Callers provide only the prepared intent/request context;
 * they cannot choose account, credential, user or live-arm revisions.
 */
export class ExecutionAuthority {
  private readonly broker: ExecutionPermitBroker;
  private readonly dispatchLedger?: ExecutionStepDispatchLedger;
  private readonly issuedPermits = new WeakMap<IssuedExecutionPermit, AuthorityIssuedPermit>();
  private readonly handoffs = new WeakSet<ExecutionPermitHandoff>();
  private readonly consumedHandoffs = new WeakSet<ExecutionPermitHandoff>();

  constructor(
    private readonly source: ExecutionAuthoritySource,
    runtimePolicy: RuntimePolicy,
    options: ExecutionAuthorityOptions = {}
  ) {
    const { executionStepLedger, ...brokerOptions } = options;
    this.dispatchLedger = executionStepLedger ? new ExecutionStepDispatchLedger(executionStepLedger) : undefined;
    this.broker = new ExecutionPermitBroker({
      ...brokerOptions,
      runtimePolicy,
      validateCurrent: (claims) => this.isLocallyCurrent(claims)
    });
  }

  async issue(request: ExecutionStepPermitRequest): Promise<IssuedExecutionPermit> {
    const prepared = snapshotPermitRequest(request);
    const classification = classifySignedExchangeRequest(prepared.signedRequest);
    assertActorSessionShape(prepared);
    const [authorization, session] = await Promise.all([this.source.loadAuthorization(prepared.ownerUserId), prepared.sessionIdHash === undefined ? Promise.resolve(undefined) : this.source.loadSessionAuthorization(prepared.sessionIdHash)]);
    if (!authorization || authorization.ownerUserId !== prepared.ownerUserId) throw authorityChanged();
    assertSessionCurrent(prepared, session);
    assertRoleAllowed(authorization.role, classification.capability);

    const account = this.source.loadAccount(prepared.ownerUserId, prepared.accountId);
    const ownerAuthority = this.source.loadOwnerAuthority(prepared.ownerUserId);
    assertAccountCurrent(prepared, account, classification.capability);
    assertArmCurrent(prepared.ownerUserId, ownerAuthority, classification.capability, prepared.operation);
    if (classification.capability !== "private-read" && !this.dispatchLedger) {
      throw new ExecutionPermitError("PERMIT_POLICY_DENIED", "Private mutations require durable execution replay protection.");
    }

    const issued = this.broker.issue({
      ownerUserId: prepared.ownerUserId,
      ...(prepared.actorUserId === undefined ? {} : { actorUserId: prepared.actorUserId }),
      ...(prepared.sessionIdHash === undefined ? {} : { sessionIdHash: prepared.sessionIdHash }),
      accountId: prepared.accountId,
      accountRevision: account.authorizationRevision,
      credentialRevision: account.credentialRevision,
      authorizationRevision: authorization.authorizationRevision,
      authorizationRole: authorization.role,
      authorizationEpoch: authorization.authorizationEpoch,
      liveArmEpoch: ownerAuthority.epoch,
      operation: prepared.operation,
      venue: prepared.signedRequest.venue,
      market: prepared.signedRequest.market,
      symbol: classification.symbol,
      capability: classification.capability,
      action: classification.action,
      riskEffect: classification.riskEffect,
      ...(prepared.riskProof === undefined ? {} : { riskProof: prepared.riskProof }),
      intentId: prepared.intentId,
      intentDigest: prepared.intentDigest,
      signedRequestDigest: signedExchangeRequestDigest(prepared.signedRequest),
      rulesFingerprint: prepared.rulesFingerprint,
      signedRequest: prepared.signedRequest,
      ...(prepared.ttlMs === undefined ? {} : { ttlMs: prepared.ttlMs })
    });
    if (!requiresDurableExecutionStep(issued.claims)) {
      this.issuedPermits.set(issued, Object.freeze({ claims: issued.claims }));
      return issued;
    }

    try {
      const reservation = await this.dispatchLedger!.reserve(issued);
      const [current, currentSession] = await this.loadDurableAuthorization(issued.claims);
      if (!sameAuthorization(current, issued.claims) || !sameSessionAuthorization(currentSession, issued.claims)) {
        throw authorityChanged();
      }
      this.issuedPermits.set(
        issued,
        Object.freeze({
          claims: issued.claims,
          durableReservation: reservation
        })
      );
      return issued;
    } catch (error) {
      this.consumeLocallyWithoutNetwork(issued, prepared.signedRequest);
      throw error;
    }
  }

  /** The engine must state the exact step it is handing to the adapter. */
  handoff(issued: IssuedExecutionPermit, expected: ExecutionPermitBinding): ExecutionPermitHandoff {
    const authorityIssued = this.issuedPermits.get(issued);
    if (!authorityIssued) {
      throw new ExecutionPermitError("PERMIT_HANDOFF_REQUIRED", "Execution permit was not issued by this authority instance.");
    }
    if (requiresDurableExecutionStep(authorityIssued.claims) && !authorityIssued.durableReservation) {
      throw new ExecutionPermitError("PERMIT_HANDOFF_REQUIRED", "Execution permit is missing its authority-owned durable reservation.");
    }
    const handoff = Object.freeze({
      claims: authorityIssued.claims,
      permit: this.broker.handoff(issued.token, expected),
      ...(authorityIssued.durableReservation === undefined ? {} : { durableReservation: authorityIssued.durableReservation }),
      [executionAuthorityHandoffBrand]: true as const
    });
    this.issuedPermits.delete(issued);
    this.handoffs.add(handoff);
    return handoff;
  }

  /**
   * Re-read the durable PostgreSQL authorization immediately before the final
   * synchronous broker consume. The network callback is unreachable on every
   * failure, and consume happens before the callback is invoked.
   */
  async consumeAndInvoke<T>(handoff: ExecutionPermitHandoff, signedRequest: SignedExchangeRequest, invokeNetwork: (claims: Readonly<ExecutionPermitClaims>) => T): Promise<Awaited<T>> {
    if (!isExecutionAuthorityHandoff(handoff)) {
      throw new ExecutionPermitError("PERMIT_HANDOFF_REQUIRED", "Execution permit did not cross the authority-to-adapter boundary.");
    }
    if (!this.handoffs.delete(handoff)) {
      if (this.consumedHandoffs.has(handoff)) {
        throw new ExecutionPermitError("PERMIT_REUSED", "Execution permit handoff was already consumed.");
      }
      throw new ExecutionPermitError("PERMIT_HANDOFF_REQUIRED", "Execution permit did not cross this authority boundary.");
    }
    this.consumedHandoffs.add(handoff);
    try {
      let [current, session] = await this.loadDurableAuthorization(handoff.claims);
      if (!sameAuthorization(current, handoff.claims) || !sameSessionAuthorization(session, handoff.claims)) {
        this.broker.revokeOperation(handoff.claims.ownerUserId, handoff.claims.operation);
        throw authorityChanged();
      }
      if (requiresDurableExecutionStep(handoff.claims)) {
        if (!this.dispatchLedger || !handoff.durableReservation) {
          throw new ExecutionPermitError("PERMIT_HANDOFF_REQUIRED", "Execution handoff is missing durable replay protection.");
        }
        await this.dispatchLedger.consume(handoff.durableReservation);
        [current, session] = await this.loadDurableAuthorization(handoff.claims);
        if (!sameAuthorization(current, handoff.claims) || !sameSessionAuthorization(session, handoff.claims)) {
          this.broker.revokeOperation(handoff.claims.ownerUserId, handoff.claims.operation);
          throw authorityChanged();
        }
      }
      return await this.broker.consumeAndInvoke(handoff.permit, signedRequest, invokeNetwork);
    } catch (error) {
      this.consumeBrokerHandoffWithoutNetwork(handoff.permit, signedRequest);
      throw error;
    }
  }

  expected(issued: IssuedExecutionPermit): ExecutionPermitBinding {
    return executionPermitExpectation(issued.claims);
  }

  revokeOwner(ownerUserId: string): number {
    return this.broker.revokeOwner(ownerUserId);
  }

  revokeAccount(ownerUserId: string, accountId: string): number {
    return this.broker.revokeAccount(ownerUserId, accountId);
  }

  revokeOperation(ownerUserId: string, operation: ExecutionPermitOperation): number {
    return this.broker.revokeOperation(ownerUserId, operation);
  }

  private loadDurableAuthorization(claims: Pick<ExecutionPermitClaims, "ownerUserId" | "sessionIdHash">): Promise<[ExecutionAuthorizationSnapshot | undefined, ExecutionSessionAuthorizationSnapshot | undefined]> {
    return Promise.all([this.source.loadAuthorization(claims.ownerUserId), claims.sessionIdHash === undefined ? Promise.resolve(undefined) : this.source.loadSessionAuthorization(claims.sessionIdHash)]);
  }

  private consumeLocallyWithoutNetwork(issued: IssuedExecutionPermit, signedRequest: SignedExchangeRequest): void {
    try {
      const handoff = this.broker.handoff(issued.token, executionPermitExpectation(issued.claims));
      this.broker.consume(handoff, signedRequest);
    } catch {
      // Every broker validation failure terminates or makes the permit unusable.
    }
  }

  private consumeBrokerHandoffWithoutNetwork(handoff: HandedOffExecutionPermit, signedRequest: SignedExchangeRequest): void {
    try {
      this.broker.consume(handoff, signedRequest);
    } catch {
      // A terminal broker state is sufficient; no network callback is invoked.
    }
  }

  private isLocallyCurrent(claims: Readonly<ExecutionPermitClaims>): boolean {
    const snapshot: ExecutionAuthorizationSnapshot = {
      ownerUserId: claims.ownerUserId,
      authorizationRevision: claims.authorizationRevision,
      authorizationEpoch: claims.authorizationEpoch,
      role: claims.authorizationRole
    };
    if (!this.source.isAuthorizationCurrent(snapshot)) return false;
    if (!roleAllowed(claims.authorizationRole, claims.capability)) return false;

    const account = this.source.loadAccount(claims.ownerUserId, claims.accountId);
    if (
      !account ||
      account.ownerUserId !== claims.ownerUserId ||
      account.accountId !== claims.accountId ||
      account.exchange !== claims.venue ||
      account.authorizationRevision !== claims.accountRevision ||
      account.credentialRevision !== claims.credentialRevision ||
      !account.credentialsConfigured ||
      (!account.enabled && !operationMayUseDisabledAccount(claims.operation, claims.capability))
    ) {
      return false;
    }

    const authority = this.source.loadOwnerAuthority(claims.ownerUserId);
    return authority.ownerUserId === claims.ownerUserId && authority.epoch === claims.liveArmEpoch && (!requiresArmed(claims.capability, claims.operation) || authority.armed);
  }
}

export function createRuntimeExecutionAuthority(identity: IdentityService, runtimePolicy: RuntimePolicy, pool: Pool, brokerOptions: Omit<ExecutionPermitBrokerOptions, "runtimePolicy" | "validateCurrent"> = {}): ExecutionAuthority {
  return new ExecutionAuthority(
    {
      loadAuthorization: (ownerUserId) => identity.executionAuthorizationSnapshot(ownerUserId),
      loadSessionAuthorization: async (sessionIdHash) => {
        const found = await identity.repository.findSession(sessionIdHash);
        const now = Date.now();
        if (!found || found.session.idHash !== sessionIdHash || found.session.revokedAt || found.session.expiresAt.getTime() <= now || found.user.status !== "active" || found.user.mustChangePassword) {
          return undefined;
        }
        return {
          ownerUserId: found.user.id,
          actorUserId: found.user.id,
          sessionIdHash
        };
      },
      isAuthorizationCurrent: (snapshot) => identity.isExecutionAuthorizationCurrent(snapshot),
      loadAccount: getTradingAccountAuthorizationStateForOwner,
      loadOwnerAuthority: getTradingOwnerAuthorityForOwner
    },
    runtimePolicy,
    {
      ...brokerOptions,
      executionStepLedger: new PostgresExecutionStepLedgerRepository(pool)
    }
  );
}

function assertAccountCurrent(request: ExecutionStepPermitRequest, account: TradingAccountAuthorizationState | undefined, capability: ExecutionPermitClaims["capability"]): asserts account is TradingAccountAuthorizationState {
  if (!account || account.ownerUserId !== request.ownerUserId || account.accountId !== request.accountId) {
    throw authorityChanged("Trading account authority is unavailable.");
  }
  if (account.exchange !== request.signedRequest.venue) {
    throw new ExecutionPermitError("PERMIT_CONTEXT_MISMATCH", "Trading account venue does not match the prepared request.");
  }
  if (!account.credentialsConfigured || account.credentialRevision < 1) {
    throw authorityChanged("Trading account credentials are unavailable.");
  }
  if (!account.enabled && !operationMayUseDisabledAccount(request.operation, capability)) {
    throw authorityChanged("Trading account is disabled.");
  }
}

function assertArmCurrent(ownerUserId: string, authority: TradingOwnerAuthorityState, capability: ExecutionPermitClaims["capability"], operation: ExecutionPermitOperation): void {
  if (authority.ownerUserId !== ownerUserId || !Number.isSafeInteger(authority.epoch) || authority.epoch < 1) throw authorityChanged();
  if (requiresArmed(capability, operation) && !authority.armed) {
    throw new ExecutionPermitError("PERMIT_POLICY_DENIED", "Live trading is not armed for this owner.");
  }
}

function assertRoleAllowed(role: AuthRole, capability: ExecutionPermitClaims["capability"]): void {
  if (!roleAllowed(role, capability)) {
    throw new ExecutionPermitError("PERMIT_POLICY_DENIED", "The current trading role does not allow this signed action.");
  }
}

function roleAllowed(role: AuthRole, capability: ExecutionPermitClaims["capability"]): boolean {
  return roleAllows(role, capability === "private-read" ? "read-only" : "live-trade");
}

function requiresArmed(capability: ExecutionPermitClaims["capability"], operation: ExecutionPermitOperation): boolean {
  if (operation.kind === "emergency" || operation.kind === "reconciliation") return false;
  return !["private-read", "cancel", "reduce-only"].includes(capability);
}

function operationMayUseDisabledAccount(operation: ExecutionPermitOperation, capability: ExecutionPermitClaims["capability"]): boolean {
  return (operation.kind === "emergency" || operation.kind === "reconciliation") && ["private-read", "cancel", "reduce-only"].includes(capability);
}

function sameAuthorization(current: ExecutionAuthorizationSnapshot | undefined, claims: Readonly<ExecutionPermitClaims>): boolean {
  return current?.ownerUserId === claims.ownerUserId && current.authorizationRevision === claims.authorizationRevision && current.authorizationEpoch === claims.authorizationEpoch && current.role === claims.authorizationRole && roleAllowed(current.role, claims.capability);
}

function sameSessionAuthorization(current: ExecutionSessionAuthorizationSnapshot | undefined, claims: Readonly<ExecutionPermitClaims>): boolean {
  if (claims.actorUserId === undefined && claims.sessionIdHash === undefined) return current === undefined;
  return current?.ownerUserId === claims.ownerUserId && current.actorUserId === claims.actorUserId && current.sessionIdHash === claims.sessionIdHash;
}

function snapshotPermitRequest(request: ExecutionStepPermitRequest): Readonly<ExecutionStepPermitRequest> {
  const operation = Object.freeze({ ...request.operation }) as ExecutionPermitOperation;
  const riskProof = request.riskProof === undefined ? undefined : Object.freeze({ ...request.riskProof });
  return Object.freeze({
    ownerUserId: request.ownerUserId,
    ...(request.actorUserId === undefined ? {} : { actorUserId: request.actorUserId }),
    ...(request.sessionIdHash === undefined ? {} : { sessionIdHash: request.sessionIdHash }),
    accountId: request.accountId,
    operation,
    signedRequest: normalizeSignedExchangeRequest(request.signedRequest),
    intentId: request.intentId,
    intentDigest: request.intentDigest,
    rulesFingerprint: request.rulesFingerprint,
    ...(riskProof === undefined ? {} : { riskProof }),
    ...(request.ttlMs === undefined ? {} : { ttlMs: request.ttlMs })
  });
}

/**
 * Delegated/admin-on-behalf-of execution is intentionally unsupported until a
 * durable delegation model exists. A supplied actor must be the owner and must
 * be accompanied by that owner's current durable session.
 */
function assertActorSessionShape(request: Readonly<ExecutionStepPermitRequest>): void {
  const hasActor = request.actorUserId !== undefined;
  const hasSession = request.sessionIdHash !== undefined;
  if (hasActor !== hasSession) {
    throw new ExecutionPermitError("PERMIT_CONTEXT_MISMATCH", "actorUserId and sessionIdHash must be supplied together.");
  }
  if (hasActor && request.actorUserId !== request.ownerUserId) {
    throw new ExecutionPermitError("PERMIT_CONTEXT_MISMATCH", "Delegated execution actors are not supported.");
  }
  if (request.operation.kind === "manual" && !hasActor) {
    throw new ExecutionPermitError("PERMIT_CONTEXT_MISMATCH", "Manual execution requires a current owner session.");
  }
}

function assertSessionCurrent(request: Readonly<ExecutionStepPermitRequest>, current: ExecutionSessionAuthorizationSnapshot | undefined): void {
  if (request.sessionIdHash === undefined) return;
  if (current?.ownerUserId !== request.ownerUserId || current.actorUserId !== request.actorUserId || current.sessionIdHash !== request.sessionIdHash) {
    throw authorityChanged("Execution session authority is unavailable.");
  }
}

function isExecutionAuthorityHandoff(value: unknown): value is ExecutionPermitHandoff {
  return typeof value === "object" && value !== null && (value as Partial<ExecutionPermitHandoff>)[executionAuthorityHandoffBrand] === true;
}

function authorityChanged(message = "Execution authorization changed after the prepared step was created."): ExecutionPermitError {
  return new ExecutionPermitError("PERMIT_CURRENT_STATE_CHANGED", message);
}
