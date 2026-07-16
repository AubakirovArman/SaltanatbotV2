import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import {
  COMPUTE_JOB_FULL_ARTIFACT_BYTES_PER_OWNER,
  COMPUTE_JOB_FULL_ARTIFACT_RETENTION_DAYS,
  COMPUTE_JOB_FULL_ARTIFACTS_PER_OWNER,
  COMPUTE_JOB_RETENTION_BATCH_LIMIT,
  COMPUTE_JOB_TOMBSTONE_RETENTION_DAYS,
  COMPUTE_JOB_TOMBSTONES_PER_OWNER,
  ComputeJobArtifactRetention
} from "../src/jobs/artifactRetention.js";

const OWNER_ID = "00000000-0000-4000-8000-000000000001";

interface Query {
  text: string;
  values: readonly unknown[];
}

function retentionPool(): { pool: Pool; queries: Query[] } {
  const queries: Query[] = [];
  const usage = [
    {
      terminal_artifact_count: "201",
      terminal_artifact_bytes: String(COMPUTE_JOB_FULL_ARTIFACT_BYTES_PER_OWNER + 10),
      tombstone_count: "1000"
    },
    {
      terminal_artifact_count: "200",
      terminal_artifact_bytes: String(COMPUTE_JOB_FULL_ARTIFACT_BYTES_PER_OWNER + 10),
      tombstone_count: "1001"
    },
    {
      terminal_artifact_count: "199",
      terminal_artifact_bytes: String(COMPUTE_JOB_FULL_ARTIFACT_BYTES_PER_OWNER - 1),
      tombstone_count: "1002"
    }
  ];
  let usageIndex = 0;
  const query = async (text: string, values: readonly unknown[] = []) => {
    queries.push({ text, values });
    if (text.includes("SELECT usage.owner_user_id")) return { rows: [{ owner_user_id: OWNER_ID }], rowCount: 1 };
    if (text.includes("pg_try_advisory_xact_lock")) return { rows: [{ locked: true }], rowCount: 1 };
    if (text.includes("FROM compute_job_retention_usage") && text.includes("FOR UPDATE")) {
      return { rows: [usage[Math.min(usageIndex++, usage.length - 1)]], rowCount: 1 };
    }
    if (text.includes("UPDATE compute_jobs job SET") && text.includes("completed_at < $3")) {
      return { rows: [], rowCount: 1 };
    }
    if (text.includes("UPDATE compute_jobs job SET") && text.includes("FROM candidates")) {
      return { rows: [], rowCount: 1 };
    }
    if (text.includes("DELETE FROM compute_jobs job") && text.includes("artifacts_pruned_at < $3")) {
      return { rows: [], rowCount: 1 };
    }
    if (text.includes("DELETE FROM compute_jobs job")) return { rows: [], rowCount: 2 };
    return { rows: [], rowCount: 0 };
  };
  const client = { query, release() {} };
  return {
    pool: { query, connect: async () => client } as unknown as Pool,
    queries
  };
}

describe("compute job artifact retention", () => {
  it("uses fixed bounded owner limits and the shared enqueue advisory lock", async () => {
    const database = retentionPool();
    const result = await new ComputeJobArtifactRetention(database.pool).enforce(
      new Date("2026-07-16T00:00:00.000Z"),
      500
    );

    expect(result.batchLimit).toBe(COMPUTE_JOB_RETENTION_BATCH_LIMIT);
    expect(result.ownersLocked).toBe(1);
    expect(result.artifactsCompacted).toBeGreaterThan(0);
    expect(result.tombstonesDeleted).toBeGreaterThan(0);
    expect(result.artifactsCompacted + result.tombstonesDeleted).toBeLessThanOrEqual(
      COMPUTE_JOB_RETENTION_BATCH_LIMIT
    );

    const candidateQuery = database.queries.find((query) => query.text.includes("SELECT usage.owner_user_id"));
    expect(candidateQuery?.values).toEqual([
      new Date("2026-06-16T00:00:00.000Z"),
      new Date("2026-04-17T00:00:00.000Z"),
      COMPUTE_JOB_FULL_ARTIFACTS_PER_OWNER,
      COMPUTE_JOB_FULL_ARTIFACT_BYTES_PER_OWNER,
      COMPUTE_JOB_TOMBSTONES_PER_OWNER
    ]);
    expect(database.queries.some((query) => query.text.includes("pg_try_advisory_xact_lock"))).toBe(true);
  });

  it("never selects active rows and bounds the byte calculation before its window sum", async () => {
    const database = retentionPool();
    await new ComputeJobArtifactRetention(database.pool).enforce(new Date("2026-07-16T00:00:00.000Z"), 10);

    const mutations = database.queries.filter((query) =>
      query.text.includes("UPDATE compute_jobs job SET") || query.text.includes("DELETE FROM compute_jobs job")
    );
    expect(mutations.length).toBeGreaterThan(0);
    for (const mutation of mutations) {
      if (mutation.text.includes("UPDATE compute_jobs job SET")) {
        expect(mutation.text).toContain("status IN ('completed', 'failed', 'cancelled')");
        expect(mutation.text).toContain("artifacts_pruned_at IS NULL");
      } else {
        expect(mutation.text).toContain("artifacts_pruned_at IS NOT NULL");
      }
      expect(mutation.values[1]).toEqual(expect.any(Number));
      expect(Number(mutation.values[1])).toBeLessThanOrEqual(10);
    }
    const byteMutation = mutations.find((query) => query.text.includes("ROWS BETWEEN UNBOUNDED PRECEDING"));
    expect(byteMutation?.text.indexOf("LIMIT $2")).toBeLessThan(
      byteMutation?.text.indexOf("sum(artifact_size_bytes)") ?? -1
    );
  });

  it("publishes the documented fixed retention horizons", () => {
    expect(COMPUTE_JOB_FULL_ARTIFACT_RETENTION_DAYS).toBe(30);
    expect(COMPUTE_JOB_TOMBSTONE_RETENTION_DAYS).toBe(90);
    expect(COMPUTE_JOB_FULL_ARTIFACTS_PER_OWNER).toBe(200);
    expect(COMPUTE_JOB_FULL_ARTIFACT_BYTES_PER_OWNER).toBe(256 * 1024 * 1024);
    expect(COMPUTE_JOB_TOMBSTONES_PER_OWNER).toBe(1_000);
    expect(COMPUTE_JOB_RETENTION_BATCH_LIMIT).toBe(50);
  });
});
