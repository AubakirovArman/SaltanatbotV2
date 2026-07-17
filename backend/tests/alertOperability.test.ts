import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { AlertOperabilityRepository } from "../src/alerts/operability.js";

describe("alert control-plane operability metrics", () => {
  it("reads one aggregate PostgreSQL snapshot without owner or payload data", async () => {
    const query = vi.fn(async () => ({
      rows: [
        {
          active_rules: "17",
          due_rules: "3",
          leased_rules: "2",
          archived_rules: "4",
          rules_with_errors: "1",
          oldest_due_age_ms: "1250",
          evaluations_last_minute: "53",
          triggers_last_minute: "2"
        }
      ]
    }));
    const repository = new AlertOperabilityRepository({ query } as unknown as Pool);

    await expect(repository.getMetrics()).resolves.toEqual({
      activeRules: 17,
      dueRules: 3,
      leasedRules: 2,
      archivedRules: 4,
      rulesWithErrors: 1,
      oldestDueAgeMs: 1_250,
      evaluationsLastMinute: 53,
      triggersLastMinute: 2
    });
    expect(query).toHaveBeenCalledOnce();
    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("clock_timestamp()");
    expect(sql).toContain("interval '1 minute'");
    expect(sql).not.toMatch(/payload|definition|owner_user_id|destination|secret/i);
  });

  it.each(["-1", "1.5", "not-a-count", String(Number.MAX_SAFE_INTEGER + 1)])("fails closed on invalid metric %s", async (activeRules) => {
    const pool = {
      query: vi.fn(async () => ({
        rows: [
          {
            active_rules: activeRules,
            due_rules: "0",
            leased_rules: "0",
            archived_rules: "0",
            rules_with_errors: "0",
            oldest_due_age_ms: "0",
            evaluations_last_minute: "0",
            triggers_last_minute: "0"
          }
        ]
      }))
    } as unknown as Pool;
    await expect(new AlertOperabilityRepository(pool).getMetrics()).rejects.toThrow(/metric/);
  });
});
