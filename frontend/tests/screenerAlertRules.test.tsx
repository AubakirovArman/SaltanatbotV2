// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import type { AlertEventV1, AlertRuleRecordV1, NotificationOutboxItemV1, ScreenerAlertDefinitionV1 } from "@saltanatbotv2/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { publishServerEventToasts } from "../src/alerts/eventPolling";
import { AuthContext, type AuthContextValue } from "../src/auth/AuthRoot";
import { usePriceAlerts, type AlertToast } from "../src/hooks/usePriceAlerts";

const OWNER = "00000000-0000-4000-8000-000000000031";
const PRICE_RULE_ID = "00000000-0000-4000-8000-000000000041";
const SCREEN_RULE_ID = "00000000-0000-4000-8000-000000000042";
const ARCHIVED_RULE_ID = "00000000-0000-4000-8000-000000000043";

beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

describe("screener-kind server alert listing", () => {
  it("lists screener rules as server records without projecting them into price rows", async () => {
    const mutations: Array<{ method: string; path: string; body: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (path: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "PUT" && path === `/api/alerts/${SCREEN_RULE_ID}`) {
        const body = JSON.parse(String(init?.body)) as { expectedRevision: number; definition: ScreenerAlertDefinitionV1 };
        mutations.push({ method, path, body });
        return jsonResponse({ rule: screenerRule({ revision: body.expectedRevision + 1, definition: body.definition }) });
      }
      if (method === "POST" && path === `/api/alerts/${SCREEN_RULE_ID}/archive`) {
        const body = JSON.parse(String(init?.body)) as { expectedRevision: number };
        mutations.push({ method, path, body });
        return jsonResponse({ rule: screenerRule({ revision: body.expectedRevision + 1, definition: { ...screenerDefinition(), enabled: false }, lifecycleState: "archived" }) });
      }
      const body = path.includes("/events?")
        ? eventPage()
        : path.includes("/outbox?")
          ? { items: [], researchOnly: true, executionPermission: false }
          : ruleList();
      return jsonResponse(body);
    }));

    const container = document.createElement("div");
    const root = createRoot(container);
    let api: ReturnType<typeof usePriceAlerts> | undefined;

    function Harness() {
      const alerts = usePriceAlerts(() => 2);
      api = alerts;
      const screeners = alerts.screenerRules.map((rule) => `${rule.definition.kind}:${rule.definition.name}:${String(rule.definition.enabled)}`).join(",");
      return <output>{screeners}|{alerts.alerts.map(({ symbol }) => symbol).join(",")}|{alerts.browserAlerts.length}|{alerts.activeCount}</output>;
    }

    await act(async () => root.render(<AuthContext.Provider value={auth}><Harness /></AuthContext.Provider>));

    // The archived screener rule stays hidden; the active one is listed as a
    // server record while the price projection and browser rows ignore it.
    expect(container.querySelector("output")?.textContent).toBe("screener:Momentum screen:true|BTCUSDT|0|1");
    expect(api?.screenerRules[0]).toMatchObject({ id: SCREEN_RULE_ID, revision: 1, lifecycleState: "armed" });

    await expect(api?.setScreenerAlertEnabled(PRICE_RULE_ID, false)).rejects.toThrowError("The screen alert is unavailable.");

    await act(async () => { await api?.setScreenerAlertEnabled(SCREEN_RULE_ID, false); });
    expect(mutations).toEqual([
      {
        method: "PUT",
        path: `/api/alerts/${SCREEN_RULE_ID}`,
        body: { expectedRevision: 1, definition: { ...screenerDefinition(), enabled: false } }
      }
    ]);
    expect(container.querySelector("output")?.textContent).toBe("screener:Momentum screen:false|BTCUSDT|0|1");

    await act(async () => { await api?.archiveScreenerAlert(SCREEN_RULE_ID); });
    expect(mutations[1]).toEqual({
      method: "POST",
      path: `/api/alerts/${SCREEN_RULE_ID}/archive`,
      body: { expectedRevision: 2 }
    });
    expect(container.querySelector("output")?.textContent).toBe("|BTCUSDT|0|1");
    await act(async () => root.unmount());
  });

  it("renders screener toasts from the delivery envelope with a rule-name fallback", () => {
    const withEnvelope = screenerEvent(1);
    const withoutEnvelope = screenerEvent(2);
    let toasts: AlertToast[] = [];
    publishServerEventToasts(
      [withEnvelope, withoutEnvelope],
      [screenerRule(), priceRule()],
      [screenerOutboxItem(withEnvelope.id)],
      (action) => { toasts = action(toasts); }
    );

    expect(toasts).toHaveLength(2);
    expect(toasts[0]).toEqual({
      id: `server:${withEnvelope.id}`,
      source: "server",
      title: "Screen match changed: Momentum screen",
      body: "Entered: SOLUSDT. Matched 3 symbols.",
      summary: withEnvelope.summary,
      occurredAt: withEnvelope.occurredAt
    });
    expect(toasts[1]).toEqual({
      id: `server:${withoutEnvelope.id}`,
      source: "server",
      title: "Momentum screen",
      summary: withoutEnvelope.summary,
      occurredAt: withoutEnvelope.occurredAt
    });
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

function screenerDefinition(): ScreenerAlertDefinitionV1 {
  return {
    schemaVersion: "alert-rule-v1",
    kind: "screener",
    name: "Momentum screen",
    enabled: true,
    cooldownSeconds: 3600,
    deliveryChannels: ["in-app"],
    screen: {
      schemaVersion: "screener-definition-v1",
      kind: "technical",
      name: "Momentum screen",
      exchange: "binance",
      marketType: "spot",
      priceType: "last",
      timeframe: "1h",
      universeLimit: 100,
      sort: { key: "quoteVolume24h", direction: "desc" },
      filters: [{ kind: "quote-volume-24h", min: "1000000" }],
      researchOnly: true,
      executionPermission: false
    },
    repeat: "on-change",
    researchOnly: true,
    executionPermission: false
  };
}

function screenerRule(overrides: Partial<AlertRuleRecordV1> = {}): AlertRuleRecordV1 {
  return {
    schemaVersion: "alert-rule-record-v1",
    id: SCREEN_RULE_ID,
    clientId: "screen-alert-01",
    revision: 1,
    definition: screenerDefinition(),
    lifecycleState: "armed",
    createdAt: "2026-07-17T08:00:00.000Z",
    updatedAt: "2026-07-17T08:01:00.000Z",
    researchOnly: true,
    executionPermission: false,
    ...overrides
  };
}

function priceRule(): AlertRuleRecordV1 {
  return {
    schemaVersion: "alert-rule-record-v1",
    id: PRICE_RULE_ID,
    clientId: "server-created:one",
    revision: 1,
    definition: {
      schemaVersion: "alert-rule-v1",
      kind: "price-threshold",
      name: "BTC threshold",
      enabled: true,
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
    lifecycleState: "armed",
    createdAt: "2026-07-17T08:00:00.000Z",
    updatedAt: "2026-07-17T08:01:00.000Z",
    researchOnly: true,
    executionPermission: false
  };
}

function ruleList() {
  return {
    schemaVersion: "alert-rule-list-v1",
    rules: [
      priceRule(),
      screenerRule(),
      screenerRule({ id: ARCHIVED_RULE_ID, clientId: "screen-alert-02", revision: 4, lifecycleState: "archived" })
    ],
    generatedAt: "2026-07-17T08:03:00.000Z",
    researchOnly: true,
    executionPermission: false
  };
}

function eventPage() {
  return {
    schemaVersion: "alert-event-page-v1",
    events: [],
    nextCursor: "cursor_1",
    hasMore: false,
    generatedAt: "2026-07-17T08:03:00.000Z",
    researchOnly: true,
    executionPermission: false
  };
}

function screenerEvent(index: number): AlertEventV1 {
  const suffix = String(50 + index).padStart(12, "0");
  return {
    schemaVersion: "alert-event-v1",
    id: `00000000-0000-4000-8000-${suffix}`,
    ruleId: SCREEN_RULE_ID,
    ruleRevision: 1,
    ruleKind: "screener",
    eventType: "triggered",
    subjectKey: `${"d".repeat(64)}:bar:1752739200000`,
    transitionKey: index.toString(16).padStart(64, "0"),
    occurredAt: "2026-07-17T08:04:00.000Z",
    summary: "Screen match set changed.",
    researchOnly: true,
    executionPermission: false
  };
}

function screenerOutboxItem(alertEventId: string): NotificationOutboxItemV1 {
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
      alertEventId,
      ruleId: SCREEN_RULE_ID,
      ruleRevision: 1,
      severity: "warning",
      title: "Screen match changed: Momentum screen",
      body: "Entered: SOLUSDT. Matched 3 symbols.",
      createdAt: "2026-07-17T08:04:00.000Z",
      researchOnly: true,
      executionPermission: false
    },
    researchOnly: true,
    executionPermission: false
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
