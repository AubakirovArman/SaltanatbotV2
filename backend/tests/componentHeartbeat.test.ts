import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  RuntimeComponentHeartbeatRepository,
  type StartRuntimeComponentHeartbeat
} from "../src/operations/componentHeartbeat.js";

const GENERATION_ID = "11111111-1111-4111-8111-111111111111";
const STARTED_AT = new Date("2026-07-16T20:00:00.000Z");
const HEARTBEAT_AT = new Date("2026-07-16T20:00:01.000Z");

describe("runtime component heartbeat repository", () => {
  it("rejects invalid start inputs before querying PostgreSQL", async () => {
    const query = vi.fn();
    const repository = createRepository(query);
    const valid: StartRuntimeComponentHeartbeat = {
      component: "research-worker",
      generationId: GENERATION_ID,
      status: "ready",
      releaseCommit: "abcdef0",
      databaseSchemaVersion: 11
    };

    for (const input of [
      { ...valid, component: "api" },
      { ...valid, generationId: "not-a-uuid" },
      { ...valid, status: "failed" },
      { ...valid, releaseCommit: "ABCDEF0" },
      { ...valid, releaseCommit: "abcdef" },
      { ...valid, databaseSchemaVersion: 0 },
      { ...valid, databaseSchemaVersion: Number.MAX_SAFE_INTEGER + 1 }
    ]) {
      await expect(
        repository.start(input as StartRuntimeComponentHeartbeat)
      ).rejects.toThrow();
    }
    expect(query).not.toHaveBeenCalled();
  });

  it("maps one valid start row and rejects missing or duplicate rows", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [validRow()], rowCount: 1 });
    const repository = createRepository(query);

    const started = await repository.start({
      component: "research-worker",
      generationId: GENERATION_ID,
      status: "ready",
      releaseCommit: "abcdef0",
      databaseSchemaVersion: 11
    });
    expect(started).toEqual({
      component: "research-worker",
      generationId: GENERATION_ID,
      status: "ready",
      startedAt: STARTED_AT,
      heartbeatAt: HEARTBEAT_AT,
      releaseCommit: "abcdef0",
      databaseSchemaVersion: 11
    });
    expect(started.startedAt).not.toBe(STARTED_AT);
    expect(started.heartbeatAt).not.toBe(HEARTBEAT_AT);

    query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(
      repository.start({
        component: "research-worker",
        generationId: randomUUID(),
        databaseSchemaVersion: 11
      })
    ).rejects.toThrow(/returned 0 rows/);

    query.mockResolvedValueOnce({
      rows: [validRow(), validRow()],
      rowCount: 2
    });
    await expect(
      repository.start({
        component: "research-worker",
        generationId: randomUUID(),
        databaseSchemaVersion: 11
      })
    ).rejects.toThrow(/returned 2 rows/);
  });

  it.each([
    ["component", { component: "api" }, /component/i],
    ["generation", { generation_id: "bad" }, /generation/i],
    ["status", { status: "unknown" }, /status/i],
    ["started timestamp", { started_at: "2026-07-16" }, /started_at/i],
    ["heartbeat timestamp", { heartbeat_at: new Date("invalid") }, /heartbeat_at/i],
    [
      "timestamp order",
      { heartbeat_at: new Date("2026-07-16T19:59:59.000Z") },
      /precedes/i
    ],
    ["release commit", { release_commit: "ABCDEF0" }, /release commit/i],
    ["schema version", { database_schema_version: 0 }, /schema version/i]
  ])("rejects an invalid %s returned by PostgreSQL", async (_label, override, message) => {
    const query = vi.fn().mockResolvedValue({
      rows: [{ ...validRow(), ...override }],
      rowCount: 1
    });
    const repository = createRepository(query);

    await expect(repository.get("research-worker")).rejects.toThrow(message);
  });

  it("validates pulse and mark inputs and accepts only exact row counts", async () => {
    const query = vi.fn();
    const repository = createRepository(query);

    await expect(
      repository.pulse("api" as "research-worker", GENERATION_ID)
    ).rejects.toThrow(/component/i);
    await expect(
      repository.pulse("research-worker", "not-a-uuid")
    ).rejects.toThrow(/generation/i);
    await expect(
      repository.pulse(
        "research-worker",
        GENERATION_ID,
        "failed" as "ready"
      )
    ).rejects.toThrow(/status/i);
    await expect(
      repository.mark(
        "research-worker",
        GENERATION_ID,
        "unknown" as "ready"
      )
    ).rejects.toThrow(/status/i);
    await expect(
      repository.get("api" as "research-worker")
    ).rejects.toThrow(/component/i);
    expect(query).not.toHaveBeenCalled();

    query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(
      repository.pulse("research-worker", GENERATION_ID)
    ).resolves.toBe(false);

    query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    await expect(
      repository.mark("research-worker", GENERATION_ID, "draining")
    ).resolves.toBe(true);

    query.mockResolvedValueOnce({ rows: [], rowCount: 2 });
    await expect(
      repository.mark("research-worker", GENERATION_ID, "stopped")
    ).rejects.toThrow(/affected 2 rows/);

    query.mockResolvedValueOnce({ rows: [], rowCount: null });
    await expect(
      repository.pulse("research-worker", GENERATION_ID)
    ).rejects.toThrow(/affected null rows/);
  });

  it("returns undefined for no heartbeat and rejects duplicate lookup rows", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({
        rows: [validRow(), validRow()],
        rowCount: 2
      });
    const repository = createRepository(query);

    await expect(repository.get("research-worker")).resolves.toBeUndefined();
    await expect(repository.get("research-worker")).rejects.toThrow(
      /lookup returned 2 rows/
    );
  });
});

function createRepository(query: ReturnType<typeof vi.fn>) {
  return new RuntimeComponentHeartbeatRepository({
    query
  } as unknown as Pick<Pool, "query">);
}

function validRow() {
  return {
    component: "research-worker",
    generation_id: GENERATION_ID,
    status: "ready",
    started_at: STARTED_AT,
    heartbeat_at: HEARTBEAT_AT,
    release_commit: "abcdef0",
    database_schema_version: 11
  };
}
