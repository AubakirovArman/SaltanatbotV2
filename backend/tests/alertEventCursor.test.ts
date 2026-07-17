import { describe, expect, it } from "vitest";
import {
  AlertEventCursorError,
  decodeAlertEventCursor,
  encodeAlertEventCursor,
} from "../src/alerts/eventCursor.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER_OWNER = "22222222-2222-4222-8222-222222222222";

describe("alert event cursor", () => {
  it("round-trips empty, ordinary and maximum PostgreSQL bigint boundaries", () => {
    for (const sequence of ["0", "51", "9223372036854775807"]) {
      const cursor = encodeAlertEventCursor(OWNER, sequence);
      expect(decodeAlertEventCursor(OWNER, cursor)).toEqual({
        ownerSequence: sequence,
      });
      expect(cursor).toBe(encodeAlertEventCursor(OWNER.toUpperCase(), sequence));
    }
  });

  it("rejects cross-owner cursor reuse", () => {
    const cursor = encodeAlertEventCursor(OWNER, 7);
    expect(() => decodeAlertEventCursor(OTHER_OWNER, cursor)).toThrow(
      /another owner/,
    );
  });

  it.each([
    "",
    "not+base64",
    `${encodeAlertEventCursor(OWNER, 1)}=`,
    Buffer.from("not json").toString("base64url"),
    Buffer.from(JSON.stringify(["alert-event-cursor-v1", "0".repeat(64)]))
      .toString("base64url"),
    Buffer.from(
      JSON.stringify([
        "alert-event-cursor-v1",
        "0".repeat(64),
        "01",
      ]),
    ).toString("base64url"),
    Buffer.from(
      JSON.stringify([
        "alert-event-cursor-v1",
        "0".repeat(64),
        "9223372036854775808",
      ]),
    ).toString("base64url"),
  ])("rejects malformed cursor %s", (cursor) => {
    expect(() => decodeAlertEventCursor(OWNER, cursor)).toThrow(
      AlertEventCursorError,
    );
  });

  it("rejects unsafe numeric sequence input instead of rounding it", () => {
    expect(() =>
      encodeAlertEventCursor(OWNER, Number.MAX_SAFE_INTEGER + 1),
    ).toThrow(/sequence/);
  });
});
