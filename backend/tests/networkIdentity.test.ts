import { describe, expect, it } from "vitest";
import { decimalUnits } from "../src/market/networkIdentity/decimal.js";
import { evaluateTransferCompatibility, NetworkIdentityRegistry, verifyTransferArrival, type NetworkIdentityRegistryDocument, type ReviewedIdentityEvidence, type TransferArrivalProof, type TransferCompatibilityRequest, type TransferFailureCode } from "../src/market/networkIdentity/index.js";

const NOW = 2_000_000;

function evidence(overrides: Partial<ReviewedIdentityEvidence> = {}): ReviewedIdentityEvidence {
  return { status: "reviewed", source: "synthetic-review", version: "v1", asOf: NOW - 100_000, validUntil: NOW + 100_000, ...overrides };
}

function capability(mappingId: string) {
  return {
    mappingId,
    status: { deposit: "enabled" as const, withdrawal: "enabled" as const, evidence: evidence({ source: `${mappingId}:status` }) },
    limits: {
      minimumDeposit: "0.5",
      maximumDeposit: "100",
      minimumWithdrawal: "1",
      maximumWithdrawal: "100",
      evidence: evidence({ source: `${mappingId}:limits` })
    },
    fee: { feeAssetId: "asset:alpha", fixed: "0.1", percentageBps: 25, evidence: evidence({ source: `${mappingId}:fee` }) },
    confirmations: { required: 2, safe: 3, evidence: evidence({ source: `${mappingId}:confirmations` }) },
    timing: { withdrawalProcessingMs: 1_000, estimatedArrivalMs: 2_000, evidence: evidence({ source: `${mappingId}:timing` }) }
  };
}

function fixture(): NetworkIdentityRegistryDocument {
  return {
    schemaVersion: 1,
    registryVersion: "synthetic-registry-v1",
    evidence: evidence({ source: "synthetic-registry" }),
    assets: [
      { assetId: "asset:alpha", symbol: "ALPHA", kind: "native", evidence: evidence({ source: "asset-alpha" }) },
      {
        assetId: "asset:wrapped-alpha",
        symbol: "WALPHA",
        kind: "wrapped",
        underlyingAssetId: "asset:alpha",
        evidence: evidence({ source: "asset-wrapped-alpha" })
      }
    ],
    networks: [
      {
        networkId: "network:synthetic-safe",
        chainNamespace: "synthetic",
        chainReference: "safe-1",
        finalityModel: "deterministic",
        reorgSensitive: false,
        evidence: evidence({ source: "network-safe" })
      },
      {
        networkId: "network:synthetic-other",
        chainNamespace: "synthetic",
        chainReference: "safe-2",
        finalityModel: "deterministic",
        reorgSensitive: false,
        evidence: evidence({ source: "network-other" })
      },
      {
        networkId: "network:synthetic-reorg",
        chainNamespace: "synthetic",
        chainReference: "reorg-1",
        finalityModel: "probabilistic",
        reorgSensitive: true,
        evidence: evidence({ source: "network-reorg" })
      }
    ],
    networkAssets: [
      {
        networkAssetId: "network-asset:alpha-safe",
        assetId: "asset:alpha",
        networkId: "network:synthetic-safe",
        quantityDecimals: 6,
        representation: { kind: "native" },
        evidence: evidence({ source: "network-asset-alpha-safe" })
      },
      {
        networkAssetId: "network-asset:alpha-other",
        assetId: "asset:alpha",
        networkId: "network:synthetic-other",
        quantityDecimals: 6,
        representation: { kind: "token-contract", tokenContract: { namespace: "synthetic", address: "contract-alpha-other" } },
        evidence: evidence({ source: "network-asset-alpha-other" })
      },
      {
        networkAssetId: "network-asset:alpha-reorg",
        assetId: "asset:alpha",
        networkId: "network:synthetic-reorg",
        quantityDecimals: 6,
        representation: { kind: "token-contract", tokenContract: { namespace: "synthetic", address: "contract-alpha-reorg" } },
        evidence: evidence({ source: "network-asset-alpha-reorg" })
      },
      {
        networkAssetId: "network-asset:wrapped-alpha-safe",
        assetId: "asset:wrapped-alpha",
        networkId: "network:synthetic-safe",
        quantityDecimals: 6,
        representation: {
          kind: "wrapped",
          tokenContract: { namespace: "synthetic", address: "contract-wrapped-alpha" },
          underlyingAssetId: "asset:alpha",
          bridgeId: "bridge:synthetic"
        },
        evidence: evidence({ source: "network-asset-wrapped-alpha" })
      }
    ],
    venueMappings: [
      {
        mappingId: "mapping:source-safe",
        venue: "venue-a",
        assetId: "asset:alpha",
        networkAssetId: "network-asset:alpha-safe",
        depositNetworkCode: "A_SAFE_DEPOSIT",
        withdrawalNetworkCode: "A_SAFE_WITHDRAW",
        memo: { requirement: "none" },
        evidence: evidence({ source: "mapping-source-safe" })
      },
      {
        mappingId: "mapping:destination-safe",
        venue: "venue-b",
        assetId: "asset:alpha",
        networkAssetId: "network-asset:alpha-safe",
        depositNetworkCode: "B_SAFE_DEPOSIT",
        withdrawalNetworkCode: "B_SAFE_WITHDRAW",
        memo: { requirement: "none" },
        evidence: evidence({ source: "mapping-destination-safe" })
      },
      {
        mappingId: "mapping:destination-other",
        venue: "venue-c",
        assetId: "asset:alpha",
        networkAssetId: "network-asset:alpha-other",
        depositNetworkCode: "C_OTHER_DEPOSIT",
        withdrawalNetworkCode: "C_OTHER_WITHDRAW",
        memo: { requirement: "required", memoType: "synthetic-tag" },
        evidence: evidence({ source: "mapping-destination-other" })
      },
      {
        mappingId: "mapping:source-reorg",
        venue: "venue-r1",
        assetId: "asset:alpha",
        networkAssetId: "network-asset:alpha-reorg",
        depositNetworkCode: "R1_DEPOSIT",
        withdrawalNetworkCode: "R1_WITHDRAW",
        memo: { requirement: "none" },
        evidence: evidence({ source: "mapping-source-reorg" })
      },
      {
        mappingId: "mapping:destination-reorg",
        venue: "venue-r2",
        assetId: "asset:alpha",
        networkAssetId: "network-asset:alpha-reorg",
        depositNetworkCode: "R2_DEPOSIT",
        withdrawalNetworkCode: "R2_WITHDRAW",
        memo: { requirement: "none" },
        evidence: evidence({ source: "mapping-destination-reorg" })
      }
    ],
    transferCapabilities: [capability("mapping:source-safe"), capability("mapping:destination-safe"), capability("mapping:destination-other"), capability("mapping:source-reorg"), capability("mapping:destination-reorg")]
  };
}

function compatibilityRequest(overrides: Partial<TransferCompatibilityRequest> = {}): TransferCompatibilityRequest {
  return {
    schemaVersion: 1,
    registryVersion: "synthetic-registry-v1",
    routeId: "route:synthetic",
    evaluatedAt: NOW,
    assetId: "asset:alpha",
    amount: "10",
    source: { venue: "venue-a", withdrawalNetworkCode: "A_SAFE_WITHDRAW" },
    destination: { venue: "venue-b", depositNetworkCode: "B_SAFE_DEPOSIT" },
    maximumEvidenceAgeMs: 200_000,
    maximumFutureClockSkewMs: 1_000,
    maximumArrivalMs: 5_000,
    ...overrides
  };
}

function arrivalProof(overrides: Partial<TransferArrivalProof> = {}): TransferArrivalProof {
  return {
    schemaVersion: 1,
    transferId: "transfer:synthetic-1",
    status: "confirmed",
    fromVenue: "venue-a",
    toVenue: "venue-b",
    assetId: "asset:alpha",
    networkId: "network:synthetic-safe",
    networkAssetId: "network-asset:alpha-safe",
    withdrawalNetworkCode: "A_SAFE_WITHDRAW",
    depositNetworkCode: "B_SAFE_DEPOSIT",
    amountReceived: "9.875",
    confirmations: 3,
    observedAt: NOW + 900,
    evidence: evidence({ source: "synthetic-arrival-observer", asOf: NOW + 500, validUntil: NOW + 10_000 }),
    ...overrides
  };
}

function expectFailure(result: { failures: { code: TransferFailureCode }[] }, code: TransferFailureCode): void {
  expect(result.failures.map((failure) => failure.code)).toContain(code);
}

describe("reviewed network identity registry", () => {
  it("accepts exact synthetic identities and remains an immutable snapshot", () => {
    const input = fixture();
    const registry = new NetworkIdentityRegistry(input);
    input.assets[0]!.symbol = "MUTATED";
    const snapshot = registry.snapshot();
    snapshot.assets[0]!.symbol = "ALSO_MUTATED";
    expect(registry.asset("asset:alpha")?.symbol).toBe("ALPHA");
  });

  it("rejects broken references, wrapper cycles, invalid bounds, and unsafe confirmations", () => {
    const brokenReference = fixture();
    brokenReference.venueMappings[0]!.networkAssetId = "network-asset:missing";
    expect(() => new NetworkIdentityRegistry(brokenReference)).toThrow();

    const cycle = fixture();
    cycle.assets[0] = {
      ...cycle.assets[0]!,
      kind: "wrapped",
      underlyingAssetId: "asset:wrapped-alpha"
    };
    expect(() => new NetworkIdentityRegistry(cycle)).toThrow(/cycle|wrapped/i);

    const bounds = fixture();
    bounds.transferCapabilities[0]!.limits.minimumWithdrawal = "101";
    expect(() => new NetworkIdentityRegistry(bounds)).toThrow(/minimum/i);

    const confirmations = fixture();
    confirmations.transferCapabilities[0]!.confirmations = {
      ...confirmations.transferCapabilities[0]!.confirmations,
      required: 4,
      safe: 3
    };
    expect(() => new NetworkIdentityRegistry(confirmations)).toThrow(/confirmations/i);

    const precision = fixture();
    precision.transferCapabilities[0]!.fee.fixed = "0.0000001";
    expect(() => new NetworkIdentityRegistry(precision)).toThrow(/decimal places/i);

    const representation = fixture();
    representation.networkAssets[3]!.representation = { kind: "native" };
    expect(() => new NetworkIdentityRegistry(representation)).toThrow(/native representation/i);
  });
});

describe("fail-closed transfer compatibility", () => {
  it("computes exact fees and a non-executable compatible preflight", () => {
    const result = evaluateTransferCompatibility(new NetworkIdentityRegistry(fixture()), compatibilityRequest());
    expect(result).toMatchObject({
      compatible: true,
      executable: false,
      arrivalProofRequired: true,
      registryVersion: "synthetic-registry-v1",
      networkId: "network:synthetic-safe",
      networkAssetId: "network-asset:alpha-safe",
      grossAmount: "10",
      feeAmount: "0.125",
      minimumArrivalAmount: "9.875",
      estimatedArrivalMs: 3_000,
      requiredConfirmations: 2,
      safeConfirmations: 3,
      failures: []
    });
    expect(result.evidenceIds).toEqual([...result.evidenceIds].sort());
    expect(result.evidenceIds.length).toBeGreaterThan(8);
  });

  it("fails closed for unknown, case-mismatched, and ambiguous venue codes", () => {
    const registry = new NetworkIdentityRegistry(fixture());
    expectFailure(evaluateTransferCompatibility(registry, compatibilityRequest({ source: { venue: "venue-a", withdrawalNetworkCode: "missing" } })), "unknown-source-mapping");
    expectFailure(evaluateTransferCompatibility(registry, compatibilityRequest({ destination: { venue: "venue-b", depositNetworkCode: "b_safe_deposit" } })), "unknown-destination-mapping");

    const ambiguous = fixture();
    ambiguous.venueMappings.push({ ...structuredClone(ambiguous.venueMappings[0]!), mappingId: "mapping:source-duplicate" });
    ambiguous.transferCapabilities.push({ ...structuredClone(ambiguous.transferCapabilities[0]!), mappingId: "mapping:source-duplicate" });
    expectFailure(evaluateTransferCompatibility(new NetworkIdentityRegistry(ambiguous), compatibilityRequest()), "ambiguous-source-mapping");

    const ambiguousDestination = fixture();
    ambiguousDestination.venueMappings.push({ ...structuredClone(ambiguousDestination.venueMappings[1]!), mappingId: "mapping:destination-duplicate" });
    ambiguousDestination.transferCapabilities.push({ ...structuredClone(ambiguousDestination.transferCapabilities[1]!), mappingId: "mapping:destination-duplicate" });
    expectFailure(evaluateTransferCompatibility(new NetworkIdentityRegistry(ambiguousDestination), compatibilityRequest()), "ambiguous-destination-mapping");
  });

  it("pins evaluation to the requested registry version", () => {
    const result = evaluateTransferCompatibility(new NetworkIdentityRegistry(fixture()), compatibilityRequest({ registryVersion: "synthetic-registry-v0" }));
    expectFailure(result, "registry-version-mismatch");
    expect(result.registryVersion).toBe("synthetic-registry-v1");
  });

  it("does not equate the same economic asset across different networks", () => {
    const result = evaluateTransferCompatibility(new NetworkIdentityRegistry(fixture()), compatibilityRequest({ destination: { venue: "venue-c", depositNetworkCode: "C_OTHER_DEPOSIT", memo: "tag-1" } }));
    expectFailure(result, "network-asset-mismatch");
    expect(result.compatible).toBe(false);
  });

  it("enforces memo policy, status, freshness, fee denomination, and route timeout", () => {
    const memoRequired = evaluateTransferCompatibility(new NetworkIdentityRegistry(fixture()), compatibilityRequest({ destination: { venue: "venue-c", depositNetworkCode: "C_OTHER_DEPOSIT" } }));
    expectFailure(memoRequired, "memo-required");
    expectFailure(
      evaluateTransferCompatibility(
        new NetworkIdentityRegistry(fixture()),
        compatibilityRequest({
          destination: { venue: "venue-b", depositNetworkCode: "B_SAFE_DEPOSIT", memo: "unexpected" }
        })
      ),
      "memo-unexpected"
    );

    const disabled = fixture();
    disabled.transferCapabilities[0]!.status.withdrawal = "maintenance";
    disabled.transferCapabilities[1]!.status.deposit = "unknown";
    const disabledResult = evaluateTransferCompatibility(new NetworkIdentityRegistry(disabled), compatibilityRequest());
    expectFailure(disabledResult, "withdrawal-unavailable");
    expectFailure(disabledResult, "deposit-unavailable");

    const stale = fixture();
    stale.transferCapabilities[0]!.status.evidence = evidence({ source: "stale-status", asOf: NOW - 300_000, validUntil: NOW - 1 });
    expectFailure(evaluateTransferCompatibility(new NetworkIdentityRegistry(stale), compatibilityRequest()), "capability-evidence-invalid");

    const future = fixture();
    future.networks[0]!.evidence = evidence({ source: "future-network", asOf: NOW + 2_000, validUntil: NOW + 20_000 });
    expectFailure(evaluateTransferCompatibility(new NetworkIdentityRegistry(future), compatibilityRequest()), "identity-evidence-invalid");

    const foreignFee = fixture();
    foreignFee.transferCapabilities[0]!.fee.feeAssetId = "asset:wrapped-alpha";
    expectFailure(evaluateTransferCompatibility(new NetworkIdentityRegistry(foreignFee), compatibilityRequest()), "fee-unpriced");
    expectFailure(evaluateTransferCompatibility(new NetworkIdentityRegistry(fixture()), compatibilityRequest({ maximumArrivalMs: 2_999 })), "arrival-estimate-timeout");
  });

  it("rejects reorg-sensitive mappings and exact amount boundary failures", () => {
    const reorg = evaluateTransferCompatibility(
      new NetworkIdentityRegistry(fixture()),
      compatibilityRequest({
        source: { venue: "venue-r1", withdrawalNetworkCode: "R1_WITHDRAW" },
        destination: { venue: "venue-r2", depositNetworkCode: "R2_DEPOSIT" }
      })
    );
    expectFailure(reorg, "reorg-sensitive-network");

    const registry = new NetworkIdentityRegistry(fixture());
    expectFailure(evaluateTransferCompatibility(registry, compatibilityRequest({ amount: "0.9" })), "amount-below-withdrawal-minimum");
    expectFailure(evaluateTransferCompatibility(registry, compatibilityRequest({ amount: "101" })), "amount-above-withdrawal-maximum");
    expectFailure(evaluateTransferCompatibility(registry, compatibilityRequest({ amount: "0.0000001" })), "invalid-request");

    const noArrival = fixture();
    noArrival.transferCapabilities[0]!.fee.fixed = "1";
    expectFailure(evaluateTransferCompatibility(new NetworkIdentityRegistry(noArrival), compatibilityRequest({ amount: "1" })), "amount-after-fee-nonpositive");

    const belowDeposit = fixture();
    belowDeposit.transferCapabilities[1]!.limits.minimumDeposit = "9.9";
    expectFailure(evaluateTransferCompatibility(new NetworkIdentityRegistry(belowDeposit), compatibilityRequest()), "amount-below-deposit-minimum");
    const aboveDeposit = fixture();
    aboveDeposit.transferCapabilities[1]!.limits.maximumDeposit = "9";
    expectFailure(evaluateTransferCompatibility(new NetworkIdentityRegistry(aboveDeposit), compatibilityRequest()), "amount-above-deposit-maximum");
  });

  it("keeps conservative percentage rounding exact across deterministic quantities", () => {
    const document = fixture();
    document.transferCapabilities[0]!.limits.minimumWithdrawal = "0.000001";
    document.transferCapabilities[1]!.limits.minimumDeposit = "0.000001";
    document.transferCapabilities[0]!.fee.fixed = "0";
    document.transferCapabilities[0]!.fee.percentageBps = 1;
    const registry = new NetworkIdentityRegistry(document);
    for (let units = 10_001; units <= 250_001; units += 7_919) {
      const amount = `${Math.floor(units / 1_000_000)}.${String(units % 1_000_000).padStart(6, "0")}`;
      const result = evaluateTransferCompatibility(registry, compatibilityRequest({ amount }));
      expect(result.compatible).toBe(true);
      const gross = decimalUnits(result.grossAmount!, 6, "gross");
      const fee = decimalUnits(result.feeAmount!, 6, "fee");
      const arrival = decimalUnits(result.minimumArrivalAmount!, 6, "arrival");
      expect(fee).toBe((gross + 9_999n) / 10_000n);
      expect(fee + arrival).toBe(gross);
    }
  });
});

describe("fail-closed arrival proof", () => {
  it("verifies exact safe-confirmed arrival without authorising execution", () => {
    const compatibility = compatibilityRequest();
    const result = verifyTransferArrival(new NetworkIdentityRegistry(fixture()), {
      schemaVersion: 1,
      initiatedAt: NOW + 100,
      evaluatedAt: NOW + 1_000,
      compatibility,
      proof: arrivalProof()
    });
    expect(result).toMatchObject({ compatible: true, verified: true, executable: false, amountReceived: "9.875", confirmations: 3, failures: [] });
    expect(result.evidenceIds.some((id) => id.includes("synthetic-arrival-observer"))).toBe(true);
  });

  it("rejects mismatched, unconfirmed, under-confirmed, timed-out, and invalid-amount proofs", () => {
    const registry = new NetworkIdentityRegistry(fixture());
    const run = (proof: TransferArrivalProof, evaluatedAt = NOW + 1_000) =>
      verifyTransferArrival(registry, {
        schemaVersion: 1,
        initiatedAt: NOW + 100,
        evaluatedAt,
        compatibility: compatibilityRequest(),
        proof
      });
    expectFailure(run(arrivalProof({ networkId: "network:synthetic-other" })), "arrival-proof-mismatch");
    expectFailure(run(arrivalProof({ status: "reorged" })), "arrival-status-unconfirmed");
    expectFailure(run(arrivalProof({ confirmations: 2 })), "arrival-confirmations-insufficient");
    expectFailure(run(arrivalProof({ amountReceived: "9.874999" })), "arrival-amount-invalid");
    expectFailure(run(arrivalProof({ observedAt: NOW + 5_101 }), NOW + 5_101), "arrival-timeout");
  });

  it("rejects stale provenance and observation timestamps", () => {
    const result = verifyTransferArrival(new NetworkIdentityRegistry(fixture()), {
      schemaVersion: 1,
      initiatedAt: NOW + 100,
      evaluatedAt: NOW + 1_000,
      compatibility: compatibilityRequest(),
      proof: arrivalProof({
        observedAt: NOW - 1,
        evidence: evidence({ source: "stale-proof", asOf: NOW - 300_000, validUntil: NOW - 1 })
      })
    });
    expectFailure(result, "arrival-proof-invalid");
    expect(result.verified).toBe(false);
  });
});
