import { describe, expect, it, vi } from "vitest";
import { SaltanatArbitrageClient } from "./client.js";
import { parseNetworkIdentityRegistryResponse, parseNetworkTransferCompatibilityResult } from "./networkIdentity.js";
import type { NetworkIdentityRegistryResponse, NetworkTransferCompatibilityRequest, NetworkTransferCompatibilityResult } from "./networkIdentityTypes.js";

const NOW = 2_000_000;

describe("network identity SDK", () => {
  it("strictly parses a bounded server-owned registry", () => {
    expect(parseNetworkIdentityRegistryResponse(registryFixture())).toMatchObject({
      readOnly: true,
      executable: false,
      generation: 1,
      evaluatedAt: NOW,
      validity: { status: "current", reason: "current" },
      registry: { registryVersion: "fixture.v1" }
    });
    const extra = registryFixture() as NetworkIdentityRegistryResponse & { apiKey?: string };
    extra.apiKey = "forbidden";
    expect(() => parseNetworkIdentityRegistryResponse(extra)).toThrow(/apiKey/);

    const duplicate = registryFixture();
    duplicate.registry.assets.push(structuredClone(duplicate.registry.assets[0]!));
    expect(() => parseNetworkIdentityRegistryResponse(duplicate)).toThrow(/unique/);

    const brokenReference = registryFixture();
    brokenReference.registry.networkAssets[0]!.networkId = "network:unknown";
    expect(() => parseNetworkIdentityRegistryResponse(brokenReference)).toThrow(/unknown identity reference/);

    const forgedWindow = registryFixture();
    forgedWindow.validity.validUntil += 1;
    forgedWindow.validity.remainingMs += 1;
    expect(() => parseNetworkIdentityRegistryResponse(forgedWindow)).toThrow(/does not match registry evidence/);

    const forgedVersion = registryFixture();
    forgedVersion.registry.assets[0]!.evidence.version = "forged.v2";
    expect(() => parseNetworkIdentityRegistryResponse(forgedVersion)).toThrow(/versions do not match/);
  });

  it("rejects executable or semantically inconsistent preflight results", () => {
    expect(parseNetworkTransferCompatibilityResult(resultFixture())).toMatchObject({ compatible: false, executable: false });
    expect(() => parseNetworkTransferCompatibilityResult({ ...resultFixture(), executable: true })).toThrow(/executable/);
    expect(() => parseNetworkTransferCompatibilityResult({ ...resultFixture(), compatible: true })).toThrow(/compatible/);
    expect(() => parseNetworkTransferCompatibilityResult({ ...resultFixture(), credentials: "forbidden" })).toThrow(/credentials/);
  });

  it("calls only the public registry and read-only preflight routes", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/network-identity/registry")) {
        expect(init?.method).toBe("GET");
        return Response.json(registryFixture());
      }
      expect(url).toMatch(/\/api\/network-identity\/preflight$/);
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual(requestFixture());
      return Response.json(resultFixture());
    });
    const client = new SaltanatArbitrageClient({ baseUrl: "https://research.invalid", fetch: fetcher as typeof fetch });
    await expect(client.networkIdentityRegistry()).resolves.toMatchObject({ readOnly: true, executable: false });
    await expect(client.networkTransferPreflight(requestFixture())).resolves.toMatchObject({ compatible: false, executable: false });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

function evidence(source = "https://official.example/evidence") {
  return { status: "reviewed" as const, source, version: "fixture.v1", asOf: NOW - 1_000, validUntil: NOW + 1_000 };
}

function registryFixture(): NetworkIdentityRegistryResponse {
  return {
    schemaVersion: 1,
    modelVersion: "network-identity-registry-v1",
    readOnly: true,
    executable: false,
    generation: 1,
    evaluatedAt: NOW,
    validity: { status: "current", reason: "current", asOf: NOW - 1_000, validUntil: NOW + 1_000, remainingMs: 1_000 },
    registry: {
      schemaVersion: 1,
      registryVersion: "fixture.v1",
      evidence: evidence(),
      assets: [{ assetId: "asset:alpha", symbol: "ALPHA", kind: "native", evidence: evidence() }],
      networks: [
        {
          networkId: "network:alpha",
          chainNamespace: "fixture",
          chainReference: "alpha",
          finalityModel: "deterministic",
          reorgSensitive: false,
          evidence: evidence()
        }
      ],
      networkAssets: [
        {
          networkAssetId: "network-asset:alpha",
          assetId: "asset:alpha",
          networkId: "network:alpha",
          quantityDecimals: 6,
          representation: { kind: "native" },
          evidence: evidence()
        }
      ],
      venueMappings: [
        {
          mappingId: "mapping:alpha",
          venue: "venue-a",
          assetId: "asset:alpha",
          networkAssetId: "network-asset:alpha",
          depositNetworkCode: "ALPHA",
          withdrawalNetworkCode: "ALPHA",
          memo: { requirement: "none" },
          evidence: evidence()
        }
      ],
      transferCapabilities: []
    }
  };
}

function requestFixture(): NetworkTransferCompatibilityRequest {
  return {
    schemaVersion: 1,
    registryVersion: "fixture.v1",
    routeId: "route:alpha",
    assetId: "asset:alpha",
    amount: "1",
    source: { venue: "venue-a", withdrawalNetworkCode: "ALPHA" },
    destination: { venue: "venue-b", depositNetworkCode: "ALPHA" },
    maximumEvidenceAgeMs: 2_000,
    maximumFutureClockSkewMs: 1_000,
    maximumArrivalMs: 10_000
  };
}

function resultFixture(): NetworkTransferCompatibilityResult {
  return {
    schemaVersion: 1,
    modelVersion: "network-transfer-compatibility-v1",
    registryVersion: "fixture.v1",
    routeId: "route:alpha",
    evaluatedAt: NOW,
    compatible: false,
    executable: false,
    arrivalProofRequired: true,
    assetId: "asset:alpha",
    grossAmount: "1",
    evidenceIds: [],
    failures: [{ code: "unknown-destination-mapping", message: "No exact mapping" }]
  };
}
