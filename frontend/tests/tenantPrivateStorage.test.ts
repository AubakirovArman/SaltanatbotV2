// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { TENANT_LOCAL_LEGACY_LOCK_NAME, TENANT_LOCAL_LEGACY_OWNER_KEY, claimLegacyTenantLocalData, prepareTenantLocalStorageOwner, readTenantLocalItem, writeTenantLocalItem } from "../src/app/tenantLocalStorage";
import type { ArbitragePaperPosition } from "../src/arbitrage/paper";
import { createOpenEvent, loadPaperEvents, storePaperEvents } from "../src/arbitrage/paperLedger";
import type { StrategyArtifact } from "../src/strategy/library";
import { loadInitialWorkspaceState, storeStrategyLibrary } from "../src/strategy/storage";
import { loadSavedCommands, persistSavedCommands } from "../src/trading/savedCommands";

describe("tenant-private browser storage", () => {
  beforeEach(() => localStorage.clear());

  it("never assigns or copies legacy data from a synchronous reader before the bootstrap barrier", () => {
    localStorage.setItem("legacy:strategies", "private-strategy");

    expect(readTenantLocalItem(localStorage, "legacy:strategies", "user-a")).toBeNull();
    expect(localStorage.getItem(TENANT_LOCAL_LEGACY_OWNER_KEY)).toBeNull();
    expect(localStorage.getItem("legacy:strategies:user-a")).toBeNull();
  });

  it("does not auto-claim legacy data when Web Locks are unavailable", async () => {
    localStorage.setItem("legacy:strategies", "private-strategy");

    await expect(prepareTenantLocalStorageOwner(localStorage, "user-a", null)).resolves.toBe(false);
    expect(localStorage.getItem(TENANT_LOCAL_LEGACY_OWNER_KEY)).toBeNull();
    expect(readTenantLocalItem(localStorage, "legacy:strategies", "user-a")).toBeNull();
  });

  it("serializes competing tabs so exactly one owner can migrate all legacy data", async () => {
    localStorage.setItem("legacy:strategies", "private-strategy");
    localStorage.setItem("legacy:commands", "private-command");
    const locks = serializedLockManager();

    const [claimedA, claimedB] = await Promise.all([prepareTenantLocalStorageOwner(localStorage, "user-a", locks), prepareTenantLocalStorageOwner(localStorage, "user-b", locks)]);

    expect([claimedA, claimedB].filter(Boolean)).toHaveLength(1);
    const owner = claimedA ? "user-a" : "user-b";
    const other = claimedA ? "user-b" : "user-a";
    expect(localStorage.getItem(TENANT_LOCAL_LEGACY_OWNER_KEY)).toBe(owner);
    expect(localStorage.getItem("sbv2:workspaces:legacy-owner")).toBe(owner);
    expect(readTenantLocalItem(localStorage, "legacy:strategies", owner)).toBe("private-strategy");
    expect(readTenantLocalItem(localStorage, "legacy:commands", owner)).toBe("private-command");
    expect(readTenantLocalItem(localStorage, "legacy:strategies", other)).toBeNull();
  });

  it("reconciles an owner selected by an earlier workspace migration under the common lock", async () => {
    localStorage.setItem("sbv2:workspaces:legacy-owner", "user-a");

    expect(claimLegacyTenantLocalData(localStorage, "user-a")).toBe(false);
    await expect(prepareTenantLocalStorageOwner(localStorage, "user-b", serializedLockManager())).resolves.toBe(false);
    expect(claimLegacyTenantLocalData(localStorage, "user-b")).toBe(false);
    expect(claimLegacyTenantLocalData(localStorage, "user-a")).toBe(true);
    expect(localStorage.getItem(TENANT_LOCAL_LEGACY_OWNER_KEY)).toBe("user-a");
  });

  it("keeps strategies, parameter overrides, paper positions and commands isolated", () => {
    const strategyA = fixtureStrategy("strategy:private-a", "Private A");
    const strategyB = fixtureStrategy("strategy:private-b", "Private B");
    storeStrategyLibrary([strategyA], "user-a");
    storeStrategyLibrary([strategyB], "user-b");

    expect(loadInitialWorkspaceState("user-a").strategyLibrary.some((item) => item.id === strategyA.id)).toBe(true);
    expect(loadInitialWorkspaceState("user-a").strategyLibrary.some((item) => item.id === strategyB.id)).toBe(false);
    expect(loadInitialWorkspaceState("user-b").strategyLibrary.some((item) => item.id === strategyB.id)).toBe(true);
    expect(loadInitialWorkspaceState("user-b").strategyLibrary.some((item) => item.id === strategyA.id)).toBe(false);

    writeTenantLocalItem(localStorage, "marketforge.artifactInputs.v1", JSON.stringify({ [strategyA.id]: { period: 21 } }), "user-a");
    expect(readTenantLocalItem(localStorage, "marketforge.artifactInputs.v1", "user-a")).toContain("period");
    expect(readTenantLocalItem(localStorage, "marketforge.artifactInputs.v1", "user-b")).toBeNull();

    const events = [createOpenEvent(fixturePosition(), [], "event-open")];
    storePaperEvents(events, "user-a");
    expect(loadPaperEvents("user-a")).toHaveLength(1);
    expect(loadPaperEvents("user-b")).toEqual([]);

    persistSavedCommands([{ id: "command-a", name: "Private A", command: "exit=BTCUSDT" }], "user-a");
    persistSavedCommands([{ id: "command-b", name: "Private B", command: "exit=ETHUSDT" }], "user-b");
    expect(loadSavedCommands("user-a").map((item) => item.id)).toEqual(["command-a"]);
    expect(loadSavedCommands("user-b").map((item) => item.id)).toEqual(["command-b"]);
  });

  it("fails closed while database authentication has no resolved user", () => {
    writeTenantLocalItem(localStorage, "private:key", "value-a", "user-a");
    writeTenantLocalItem(localStorage, "private:key", "must-not-be-written", "");

    expect(readTenantLocalItem(localStorage, "private:key", "")).toBeNull();
    expect(readTenantLocalItem(localStorage, "private:key", "user-a")).toBe("value-a");
  });
});

function serializedLockManager() {
  let tail = Promise.resolve();
  return {
    request<T>(name: string, options: { mode: "exclusive" }, callback: () => T | Promise<T>): Promise<T> {
      expect(name).toBe(TENANT_LOCAL_LEGACY_LOCK_NAME);
      expect(options).toEqual({ mode: "exclusive" });
      const run = tail.then(callback);
      tail = run.then(
        () => undefined,
        () => undefined
      );
      return run;
    }
  };
}

function fixtureStrategy(id: string, name: string): StrategyArtifact {
  return {
    id,
    kind: "strategy",
    name,
    description: "Private tenant strategy",
    xml: "<xml />",
    createdAt: 100,
    updatedAt: 100
  };
}

function fixturePosition(): ArbitragePaperPosition {
  return {
    id: "arb-paper-position-1",
    routeId: "BTCUSDT:binance:bybit",
    identityScope: "cross-venue-reviewed",
    assetId: "crypto:bitcoin",
    economicAssetId: "crypto:bitcoin",
    spotInstrumentId: "binance:spot:BTCUSDT",
    futuresInstrumentId: "bybit:perpetual:BTCUSDT",
    symbol: "BTCUSDT",
    spotExchange: "binance",
    futuresExchange: "bybit",
    notionalUsd: 100,
    matchedQuantity: 1,
    spotQuantity: 1,
    futuresQuantity: 1,
    quantityStep: 0.001,
    precisionVerified: true,
    roundingDustQuantity: 0,
    residualDeltaQuantity: 0,
    spotEntry: 100,
    futuresEntry: 103,
    openedAt: 100,
    estimatedRoundTripCostUsd: 0.4,
    fundingPnlUsd: 0
  };
}
