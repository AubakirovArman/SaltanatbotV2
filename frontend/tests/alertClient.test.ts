// @vitest-environment jsdom

import type { AlertRuleListV1, AlertRuleRecordV1, PriceThresholdAlertDefinitionV1 } from "@saltanatbotv2/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ALERT_API_MAX_ERROR_MESSAGE_LENGTH, ALERT_API_MAX_RESPONSE_BYTES, ALERT_API_TIMEOUT_MS, AlertApiError, archiveAlertRule, createAlertRule, listAlertEvents, listAlertOutbox, listAlertRules, rearmAlertRule, updateAlertRule } from "../src/alerts/client";

const OWNER = "00000000-0000-4000-8000-000000000031";
const RULE_ID = "00000000-0000-4000-8000-000000000041";
const SIGNAL = new AbortController().signal;

beforeEach(() => {
  document.cookie = "sbv2_csrf=alert-csrf; path=/";
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.cookie = "sbv2_csrf=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
});

describe("owner-scoped alert API client", () => {
  it("lists strict shared records with no-store owner-bound transport", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(list()));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listAlertRules(OWNER, SIGNAL)).resolves.toEqual(list());

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/alerts");
    expect(init).toMatchObject({
      method: "GET",
      credentials: "same-origin",
      cache: "no-store"
    });
    expect(init.signal).not.toBe(SIGNAL);
    expect(init.signal?.aborted).toBe(false);
    const headers = new Headers(init.headers);
    expect(headers.get("Accept")).toBe("application/json");
    expect(headers.get("X-SBV2-Expected-User")).toBe(OWNER);
    expect(headers.get("X-CSRF-Token")).toBeNull();
  });

  it("creates with an exact envelope, CSRF token, signal and shared record parsing", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ rule: record() }, 201));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createAlertRule(OWNER, { clientId: "browser.alert-01", definition }, SIGNAL)).resolves.toEqual(record());

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/alerts");
    expect(init.method).toBe("POST");
    expect(init.signal).not.toBe(SIGNAL);
    expect(init.signal?.aborted).toBe(false);
    expect(JSON.parse(String(init.body))).toEqual({
      clientId: "browser.alert-01",
      definition
    });
    const headers = new Headers(init.headers);
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("X-SBV2-Expected-User")).toBe(OWNER);
    expect(headers.get("X-CSRF-Token")).toBe("alert-csrf");
  });

  it("uses exact update, archive and rearm routes with optimistic revisions", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ rule: record({ revision: 2 }) }))
      .mockResolvedValueOnce(json({ rule: record({ revision: 3, lifecycleState: "archived" }) }))
      .mockResolvedValueOnce(json({ rule: record({ revision: 4 }) }));
    vi.stubGlobal("fetch", fetchMock);

    await updateAlertRule(OWNER, RULE_ID, { expectedRevision: 1, definition: { ...definition, threshold: "66000" } }, SIGNAL);
    await archiveAlertRule(OWNER, RULE_ID, 2, SIGNAL);
    await rearmAlertRule(OWNER, RULE_ID, 3, SIGNAL);

    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([`/api/alerts/${RULE_ID}`, `/api/alerts/${RULE_ID}/archive`, `/api/alerts/${RULE_ID}/rearm`]);
    expect(fetchMock.mock.calls.map(([, init]) => init.method)).toEqual(["PUT", "POST", "POST"]);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      expectedRevision: 1,
      definition: { ...definition, threshold: "66000" }
    });
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      expectedRevision: 2
    });
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toEqual({
      expectedRevision: 3
    });
    for (const [, init] of fetchMock.mock.calls) {
      expect(init.signal).not.toBe(SIGNAL);
      expect(init.signal?.aborted).toBe(false);
      expect(new Headers(init.headers).get("X-CSRF-Token")).toBe("alert-csrf");
    }
  });

  it("reads bounded event and in-app outbox history through shared parsers", async () => {
    const event = alertEvent();
    const page = eventPage([event], "cursor_2");
    const item = outboxItem();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(page))
      .mockResolvedValueOnce(json({ items: [item], researchOnly: true, executionPermission: false }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listAlertEvents(OWNER, { ruleId: RULE_ID, limit: 25, cursor: "cursor_1", since: "2026-07-17T08:03:00.000Z" }, SIGNAL)).resolves.toEqual(page);
    await expect(listAlertOutbox(OWNER, 25, SIGNAL)).resolves.toEqual({ items: [item], researchOnly: true, executionPermission: false });

    expect(fetchMock.mock.calls.map(([path]) => path)).toEqual([
      `/api/alerts/events?ruleId=${RULE_ID}&cursor=cursor_1&since=2026-07-17T08%3A03%3A00.000Z&limit=25`,
      "/api/alerts/outbox?limit=25"
    ]);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init).toMatchObject({ method: "GET", credentials: "same-origin", cache: "no-store" });
      expect(init.signal).not.toBe(SIGNAL);
      expect(init.signal?.aborted).toBe(false);
      expect(new Headers(init.headers).get("X-SBV2-Expected-User")).toBe(OWNER);
      expect(new Headers(init.headers).get("X-CSRF-Token")).toBeNull();
    }
  });

  it("fails closed when a success envelope bypasses either shared parser", async () => {
    const malformedList = { ...list(), executionPermission: true };
    const malformedRecord = { rule: { ...record(), ownerUserId: OWNER } };
    const { generatedAt: _missingGeneratedAt, ...malformedEventPage } = eventPage([alertEvent()], "cursor_2");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json(malformedList)).mockResolvedValueOnce(json(malformedRecord)).mockResolvedValueOnce(json(malformedEventPage)));

    await expect(listAlertRules(OWNER)).rejects.toMatchObject({
      status: 200,
      code: "invalid_response"
    });
    await expect(createAlertRule(OWNER, { clientId: "browser.alert-01", definition })).rejects.toMatchObject({ status: 200, code: "invalid_response" });
    await expect(listAlertEvents(OWNER)).rejects.toMatchObject({ status: 200, code: "invalid_response" });
  });

  it("bounds streamed JSON before parsing and never reflects the oversized body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ padding: "x".repeat(ALERT_API_MAX_RESPONSE_BYTES + 1) })));

    const error = await listAlertRules(OWNER).catch((cause) => cause);
    expect(error).toBeInstanceOf(AlertApiError);
    expect(error).toMatchObject({
      status: 200,
      code: "alert_response_too_large"
    });
    expect(error.message).not.toContain("xxxx");
  });

  it("normalizes and bounds server error envelopes deterministically", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        json(
          {
            code: "alert_revision_conflict",
            error: `  reload\n${"x".repeat(2_000)}  `
          },
          409
        )
      )
    );

    const error = await rearmAlertRule(OWNER, RULE_ID, 1).catch((cause) => cause);
    expect(error).toBeInstanceOf(AlertApiError);
    expect(error).toMatchObject({ status: 409, code: "alert_revision_conflict" });
    expect(error.message.startsWith("reload ")).toBe(true);
    expect(error.message.length).toBe(ALERT_API_MAX_ERROR_MESSAGE_LENGTH);

    const constructed = new AlertApiError(999, "INVALID CODE", "\n\t");
    expect(constructed).toMatchObject({
      status: 0,
      code: "alert_error",
      message: "Alert request failed."
    });
  });

  it("rejects malformed ownership and revisions locally without issuing a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(listAlertRules("other-user")).rejects.toMatchObject({
      status: 0,
      code: "invalid_request"
    });
    expect(() => archiveAlertRule(OWNER, RULE_ID, 0)).toThrowError(expect.objectContaining({ status: 0, code: "invalid_request" }));
    expect(() => listAlertEvents(OWNER, { since: "2026-07-17T08:03:00Z" })).toThrowError(expect.objectContaining({ status: 0, code: "invalid_request" }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("aborts a stalled request at the bounded client timeout", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn((_path: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    })));

    const request = expect(listAlertRules(OWNER)).rejects.toMatchObject({
      status: 0,
      code: "request_timeout"
    });
    await vi.advanceTimersByTimeAsync(ALERT_API_TIMEOUT_MS);
    await request;
  });
});

const definition: PriceThresholdAlertDefinitionV1 = {
  schemaVersion: "alert-rule-v1",
  kind: "price-threshold",
  name: "BTC threshold",
  enabled: true,
  cooldownSeconds: 60,
  deliveryChannels: ["in-app"],
  exchange: "binance",
  marketType: "spot",
  priceType: "last",
  symbol: "BTCUSDT",
  timeframe: "1m",
  direction: "above",
  threshold: "65000.25",
  crossing: "inclusive",
  repeat: "once-until-rearmed",
  researchOnly: true,
  executionPermission: false
};

function record(overrides: Partial<AlertRuleRecordV1> = {}): AlertRuleRecordV1 {
  return {
    schemaVersion: "alert-rule-record-v1",
    id: RULE_ID,
    clientId: "browser.alert-01",
    revision: 1,
    definition,
    lifecycleState: "armed",
    createdAt: "2026-07-17T08:00:00.000Z",
    updatedAt: "2026-07-17T08:01:00.000Z",
    researchOnly: true,
    executionPermission: false,
    ...overrides
  };
}

function list(): AlertRuleListV1 {
  return {
    schemaVersion: "alert-rule-list-v1",
    rules: [record()],
    generatedAt: "2026-07-17T08:02:00.000Z",
    researchOnly: true,
    executionPermission: false
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function alertEvent() {
  return {
    schemaVersion: "alert-event-v1" as const,
    id: "00000000-0000-4000-8000-000000000051",
    ruleId: RULE_ID,
    ruleRevision: 1,
    ruleKind: "price-threshold" as const,
    eventType: "triggered" as const,
    subjectKey: "binance:spot:last:BTCUSDT:1m",
    transitionKey: "a".repeat(64),
    occurredAt: "2026-07-17T08:02:00.000Z",
    summary: "Price alert triggered.",
    researchOnly: true as const,
    executionPermission: false as const
  };
}

function eventPage(events: ReturnType<typeof alertEvent>[], nextCursor: string) {
  return {
    schemaVersion: "alert-event-page-v1" as const,
    events,
    nextCursor,
    hasMore: false,
    generatedAt: "2026-07-17T08:03:00.000Z",
    researchOnly: true as const,
    executionPermission: false as const
  };
}

function outboxItem() {
  return {
    schemaVersion: "notification-outbox-v1" as const,
    id: "00000000-0000-4000-8000-000000000061",
    channel: "in-app" as const,
    status: "delivered" as const,
    attempts: 1,
    maxAttempts: 5,
    queuedAt: "2026-07-17T08:02:00.000Z",
    deliveredAt: "2026-07-17T08:02:01.000Z",
    envelope: {
      schemaVersion: "notification-envelope-v1" as const,
      deduplicationId: "a".repeat(64),
      alertEventId: "00000000-0000-4000-8000-000000000051",
      ruleId: RULE_ID,
      ruleRevision: 1,
      severity: "warning" as const,
      title: "BTCUSDT price alert",
      body: "BTCUSDT crossed 65000.",
      createdAt: "2026-07-17T08:02:00.000Z",
      researchOnly: true as const,
      executionPermission: false as const
    },
    researchOnly: true as const,
    executionPermission: false as const
  };
}
