// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthContext, type AuthContextValue } from "../src/auth/AuthRoot";
import { TENANT_LOCAL_LEGACY_OWNER_KEY } from "../src/app/tenantLocalStorage";
import { usePriceAlerts, type NewAlertInput } from "../src/hooks/usePriceAlerts";
import { loadAlertSnapshot, loadAlerts, priceAlertStorageKey, storeAlerts } from "../src/market/alerts";
import type { ChartDataRoute } from "../src/types";

const route = { exchange: "binance", marketType: "spot", priceType: "last" } as const;
const USER_A = "00000000-0000-4000-8000-0000000000a1";
const USER_B = "00000000-0000-4000-8000-0000000000b2";

const auth = (id: string): AuthContextValue => ({
  authRequired: true,
  openAccount: () => undefined,
  refreshSession: async () => undefined,
  tradingRoleAssignmentsEnabled: true,
  tradingAvailable: false,
  user: {
    id,
    login: id,
    status: "active",
    appRole: "user",
    tradingRole: "none",
    mustChangePassword: false,
    authorizationRevision: 1
  }
});

const legacyAuth: AuthContextValue = {
  authRequired: false,
  openAccount: () => undefined,
  refreshSession: async () => undefined,
  tradingRoleAssignmentsEnabled: false,
  tradingAvailable: false
};

describe("tenant-private price alerts", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal("fetch", vi.fn(async (path: string) => emptyAlertApiResponse(path)));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("keeps owners isolated and preserves unscoped legacy mode", () => {
    const alert = { id: "alert-a", symbol: "BTCUSDT", price: 100, direction: "above" as const, createdAt: 1, triggered: false, ...route };
    storeAlerts([alert], USER_A);
    storeAlerts([{ ...alert, id: "alert-b" }], USER_B);

    expect(loadAlerts(USER_A).map(({ id }) => id)).toEqual(["alert-a"]);
    expect(loadAlerts(USER_B).map(({ id }) => id)).toEqual(["alert-b"]);
    expect(loadAlerts("")).toEqual([]);
    storeAlerts([{ ...alert, id: "unresolved-alert" }], "");
    expect(localStorage.getItem("sbv2:alerts:")).toBeNull();

    storeAlerts([{ ...alert, id: "legacy-alert" }]);
    expect(loadAlerts().map(({ id }) => id)).toEqual(["legacy-alert"]);
  });

  it("allows only one authenticated owner to claim legacy alerts", () => {
    const legacy = { id: "legacy", symbol: "BTCUSDT", price: 100, direction: "above" as const, createdAt: 1, triggered: false };
    localStorage.setItem(TENANT_LOCAL_LEGACY_OWNER_KEY, USER_A);
    localStorage.setItem("sbv2:alerts", JSON.stringify([legacy]));
    expect(loadAlerts(USER_A)).toEqual([{ ...legacy, ...route }]);
    expect(loadAlerts(USER_B)).toEqual([]);
  });

  it("does not persist the previous user's in-memory alerts when context switches in-place", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    storeAlerts([{ id: "alert-a", symbol: "BTCUSDT", price: 100, direction: "above", createdAt: 1, triggered: true, ...route }], USER_A);
    storeAlerts([{ id: "alert-b", symbol: "ETHUSDT", price: 200, direction: "above", createdAt: 2, triggered: true, ...route }], USER_B);

    function Harness() {
      const alerts = usePriceAlerts(() => 2);
      return <output>{alerts.alerts.map(({ symbol }) => symbol).join(",")}</output>;
    }

    await act(async () =>
      root.render(
        <AuthContext.Provider value={auth(USER_A)}>
          <Harness />
        </AuthContext.Provider>
      )
    );
    expect(container.querySelector("output")?.textContent).toBe("BTCUSDT");

    await act(async () =>
      root.render(
        <AuthContext.Provider value={auth(USER_B)}>
          <Harness />
        </AuthContext.Provider>
      )
    );
    expect(container.querySelector("output")?.textContent).toBe("ETHUSDT");
    expect(loadAlerts(USER_B).map(({ symbol }) => symbol)).toEqual(["ETHUSDT"]);
    expect(loadAlerts(USER_A).map(({ symbol }) => symbol)).toEqual(["BTCUSDT"]);

    await act(async () => root.unmount());
  });

  it("evaluates an alert-only price feed without taking prices as hook state", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    let addAlert: ((input: NewAlertInput) => void) | undefined;
    let evaluatePrices: ((route: ChartDataRoute, prices: Record<string, number>) => void) | undefined;

    function Harness() {
      const alerts = usePriceAlerts(() => 2);
      addAlert = alerts.addAlert;
      evaluatePrices = (nextRoute, prices) => alerts.evaluatePrices(nextRoute, "1m", prices);
      return <output>{alerts.alerts.map(({ triggered }) => String(triggered)).join(",")}|{alerts.toasts.length}</output>;
    }

    await act(async () =>
      root.render(
        <AuthContext.Provider value={legacyAuth}>
          <Harness />
        </AuthContext.Provider>
      )
    );
    await act(async () => addAlert?.({ symbol: "BTCUSDT", price: 100, direction: "above", timeframe: "1m", ...route }));
    expect(container.querySelector("output")?.textContent).toBe("false|0");

    await act(async () => evaluatePrices?.({ exchange: "bybit", marketType: "spot", priceType: "last" }, { BTCUSDT: 101 }));
    expect(container.querySelector("output")?.textContent).toBe("false|0");
    await act(async () => evaluatePrices?.(route, { BTCUSDT: 101 }));
    expect(container.querySelector("output")?.textContent).toBe("true|1");

    await act(async () => root.unmount());
  });

  it("archives a linked server draft before removing its retained browser row", async () => {
    const ruleId = "00000000-0000-4000-8000-000000000041";
    const retained = {
      id: "alert-linked",
      clientId: "browser-alert:linked",
      symbol: "BTCUSDT",
      price: 100,
      direction: "above" as const,
      timeframe: "1m" as const,
      createdAt: 1,
      triggered: true,
      source: "browser" as const,
      serverRuleId: ruleId,
      serverRevision: 1,
      serverLifecycle: "disabled" as const,
      ...route
    };
    storeAlerts([retained], USER_A);
    const archived = {
      schemaVersion: "alert-rule-record-v1",
      id: ruleId,
      clientId: retained.clientId,
      revision: 2,
      definition: {
        schemaVersion: "alert-rule-v1",
        kind: "price-threshold",
        name: "BTCUSDT above 100",
        enabled: false,
        cooldownSeconds: 0,
        deliveryChannels: ["in-app"],
        exchange: "binance",
        marketType: "spot",
        priceType: "last",
        symbol: "BTCUSDT",
        timeframe: "1m",
        direction: "above",
        threshold: "100",
        crossing: "inclusive",
        repeat: "once-until-rearmed",
        researchOnly: true,
        executionPermission: false
      },
      lifecycleState: "archived",
      createdAt: "2026-07-17T08:00:00.000Z",
      updatedAt: "2026-07-17T08:01:00.000Z",
      researchOnly: true,
      executionPermission: false
    };
    const fetchMock = vi.fn(async (path: string) => path.endsWith(`/${ruleId}/archive`)
      ? new Response(JSON.stringify({ rule: archived }), { headers: { "Content-Type": "application/json" } })
      : emptyAlertApiResponse(path));
    vi.stubGlobal("fetch", fetchMock);
    const container = document.createElement("div");
    const root = createRoot(container);
    let remove: ((id: string) => Promise<void>) | undefined;

    function Harness() {
      const alerts = usePriceAlerts(() => 2);
      remove = alerts.removeAlert;
      return <output>{alerts.alerts.length}</output>;
    }

    await act(async () => root.render(<AuthContext.Provider value={auth(USER_A)}><Harness /></AuthContext.Provider>));
    await act(async () => remove?.("alert-linked"));

    expect(fetchMock.mock.calls.map(([path]) => path)).toContain(`/api/alerts/${ruleId}/archive`);
    expect(loadAlerts(USER_A)).toEqual([]);
    await act(async () => root.unmount());
  });

  it("persists a stable database alert intent before reconciliation can reach the server", async () => {
    const fetchMock = vi.fn(() => new Promise<Response>(() => undefined));
    vi.stubGlobal("fetch", fetchMock);
    const container = document.createElement("div");
    const root = createRoot(container);
    let add: ((input: NewAlertInput) => Promise<void>) | undefined;

    function Harness() {
      const alerts = usePriceAlerts(() => 8);
      add = alerts.addAlert;
      return <output>{alerts.alerts.length}</output>;
    }

    await act(async () => root.render(<AuthContext.Provider value={auth(USER_A)}><Harness /></AuthContext.Provider>));
    await act(async () => add?.({ symbol: "BTCUSDT", price: 1e-8, direction: "above", timeframe: "1m", ...route }));

    const stored = loadAlerts(USER_A);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ symbol: "BTCUSDT", price: 1e-8, timeframe: "1m", source: "browser", syncState: "syncing" });
    expect(stored[0]?.clientId).toMatch(/^browser-alert:[0-9a-f]{16}$/);
    expect(stored[0]?.suspended).not.toBe(true);
    expect(fetchMock.mock.calls.every(([path]) => String(path).startsWith("/api/alerts"))).toBe(true);
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    await act(async () => root.unmount());
  });

  it("reads the durable snapshot before evaluation so another tab's suspension wins", async () => {
    const alert = { id: "cross-tab", symbol: "BTCUSDT", price: 100, direction: "above" as const, timeframe: "1m" as const, createdAt: 1, triggered: false, localRevision: 1, ...route };
    storeAlerts([alert]);
    const container = document.createElement("div");
    const root = createRoot(container);
    let evaluate: (() => void) | undefined;

    function Harness() {
      const alerts = usePriceAlerts(() => 2);
      evaluate = () => alerts.evaluatePrices(route, "1m", { BTCUSDT: 101 });
      return <output>{alerts.alerts[0]?.suspended ? "suspended" : "live"}|{alerts.toasts.length}</output>;
    }

    await act(async () => root.render(<AuthContext.Provider value={legacyAuth}><Harness /></AuthContext.Provider>));
    storeAlerts([{ ...alert, suspended: true, localRevision: 2 }]);
    await act(async () => evaluate?.());

    expect(container.querySelector("output")?.textContent).toBe("suspended|0");
    expect(loadAlertSnapshot()[0]).toMatchObject({ suspended: true, triggered: false });
    await act(async () => root.unmount());
  });

  it("rejects unsupported threshold precision before persisting a database intent", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    let add: ((input: NewAlertInput) => Promise<void>) | undefined;

    function Harness() {
      const alerts = usePriceAlerts(() => 2);
      add = alerts.addAlert;
      return null;
    }

    await act(async () => root.render(<AuthContext.Provider value={auth(USER_A)}><Harness /></AuthContext.Provider>));
    await expect(add?.({ symbol: "BTCUSDT", price: 100.001, direction: "above", timeframe: "1m", ...route })).rejects.toThrow(/2 decimal places/i);
    expect(loadAlerts(USER_A)).toEqual([]);
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    await act(async () => root.unmount());
  });

  it("keeps an inert durable tombstone when storage fails after server archive", async () => {
    const ruleId = "00000000-0000-4000-8000-000000000041";
    const retained = {
      id: "delete-fence",
      clientId: "browser-alert:delete-fence",
      symbol: "BTCUSDT",
      price: 100,
      direction: "above" as const,
      timeframe: "1m" as const,
      createdAt: 1,
      triggered: true,
      source: "browser" as const,
      serverRuleId: ruleId,
      serverRevision: 1,
      serverLifecycle: "disabled" as const,
      ...route
    };
    storeAlerts([retained], USER_A);
    const archived = archivedRule(ruleId, retained.clientId);
    vi.stubGlobal("fetch", vi.fn(async (path: string) => path.endsWith(`/${ruleId}/archive`)
      ? new Response(JSON.stringify({ rule: archived }), { headers: { "Content-Type": "application/json" } })
      : emptyAlertApiResponse(path)));
    const originalSetItem = Storage.prototype.setItem;
    let ownerWrites = 0;
    const key = priceAlertStorageKey(USER_A);
    const storageSpy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (name, value) {
      if (name === key && ++ownerWrites === 2) throw new DOMException("quota", "QuotaExceededError");
      return originalSetItem.call(this, name, value);
    });
    const container = document.createElement("div");
    const root = createRoot(container);
    let remove: (() => Promise<void>) | undefined;
    let evaluate: (() => void) | undefined;

    function Harness() {
      const alerts = usePriceAlerts(() => 2);
      remove = () => alerts.removeAlert("delete-fence");
      evaluate = () => alerts.evaluatePrices(route, "1m", { BTCUSDT: 101 });
      return <output>{alerts.toasts.length}</output>;
    }

    await act(async () => root.render(<AuthContext.Provider value={auth(USER_A)}><Harness /></AuthContext.Provider>));
    let removalError: unknown;
    await act(async () => {
      try {
        await remove?.();
      } catch (error) {
        removalError = error;
      }
    });
    await act(async () => evaluate?.());

    expect(removalError).toBeInstanceOf(Error);
    expect(String((removalError as Error).message)).toContain("remains inert");
    expect(loadAlertSnapshot(USER_A)[0]).toMatchObject({ suspended: true, deletionPending: true, syncState: "deleting" });
    expect(container.querySelector("output")?.textContent).toBe("0");
    storageSpy.mockRestore();
    await act(async () => root.unmount());
  });
});

function archivedRule(ruleId: string, clientId: string) {
  return {
    schemaVersion: "alert-rule-record-v1",
    id: ruleId,
    clientId,
    revision: 1,
    definition: {
      schemaVersion: "alert-rule-v1",
      kind: "price-threshold",
      name: "BTCUSDT above 100",
      enabled: false,
      cooldownSeconds: 0,
      deliveryChannels: ["in-app"],
      exchange: "binance",
      marketType: "spot",
      priceType: "last",
      symbol: "BTCUSDT",
      timeframe: "1m",
      direction: "above",
      threshold: "100",
      crossing: "inclusive",
      repeat: "once-until-rearmed",
      researchOnly: true,
      executionPermission: false
    },
    lifecycleState: "archived",
    createdAt: "2026-07-17T08:00:00.000Z",
    updatedAt: "2026-07-17T08:01:00.000Z",
    researchOnly: true,
    executionPermission: false
  };
}

function emptyAlertApiResponse(path: string): Response {
  const body = path.includes("/events?")
    ? { events: [], researchOnly: true, executionPermission: false }
    : path.includes("/outbox?")
      ? { items: [], researchOnly: true, executionPermission: false }
      : { schemaVersion: "alert-rule-list-v1", rules: [], generatedAt: "2026-07-17T08:00:00.000Z", researchOnly: true, executionPermission: false };
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
}
