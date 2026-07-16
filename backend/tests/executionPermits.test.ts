import { describe, expect, it } from "vitest";
import { runtimePolicyFromConfig } from "../src/runtimeProfile.js";
import { classifySignedExchangeRequest, signedExchangeRequestDigest, type SignedExchangeRequest } from "../src/trading/executionCapabilities.js";
import { ExecutionPermitBroker, ExecutionPermitError, executionPermitExpectation, type ExecutionPermitBinding, type ExecutionPermitClaims, type ExecutionPermitIssueRequest, type ExecutionPermitBrokerOptions, type ExecutionPermitOperation, type ExecutionPermitToken, type HandedOffExecutionPermit } from "../src/trading/executionPermits.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const LIVE = runtimePolicyFromConfig({ runtimeProfile: "private-live" });
const PAPER = runtimePolicyFromConfig({ runtimeProfile: "public-http-paper" });

function entryRequest(qty = "0.01"): SignedExchangeRequest {
  return {
    venue: "bybit",
    market: "futures",
    method: "POST",
    path: "/v5/order/create",
    payload: { category: "linear", symbol: "BTCUSDT", side: "Buy", orderType: "Market", qty }
  };
}

function reduceRequest(): SignedExchangeRequest {
  return {
    venue: "bybit",
    market: "futures",
    method: "POST",
    path: "/v5/order/create",
    payload: { category: "linear", symbol: "BTCUSDT", side: "Sell", orderType: "Market", qty: "0.01", reduceOnly: true }
  };
}

function privateReadRequest(): SignedExchangeRequest {
  return {
    venue: "bybit",
    market: "futures",
    method: "GET",
    path: "/v5/account/wallet-balance",
    payload: { accountType: "UNIFIED" }
  };
}

function cancelRequest(): SignedExchangeRequest {
  return {
    venue: "bybit",
    market: "futures",
    method: "POST",
    path: "/v5/order/cancel",
    payload: { category: "linear", symbol: "BTCUSDT", orderId: "order-1" }
  };
}

function protectionRequest(): SignedExchangeRequest {
  return {
    venue: "bybit",
    market: "futures",
    method: "POST",
    path: "/v5/position/trading-stop",
    payload: { category: "linear", symbol: "BTCUSDT", stopLoss: "60000" }
  };
}

function settingsRequest(): SignedExchangeRequest {
  return {
    venue: "bybit",
    market: "futures",
    method: "POST",
    path: "/v5/position/set-leverage",
    payload: { category: "linear", symbol: "BTCUSDT", buyLeverage: "2", sellLeverage: "2" }
  };
}

function debtRequest(): SignedExchangeRequest {
  return {
    venue: "bybit",
    market: "futures",
    method: "POST",
    path: "/v5/account/borrow",
    payload: { coin: "USDT", amount: "100" }
  };
}

function permitRequest(signedRequest: SignedExchangeRequest = entryRequest(), overrides: Partial<ExecutionPermitIssueRequest> = {}): ExecutionPermitIssueRequest {
  const classification = classifySignedExchangeRequest(signedRequest);
  return {
    ownerUserId: "owner-a",
    actorUserId: "owner-a",
    sessionIdHash: SHA_A,
    accountId: "account-a",
    accountRevision: 1,
    credentialRevision: 2,
    authorizationRevision: 3,
    authorizationRole: "live-trade",
    authorizationEpoch: 4,
    liveArmEpoch: 5,
    operation: { kind: "bot", botId: "bot-a", runId: "run-a" },
    venue: signedRequest.venue,
    market: signedRequest.market,
    symbol: classification.symbol,
    capability: classification.capability,
    action: classification.action,
    riskEffect: classification.riskEffect,
    ...(classification.requiresReduceOnlyProof ? { riskProof: { kind: "venue-enforced-reduce-only", evidenceDigest: SHA_B } as const } : {}),
    intentId: "intent-a",
    intentDigest: SHA_B,
    signedRequestDigest: signedExchangeRequestDigest(signedRequest),
    rulesFingerprint: classification.requiresRulesFingerprint ? SHA_C : null,
    signedRequest,
    ttlMs: 1_000,
    ...overrides
  };
}

function broker(options: Partial<ExecutionPermitBrokerOptions> = {}): ExecutionPermitBroker {
  return new ExecutionPermitBroker({
    ...options,
    runtimePolicy: options.runtimePolicy ?? LIVE,
    validateCurrent: options.validateCurrent ?? (() => true)
  });
}

function handoff(brokerInstance: ExecutionPermitBroker, request: ExecutionPermitIssueRequest) {
  const issued = brokerInstance.issue(request);
  return { issued, handed: brokerInstance.handoff(issued.token, executionPermitExpectation(issued.claims)) };
}

function expectPermitCode(action: () => unknown, code: string): void {
  expect(action).toThrowError(expect.objectContaining({ code }));
}

describe("execution permit broker", () => {
  it("binds one opaque 256-bit token to exact immutable claims and stores only its hash", () => {
    let wall = 10_000;
    let monotonic = 50;
    const instance = broker({ now: () => wall, monotonicNow: () => monotonic });
    const request = permitRequest();
    const issued = instance.issue(request);

    expect(issued.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(issued.claims.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(issued.claims.nonce).not.toBe(issued.token);
    expect(issued.claims).toEqual({
      ...executionPermitExpectation(request),
      permitId: expect.any(String),
      nonce: expect.any(String),
      issuedAt: wall,
      expiresAt: wall + 1_000
    });
    expect(Object.isFrozen(issued.claims)).toBe(true);
    expect(Object.isFrozen(issued.claims.operation)).toBe(true);

    const registry = (instance as unknown as { entries: Map<string, unknown> }).entries;
    expect([...registry.keys()]).toHaveLength(1);
    expect([...registry.keys()][0]).toMatch(/^[0-9a-f]{64}$/);
    expect([...registry.keys()][0]).not.toBe(issued.token);
    expect(JSON.stringify([...registry.values()])).not.toContain(issued.token);

    monotonic += 1;
    wall += 1;
    const handed = instance.handoff(issued.token, executionPermitExpectation(issued.claims));
    expect(instance.stats()).toMatchObject({ active: 1, handedOff: 1, tombstones: 0, owners: { "owner-a": 1 } });
    const claims = instance.consumeAndInvoke(handed, request.signedRequest, (consumed) => consumed);
    expect(claims).toBe(issued.claims);
    expect(instance.stats()).toMatchObject({ active: 0, handedOff: 0, tombstones: 1 });
  });

  it("never invokes transport for an unbranded forged token", () => {
    const instance = broker();
    let callbacks = 0;
    const forged = {
      token: "x".repeat(43) as ExecutionPermitToken,
      permitId: "forged"
    } as HandedOffExecutionPermit;
    expectPermitCode(
      () =>
        instance.consumeAndInvoke(forged, entryRequest(), () => {
          callbacks += 1;
        }),
      "PERMIT_HANDOFF_REQUIRED"
    );
    expect(callbacks).toBe(0);
  });

  it("uses the monotonic deadline even if wall time moves backwards", () => {
    let wall = 10_000;
    let monotonic = 100;
    const instance = broker({ now: () => wall, monotonicNow: () => monotonic, defaultTtlMs: 100, maxTtlMs: 1_000 });
    const request = permitRequest(entryRequest(), { ttlMs: 100 });
    const { handed } = handoff(instance, request);
    wall = 1;
    monotonic = 200;
    let callbacks = 0;
    expectPermitCode(
      () =>
        instance.consumeAndInvoke(handed, request.signedRequest, () => {
          callbacks += 1;
        }),
      "PERMIT_EXPIRED"
    );
    expect(callbacks).toBe(0);
  });

  it("consumes synchronously before invocation and cannot be reused", () => {
    const instance = broker();
    const request = permitRequest();
    const { handed } = handoff(instance, request);
    let callbacks = 0;
    expect(
      instance.consumeAndInvoke(handed, request.signedRequest, () => {
        callbacks += 1;
        return "sent";
      })
    ).toBe("sent");
    expectPermitCode(
      () =>
        instance.consumeAndInvoke(handed, request.signedRequest, () => {
          callbacks += 1;
        }),
      "PERMIT_REUSED"
    );
    expect(callbacks).toBe(1);
  });

  it("allows only one permit for an exact signed step within the bounded replay registry", () => {
    const instance = broker();
    const request = permitRequest();
    const issued = instance.issue(request);
    expectPermitCode(() => instance.issue(request), "PERMIT_DUPLICATE_STEP");

    const handed = instance.handoff(issued.token, executionPermitExpectation(issued.claims));
    instance.consume(handed, request.signedRequest);
    expectPermitCode(() => instance.issue(request), "PERMIT_DUPLICATE_STEP");
    expect(instance.issue(permitRequest(entryRequest(), { intentId: "next-step" })).claims.intentId).toBe("next-step");
  });

  it("allows only one concurrent caller to reach the network callback", async () => {
    const instance = broker();
    const request = permitRequest();
    const { handed } = handoff(instance, request);
    let callbacks = 0;
    const attempts = [0, 1].map(() =>
      Promise.resolve().then(() =>
        instance.consumeAndInvoke(handed, request.signedRequest, async () => {
          callbacks += 1;
          return "sent";
        })
      )
    );
    const results = await Promise.allSettled(attempts);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(callbacks).toBe(1);
  });

  it("revokes a permit on a cross-owner or revision-mismatched handoff", () => {
    for (const mismatch of [{ ownerUserId: "owner-b" }, { accountRevision: 2 }, { credentialRevision: 3 }, { authorizationRevision: 4 }, { authorizationRole: "paper-trade" }, { authorizationEpoch: 5 }, { liveArmEpoch: 6 }] satisfies Partial<ExecutionPermitBinding>[]) {
      const instance = broker();
      const request = permitRequest();
      const issued = instance.issue(request);
      expectPermitCode(() => instance.handoff(issued.token, { ...executionPermitExpectation(issued.claims), ...mismatch }), "PERMIT_CONTEXT_MISMATCH");
      expect(instance.stats().active).toBe(0);
    }
  });

  it("blocks wrong capability and request digest with callback count zero", () => {
    let callbacks = 0;
    const wrongCapabilityBroker = broker();
    const entry = permitRequest();
    const entryHandoff = handoff(wrongCapabilityBroker, entry).handed;
    expectPermitCode(
      () =>
        wrongCapabilityBroker.consumeAndInvoke(entryHandoff, reduceRequest(), () => {
          callbacks += 1;
        }),
      "PERMIT_CONTEXT_MISMATCH"
    );

    const wrongDigestBroker = broker();
    const digestHandoff = handoff(wrongDigestBroker, entry).handed;
    expectPermitCode(
      () =>
        wrongDigestBroker.consumeAndInvoke(digestHandoff, entryRequest("0.02"), () => {
          callbacks += 1;
        }),
      "PERMIT_CONTEXT_MISMATCH"
    );

    expectPermitCode(() => broker().issue(permitRequest(entryRequest(), { capability: "cancel" })), "PERMIT_CAPABILITY_MISMATCH");
    expectPermitCode(() => broker().issue(permitRequest(entryRequest(), { signedRequestDigest: SHA_A })), "PERMIT_CAPABILITY_MISMATCH");
    expect(callbacks).toBe(0);
  });

  it("rechecks account, credential, durable authorization, role and live-arm state at consume", () => {
    const fields = ["accountRevision", "credentialRevision", "authorizationRevision", "authorizationEpoch", "liveArmEpoch"] as const;
    for (const field of fields) {
      const state: Record<(typeof fields)[number], number> = {
        accountRevision: 1,
        credentialRevision: 2,
        authorizationRevision: 3,
        authorizationEpoch: 4,
        liveArmEpoch: 5
      };
      const instance = broker({ validateCurrent: (claims) => claims[field] === state[field] });
      const request = permitRequest();
      const { handed } = handoff(instance, request);
      state[field] += 1;
      let callbacks = 0;
      expectPermitCode(
        () =>
          instance.consumeAndInvoke(handed, request.signedRequest, () => {
            callbacks += 1;
          }),
        "PERMIT_CURRENT_STATE_CHANGED"
      );
      expect(callbacks).toBe(0);
    }

    let currentRole: ExecutionPermitBinding["authorizationRole"] = "live-trade";
    const roleBroker = broker({ validateCurrent: (claims) => claims.authorizationRole === currentRole });
    const roleRequest = permitRequest();
    const { handed } = handoff(roleBroker, roleRequest);
    currentRole = "read-only";
    let roleCallbacks = 0;
    expectPermitCode(
      () =>
        roleBroker.consumeAndInvoke(handed, roleRequest.signedRequest, () => {
          roleCallbacks += 1;
        }),
      "PERMIT_CURRENT_STATE_CHANGED"
    );
    expect(roleCallbacks).toBe(0);
  });

  it("fails closed when the injected current-state validator rejects or throws at any phase", () => {
    expectPermitCode(() => broker({ validateCurrent: () => false }).issue(permitRequest()), "PERMIT_CURRENT_STATE_CHANGED");
    expectPermitCode(
      () =>
        broker({
          validateCurrent: () => {
            throw new Error("state unavailable");
          }
        }).issue(permitRequest()),
      "PERMIT_CURRENT_STATE_CHANGED"
    );

    const atHandoff = broker({ validateCurrent: (_claims, phase) => phase !== "handoff" });
    const issued = atHandoff.issue(permitRequest());
    expectPermitCode(() => atHandoff.handoff(issued.token, executionPermitExpectation(issued.claims)), "PERMIT_CURRENT_STATE_CHANGED");

    let current = true;
    const atConsume = broker({ validateCurrent: () => current });
    const request = permitRequest();
    const { handed } = handoff(atConsume, request);
    current = false;
    let callbacks = 0;
    expectPermitCode(
      () =>
        atConsume.consumeAndInvoke(handed, request.signedRequest, () => {
          callbacks += 1;
        }),
      "PERMIT_CURRENT_STATE_CHANGED"
    );
    expect(callbacks).toBe(0);
  });

  it("denies every signed capability in public-http-paper, including risk increases", () => {
    const requests = [privateReadRequest(), entryRequest(), reduceRequest(), protectionRequest(), cancelRequest(), settingsRequest(), debtRequest()];
    for (const signedRequest of requests) {
      expectPermitCode(() => broker({ runtimePolicy: PAPER }).issue(permitRequest(signedRequest)), "PERMIT_POLICY_DENIED");
    }
  });

  it("limits emergency operations to private read, cancel and proven reduce-only", () => {
    let callbacks = 0;
    for (const signedRequest of [privateReadRequest(), cancelRequest(), reduceRequest()]) {
      const instance = broker();
      const request = permitRequest(signedRequest, { operation: { kind: "emergency", operationId: `emergency-${callbacks}` } });
      const { handed } = handoff(instance, request);
      instance.consumeAndInvoke(handed, signedRequest, () => {
        callbacks += 1;
      });
    }
    expect(callbacks).toBe(3);

    for (const signedRequest of [entryRequest(), protectionRequest(), settingsRequest(), debtRequest()]) {
      expectPermitCode(() => broker().issue(permitRequest(signedRequest, { operation: { kind: "emergency", operationId: "emergency-denied" } })), "PERMIT_POLICY_DENIED");
    }
    expectPermitCode(() => broker().issue(permitRequest(reduceRequest(), { operation: { kind: "emergency", operationId: "emergency-unproven" }, riskProof: undefined })), "PERMIT_INVALID");
  });

  it("enforces an exhaustive operation-to-capability matrix", () => {
    const requests = [privateReadRequest(), entryRequest(), reduceRequest(), protectionRequest(), cancelRequest(), settingsRequest(), debtRequest()];
    const operationCases: Array<{ operation: ExecutionPermitOperation; allowed: ReadonlySet<ExecutionPermitBinding["capability"]> }> = [
      {
        operation: { kind: "bot", botId: "bot-a", runId: "run-a" },
        allowed: new Set(["private-read", "entry", "reduce-only", "protection", "cancel", "account-settings", "debt-actions"])
      },
      {
        operation: { kind: "manual", requestId: "manual-a" },
        allowed: new Set(["private-read", "entry", "reduce-only", "protection", "cancel", "account-settings", "debt-actions"])
      },
      {
        operation: { kind: "emergency", operationId: "emergency-a" },
        allowed: new Set(["private-read", "reduce-only", "cancel"])
      },
      {
        operation: { kind: "reconciliation", operationId: "reconciliation-a" },
        allowed: new Set(["private-read", "reduce-only", "cancel"])
      },
      {
        operation: { kind: "telemetry", operationId: "telemetry-a" },
        allowed: new Set(["private-read"])
      }
    ];

    for (const { operation, allowed } of operationCases) {
      for (const signedRequest of requests) {
        const request = permitRequest(signedRequest, { operation });
        const capability = classifySignedExchangeRequest(signedRequest).capability;
        if (allowed.has(capability)) {
          expect(() => broker().issue(request)).not.toThrow();
        } else {
          expectPermitCode(() => broker().issue(request), "PERMIT_POLICY_DENIED");
        }
      }
    }
  });

  it("enforces bounded active, per-owner and tombstone registries", () => {
    const instance = broker({ maxActive: 2, maxActivePerOwner: 1, maxTombstones: 1 });
    const ownerA = permitRequest(entryRequest(), { intentId: "intent-a" });
    const issuedA = instance.issue(ownerA);
    expectPermitCode(() => instance.issue(permitRequest(entryRequest(), { intentId: "intent-a-2" })), "PERMIT_CAPACITY");

    const ownerB = permitRequest(entryRequest(), {
      ownerUserId: "owner-b",
      actorUserId: "owner-b",
      accountId: "account-b",
      intentId: "intent-b"
    });
    const issuedB = instance.issue(ownerB);
    expectPermitCode(() => instance.issue(permitRequest(entryRequest(), { ownerUserId: "owner-c", actorUserId: "owner-c", accountId: "account-c" })), "PERMIT_CAPACITY");

    const handedA = instance.handoff(issuedA.token, executionPermitExpectation(issuedA.claims));
    instance.consume(handedA, ownerA.signedRequest);
    const handedB = instance.handoff(issuedB.token, executionPermitExpectation(issuedB.claims));
    instance.consume(handedB, ownerB.signedRequest);
    expect(instance.stats()).toMatchObject({ active: 0, handedOff: 0, tombstones: 1 });
  });

  it("bounds tombstones per owner so one owner cannot evict every replay record", () => {
    const instance = broker({ maxActive: 10, maxActivePerOwner: 10, maxTombstones: 10, maxTombstonesPerOwner: 1 });
    const consumeOne = (request: ExecutionPermitIssueRequest) => {
      const issued = instance.issue(request);
      const handed = instance.handoff(issued.token, executionPermitExpectation(issued.claims));
      instance.consume(handed, request.signedRequest);
    };
    consumeOne(permitRequest(entryRequest(), { intentId: "owner-a-step-1" }));
    consumeOne(permitRequest(entryRequest(), { intentId: "owner-a-step-2" }));
    expect(instance.stats().tombstones).toBe(1);
    consumeOne(permitRequest(entryRequest(), { ownerUserId: "owner-b", actorUserId: "owner-b", accountId: "account-b", intentId: "owner-b-step-1" }));
    expect(instance.stats().tombstones).toBe(2);
  });

  it("supports explicit owner/account revocation and scopes operation revocation to one owner", () => {
    const ownerA = broker();
    const first = ownerA.issue(permitRequest());
    expect(ownerA.revokeOwner("owner-a")).toBe(1);
    expectPermitCode(() => ownerA.handoff(first.token, executionPermitExpectation(first.claims)), "PERMIT_REVOKED");

    const account = broker();
    const second = account.issue(permitRequest());
    expect(account.revokeAccount("owner-a", "account-a")).toBe(1);
    expectPermitCode(() => account.handoff(second.token, executionPermitExpectation(second.claims)), "PERMIT_REVOKED");

    const operation = broker();
    const sharedOperation = { kind: "telemetry", operationId: "shared-operation" } as const;
    const thirdRequest = permitRequest(privateReadRequest(), { operation: sharedOperation });
    const third = operation.issue(thirdRequest);
    const otherRequest = permitRequest(privateReadRequest(), {
      ownerUserId: "owner-b",
      actorUserId: "owner-b",
      accountId: "account-b",
      intentId: "intent-b",
      operation: sharedOperation
    });
    const other = operation.issue(otherRequest);
    expect(operation.revokeOperation("owner-a", sharedOperation)).toBe(1);
    expectPermitCode(() => operation.handoff(third.token, executionPermitExpectation(third.claims)), "PERMIT_REVOKED");
    const otherHandoff = operation.handoff(other.token, executionPermitExpectation(other.claims));
    expect(operation.consume(otherHandoff, otherRequest.signedRequest)).toBe(other.claims);
  });

  it("requires the runtime handoff brand even after the broker entered handed-off state", () => {
    const instance = broker();
    const request = permitRequest();
    const issued = instance.issue(request);
    const handed = instance.handoff(issued.token, executionPermitExpectation(issued.claims));
    let callbacks = 0;
    expectPermitCode(
      () =>
        instance.consumeAndInvoke({ token: issued.token, permitId: issued.claims.permitId } as HandedOffExecutionPermit, request.signedRequest, () => {
          callbacks += 1;
        }),
      "PERMIT_HANDOFF_REQUIRED"
    );
    expect(callbacks).toBe(0);
    expect(instance.consume(handed, request.signedRequest)).toBe(issued.claims);
  });

  it("rejects invalid TTL and exact-binding fields", () => {
    expectPermitCode(() => broker().issue(permitRequest(entryRequest(), { ttlMs: 30_001 })), "PERMIT_INVALID");
    expectPermitCode(() => broker().issue(permitRequest(entryRequest(), { intentDigest: "not-a-digest" })), "PERMIT_INVALID");
    expectPermitCode(() => broker().issue(permitRequest(entryRequest(), { authorizationRevision: 0 })), "PERMIT_INVALID");
    expectPermitCode(() => broker().issue(permitRequest(entryRequest(), { authorizationRevision: Number.MAX_SAFE_INTEGER + 1 })), "PERMIT_INVALID");
    expectPermitCode(() => broker().issue(permitRequest(entryRequest(), { authorizationRole: "superuser" as ExecutionPermitBinding["authorizationRole"] })), "PERMIT_INVALID");
    expectPermitCode(() => broker().issue(permitRequest(entryRequest(), { rulesFingerprint: null })), "PERMIT_INVALID");
    expectPermitCode(() => broker().issue(permitRequest(privateReadRequest(), { rulesFingerprint: SHA_A })), "PERMIT_INVALID");
    expectPermitCode(() => broker().issue(permitRequest(entryRequest(), { actorUserId: "owner-b" })), "PERMIT_INVALID");
    expectPermitCode(() => broker().issue(permitRequest(entryRequest(), { sessionIdHash: undefined })), "PERMIT_INVALID");
    expectPermitCode(() => broker().issue(permitRequest(entryRequest(), { actorUserId: undefined })), "PERMIT_INVALID");
    expectPermitCode(
      () =>
        broker().issue(
          permitRequest(entryRequest(), {
            actorUserId: undefined,
            sessionIdHash: undefined,
            operation: { kind: "manual", requestId: "manual-without-session" }
          })
        ),
      "PERMIT_INVALID"
    );
  });

  it("returns typed errors for broker failures", () => {
    try {
      broker().issue(permitRequest(entryRequest(), { capability: "cancel" }));
      throw new Error("expected issuance failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ExecutionPermitError);
      expect((error as ExecutionPermitError).code).toBe("PERMIT_CAPABILITY_MISMATCH");
    }
  });
});
