import { describe, expect, it } from "vitest";
import type { ExecutionStepLedgerRepository } from "../src/database/executionStepLedgerTypes.js";
import type { ExecutionAuthorizationSnapshot } from "../src/identity/service.js";
import { runtimePolicyFromConfig } from "../src/runtimeProfile.js";
import { signedExchangeRequestDigest, type SignedExchangeRequest } from "../src/trading/executionCapabilities.js";
import { ExecutionAuthority, type ExecutionAuthorityOptions, type ExecutionAuthoritySource, type ExecutionSessionAuthorizationSnapshot, type ExecutionStepPermitRequest } from "../src/trading/executionAuthority.js";
import type { ExecutionPermitBinding, ExecutionPermitClaims, IssuedExecutionPermit } from "../src/trading/executionPermits.js";
import type { TradingAccountAuthorizationState, TradingOwnerAuthorityState } from "../src/trading/tradingAccountStore.js";
import { TestExecutionStepLedger } from "./support/executionStepLedger.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const LIVE = runtimePolicyFromConfig({ runtimeProfile: "private-live" });
const PAPER = runtimePolicyFromConfig({ runtimeProfile: "public-http-paper" });

function signedEntry(): SignedExchangeRequest {
  return {
    venue: "bybit",
    market: "futures",
    method: "POST",
    path: "/v5/order/create",
    payload: {
      category: "linear",
      symbol: "BTCUSDT",
      side: "Buy",
      orderType: "Market",
      qty: "0.01"
    }
  };
}

function signedRead(): SignedExchangeRequest {
  return {
    venue: "bybit",
    market: "futures",
    method: "GET",
    path: "/v5/account/wallet-balance",
    payload: { accountType: "UNIFIED" }
  };
}

function permitRequest(signedRequest = signedEntry()): ExecutionStepPermitRequest {
  return {
    ownerUserId: "owner-a",
    actorUserId: "owner-a",
    sessionIdHash: SHA_A,
    accountId: "account-a",
    operation: { kind: "bot", botId: "bot-a", runId: "run-a" },
    signedRequest,
    intentId: "intent-a",
    intentDigest: SHA_A,
    rulesFingerprint: signedRequest.method === "GET" ? null : SHA_B
  };
}

function fixture(
  overrides: {
    authorization?: Partial<ExecutionAuthorizationSnapshot> | null;
    session?: Partial<ExecutionSessionAuthorizationSnapshot> | null;
    account?: Partial<TradingAccountAuthorizationState> | null;
    owner?: Partial<TradingOwnerAuthorityState>;
  } = {}
) {
  let authorization: ExecutionAuthorizationSnapshot | undefined =
    overrides.authorization === null
      ? undefined
      : {
          ownerUserId: "owner-a",
          authorizationRevision: 7,
          authorizationEpoch: 3,
          role: "live-trade",
          ...overrides.authorization
        };
  let account: TradingAccountAuthorizationState | undefined =
    overrides.account === null
      ? undefined
      : {
          ownerUserId: "owner-a",
          accountId: "account-a",
          exchange: "bybit",
          enabled: true,
          authorizationRevision: 5,
          credentialRevision: 4,
          credentialsConfigured: true,
          ...overrides.account
        };
  let session: ExecutionSessionAuthorizationSnapshot | undefined =
    overrides.session === null
      ? undefined
      : {
          ownerUserId: "owner-a",
          actorUserId: "owner-a",
          sessionIdHash: SHA_A,
          ...overrides.session
        };
  let owner: TradingOwnerAuthorityState = {
    ownerUserId: "owner-a",
    armed: true,
    epoch: 9,
    updatedAt: 1,
    ...overrides.owner
  };
  const source: ExecutionAuthoritySource = {
    loadAuthorization: async () => authorization && { ...authorization },
    loadSessionAuthorization: async (sessionIdHash) => (session?.sessionIdHash === sessionIdHash ? { ...session } : undefined),
    isAuthorizationCurrent: (snapshot) => !!authorization && snapshot.ownerUserId === authorization.ownerUserId && snapshot.authorizationRevision === authorization.authorizationRevision && snapshot.authorizationEpoch === authorization.authorizationEpoch && snapshot.role === authorization.role,
    loadAccount: () => account && { ...account },
    loadOwnerAuthority: () => ({ ...owner })
  };
  return {
    source,
    setAuthorization(next: ExecutionAuthorizationSnapshot | undefined) {
      authorization = next;
    },
    setSession(next: ExecutionSessionAuthorizationSnapshot | undefined) {
      session = next;
    },
    setAccount(next: TradingAccountAuthorizationState | undefined) {
      account = next;
    },
    setOwner(next: TradingOwnerAuthorityState) {
      owner = next;
    },
    authorization: () => authorization,
    session: () => session,
    account: () => account,
    owner: () => owner
  };
}

function expectedFromClaims(claims: Readonly<ExecutionPermitClaims>): ExecutionPermitBinding {
  const { permitId: _permitId, nonce: _nonce, issuedAt: _issuedAt, expiresAt: _expiresAt, ...expected } = claims;
  return expected;
}

function executionAuthority(source: ExecutionAuthoritySource, runtimePolicy = LIVE, options: ExecutionAuthorityOptions = {}): ExecutionAuthority {
  return new ExecutionAuthority(source, runtimePolicy, {
    executionStepLedger: new TestExecutionStepLedger(),
    ...options
  });
}

describe("execution authority", () => {
  it("derives every mutable revision from the authority sources", async () => {
    const state = fixture();
    const authority = executionAuthority(state.source);
    const issued = await authority.issue(permitRequest());

    expect(issued.claims).toMatchObject({
      ownerUserId: "owner-a",
      accountRevision: 5,
      credentialRevision: 4,
      authorizationRevision: 7,
      authorizationRole: "live-trade",
      authorizationEpoch: 3,
      liveArmEpoch: 9,
      venue: "bybit",
      capability: "entry",
      action: "order.entry"
    });
  });

  it("revalidates PostgreSQL authorization and invokes the network once after sync consume", async () => {
    const state = fixture();
    const authority = executionAuthority(state.source);
    const request = permitRequest();
    const issued = await authority.issue(request);
    const handed = authority.handoff(issued, expectedFromClaims(issued.claims));
    let callbacks = 0;

    await expect(
      authority.consumeAndInvoke(handed, request.signedRequest, async () => {
        callbacks += 1;
        return "sent";
      })
    ).resolves.toBe("sent");
    await expect(
      authority.consumeAndInvoke(handed, request.signedRequest, () => {
        callbacks += 1;
      })
    ).rejects.toMatchObject({ code: "PERMIT_REUSED" });
    expect(callbacks).toBe(1);
  });

  it("requires a durable mutation ledger and blocks the same step across authority instances", async () => {
    const state = fixture();
    await expect(new ExecutionAuthority(state.source, LIVE).issue(permitRequest())).rejects.toMatchObject({ code: "PERMIT_POLICY_DENIED" });

    const ledger = new TestExecutionStepLedger();
    const firstAuthority = executionAuthority(state.source, LIVE, {
      executionStepLedger: ledger
    });
    const secondAuthority = executionAuthority(state.source, LIVE, {
      executionStepLedger: ledger
    });
    const request = permitRequest();
    const issued = await firstAuthority.issue(request);

    await expect(secondAuthority.issue(request)).rejects.toMatchObject({
      code: "PERMIT_DUPLICATE_STEP"
    });
    const handed = firstAuthority.handoff(issued, firstAuthority.expected(issued));
    let callbacks = 0;
    await expect(
      firstAuthority.consumeAndInvoke(handed, request.signedRequest, () => {
        callbacks += 1;
        return "sent";
      })
    ).resolves.toBe("sent");
    await expect(secondAuthority.issue(request)).rejects.toMatchObject({
      code: "PERMIT_DUPLICATE_STEP"
    });
    expect(callbacks).toBe(1);
  });

  it("allows only one network callback when a durable handoff is consumed concurrently", async () => {
    const state = fixture();
    const authority = executionAuthority(state.source);
    const request = permitRequest();
    const issued = await authority.issue(request);
    const handed = authority.handoff(issued, authority.expected(issued));
    let callbacks = 0;

    const outcomes = await Promise.allSettled([
      authority.consumeAndInvoke(handed, request.signedRequest, async () => {
        callbacks += 1;
        return "sent";
      }),
      authority.consumeAndInvoke(handed, request.signedRequest, async () => {
        callbacks += 1;
        return "sent";
      })
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect(callbacks).toBe(1);
  });

  it("rejects copied or cross-authority handoff objects", async () => {
    const state = fixture();
    const ledger = new TestExecutionStepLedger();
    const authority = executionAuthority(state.source, LIVE, {
      executionStepLedger: ledger
    });
    const otherAuthority = executionAuthority(state.source, LIVE, {
      executionStepLedger: ledger
    });
    const request = permitRequest();
    const issued = await authority.issue(request);
    const copiedIssued = {
      ...issued,
      claims: {
        ...issued.claims,
        capability: "private-read",
        action: "private.account.read",
        riskEffect: "none"
      }
    } as unknown as IssuedExecutionPermit;
    expect(() => authority.handoff(copiedIssued, authority.expected(issued))).toThrowError(expect.objectContaining({ code: "PERMIT_HANDOFF_REQUIRED" }));
    expect(() => otherAuthority.handoff(issued, authority.expected(issued))).toThrowError(expect.objectContaining({ code: "PERMIT_HANDOFF_REQUIRED" }));
    const handed = authority.handoff(issued, authority.expected(issued));
    const copied = { ...handed };
    let callbacks = 0;

    await expect(
      authority.consumeAndInvoke(copied, request.signedRequest, () => {
        callbacks += 1;
      })
    ).rejects.toMatchObject({ code: "PERMIT_HANDOFF_REQUIRED" });
    await expect(
      otherAuthority.consumeAndInvoke(handed, request.signedRequest, () => {
        callbacks += 1;
      })
    ).rejects.toMatchObject({ code: "PERMIT_HANDOFF_REQUIRED" });
    await expect(
      authority.consumeAndInvoke(handed, request.signedRequest, () => {
        callbacks += 1;
        return "sent";
      })
    ).resolves.toBe("sent");
    expect(callbacks).toBe(1);
  });

  it("revalidates durable authorization again after the ledger consume await", async () => {
    const state = fixture();
    const baseLedger = new TestExecutionStepLedger();
    let releaseConsume: (() => void) | undefined;
    let markConsumeStarted: (() => void) | undefined;
    const consumeGate = new Promise<void>((resolve) => {
      releaseConsume = resolve;
    });
    const consumeStarted = new Promise<void>((resolve) => {
      markConsumeStarted = resolve;
    });
    const delayedLedger: ExecutionStepLedgerRepository = {
      reserve: (input) => baseLedger.reserve(input),
      consume: async (input) => {
        markConsumeStarted?.();
        await consumeGate;
        return baseLedger.consume(input);
      },
      pruneOwner: (ownerUserId, options) => baseLedger.pruneOwner(ownerUserId, options)
    };
    const authority = executionAuthority(state.source, LIVE, {
      executionStepLedger: delayedLedger
    });
    const request = permitRequest();
    const issued = await authority.issue(request);
    const handed = authority.handoff(issued, authority.expected(issued));
    let callbacks = 0;
    const consume = authority.consumeAndInvoke(handed, request.signedRequest, () => {
      callbacks += 1;
    });

    await consumeStarted;
    const current = state.authorization()!;
    state.setAuthorization({
      ...current,
      authorizationRevision: current.authorizationRevision + 1
    });
    releaseConsume?.();

    await expect(consume).rejects.toMatchObject({ code: "PERMIT_CURRENT_STATE_CHANGED" });
    expect(callbacks).toBe(0);
  });

  it("gives ledger failures zero network callbacks", async () => {
    const state = fixture();
    const baseLedger = new TestExecutionStepLedger();
    const failingLedger: ExecutionStepLedgerRepository = {
      reserve: (input) => baseLedger.reserve(input),
      consume: async () => {
        throw new Error("database unavailable");
      },
      pruneOwner: (ownerUserId, options) => baseLedger.pruneOwner(ownerUserId, options)
    };
    const authority = executionAuthority(state.source, LIVE, {
      executionStepLedger: failingLedger
    });
    const request = permitRequest();
    const issued = await authority.issue(request);
    const handed = authority.handoff(issued, authority.expected(issued));
    let callbacks = 0;

    await expect(
      authority.consumeAndInvoke(handed, request.signedRequest, () => {
        callbacks += 1;
      })
    ).rejects.toMatchObject({ code: "PERMIT_POLICY_DENIED" });
    expect(callbacks).toBe(0);
  });

  it("gives durable authorization changes zero network callbacks", async () => {
    const state = fixture();
    const authority = executionAuthority(state.source);
    const request = permitRequest();
    const issued = await authority.issue(request);
    const handed = authority.handoff(issued, expectedFromClaims(issued.claims));
    const current = state.authorization()!;
    state.setAuthorization({ ...current, authorizationRevision: current.authorizationRevision + 1 });
    let callbacks = 0;

    await expect(
      authority.consumeAndInvoke(handed, request.signedRequest, () => {
        callbacks += 1;
      })
    ).rejects.toMatchObject({ code: "PERMIT_CURRENT_STATE_CHANGED" });
    expect(callbacks).toBe(0);
  });

  it("invalidates outstanding permits on account, credential and arm changes", async () => {
    for (const mutation of ["account", "credential", "arm"] as const) {
      const state = fixture();
      const authority = executionAuthority(state.source);
      const request = permitRequest();
      const issued = await authority.issue(request);
      const handed = authority.handoff(issued, expectedFromClaims(issued.claims));
      if (mutation === "account") {
        const current = state.account()!;
        state.setAccount({ ...current, authorizationRevision: current.authorizationRevision + 1 });
      } else if (mutation === "credential") {
        const current = state.account()!;
        state.setAccount({ ...current, credentialRevision: current.credentialRevision + 1 });
      } else {
        const current = state.owner();
        state.setOwner({ ...current, armed: false, epoch: current.epoch + 1 });
      }
      let callbacks = 0;
      await expect(
        authority.consumeAndInvoke(handed, request.signedRequest, () => {
          callbacks += 1;
        })
      ).rejects.toMatchObject({ code: "PERMIT_CURRENT_STATE_CHANGED" });
      expect(callbacks).toBe(0);
    }
  });

  it("snapshots the exact signed request before awaiting durable authorization", async () => {
    const state = fixture();
    let resolveAuthorization: ((value: ExecutionAuthorizationSnapshot | undefined) => void) | undefined;
    const deferredAuthorization = new Promise<ExecutionAuthorizationSnapshot | undefined>((resolve) => {
      resolveAuthorization = resolve;
    });
    const authority = executionAuthority({
      ...state.source,
      loadAuthorization: () => deferredAuthorization
    });
    const mutableRequest = signedEntry();
    const originalRequest = signedEntry();
    const issue = authority.issue(permitRequest(mutableRequest));

    (mutableRequest.payload as Record<string, unknown>).qty = "99";
    resolveAuthorization?.(state.authorization());
    const issued = await issue;

    expect(issued.claims.signedRequestDigest).toBe(signedExchangeRequestDigest(originalRequest));
    expect(issued.claims.signedRequestDigest).not.toBe(signedExchangeRequestDigest(mutableRequest));
  });

  it("rejects spoofed, incomplete and unavailable actor/session contexts", async () => {
    const state = fixture();
    const authority = executionAuthority(state.source);

    await expect(authority.issue({ ...permitRequest(), actorUserId: "owner-b" })).rejects.toMatchObject({ code: "PERMIT_CONTEXT_MISMATCH" });
    await expect(authority.issue({ ...permitRequest(), sessionIdHash: undefined })).rejects.toMatchObject({ code: "PERMIT_CONTEXT_MISMATCH" });
    await expect(authority.issue({ ...permitRequest(), actorUserId: undefined })).rejects.toMatchObject({ code: "PERMIT_CONTEXT_MISMATCH" });

    const manual = permitRequest();
    manual.operation = { kind: "manual", requestId: "manual-a" };
    manual.actorUserId = undefined;
    manual.sessionIdHash = undefined;
    await expect(authority.issue(manual)).rejects.toMatchObject({ code: "PERMIT_CONTEXT_MISMATCH" });

    const missingSession = fixture({ session: null });
    await expect(executionAuthority(missingSession.source).issue(permitRequest())).rejects.toMatchObject({ code: "PERMIT_CURRENT_STATE_CHANGED" });
  });

  it("revalidates the durable owner session immediately before consume", async () => {
    const state = fixture();
    const authority = executionAuthority(state.source);
    const request = permitRequest();
    const issued = await authority.issue(request);
    const handed = authority.handoff(issued, expectedFromClaims(issued.claims));
    state.setSession(undefined);
    let callbacks = 0;

    await expect(
      authority.consumeAndInvoke(handed, request.signedRequest, () => {
        callbacks += 1;
      })
    ).rejects.toMatchObject({ code: "PERMIT_CURRENT_STATE_CHANGED" });
    expect(callbacks).toBe(0);
  });

  it("fails closed for missing credentials, wrong venue, disabled account and insufficient role", async () => {
    await expect(executionAuthority(fixture({ account: { credentialsConfigured: false } }).source).issue(permitRequest())).rejects.toMatchObject({ code: "PERMIT_CURRENT_STATE_CHANGED" });
    await expect(executionAuthority(fixture({ account: { exchange: "binance" } }).source).issue(permitRequest())).rejects.toMatchObject({ code: "PERMIT_CONTEXT_MISMATCH" });
    await expect(executionAuthority(fixture({ account: { enabled: false } }).source).issue(permitRequest())).rejects.toMatchObject({ code: "PERMIT_CURRENT_STATE_CHANGED" });
    await expect(executionAuthority(fixture({ authorization: { role: "paper-trade" } }).source).issue(permitRequest())).rejects.toMatchObject({ code: "PERMIT_POLICY_DENIED" });
  });

  it("allows safe emergency reads on a disabled, disarmed account but denies emergency entry", async () => {
    const state = fixture({ account: { enabled: false }, owner: { armed: false } });
    const authority = executionAuthority(state.source);
    const read = permitRequest(signedRead());
    read.operation = { kind: "emergency", operationId: "emergency-a" };
    await expect(authority.issue(read)).resolves.toMatchObject({ claims: { capability: "private-read" } });

    state.setAccount({ ...state.account()!, enabled: true });
    const entry = permitRequest();
    entry.operation = { kind: "emergency", operationId: "emergency-entry" };
    await expect(authority.issue(entry)).rejects.toMatchObject({ code: "PERMIT_POLICY_DENIED" });
  });

  it("denies all signed requests in public-http-paper before any callback exists", async () => {
    const state = fixture();
    const authority = executionAuthority(state.source, PAPER);
    await expect(authority.issue(permitRequest())).rejects.toMatchObject({ code: "PERMIT_POLICY_DENIED" });
    await expect(authority.issue(permitRequest(signedRead()))).rejects.toMatchObject({ code: "PERMIT_POLICY_DENIED" });
  });
});
