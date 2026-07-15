import express from "express";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  createNetworkIdentityPreflightHandler,
  createNetworkIdentityRegistryHandler,
  NetworkIdentityService,
  reviewedNetworkIdentityDocument,
  REVIEWED_NETWORK_IDENTITY_VERSION,
  type NetworkIdentityPreflightRequest,
  type NetworkIdentityRegistryDocument,
  type TransferCompatibilityRequest
} from "../src/market/networkIdentity/index.js";

const EVALUATED_AT = Date.parse("2026-07-15T00:00:00.000Z");
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

function request(overrides: Partial<TransferCompatibilityRequest> = {}): TransferCompatibilityRequest {
  return {
    schemaVersion: 1,
    registryVersion: REVIEWED_NETWORK_IDENTITY_VERSION,
    routeId: "route:binance-bybit-btc",
    evaluatedAt: EVALUATED_AT,
    assetId: "asset:bitcoin",
    amount: "1",
    source: { venue: "binance", withdrawalNetworkCode: "BTC" },
    destination: { venue: "bybit", depositNetworkCode: "BTC" },
    maximumEvidenceAgeMs: 30 * 86_400_000,
    maximumFutureClockSkewMs: 1_000,
    maximumArrivalMs: 86_400_000,
    ...overrides
  };
}

function failureCodes(result: ReturnType<NetworkIdentityService["evaluate"]>): string[] {
  return result.failures.map(({ code }) => code);
}

describe("reviewed Binance/Bybit network identity snapshot", () => {
  it("publishes only the exact reviewed BTC, ETH, USDT and USDC allowlist", () => {
    const snapshot = new NetworkIdentityService().snapshot(EVALUATED_AT);
    expect(snapshot).toMatchObject({
      schemaVersion: 1,
      modelVersion: "network-identity-registry-v1",
      readOnly: true,
      executable: false,
      generation: 1,
      evaluatedAt: EVALUATED_AT,
      validity: { status: "current", reason: "current" },
      registry: {
        registryVersion: REVIEWED_NETWORK_IDENTITY_VERSION,
        evidence: { status: "reviewed", asOf: Date.parse("2026-07-14T00:00:00.000Z"), validUntil: Date.parse("2026-10-12T00:00:00.000Z") },
        transferCapabilities: []
      }
    });
    expect(snapshot.registry.assets.map(({ symbol }) => symbol)).toEqual(["BTC", "ETH", "USDT", "USDC"]);
    expect(snapshot.registry.venueMappings.map(({ venue, assetId, depositNetworkCode, withdrawalNetworkCode }) => [venue, assetId, depositNetworkCode, withdrawalNetworkCode])).toEqual([
      ["binance", "asset:bitcoin", "BTC", "BTC"],
      ["bybit", "asset:bitcoin", "BTC", "BTC"],
      ["binance", "asset:ether", "ETH", "ETH"],
      ["bybit", "asset:ether", "ETH", "ETH"],
      ["binance", "asset:tether-usd", "ETH", "ETH"],
      ["bybit", "asset:tether-usd", "ETH", "ETH"],
      ["binance", "asset:usd-coin", "ETH", "ETH"],
      ["bybit", "asset:usd-coin", "ETH", "ETH"]
    ]);
    expect(snapshot.registry.networkAssets.find(({ assetId }) => assetId === "asset:tether-usd")?.representation).toEqual({
      kind: "token-contract",
      tokenContract: { namespace: "eip155:1", address: "0xdAC17F958D2ee523a2206206994597C13D831ec7" }
    });
    expect(snapshot.registry.networkAssets.find(({ assetId }) => assetId === "asset:usd-coin")?.representation).toEqual({
      kind: "token-contract",
      tokenContract: { namespace: "eip155:1", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" }
    });
    for (const mapping of snapshot.registry.venueMappings) {
      expect(mapping.evidence).toMatchObject({ status: "reviewed", version: REVIEWED_NETWORK_IDENTITY_VERSION });
      expect(mapping.evidence.source).toMatch(/^https:\/\/(developers\.binance\.com|bybit-exchange\.github\.io)\//);
    }
  });

  it("resolves exact identity but remains fail-closed without live capability evidence", () => {
    const result = new NetworkIdentityService().evaluate(request());
    expect(result).toMatchObject({
      registryVersion: REVIEWED_NETWORK_IDENTITY_VERSION,
      compatible: false,
      executable: false,
      networkId: "network:bip122:000000000019d6689c085ae165831e93",
      networkAssetId: "network-asset:bitcoin:bip122-mainnet"
    });
    expect(failureCodes(result)).toEqual(expect.arrayContaining(["reorg-sensitive-network", "capability-missing"]));
  });

  it("fails closed for unknown, case-mismatched, ambiguous, delisted and wrapped identities", () => {
    const service = new NetworkIdentityService();
    expect(failureCodes(service.evaluate(request({ source: { venue: "binance", withdrawalNetworkCode: "UNKNOWN" } })))).toContain("unknown-source-mapping");
    expect(failureCodes(service.evaluate(request({ destination: { venue: "bybit", depositNetworkCode: "btc" } })))).toContain("unknown-destination-mapping");

    const ambiguous = reviewedNetworkIdentityDocument();
    reversion(ambiguous, "network-identity-ambiguous-fixture.v1");
    ambiguous.venueMappings.push({ ...structuredClone(ambiguous.venueMappings[0]!), mappingId: "mapping:binance:asset:bitcoin:BTC:duplicate" });
    const ambiguousService = new NetworkIdentityService(ambiguous);
    expect(failureCodes(ambiguousService.evaluate(request({ registryVersion: ambiguous.registryVersion })))).toContain("ambiguous-source-mapping");

    const delisted = reviewedNetworkIdentityDocument();
    reversion(delisted, "network-identity-delisted-fixture.v1");
    delisted.venueMappings = delisted.venueMappings.filter(({ venue, assetId }) => venue !== "bybit" || assetId !== "asset:bitcoin");
    const delistedService = new NetworkIdentityService(delisted);
    expect(failureCodes(delistedService.evaluate(request({ registryVersion: delisted.registryVersion })))).toContain("unknown-destination-mapping");

    const wrapped = reviewedNetworkIdentityDocument();
    reversion(wrapped, "network-identity-wrapped-fixture.v1");
    const bitcoin = wrapped.assets.find(({ assetId }) => assetId === "asset:bitcoin")!;
    bitcoin.kind = "wrapped";
    bitcoin.underlyingAssetId = "asset:ether";
    const networkBitcoin = wrapped.networkAssets.find(({ assetId }) => assetId === "asset:bitcoin")!;
    networkBitcoin.representation = {
      kind: "wrapped",
      tokenContract: { namespace: "fixture", address: "wrapped-bitcoin" },
      underlyingAssetId: "asset:ether",
      bridgeId: "bridge:fixture"
    };
    const wrappedService = new NetworkIdentityService(wrapped);
    expect(failureCodes(wrappedService.evaluate(request({ registryVersion: wrapped.registryVersion })))).toContain("wrapped-asset-unsupported");
  });

  it("validates a complete replacement before one atomic generation swap", () => {
    const service = new NetworkIdentityService();
    const before = service.snapshot(EVALUATED_AT);
    const mismatchedVersion = reviewedNetworkIdentityDocument();
    mismatchedVersion.assets[0]!.evidence.version = "caller-forged-evidence-version";
    expect(() => service.install(mismatchedVersion)).toThrow(/does not match registry/);
    expect(service.snapshot(EVALUATED_AT)).toEqual(before);

    const broken = reviewedNetworkIdentityDocument();
    reversion(broken, "broken.v2");
    broken.networkAssets[0]!.networkId = "network:missing";
    expect(() => service.install(broken)).toThrow();
    expect(service.snapshot(EVALUATED_AT)).toEqual(before);

    const next = reviewedNetworkIdentityDocument();
    reversion(next, "network-identity-2026-07-14.v2");
    next.venueMappings = next.venueMappings.filter(({ assetId }) => assetId !== "asset:usd-coin");
    const installed = service.install(next);
    expect(installed).toMatchObject({ generation: 2, registry: { registryVersion: next.registryVersion } });
    expect(before).toMatchObject({ generation: 1, registry: { registryVersion: REVIEWED_NETWORK_IDENTITY_VERSION } });
  });
});

describe("public read-only network identity API", () => {
  it("serves a bounded snapshot and evaluates only the server-owned registry", async () => {
    const service = new NetworkIdentityService();
    const app = express();
    app.use(express.json({ limit: "64kb" }));
    app.get(
      "/api/network-identity/registry",
      createNetworkIdentityRegistryHandler(service, () => EVALUATED_AT)
    );
    app.post(
      "/api/network-identity/preflight",
      createNetworkIdentityPreflightHandler(service, () => EVALUATED_AT)
    );
    const server = await listen(app);
    const address = server.address();
    const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/api/network-identity`;

    const registryResponse = await fetch(`${base}/registry`);
    expect(registryResponse.status).toBe(200);
    expect(registryResponse.headers.get("cache-control")).toBe("public, max-age=300");
    expect(await registryResponse.json()).toMatchObject({ readOnly: true, executable: false, registry: { registryVersion: REVIEWED_NETWORK_IDENTITY_VERSION } });
    expect((await fetch(`${base}/registry?version=forged`)).status).toBe(400);

    const preflight = await fetch(`${base}/preflight`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(publicRequest())
    });
    expect(preflight.status).toBe(200);
    expect(preflight.headers.get("cache-control")).toBe("no-store");
    expect(await preflight.json()).toMatchObject({ registryVersion: REVIEWED_NETWORK_IDENTITY_VERSION, compatible: false, executable: false });

    const forged = { ...publicRequest(), registry: forgedRegistry() };
    const forgedResponse = await fetch(`${base}/preflight`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(forged)
    });
    expect(forgedResponse.status).toBe(400);
    const forgedResult = (await forgedResponse.json()) as { failures: Array<{ code: string }> };
    expect(forgedResult.failures.map(({ code }) => code)).toContain("invalid-request");
  });

  it("cannot backdate a public preflight into an expired evidence window", async () => {
    const expiredAt = Date.parse("2026-10-12T00:00:00.000Z") + 1;
    const service = new NetworkIdentityService();
    const app = express();
    app.use(express.json());
    app.get(
      "/registry",
      createNetworkIdentityRegistryHandler(service, () => expiredAt)
    );
    app.post(
      "/preflight",
      createNetworkIdentityPreflightHandler(service, () => expiredAt)
    );
    const server = await listen(app);
    const address = server.address();
    const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;

    const snapshotResponse = await fetch(`${base}/registry`);
    expect(snapshotResponse.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
    const snapshot = (await snapshotResponse.json()) as { evaluatedAt: number; validity: { status: string; reason: string; remainingMs: number } };
    expect(snapshot).toMatchObject({ evaluatedAt: expiredAt, validity: { status: "stale", reason: "expired", remainingMs: 0 } });

    const backdated = { ...publicRequest(), evaluatedAt: EVALUATED_AT };
    const backdatedResponse = await fetch(`${base}/preflight`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(backdated) });
    expect(backdatedResponse.status).toBe(400);
    const backdatedResult = (await backdatedResponse.json()) as { evaluatedAt: number; failures: Array<{ code: string }> };
    expect(backdatedResult.evaluatedAt).toBe(expiredAt);
    expect(backdatedResult.failures.map(({ code }) => code)).toEqual(["invalid-request"]);

    const current = await fetch(`${base}/preflight`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(publicRequest()) });
    expect(current.status).toBe(200);
    const result = (await current.json()) as { evaluatedAt: number; failures: Array<{ code: string }> };
    expect(result.evaluatedAt).toBe(expiredAt);
    expect(result.failures.map(({ code }) => code)).toContain("identity-evidence-invalid");
  });
});

function publicRequest(): NetworkIdentityPreflightRequest {
  const { evaluatedAt: _evaluatedAt, ...value } = request();
  return value;
}

function forgedRegistry(): NetworkIdentityRegistryDocument {
  const document = reviewedNetworkIdentityDocument();
  document.registryVersion = "caller-forged";
  return document;
}

function reversion(document: NetworkIdentityRegistryDocument, version: string): void {
  document.registryVersion = version;
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (!Array.isArray(value)) {
      const row = value as Record<string, unknown>;
      if (row.status === "reviewed" && typeof row.source === "string" && typeof row.version === "string") row.version = version;
    }
    for (const child of Object.values(value)) visit(child);
  };
  visit(document);
}

function listen(app: express.Express): Promise<Server> {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      servers.push(server);
      resolve(server);
    });
  });
}
