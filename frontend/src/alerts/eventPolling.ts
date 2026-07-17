import type { AlertEventV1 } from "@saltanatbotv2/contracts";
import { listAlertEvents, type AlertEventList } from "./client";
import type { AlertEventWatermark } from "./eventWatermark";

export const ALERT_EVENT_PAGE_LIMIT = 200;
const ALERT_EVENT_MAX_PAGES = 20;

export async function drainAlertEventPages(ownerUserId: string, first: AlertEventList, signal: AbortSignal, since?: string): Promise<AlertEventList> {
  const events = first.events.slice();
  const ids = new Set(events.map(({ id }) => id));
  let page = first;
  let cursor = first.nextCursor;
  let generatedAt = first.generatedAt;
  for (let index = 1; page.hasMore === true; index += 1) {
    if (index >= ALERT_EVENT_MAX_PAGES) throw new Error("Alert event pagination exceeded the safe page budget.");
    if (!cursor) throw new Error("Alert event pagination did not provide a continuation cursor.");
    const previousCursor = cursor;
    page = await listAlertEvents(ownerUserId, { limit: ALERT_EVENT_PAGE_LIMIT, cursor, ...(since ? { since } : {}) }, signal);
    if (page.generatedAt) generatedAt = page.generatedAt;
    for (const event of page.events) {
      if (ids.has(event.id)) continue;
      ids.add(event.id);
      events.push(event);
    }
    cursor = page.nextCursor ?? cursor;
    if (page.hasMore && cursor === previousCursor) throw new Error("Alert event pagination cursor did not advance.");
  }
  return {
    events,
    ...(cursor ? { nextCursor: cursor } : {}),
    hasMore: false,
    ...(generatedAt ? { generatedAt } : {}),
    researchOnly: true,
    executionPermission: false
  };
}

export function mergeAlertEventHistory(current: AlertEventV1[], incoming: AlertEventV1[]): AlertEventV1[] {
  const events = new Map(current.map((event) => [event.id, event]));
  for (const event of incoming) events.set(event.id, event);
  return [...events.values()]
    .sort((left, right) => compareAlertEventsAscending(right, left))
    .slice(0, 200);
}

export function compareAlertEventsAscending(left: AlertEventV1, right: AlertEventV1): number {
  return Date.parse(left.occurredAt) - Date.parse(right.occurredAt) || left.id.localeCompare(right.id);
}

/** Forward-cursor rows are new by owner sequence even when producer timestamps move backwards. */
export function alertEventsToPublish(events: AlertEventV1[], watermark: AlertEventWatermark | undefined, legacyUnseen: AlertEventV1[], forwardCursorResponse = true): AlertEventV1[] {
  return forwardCursorResponse && watermark?.cursor ? events.slice().sort(compareAlertEventsAscending) : legacyUnseen;
}
