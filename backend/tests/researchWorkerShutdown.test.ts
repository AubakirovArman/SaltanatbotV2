import { describe, expect, it, vi } from "vitest";
import { closeResearchWorkerDatabase, drainResearchWorkerExecutions } from "../src/workers/researchWorkerShutdown.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("research worker execution drain", () => {
  it("persists draining after a late ready pulse before a forced active-stop", async () => {
    const heartbeat = deferred();
    const drainingWrite = deferred();
    const activeStop = deferred();
    const forcedStop = deferred();
    const events: string[] = [];
    let status: "starting" | "ready" | "draining" = "starting";

    const shutdown = drainResearchWorkerExecutions({
      currentHeartbeat: heartbeat.promise.then(() => {
        status = "ready";
        events.push("ready-pulse");
      }),
      markDraining: async () => {
        events.push("draining-write-started");
        await drainingWrite.promise;
        status = "draining";
        events.push("draining-write-durable");
        return true;
      },
      stopActive: async () => {
        events.push("active-stop-started");
        await activeStop.promise;
      },
      heartbeatRejected: vi.fn(),
      heartbeatFailed: vi.fn()
    });

    await flushMicrotasks();
    expect(events).toEqual([]);

    heartbeat.resolve();
    await flushMicrotasks();
    expect(events).toEqual(["ready-pulse", "draining-write-started"]);

    drainingWrite.resolve();
    await flushMicrotasks();
    expect(events).toEqual(["ready-pulse", "draining-write-started", "draining-write-durable", "active-stop-started"]);
    expect(status).toBe("draining");

    forcedStop.resolve();
    await expect(Promise.race([shutdown.then(() => "completed" as const), forcedStop.promise.then(() => "forced" as const)])).resolves.toBe("forced");
    expect(status).toBe("draining");

    activeStop.resolve();
    await expect(shutdown).resolves.toBeUndefined();
  });
});

describe("research worker database shutdown", () => {
  it("always closes the pool when the stopped heartbeat rejects", async () => {
    const failure = new Error("heartbeat database unavailable");
    const markStopped = vi.fn().mockRejectedValue(failure);
    const closePool = vi.fn().mockResolvedValue(undefined);
    const heartbeatFailed = vi.fn();

    await expect(
      closeResearchWorkerDatabase({
        markStopped,
        closePool,
        heartbeatRejected: vi.fn(),
        heartbeatFailed
      })
    ).resolves.toBeUndefined();

    expect(markStopped).toHaveBeenCalledOnce();
    expect(heartbeatFailed).toHaveBeenCalledWith(failure);
    expect(closePool).toHaveBeenCalledOnce();
  });

  it("closes the pool and reports a generation-fenced stopped heartbeat", async () => {
    const closePool = vi.fn().mockResolvedValue(undefined);
    const heartbeatRejected = vi.fn();

    await closeResearchWorkerDatabase({
      markStopped: vi.fn().mockResolvedValue(false),
      closePool,
      heartbeatRejected,
      heartbeatFailed: vi.fn()
    });

    expect(heartbeatRejected).toHaveBeenCalledOnce();
    expect(closePool).toHaveBeenCalledOnce();
  });

  it("still closes the pool if heartbeat rejection reporting throws", async () => {
    const reportFailure = new Error("logger unavailable");
    const closePool = vi.fn().mockResolvedValue(undefined);

    const heartbeatFailed = vi.fn();
    await expect(
      closeResearchWorkerDatabase({
        markStopped: vi.fn().mockResolvedValue(false),
        closePool,
        heartbeatRejected: () => {
          throw reportFailure;
        },
        heartbeatFailed
      })
    ).resolves.toBeUndefined();
    expect(heartbeatFailed).toHaveBeenCalledWith(reportFailure);
    expect(closePool).toHaveBeenCalledOnce();
  });

  it("propagates pool close failure after a successful stopped heartbeat", async () => {
    const closeFailure = new Error("pool close failed");
    const closePool = vi.fn().mockRejectedValue(closeFailure);

    await expect(
      closeResearchWorkerDatabase({
        markStopped: vi.fn().mockResolvedValue(true),
        closePool,
        heartbeatRejected: vi.fn(),
        heartbeatFailed: vi.fn()
      })
    ).rejects.toBe(closeFailure);
    expect(closePool).toHaveBeenCalledOnce();
  });
});
