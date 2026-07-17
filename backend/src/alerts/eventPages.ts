import type { AlertEventV1 } from "@saltanatbotv2/contracts";
import type { Pool } from "pg";
import {
  iso,
  mapAlertEvent,
  type AlertEventRow,
} from "./repositoryRows.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BIGINT = /^(?:0|[1-9][0-9]{0,18})$/;
const CANONICAL_UTC_MILLISECOND_ISO =
  /^(?!0000-)[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
const MAX_POSTGRES_BIGINT = 9_223_372_036_854_775_807n;
export const MAX_ALERT_EVENT_PAGE_SIZE = 200;

export interface ListAlertEventPageInput {
  ownerUserId: string;
  ruleId?: string;
  /** Omitted for the retained-stream origin; otherwise this is a forward watermark. */
  afterOwnerSequence?: string;
  /** Inclusive event-time floor used to bootstrap a recent retained window. */
  notBefore?: string;
  limit: number;
}

export interface AlertEventPageResult {
  events: AlertEventV1[];
  nextOwnerSequence: string;
  hasMore: boolean;
  generatedAt: string;
}

interface BoundaryRow {
  owner_sequence: string | null;
  generated_at: Date | string;
}

interface SequencedAlertEventRow extends AlertEventRow {
  owner_sequence: string;
}

export class AlertEventCursorAheadError extends Error {}

/**
 * Reads one owner stream against a transactional per-owner boundary. The
 * counter row is serialized by the event insert trigger, so an event cannot
 * commit behind an already visible boundary for the same owner.
 */
export async function listAlertEventPage(
  pool: Pick<Pool, "query">,
  input: ListAlertEventPageInput,
): Promise<AlertEventPageResult> {
  const ownerUserId = validUuid(input.ownerUserId, "alert event owner");
  const ruleId =
    input.ruleId === undefined
      ? undefined
      : validUuid(input.ruleId, "alert event rule");
  const limit = validLimit(input.limit);
  const after =
    input.afterOwnerSequence === undefined
      ? undefined
      : validSequence(input.afterOwnerSequence);
  const notBefore =
    input.notBefore === undefined
      ? undefined
      : parseAlertEventNotBefore(input.notBefore);

  const boundaryResult = await pool.query<BoundaryRow>(
    `SELECT
       (SELECT last_sequence::text
        FROM alert_event_sequences
        WHERE owner_user_id = $1) AS owner_sequence,
       clock_timestamp() AS generated_at`,
    [ownerUserId],
  );
  const boundaryRow = boundaryResult.rows[0];
  if (!boundaryRow) {
    throw new Error("Alert event stream boundary query returned no row.");
  }
  const boundary = validSequence(boundaryRow.owner_sequence ?? "0");
  if (after !== undefined && BigInt(after) > BigInt(boundary)) {
    throw new AlertEventCursorAheadError(
      "Alert event cursor is ahead of the durable owner stream.",
    );
  }

  const parameters: unknown[] = [ownerUserId];
  const ruleFilter =
    ruleId === undefined
      ? ""
      : ` AND event.alert_rule_id = $${parameters.push(ruleId)}`;
  const notBeforeFilter =
    notBefore === undefined
      ? ""
      : ` AND event.occurred_at >= $${parameters.push(notBefore)}::timestamptz`;
  let rows: SequencedAlertEventRow[];
  let hasMore = false;
  let nextOwnerSequence = boundary;
  if (after === undefined) {
    parameters.push(boundary, limit + 1);
    const result = await pool.query<SequencedAlertEventRow>(
      `${eventSelect()}
       WHERE event.owner_user_id = $1${ruleFilter}${notBeforeFilter}
         AND event.owner_sequence <= $${parameters.length - 1}::bigint
       ORDER BY event.owner_sequence ASC
       LIMIT $${parameters.length}`,
      parameters,
    );
    hasMore = result.rows.length > limit;
    rows = result.rows.slice(0, limit);
    if (hasMore) {
      nextOwnerSequence = validSequence(rows.at(-1)?.owner_sequence);
    }
  } else {
    parameters.push(after, boundary, limit + 1);
    const result = await pool.query<SequencedAlertEventRow>(
      `${eventSelect()}
       WHERE event.owner_user_id = $1${ruleFilter}${notBeforeFilter}
         AND event.owner_sequence > $${parameters.length - 2}::bigint
         AND event.owner_sequence <= $${parameters.length - 1}::bigint
       ORDER BY event.owner_sequence ASC
       LIMIT $${parameters.length}`,
      parameters,
    );
    hasMore = result.rows.length > limit;
    rows = result.rows.slice(0, limit);
    if (hasMore) {
      nextOwnerSequence = validSequence(rows.at(-1)?.owner_sequence);
    }
  }

  return {
    events: rows.map(mapAlertEvent),
    nextOwnerSequence,
    hasMore,
    generatedAt: iso(boundaryRow.generated_at),
  };
}

export function parseAlertEventNotBefore(value: unknown): string {
  if (
    typeof value !== "string" ||
    !CANONICAL_UTC_MILLISECOND_ISO.test(value)
  ) {
    throw new Error("Alert event not-before timestamp is invalid.");
  }
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime()) || timestamp.toISOString() !== value) {
    throw new Error("Alert event not-before timestamp is invalid.");
  }
  return value;
}

function eventSelect(): string {
  return `SELECT event.id, event.alert_rule_id, event.rule_revision,
      revision.rule_kind, event.state_key, event.idempotency_key,
      event.event_type, event.to_state, event.observation_id,
      event.observation_hash, event.evidence, event.occurred_at,
      event.owner_sequence::text AS owner_sequence
    FROM alert_rule_events event
    INNER JOIN alert_rule_revisions revision
      ON revision.owner_user_id = event.owner_user_id
     AND revision.alert_rule_id = event.alert_rule_id
     AND revision.revision = event.rule_revision`;
}

function validUuid(value: unknown, label: string): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function validLimit(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_ALERT_EVENT_PAGE_SIZE
  ) {
    throw new Error("Alert event page limit is invalid.");
  }
  return value;
}

function validSequence(value: unknown): string {
  if (
    typeof value !== "string" ||
    !BIGINT.test(value) ||
    BigInt(value) > MAX_POSTGRES_BIGINT
  ) {
    throw new Error("Alert event owner sequence is invalid.");
  }
  return value;
}
