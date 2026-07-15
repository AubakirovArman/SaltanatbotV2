// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it } from "vitest";
import { AuthContext, type AuthContextValue } from "../src/auth/AuthRoot";
import { TENANT_LOCAL_LEGACY_OWNER_KEY } from "../src/app/tenantLocalStorage";
import { usePriceAlerts, type NewAlertInput } from "../src/hooks/usePriceAlerts";
import { loadAlerts, storeAlerts } from "../src/market/alerts";

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
    mustChangePassword: false
  }
});

describe("tenant-private price alerts", () => {
  beforeEach(() => localStorage.clear());

  it("keeps owners isolated and preserves unscoped legacy mode", () => {
    const alert = { id: "alert-a", symbol: "BTCUSDT", price: 100, direction: "above" as const, createdAt: 1, triggered: false };
    storeAlerts([alert], "user-a");
    storeAlerts([{ ...alert, id: "alert-b" }], "user-b");

    expect(loadAlerts("user-a").map(({ id }) => id)).toEqual(["alert-a"]);
    expect(loadAlerts("user-b").map(({ id }) => id)).toEqual(["alert-b"]);
    expect(loadAlerts("")).toEqual([]);
    storeAlerts([{ ...alert, id: "unresolved-alert" }], "");
    expect(localStorage.getItem("sbv2:alerts:")).toBeNull();

    storeAlerts([{ ...alert, id: "legacy-alert" }]);
    expect(loadAlerts().map(({ id }) => id)).toEqual(["legacy-alert"]);
  });

  it("allows only one authenticated owner to claim legacy alerts", () => {
    const legacy = { id: "legacy", symbol: "BTCUSDT", price: 100, direction: "above" as const, createdAt: 1, triggered: false };
    localStorage.setItem(TENANT_LOCAL_LEGACY_OWNER_KEY, "user-a");
    localStorage.setItem("sbv2:alerts", JSON.stringify([legacy]));
    expect(loadAlerts("user-a")).toEqual([legacy]);
    expect(loadAlerts("user-b")).toEqual([]);
  });

  it("does not persist the previous user's in-memory alerts when context switches in-place", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    let addAlert: ((input: NewAlertInput) => void) | undefined;

    function Harness() {
      const alerts = usePriceAlerts({}, () => 2);
      addAlert = alerts.addAlert;
      return <output>{alerts.alerts.map(({ symbol }) => symbol).join(",")}</output>;
    }

    await act(async () =>
      root.render(
        <AuthContext.Provider value={auth("user-a")}>
          <Harness />
        </AuthContext.Provider>
      )
    );
    await act(async () => addAlert?.({ symbol: "BTCUSDT", price: 100, direction: "above" }));
    expect(loadAlerts("user-a").map(({ symbol }) => symbol)).toEqual(["BTCUSDT"]);

    await act(async () =>
      root.render(
        <AuthContext.Provider value={auth("user-b")}>
          <Harness />
        </AuthContext.Provider>
      )
    );
    expect(container.querySelector("output")?.textContent).toBe("");
    expect(loadAlerts("user-b")).toEqual([]);
    expect(loadAlerts("user-a").map(({ symbol }) => symbol)).toEqual(["BTCUSDT"]);

    await act(async () => root.unmount());
  });
});
