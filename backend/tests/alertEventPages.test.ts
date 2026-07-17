import { describe, expect, it } from "vitest";
import {
  AlertEventCursorAheadError,
  listAlertEventPage,
} from "../src/alerts/eventPages.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const RULE = "22222222-2222-4222-8222-222222222222";
const AT = new Date("2026-07-16T09:00:00.000Z");
const SINCE = "2026-07-16T08:30:00.000Z";

describe("alert event pages", () => {
  it("returns a bounded retained-stream origin at the captured owner boundary", async () => {
    const queries: { text: string; values?: unknown[] }[] = [];
    const pool = {
      async query(text: string, values?: unknown[]) {
        queries.push({ text, values });
        if (queries.length === 1) {
          return {
            rows: [{ owner_sequence: "12", generated_at: AT }],
          };
        }
        return { rows: [eventRow("12")] };
      },
    };

    await expect(
      listAlertEventPage(pool as never, {
        ownerUserId: OWNER,
        ruleId: RULE,
        notBefore: SINCE,
        limit: 200,
      }),
    ).resolves.toMatchObject({
      events: [{ id: "33333333-3333-4333-8333-000000000012" }],
      nextOwnerSequence: "12",
      hasMore: false,
      generatedAt: AT.toISOString(),
    });
    expect(queries[1]?.text).toContain("ORDER BY event.owner_sequence ASC");
    expect(queries[1]?.text).toContain(
      "event.occurred_at >= $3::timestamptz",
    );
    expect(queries[1]?.values).toEqual([OWNER, RULE, SINCE, "12", 201]);
  });

  it("combines an event-time floor with a cursor while advancing by owner sequence", async () => {
    const queries: { text: string; values?: unknown[] }[] = [];
    const pool = {
      async query(text: string, values?: unknown[]) {
        queries.push({ text, values });
        if (text.includes("alert_event_sequences")) {
          return {
            rows: [{ owner_sequence: "99", generated_at: AT }],
          };
        }
        return {
          rows: [eventRow("51"), eventRow("52"), eventRow("53")],
        };
      },
    };

    await expect(
      listAlertEventPage(pool as never, {
        ownerUserId: OWNER,
        afterOwnerSequence: "50",
        notBefore: SINCE,
        limit: 2,
      }),
    ).resolves.toMatchObject({
      events: [{}, {}],
      nextOwnerSequence: "52",
      hasMore: true,
    });
    expect(queries[1]?.text).toContain(
      "event.occurred_at >= $2::timestamptz",
    );
    expect(queries[1]?.text).toContain("event.owner_sequence > $3::bigint");
    expect(queries[1]?.values).toEqual([OWNER, SINCE, "50", "99", 3]);
  });

  it("advances an empty filtered page to the captured boundary", async () => {
    const pool = {
      async query(text: string) {
        return text.includes("alert_event_sequences")
          ? { rows: [{ owner_sequence: "99", generated_at: AT }] }
          : { rows: [] };
      },
    };

    await expect(
      listAlertEventPage(pool as never, {
        ownerUserId: OWNER,
        ruleId: RULE,
        afterOwnerSequence: "50",
        limit: 10,
      }),
    ).resolves.toMatchObject({
      events: [],
      nextOwnerSequence: "99",
      hasMore: false,
    });
  });

  it("rejects a cursor ahead of a restored owner stream", async () => {
    const pool = {
      async query() {
        return { rows: [{ owner_sequence: "49", generated_at: AT }] };
      },
    };
    await expect(
      listAlertEventPage(pool as never, {
        ownerUserId: OWNER,
        afterOwnerSequence: "50",
        limit: 10,
      }),
    ).rejects.toBeInstanceOf(AlertEventCursorAheadError);
  });

  it.each([
    "2026-07-16T09:00:00Z",
    "2026-07-16T09:00:00.000+00:00",
    "2026-02-30T09:00:00.000Z",
    "2026-07-16t09:00:00.000z",
    "0000-01-01T00:00:00.000Z",
  ])("rejects non-canonical event-time floor %s", async (notBefore) => {
    let queried = false;
    const pool = {
      async query() {
        queried = true;
        return { rows: [] };
      },
    };
    await expect(
      listAlertEventPage(pool as never, {
        ownerUserId: OWNER,
        notBefore,
        limit: 10,
      }),
    ).rejects.toThrow("Alert event not-before timestamp is invalid.");
    expect(queried).toBe(false);
  });
});

function eventRow(ownerSequence: string) {
  return {
    id: `33333333-3333-4333-8333-${ownerSequence.padStart(12, "0")}`,
    alert_rule_id: RULE,
    rule_revision: "1",
    rule_kind: "price-threshold",
    state_key: "market:binance:spot:last:BTCUSDT:1m",
    idempotency_key: "a".repeat(64),
    event_type: "triggered",
    to_state: "eligible",
    observation_id: null,
    observation_hash: null,
    evidence: { summary: "BTCUSDT threshold crossed." },
    occurred_at: AT,
    owner_sequence: ownerSequence,
  };
}
