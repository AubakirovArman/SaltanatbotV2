// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthContext, type AuthContextValue } from "../src/auth/AuthRoot";
import { usePriceAlerts } from "../src/hooks/usePriceAlerts";
import { alertEventWatermarkStorageKey, loadAlertEventWatermark, storeAlertEventWatermark } from "../src/alerts/eventWatermark";

const OWNER = "00000000-0000-4000-8000-000000000031";
const RULE_ID = "00000000-0000-4000-8000-000000000041";

beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe("server alert event polling", () => {
  it("shows owner-scoped in-app history and emits each triggered toast once", async () => {
    let eventAvailable = false;
    let outbox: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (path: string) => {
      const body = path.includes("/events?")
        ? path.includes("cursor=cursor_2")
          ? eventPage([], "cursor_2")
          : path.includes("cursor=cursor_1") && eventAvailable
            ? eventPage([event()], "cursor_2")
            : eventPage([], "cursor_1")
        : path.includes("/outbox?")
          ? { items: outbox, researchOnly: true, executionPermission: false }
          : ruleList();
      return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
    }));

    const container = document.createElement("div");
    const root = createRoot(container);
    let refresh: (() => void) | undefined;

    function Harness() {
      const alerts = usePriceAlerts(() => 2);
      refresh = alerts.sync.refresh;
      return <output>{alerts.toasts.length}|{alerts.sync.events.length}|{alerts.sync.outbox.length}</output>;
    }

    await act(async () => root.render(<AuthContext.Provider value={auth}><Harness /></AuthContext.Provider>));
    expect(container.querySelector("output")?.textContent).toBe("0|0|0");

    eventAvailable = true;
    outbox = [outboxItem()];
    await act(async () => refresh?.());
    expect(container.querySelector("output")?.textContent).toBe("1|1|1");

    await act(async () => refresh?.());
    expect(container.querySelector("output")?.textContent).toBe("1|1|1");
    await act(async () => root.unmount());
  });

  it("does not count a disabled server projection as an active alert", async () => {
    vi.stubGlobal("fetch", vi.fn(async (path: string) => {
      const body = path.includes("/events?")
        ? eventPage([], "cursor_1")
        : path.includes("/outbox?")
          ? { items: [], researchOnly: true, executionPermission: false }
          : ruleList("disabled", false);
      return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
    }));
    const container = document.createElement("div");
    const root = createRoot(container);

    function Harness() {
      const alerts = usePriceAlerts(() => 2);
      return <output>{alerts.activeCount}|{alerts.alerts[0]?.serverLifecycle}</output>;
    }

    await act(async () => root.render(<AuthContext.Provider value={auth}><Harness /></AuthContext.Provider>));
    expect(container.querySelector("output")?.textContent).toBe("0|disabled");
    await act(async () => root.unmount());
  });

  it("recovers only the explicit cursor-ahead condition with a non-notifying baseline", async () => {
    storeAlertEventWatermark(OWNER, {
      occurredAt: "2026-07-17T08:00:00.000Z",
      idsAtOccurredAt: [],
      cursor: "cursor_stale"
    });
    vi.stubGlobal("fetch", vi.fn(async (path: string) => {
      const body = path.includes("/events?")
        ? path.includes("cursor=cursor_stale")
          ? { code: "alert_event_cursor_ahead", error: "The cursor is ahead of restored history." }
          : eventPage([event()], "cursor_rebased")
        : path.includes("/outbox?")
          ? { items: [], researchOnly: true, executionPermission: false }
          : ruleList();
      const status = path.includes("cursor=cursor_stale") ? 409 : 200;
      return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    }));
    const container = document.createElement("div");
    const root = createRoot(container);

    function Harness() {
      const alerts = usePriceAlerts(() => 2);
      return <output>{alerts.sync.status}|{alerts.toasts.length}|{alerts.sync.events.length}</output>;
    }

    await act(async () => root.render(<AuthContext.Provider value={auth}><Harness /></AuthContext.Provider>));

    expect(container.querySelector("output")?.textContent).toBe("synced|0|1");
    expect(loadAlertEventWatermark(OWNER)).toMatchObject({ cursor: "cursor_rebased" });
    await act(async () => root.unmount());
  });

  it("resumes a crash-interrupted cursor rebase without notifying restored history", async () => {
    storeAlertEventWatermark(OWNER, {
      occurredAt: "2026-07-17T08:00:00.000Z",
      idsAtOccurredAt: [],
      baselinePending: true
    });
    vi.stubGlobal("fetch", vi.fn(async (path: string) => {
      const body = path.includes("/events?")
        ? eventPage([event()], "cursor_after_crash")
        : path.includes("/outbox?")
          ? { items: [], researchOnly: true, executionPermission: false }
          : ruleList();
      return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
    }));
    const container = document.createElement("div");
    const root = createRoot(container);

    function Harness() {
      const alerts = usePriceAlerts(() => 2);
      return <output>{alerts.sync.status}|{alerts.toasts.length}|{alerts.sync.events.length}</output>;
    }

    await act(async () => root.render(<AuthContext.Provider value={auth}><Harness /></AuthContext.Provider>));

    expect(container.querySelector("output")?.textContent).toBe("synced|0|1");
    expect(loadAlertEventWatermark(OWNER)).toEqual({
      occurredAt: "2026-07-17T08:04:00.000Z",
      idsAtOccurredAt: [event().id],
      cursor: "cursor_after_crash"
    });
    await act(async () => root.unmount());
  });

  it("does not erase a cursor for any other cursor error", async () => {
    const watermark = { occurredAt: "2026-07-17T08:00:00.000Z", idsAtOccurredAt: [], cursor: "cursor_foreign" };
    storeAlertEventWatermark(OWNER, watermark);
    vi.stubGlobal("fetch", vi.fn(async (path: string) => {
      const body = path.includes("/events?")
        ? { code: "alert_event_cursor_invalid", error: "The cursor is invalid." }
        : path.includes("/outbox?")
          ? { items: [], researchOnly: true, executionPermission: false }
          : ruleList();
      const status = path.includes("/events?") ? 409 : 200;
      return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    }));
    const container = document.createElement("div");
    const root = createRoot(container);

    function Harness() {
      const alerts = usePriceAlerts(() => 2);
      return <output>{alerts.sync.status}</output>;
    }

    await act(async () => root.render(<AuthContext.Provider value={auth}><Harness /></AuthContext.Provider>));

    expect(container.querySelector("output")?.textContent).toBe("error");
    expect(loadAlertEventWatermark(OWNER)).toEqual(watermark);
    await act(async () => root.unmount());
  });

  it("drains every strict page before advancing the durable cursor", async () => {
    let eventsAvailable = false;
    vi.stubGlobal("fetch", vi.fn(async (path: string) => {
      const body = path.includes("/events?")
        ? !path.includes("cursor=")
          ? eventPage([], "cursor_0")
          : path.includes("cursor=cursor_0") && eventsAvailable
            ? { ...eventPage([event()], "cursor_1"), hasMore: true }
            : path.includes("cursor=cursor_1")
              ? eventPage([event(2, "2026-07-17T08:02:00.000Z")], "cursor_2")
              : eventPage([], "cursor_2")
        : path.includes("/outbox?")
          ? { items: [], researchOnly: true, executionPermission: false }
          : ruleList();
      return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
    }));
    const container = document.createElement("div");
    const root = createRoot(container);
    let refresh: (() => void) | undefined;

    function Harness() {
      const alerts = usePriceAlerts(() => 2);
      refresh = alerts.sync.refresh;
      return <output>{alerts.toasts.length}|{alerts.sync.events.length}</output>;
    }

    await act(async () => root.render(<AuthContext.Provider value={auth}><Harness /></AuthContext.Provider>));
    eventsAvailable = true;
    await act(async () => refresh?.());

    expect(container.querySelector("output")?.textContent).toBe("2|2");
    expect(loadAlertEventWatermark(OWNER)).toMatchObject({ cursor: "cursor_2" });
    await act(async () => root.unmount());
  });

  it("drains an initial retained-history snapshot but toasts only post-session events", async () => {
    const eventRequests: URL[] = [];
    vi.stubGlobal("fetch", vi.fn(async (path: string) => {
      const request = new URL(path, "http://localhost");
      if (path.includes("/events?")) eventRequests.push(request);
      const since = request.searchParams.get("since");
      const cursor = request.searchParams.get("cursor");
      const body = path.includes("/events?")
        ? since && cursor === "cursor_initial_1"
          ? eventPage([event(5, "2026-07-17T08:03:30.000Z")], "cursor_initial_2")
          : since
            ? { ...eventPage([event(4, "2026-07-17T08:04:00.000Z")], "cursor_initial_1"), hasMore: true }
            : { ...eventPage([event(3, "2026-07-17T08:02:00.000Z")], "cursor_discarded"), hasMore: true }
        : path.includes("/outbox?")
          ? { items: [], researchOnly: true, executionPermission: false }
          : ruleList();
      return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
    }));
    const container = document.createElement("div");
    const root = createRoot(container);

    function Harness() {
      const alerts = usePriceAlerts(() => 2);
      return <output>{alerts.sync.status}|{alerts.toasts.length}|{alerts.sync.events.length}</output>;
    }

    await act(async () => root.render(<AuthContext.Provider value={auth}><Harness /></AuthContext.Provider>));

    expect(container.querySelector("output")?.textContent).toBe("synced|2|2");
    expect(loadAlertEventWatermark(OWNER)).toMatchObject({ cursor: "cursor_initial_2", occurredAt: "2026-07-17T08:04:00.000Z" });
    expect(eventRequests).toHaveLength(3);
    expect(eventRequests[0]?.searchParams.has("since")).toBe(false);
    const floor = eventRequests[1]?.searchParams.get("since");
    expect(floor).toMatch(/^2026-07-17T08:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Date.parse(floor ?? "")).toBeLessThanOrEqual(Date.parse("2026-07-17T08:03:00.000Z"));
    expect(Date.parse(floor ?? "")).toBeGreaterThan(Date.parse("2026-07-17T08:00:00.000Z"));
    expect(eventRequests[1]?.searchParams.has("cursor")).toBe(false);
    expect(eventRequests[2]?.searchParams.get("since")).toBe(floor);
    expect(eventRequests[2]?.searchParams.get("cursor")).toBe("cursor_initial_1");
    await act(async () => root.unmount());
  });

  it("publishes a new event before reporting a failed durable watermark write", async () => {
    let eventAvailable = false;
    vi.stubGlobal("fetch", vi.fn(async (path: string) => {
      const body = path.includes("/events?")
        ? path.includes("cursor=cursor_1") && eventAvailable
          ? eventPage([event()], "cursor_2")
          : eventPage([], "cursor_1")
        : path.includes("/outbox?")
          ? { items: [], researchOnly: true, executionPermission: false }
          : ruleList();
      return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
    }));
    const container = document.createElement("div");
    const root = createRoot(container);
    let refresh: (() => void) | undefined;

    function Harness() {
      const alerts = usePriceAlerts(() => 2);
      refresh = alerts.sync.refresh;
      return <output>{alerts.sync.status}|{alerts.toasts.length}</output>;
    }

    await act(async () => root.render(<AuthContext.Provider value={auth}><Harness /></AuthContext.Provider>));
    const key = alertEventWatermarkStorageKey(OWNER);
    const originalSetItem = Storage.prototype.setItem;
    const storageSpy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (name, value) {
      if (name === key) throw new DOMException("quota", "QuotaExceededError");
      return originalSetItem.call(this, name, value);
    });
    eventAvailable = true;
    await act(async () => refresh?.());

    expect(container.querySelector("output")?.textContent).toBe("error|1");
    expect(loadAlertEventWatermark(OWNER)).toMatchObject({ cursor: "cursor_1" });
    storageSpy.mockRestore();
    await act(async () => root.unmount());
  });
});

const auth: AuthContextValue = {
  authRequired: true,
  openAccount: () => undefined,
  refreshSession: async () => undefined,
  tradingRoleAssignmentsEnabled: true,
  tradingAvailable: false,
  user: {
    id: OWNER,
    login: "owner",
    status: "active",
    appRole: "user",
    tradingRole: "none",
    mustChangePassword: false,
    authorizationRevision: 1
  }
};

function ruleList(lifecycleState: "armed" | "disabled" = "armed", enabled = true) {
  return {
    schemaVersion: "alert-rule-list-v1",
    rules: [rule(lifecycleState, enabled)],
    generatedAt: "2026-07-17T08:03:00.000Z",
    researchOnly: true,
    executionPermission: false
  };
}

function rule(lifecycleState: "armed" | "disabled", enabled: boolean) {
  return {
    schemaVersion: "alert-rule-record-v1",
    id: RULE_ID,
    clientId: "server-created:one",
    revision: 1,
    definition: {
      schemaVersion: "alert-rule-v1",
      kind: "price-threshold",
      name: "BTC threshold",
      enabled,
      cooldownSeconds: 0,
      deliveryChannels: ["in-app"],
      exchange: "binance",
      marketType: "spot",
      priceType: "last",
      symbol: "BTCUSDT",
      timeframe: "1m",
      direction: "above",
      threshold: "65000",
      crossing: "inclusive",
      repeat: "once-until-rearmed",
      researchOnly: true,
      executionPermission: false
    },
    lifecycleState,
    createdAt: "2026-07-17T08:00:00.000Z",
    updatedAt: "2026-07-17T08:01:00.000Z",
    researchOnly: true,
    executionPermission: false
  };
}

function event(index = 1, occurredAt = "2026-07-17T08:04:00.000Z") {
  const suffix = String(50 + index).padStart(12, "0");
  return {
    schemaVersion: "alert-event-v1",
    id: `00000000-0000-4000-8000-${suffix}`,
    ruleId: RULE_ID,
    ruleRevision: 1,
    ruleKind: "price-threshold",
    eventType: "triggered",
    subjectKey: "binance:spot:last:BTCUSDT:1m",
    transitionKey: index.toString(16).padStart(64, "0"),
    occurredAt,
    summary: "Price alert triggered.",
    researchOnly: true,
    executionPermission: false
  };
}

function eventPage(events: ReturnType<typeof event>[], nextCursor: string) {
  return {
    schemaVersion: "alert-event-page-v1",
    events,
    nextCursor,
    hasMore: false,
    generatedAt: "2026-07-17T08:03:00.000Z",
    researchOnly: true,
    executionPermission: false
  };
}

function outboxItem() {
  return {
    schemaVersion: "notification-outbox-v1",
    id: "00000000-0000-4000-8000-000000000061",
    channel: "in-app",
    status: "delivered",
    attempts: 1,
    maxAttempts: 5,
    queuedAt: "2026-07-17T08:04:00.000Z",
    deliveredAt: "2026-07-17T08:04:01.000Z",
    envelope: {
      schemaVersion: "notification-envelope-v1",
      deduplicationId: "a".repeat(64),
      alertEventId: "00000000-0000-4000-8000-000000000051",
      ruleId: RULE_ID,
      ruleRevision: 1,
      severity: "warning",
      title: "BTCUSDT price alert",
      body: "BTCUSDT crossed 65000.",
      createdAt: "2026-07-17T08:04:00.000Z",
      researchOnly: true,
      executionPermission: false
    },
    researchOnly: true,
    executionPermission: false
  };
}
