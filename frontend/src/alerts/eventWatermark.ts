import type { AlertEventV1 } from "@saltanatbotv2/contracts";
import { readTenantLocalItem, tenantLocalStorageKey, writeTenantLocalItem } from "../app/tenantLocalStorage";

const KEY = "sbv2:alert-event-watermark:v1";
const CURSOR = /^[A-Za-z0-9_-]{1,256}$/;

export interface AlertEventWatermark {
  occurredAt: string;
  idsAtOccurredAt: string[];
  cursor?: string;
  /** Durable crash marker while a restored-database cursor is being rebased. */
  baselinePending?: true;
}

export interface AdvanceAlertEventWatermarkResult {
  unseen: AlertEventV1[];
  watermark: AlertEventWatermark;
}

export function estimateServerSessionStart(generatedAt: string, clientSessionStartedAt: number, clientReceivedAt: number): string {
  return estimateServerSessionStartFromElapsed(generatedAt, Math.max(0, clientReceivedAt - clientSessionStartedAt));
}

export function estimateServerSessionStartFromElapsed(generatedAt: string, elapsedMs: number): string {
  const serverNow = Date.parse(generatedAt);
  if (!Number.isFinite(serverNow)) throw new Error("Alert service generatedAt is invalid.");
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) throw new Error("Alert session elapsed time is invalid.");
  return new Date(serverNow - elapsedMs).toISOString();
}

export function advanceAlertEventWatermark(
  events: AlertEventV1[],
  current: AlertEventWatermark | undefined,
  initialFloor: string,
  nextCursor?: string
): AdvanceAlertEventWatermarkResult {
  const floorTime = Date.parse(current?.occurredAt ?? initialFloor);
  if (!Number.isFinite(floorTime)) throw new Error("Alert event watermark is invalid.");
  const floorIds = new Set(current?.idsAtOccurredAt ?? []);
  const ordered = events.slice().sort(compareEventsAscending);
  const unseen = ordered.filter((event) => {
    const eventTime = Date.parse(event.occurredAt);
    return eventTime > floorTime || (eventTime === floorTime && !floorIds.has(event.id));
  });

  let occurredAt = current?.occurredAt ?? initialFloor;
  let idsAtOccurredAt = [...floorIds];
  for (const event of ordered) {
    const eventTime = Date.parse(event.occurredAt);
    const currentTime = Date.parse(occurredAt);
    if (eventTime > currentTime) {
      occurredAt = event.occurredAt;
      idsAtOccurredAt = [event.id];
    } else if (eventTime === currentTime && !idsAtOccurredAt.includes(event.id)) {
      idsAtOccurredAt.push(event.id);
    }
  }
  idsAtOccurredAt = idsAtOccurredAt.slice(-200);
  const cursor = nextCursor ?? current?.cursor;
  return {
    unseen,
    watermark: {
      occurredAt,
      idsAtOccurredAt,
      ...(cursor ? { cursor } : {})
    }
  };
}

/** A saturated legacy recent-window response is safe only when it overlaps the durable floor. */
export function legacyEventWindowHasOverlap(events: AlertEventV1[], limit: number, current: AlertEventWatermark | undefined, initialFloor: string): boolean {
  if (events.length < limit) return true;
  const floor = Date.parse(current?.occurredAt ?? initialFloor);
  const floorIds = new Set(current?.idsAtOccurredAt ?? []);
  const oldest = events.reduce((candidate, event) => compareEventsAscending(event, candidate) < 0 ? event : candidate, events[0]);
  const oldestTime = Date.parse(oldest.occurredAt);
  if (oldestTime < floor) return true;
  if (oldestTime > floor) return false;
  return events.some((event) => event.occurredAt === (current?.occurredAt ?? initialFloor) && floorIds.has(event.id));
}

export function loadAlertEventWatermark(ownerUserId: string): AlertEventWatermark | undefined {
  try {
    const raw = readTenantLocalItem(window.localStorage, KEY, ownerUserId);
    if (!raw) return undefined;
    return parseAlertEventWatermark(JSON.parse(raw) as unknown);
  } catch {
    return undefined;
  }
}

export function alertEventWatermarkStorageKey(ownerUserId: string): string | undefined {
  return tenantLocalStorageKey(KEY, ownerUserId);
}

export function storeAlertEventWatermark(ownerUserId: string, watermark: AlertEventWatermark): boolean {
  try {
    const parsed = parseAlertEventWatermark(watermark);
    const serialized = JSON.stringify(parsed);
    writeTenantLocalItem(window.localStorage, KEY, serialized, ownerUserId);
    return readTenantLocalItem(window.localStorage, KEY, ownerUserId) === serialized;
  } catch {
    return false;
  }
}

export function parseAlertEventWatermark(value: unknown): AlertEventWatermark {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Alert event watermark must be an object.");
  const input = value as Record<string, unknown>;
  const allowed = new Set(["occurredAt", "idsAtOccurredAt", "cursor", "baselinePending"]);
  if (Object.keys(input).some((key) => !allowed.has(key))) throw new Error("Alert event watermark has unknown fields.");
  if (typeof input.occurredAt !== "string" || !canonicalTimestamp(input.occurredAt)) throw new Error("Alert event watermark timestamp is invalid.");
  if (!Array.isArray(input.idsAtOccurredAt) || input.idsAtOccurredAt.length > 200 || input.idsAtOccurredAt.some((id) => typeof id !== "string" || !uuid(id))) {
    throw new Error("Alert event watermark identifiers are invalid.");
  }
  if (new Set(input.idsAtOccurredAt).size !== input.idsAtOccurredAt.length) throw new Error("Alert event watermark identifiers contain duplicates.");
  if (input.cursor !== undefined && (typeof input.cursor !== "string" || !CURSOR.test(input.cursor))) throw new Error("Alert event watermark cursor is invalid.");
  if (input.baselinePending !== undefined && input.baselinePending !== true) throw new Error("Alert event watermark baseline marker is invalid.");
  if (input.cursor !== undefined && input.baselinePending === true) throw new Error("Alert event watermark cannot contain a cursor while a baseline is pending.");
  return {
    occurredAt: input.occurredAt,
    idsAtOccurredAt: input.idsAtOccurredAt as string[],
    ...(typeof input.cursor === "string" ? { cursor: input.cursor } : {}),
    ...(input.baselinePending === true ? { baselinePending: true as const } : {})
  };
}

function compareEventsAscending(left: AlertEventV1, right: AlertEventV1): number {
  return Date.parse(left.occurredAt) - Date.parse(right.occurredAt) || left.id.localeCompare(right.id);
}

function canonicalTimestamp(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function uuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
