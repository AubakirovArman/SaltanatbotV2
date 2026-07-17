// @vitest-environment jsdom

import type { AlertEventV1 } from "@saltanatbotv2/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { advanceAlertEventWatermark, estimateServerSessionStart, estimateServerSessionStartFromElapsed, legacyEventWindowHasOverlap, loadAlertEventWatermark, storeAlertEventWatermark, type AlertEventWatermark } from "../src/alerts/eventWatermark";
import { alertEventsToPublish } from "../src/alerts/eventPolling";
import { prepareLocalSnapshot } from "../src/alerts/localSnapshot";
import { mergePriceAlertSnapshots, type PriceAlert } from "../src/market/alerts";

const OWNER = "00000000-0000-4000-8000-000000000031";

beforeEach(() => localStorage.clear());

describe("adversarial alert state fences", () => {
  it("uses server time to baseline old history while retaining events after page mount", () => {
    const floor = estimateServerSessionStart("2026-07-17T08:01:00.000Z", Date.parse("2026-07-17T08:00:00.000Z"), Date.parse("2026-07-17T08:01:00.000Z"));
    const old = event(1, "2026-07-17T07:59:59.000Z");
    const fresh = event(2, "2026-07-17T08:00:30.000Z");
    const advanced = advanceAlertEventWatermark([fresh, old], undefined, floor, "cursor_1");

    expect(floor).toBe("2026-07-17T08:00:00.000Z");
    expect(estimateServerSessionStartFromElapsed("2026-07-17T08:01:00.000Z", 60_000)).toBe(floor);
    expect(advanced.unseen.map(({ id }) => id)).toEqual([fresh.id]);
    expect(advanced.watermark.cursor).toBe("cursor_1");
  });

  it("publishes every forward-cursor row even when occurredAt moves backwards", () => {
    const watermark: AlertEventWatermark = {
      occurredAt: "2026-07-17T08:10:00.000Z",
      idsAtOccurredAt: [event(1, "2026-07-17T08:10:00.000Z").id],
      cursor: "cursor_1"
    };
    const nonMonotonic = event(2, "2026-07-17T08:09:00.000Z");
    const timestampFiltered = advanceAlertEventWatermark([nonMonotonic], watermark, watermark.occurredAt, "cursor_2");

    expect(timestampFiltered.unseen).toEqual([]);
    expect(alertEventsToPublish([nonMonotonic], watermark, timestampFiltered.unseen)).toEqual([nonMonotonic]);
    expect(alertEventsToPublish([nonMonotonic], watermark, timestampFiltered.unseen, false)).toEqual([]);
    expect(timestampFiltered.watermark.cursor).toBe("cursor_2");
  });

  it("detects a saturated legacy window that does not overlap its durable floor", () => {
    const events = Array.from({ length: 200 }, (_, index) => event(index + 1, `2026-07-17T08:01:${String(index % 60).padStart(2, "0")}.000Z`));
    expect(legacyEventWindowHasOverlap(events, 200, undefined, "2026-07-17T08:00:00.000Z")).toBe(false);
  });

  it("persists an owner-scoped opaque event watermark", () => {
    const watermark: AlertEventWatermark = { occurredAt: "2026-07-17T08:00:00.000Z", idsAtOccurredAt: [event(1, "2026-07-17T08:00:00.000Z").id], cursor: "cursor_1" };
    expect(storeAlertEventWatermark(OWNER, watermark)).toBe(true);
    expect(loadAlertEventWatermark(OWNER)).toEqual(watermark);
    expect(loadAlertEventWatermark("00000000-0000-4000-8000-000000000032")).toBeUndefined();
  });

  it("persists a crash-safe cursor rebase marker only without a cursor", () => {
    const pending: AlertEventWatermark = { occurredAt: "2026-07-17T08:00:00.000Z", idsAtOccurredAt: [], baselinePending: true };
    expect(storeAlertEventWatermark(OWNER, pending)).toBe(true);
    expect(loadAlertEventWatermark(OWNER)).toEqual(pending);
    expect(storeAlertEventWatermark(OWNER, { ...pending, cursor: "cursor_1" })).toBe(false);
    expect(loadAlertEventWatermark(OWNER)).toEqual(pending);
  });

  it("rebases a stale tab mutation without clearing a newer suspended checkpoint", () => {
    const old = local({ localRevision: 1 });
    const suspended = local({ localRevision: 2, suspended: true, serverRuleId: "00000000-0000-4000-8000-000000000041", serverRevision: 1 });
    const staleTrigger = local({ localRevision: 1, triggered: true });
    const prepared = prepareLocalSnapshot([old], [staleTrigger], [suspended], { current: 2 });

    expect(prepared).toEqual([expect.objectContaining({ suspended: true, triggered: true })]);
    expect(prepared[0]?.localRevision).toBeGreaterThan(2);
  });

  it("never lets an equal-clock stale row revive a tombstone", () => {
    const tombstone = local({ localRevision: 7, deleted: true, suspended: true });
    const stale = local({ localRevision: 7, deleted: false, suspended: false });
    expect(mergePriceAlertSnapshots([tombstone], [stale])[0]).toMatchObject({ deleted: true, suspended: true });
  });
});

function local(overrides: Partial<PriceAlert> = {}): PriceAlert {
  return {
    id: "local-alert",
    symbol: "BTCUSDT",
    price: 65_000,
    direction: "above",
    timeframe: "1m",
    createdAt: 1,
    triggered: false,
    exchange: "binance",
    marketType: "spot",
    priceType: "last",
    source: "browser",
    ...overrides
  };
}

function event(index: number, occurredAt: string): AlertEventV1 {
  const suffix = String(index).padStart(12, "0");
  return {
    schemaVersion: "alert-event-v1",
    id: `00000000-0000-4000-8000-${suffix}`,
    ruleId: "00000000-0000-4000-8000-000000000041",
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
