import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { ContinuousRouteDiscoveryRuntime, createContinuousRouteRuntimeHandler, loadContinuousRouteConfiguration, parseContinuousRouteConfiguration, type ContinuousRouteConfiguration } from "../src/arbitrage/continuousRoutesRuntime.js";
import type { ContinuousDiscoveryInstrument, ContinuousRouteDiscoverySnapshot } from "../src/arbitrage/upstream/publicFeeds/index.js";
import { ECONOMIC_ASSET_IDENTITY_CATALOG } from "../src/market/economicAssetIdentity.js";

const servers: Array<ReturnType<ReturnType<typeof express>["listen"]>> = [];
const temporaryDirectories: string[] = [];
const NOW = Date.UTC(2026, 6, 14, 12);

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("operator-configured continuous route runtime", () => {
  it("keeps the committed credential-free production allowlist bounded and catalog-versioned", () => {
    const raw = readFileSync(new URL("../../config/continuous-routes.research.json", import.meta.url), "utf8");
    const rows = parseContinuousRouteConfiguration(raw, NOW);

    expect(rows).toHaveLength(19);
    expect(new Set(rows.map(({ instrumentId }) => instrumentId.split(":", 1)[0]))).toEqual(new Set(["gate", "kucoin", "mexc", "kraken", "coinbase", "hyperliquid", "dydx", "deribit"]));
    expect(rows.every(({ economicIdentity }) => economicIdentity.version === ECONOMIC_ASSET_IDENTITY_CATALOG.version && economicIdentity.source === ECONOMIC_ASSET_IDENTITY_CATALOG.source)).toBe(true);
    expect(JSON.stringify(rows)).not.toMatch(/apiKey|apiSecret|wallet|mnemonic|order/i);
  });

  it("parses a strict bounded allowlist and rejects credentials, duplicates and stale review", () => {
    expect(parseContinuousRouteConfiguration(JSON.stringify(configuration()), NOW)).toHaveLength(1);
    expect(() => parseContinuousRouteConfiguration(JSON.stringify([{ ...configuration()[0], apiKey: "forbidden" }]), NOW)).toThrow(/invalid/);
    expect(() => parseContinuousRouteConfiguration(JSON.stringify([...configuration(), ...configuration()]), NOW)).toThrow(/duplicate/);
    const forgedIdentity = configuration();
    forgedIdentity[0]!.economicAssetId = "crypto:ethereum";
    expect(() => parseContinuousRouteConfiguration(JSON.stringify(forgedIdentity), NOW)).toThrow(/central reviewed catalog/);
    const forgedEvidence = configuration();
    forgedEvidence[0]!.economicIdentity.version = "forged-version";
    expect(() => parseContinuousRouteConfiguration(JSON.stringify(forgedEvidence), NOW)).toThrow(/central reviewed catalog/);
    const expired = configuration();
    expired[0]!.economicIdentity.validUntil = NOW - 1;
    expect(() => parseContinuousRouteConfiguration(JSON.stringify(expired), NOW)).toThrow(/expired/);
    expect(() => parseContinuousRouteConfiguration("x".repeat(65 * 1024), NOW)).toThrow(/exceeds/);
  });

  it("loads the same bounded allowlist from one absolute regular UTF-8 file", () => {
    const file = fileURLToPath(new URL("../../config/continuous-routes.research.json", import.meta.url));
    const rows = loadContinuousRouteConfiguration({ file }, NOW);

    expect(rows).toHaveLength(19);
    expect(rows[0]?.economicIdentity.version).toBe(ECONOMIC_ASSET_IDENTITY_CATALOG.version);
    expect(() => loadContinuousRouteConfiguration({ json: JSON.stringify(configuration()), file }, NOW)).toThrow(/only one/);
    expect(() => loadContinuousRouteConfiguration({ file: "config/continuous-routes.research.json" }, NOW)).toThrow(/absolute path/);
  });

  it("fails closed for symlinked, oversized and malformed UTF-8 allowlist files", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "continuous-routes-"));
    temporaryDirectories.push(directory);
    const valid = path.join(directory, "valid.json");
    const symlink = path.join(directory, "allowlist-link.json");
    const oversized = path.join(directory, "oversized.json");
    const malformed = path.join(directory, "malformed.json");
    writeFileSync(valid, JSON.stringify(configuration()));
    symlinkSync(valid, symlink);
    writeFileSync(oversized, Buffer.alloc(64 * 1024 + 1, 0x20));
    writeFileSync(malformed, Buffer.from([0xff, 0xfe, 0xfd]));

    expect(() => loadContinuousRouteConfiguration({ file: symlink }, NOW)).toThrow(/could not be read/);
    expect(() => loadContinuousRouteConfiguration({ file: oversized }, NOW)).toThrow(/exceeds/);
    expect(() => loadContinuousRouteConfiguration({ file: malformed }, NOW)).toThrow(/valid UTF-8/);
  });

  it("uses only current verified registry rows and central reviewed identity authority", async () => {
    const discovery = new FakeDiscovery();
    const runtime = new ContinuousRouteDiscoveryRuntime({
      configuration: configuration(),
      registry: { snapshot: async () => registrySnapshot([instrument()]) },
      discovery,
      now: () => NOW,
      refreshIntervalMs: 10_000
    });

    await runtime.refresh();

    expect(discovery.values).toHaveLength(1);
    expect(discovery.values[0]).toMatchObject({
      instrument: { id: "okx:spot:BTC-USDT", economicAssetId: "crypto:bitcoin" },
      overlay: {
        takerFeeBps: 8,
        economicIdentity: {
          status: "reviewed",
          source: ECONOMIC_ASSET_IDENTITY_CATALOG.source,
          version: ECONOMIC_ASSET_IDENTITY_CATALOG.version
        }
      }
    });
    expect(runtime.snapshot()).toMatchObject({ state: "live", readOnly: true, executable: false, activeInstrumentIds: ["okx:spot:BTC-USDT"], unavailable: [] });
    runtime.close();
  });

  it("fails closed when environment identity evidence differs from the central catalog", async () => {
    for (const mutate of [
      (row: ContinuousRouteConfiguration[number]) => {
        row.economicAssetId = "crypto:ethereum";
      },
      (row: ContinuousRouteConfiguration[number]) => {
        row.economicIdentity.version = "forged-version";
      }
    ]) {
      const rows = configuration();
      mutate(rows[0]!);
      const discovery = new FakeDiscovery();
      const runtime = new ContinuousRouteDiscoveryRuntime({
        configuration: rows,
        registry: { snapshot: async () => registrySnapshot([instrument()]) },
        discovery,
        now: () => NOW,
        refreshIntervalMs: 10_000
      });

      await runtime.refresh();

      expect(discovery.values).toEqual([]);
      expect(runtime.snapshot()).toMatchObject({
        state: "degraded",
        activeInstrumentIds: [],
        unavailable: [{ instrumentId: "okx:spot:BTC-USDT" }]
      });
      runtime.close();
    }
  });

  it("does not infer identity from a ticker when the exact instrument is not reviewed", async () => {
    const discovery = new FakeDiscovery();
    const runtime = new ContinuousRouteDiscoveryRuntime({
      configuration: [{ ...configuration()[0]!, instrumentId: "okx:spot:WBTC-USDT" }],
      registry: { snapshot: async () => registrySnapshot([{ ...instrument(), id: "okx:spot:WBTC-USDT", venueSymbol: "WBTC-USDT", baseAsset: "WBTC", assetId: "WBTC" }]) },
      discovery,
      now: () => NOW,
      refreshIntervalMs: 10_000
    });

    await runtime.refresh();

    expect(discovery.values).toEqual([]);
    expect(runtime.snapshot().unavailable[0]?.reason).toMatch(/central reviewed economic-identity catalog/);
    runtime.close();
  });

  it("withdraws every previous subscription when registry evidence disappears", async () => {
    let rows = [instrument()];
    const discovery = new FakeDiscovery();
    const runtime = new ContinuousRouteDiscoveryRuntime({
      configuration: configuration(),
      registry: { snapshot: async () => registrySnapshot(rows) },
      discovery,
      now: () => NOW,
      refreshIntervalMs: 10_000
    });
    await runtime.refresh();
    rows = [];
    await runtime.refresh(true);

    expect(discovery.values).toEqual([]);
    expect(runtime.snapshot()).toMatchObject({
      state: "degraded",
      activeInstrumentIds: [],
      unavailable: [{ instrumentId: "okx:spot:BTC-USDT" }],
      coverage: { complete: false, current: true, retainedPriorDiscovery: false, reason: "partial-instruments" }
    });
    runtime.close();
  });

  it("marks a first refresh failure incomplete without fabricating a successful refreshedAt", async () => {
    const discovery = new FakeDiscovery();
    const runtime = new ContinuousRouteDiscoveryRuntime({
      configuration: configuration(),
      registry: { snapshot: async () => Promise.reject(new Error("registry unavailable")) },
      discovery,
      now: () => NOW,
      refreshIntervalMs: 10_000
    });

    await runtime.refresh();

    expect(runtime.snapshot()).toMatchObject({
      state: "error",
      activeInstrumentIds: [],
      coverage: { complete: false, current: false, retainedPriorDiscovery: false, reason: "refresh-failed" },
      discovery: { runtimeCoverage: { retainedPriorDiscovery: false, reason: "refresh-failed" } }
    });
    expect(runtime.snapshot()).not.toHaveProperty("refreshedAt");
    runtime.close();
  });

  it("retains the prior discovery after a later registry refresh failure and marks it stale", async () => {
    let reject = false;
    const discovery = new FakeDiscovery();
    const runtime = new ContinuousRouteDiscoveryRuntime({
      configuration: configuration(),
      registry: {
        snapshot: async () => {
          if (reject) throw new Error("registry unavailable");
          return registrySnapshot([instrument()]);
        }
      },
      discovery,
      now: () => NOW,
      refreshIntervalMs: 10_000
    });
    await runtime.refresh();
    reject = true;
    await runtime.refresh(true);

    expect(discovery.values).toHaveLength(1);
    expect(runtime.snapshot()).toMatchObject({
      state: "error",
      refreshedAt: NOW,
      activeInstrumentIds: ["okx:spot:BTC-USDT"],
      coverage: { complete: false, current: false, retainedPriorDiscovery: true, reason: "refresh-failed" },
      discovery: { runtimeCoverage: { retainedPriorDiscovery: true, reason: "refresh-failed" } }
    });
    runtime.close();
  });

  it("exposes a no-store observation endpoint without a browser configuration surface", async () => {
    const runtime = new ContinuousRouteDiscoveryRuntime({ configuration: [], registry: { snapshot: async () => registrySnapshot([]) }, discovery: new FakeDiscovery(), now: () => NOW });
    const app = express();
    app.get("/live", createContinuousRouteRuntimeHandler(runtime));
    const server = app.listen(0);
    servers.push(server);
    const address = server.address();
    const response = await fetch(`http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/live`);

    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({
      state: "disabled",
      configurationSource: "operator-environment",
      executionStatus: "research-only",
      executable: false,
      coverage: { complete: false, current: false, retainedPriorDiscovery: false, reason: "configuration-disabled" }
    });
  });
});

class FakeDiscovery {
  values: ContinuousDiscoveryInstrument[] = [];
  closed = false;
  runtimeCoverage: ContinuousRouteDiscoverySnapshot["runtimeCoverage"] = { complete: true, current: true, retainedPriorDiscovery: false, reason: "complete" };

  configure(values: readonly ContinuousDiscoveryInstrument[]) {
    this.values = structuredClone(values as ContinuousDiscoveryInstrument[]);
  }

  setRuntimeCoverage(value: ContinuousRouteDiscoverySnapshot["runtimeCoverage"]) {
    this.runtimeCoverage = { ...value };
  }

  snapshot(): ContinuousRouteDiscoverySnapshot {
    return {
      engine: "continuous-route-discovery-v1",
      executionStatus: "research-only",
      executable: false,
      capturedAt: NOW,
      runtimeCoverage: { ...this.runtimeCoverage },
      totalCompatibleCandidates: 0,
      truncated: false,
      candidates: [],
      marketEconomics: {
        engine: "continuous-market-economics-v1",
        readOnly: true,
        researchOnly: true,
        executable: false,
        outcomeClass: "projected",
        evaluatedAt: NOW,
        totalCandidates: 0,
        evaluatedCandidates: 0,
        marketOnlyCandidates: 0,
        blockedCandidates: 0,
        publishedEvaluations: 0,
        publishedMarketOnlyCandidates: 0,
        publishedBlockedCandidates: 0,
        truncated: false,
        feePolicy: {
          version: "continuous-public-taker-fee-v1",
          source: "operator-environment",
          liquidity: "taker",
          discountsApplied: false,
          rebatesApplied: false,
          feeAssetVerified: false,
          exposureImpactIncluded: false,
          coverage: "entry-only"
        }
      },
      marketEvaluations: [],
      instruments: [],
      routeReadyBooks: [],
      topBooks: [],
      fundingObservations: [],
      excludedBooks: [],
      rejectedInstruments: [],
      sources: []
    };
  }

  close() {
    this.closed = true;
    this.values = [];
  }
}

function configuration(): ContinuousRouteConfiguration {
  return [
    {
      instrumentId: "okx:spot:BTC-USDT",
      economicAssetId: "crypto:bitcoin",
      takerFeeBps: 8,
      economicIdentity: {
        status: "reviewed",
        source: ECONOMIC_ASSET_IDENTITY_CATALOG.source,
        version: ECONOMIC_ASSET_IDENTITY_CATALOG.version,
        asOf: ECONOMIC_ASSET_IDENTITY_CATALOG.asOf,
        validUntil: ECONOMIC_ASSET_IDENTITY_CATALOG.validUntil
      }
    }
  ];
}

function instrument() {
  return {
    id: "okx:spot:BTC-USDT",
    assetId: "BTC",
    venue: "okx",
    venueSymbol: "BTC-USDT",
    baseAsset: "BTC",
    quoteAsset: "USDT",
    settleAsset: "USDT",
    marketType: "spot" as const,
    contractMultiplier: 1,
    quantityUnit: "base" as const,
    tickSize: 0.1,
    quantityStep: 0.00001,
    minimumQuantity: 0.00001,
    minimumNotional: 1,
    status: "trading" as const
  };
}

function registrySnapshot(verifiedInstruments: ReturnType<typeof instrument>[]) {
  return {
    updatedAt: NOW,
    instruments: verifiedInstruments,
    verifiedInstruments,
    capabilities: [],
    sourceErrors: [],
    sourceStates: []
  };
}
