import { createHash, timingSafeEqual } from "node:crypto";

const ALERT_EVENT_CURSOR_VERSION = "alert-event-cursor-v1";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OWNER_FINGERPRINT = /^[0-9a-f]{64}$/;
const BIGINT = /^(?:0|[1-9][0-9]{0,18})$/;
const MAX_POSTGRES_BIGINT = 9_223_372_036_854_775_807n;
const MAX_CURSOR_LENGTH = 256;

export interface AlertEventCursor {
  /** Transactional, per-owner event sequence. Zero is the empty-stream boundary. */
  ownerSequence: string;
}

export class AlertEventCursorError extends Error {}

/**
 * Cursor payloads are an opaque API format, not an authorization mechanism.
 * The owner fingerprint prevents accidental cross-tenant reuse while every
 * database read still applies its mandatory owner predicate.
 */
export function encodeAlertEventCursor(
  ownerUserId: string,
  ownerSequence: string | number | bigint,
): string {
  const owner = validOwner(ownerUserId);
  const sequence = validSequence(ownerSequence);
  return Buffer.from(
    JSON.stringify([
      ALERT_EVENT_CURSOR_VERSION,
      ownerFingerprint(owner),
      sequence,
    ]),
    "utf8",
  ).toString("base64url");
}

export function decodeAlertEventCursor(
  ownerUserId: string,
  cursor: unknown,
): AlertEventCursor {
  const owner = validOwner(ownerUserId);
  if (
    typeof cursor !== "string" ||
    cursor.length < 1 ||
    cursor.length > MAX_CURSOR_LENGTH ||
    !/^[A-Za-z0-9_-]+$/.test(cursor)
  ) {
    throw new AlertEventCursorError("Alert event cursor is invalid.");
  }

  let decoded: Buffer;
  try {
    decoded = Buffer.from(cursor, "base64url");
  } catch {
    throw new AlertEventCursorError("Alert event cursor is invalid.");
  }
  if (
    decoded.length === 0 ||
    decoded.toString("base64url") !== cursor ||
    decoded.length > MAX_CURSOR_LENGTH
  ) {
    throw new AlertEventCursorError("Alert event cursor is invalid.");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(decoded.toString("utf8")) as unknown;
  } catch {
    throw new AlertEventCursorError("Alert event cursor is invalid.");
  }
  if (
    !Array.isArray(payload) ||
    payload.length !== 3 ||
    payload[0] !== ALERT_EVENT_CURSOR_VERSION ||
    typeof payload[1] !== "string" ||
    !OWNER_FINGERPRINT.test(payload[1])
  ) {
    throw new AlertEventCursorError("Alert event cursor is invalid.");
  }
  const expectedOwner = Buffer.from(ownerFingerprint(owner), "hex");
  const cursorOwner = Buffer.from(payload[1], "hex");
  if (
    expectedOwner.length !== cursorOwner.length ||
    !timingSafeEqual(expectedOwner, cursorOwner)
  ) {
    throw new AlertEventCursorError(
      "Alert event cursor belongs to another owner.",
    );
  }
  return { ownerSequence: validSequence(payload[2]) };
}

function validOwner(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new AlertEventCursorError("Alert event cursor owner is invalid.");
  }
  return value.toLowerCase();
}

function validSequence(value: unknown): string {
  const result =
    typeof value === "bigint"
      ? value.toString()
      : typeof value === "number" && Number.isSafeInteger(value)
        ? String(value)
        : value;
  if (
    typeof result !== "string" ||
    !BIGINT.test(result) ||
    BigInt(result) > MAX_POSTGRES_BIGINT
  ) {
    throw new AlertEventCursorError("Alert event cursor sequence is invalid.");
  }
  return result;
}

function ownerFingerprint(ownerUserId: string): string {
  return createHash("sha256")
    .update(ALERT_EVENT_CURSOR_VERSION)
    .update("\0")
    .update(ownerUserId)
    .digest("hex");
}
