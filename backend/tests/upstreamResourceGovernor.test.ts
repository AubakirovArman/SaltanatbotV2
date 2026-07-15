import { describe, expect, it } from "vitest";
import { UpstreamCircuitOpenError, UpstreamResourceGovernor, UpstreamSourceOverloadError } from "../src/arbitrage/upstream/resourceGovernor/index.js";

const source = "binance.public-rest";

function governor(now: () => number, overrides: Partial<{ maxConcurrent: number; failureThreshold: number; cooldownMs: number }> = {}) {
  return new UpstreamResourceGovernor(
    {
      [source]: {
        maxConcurrent: overrides.maxConcurrent ?? 2,
        failureThreshold: overrides.failureThreshold ?? 2,
        cooldownMs: overrides.cooldownMs ?? 1_000
      }
    },
    now
  );
}

describe("UpstreamResourceGovernor", () => {
  it("rejects overload immediately without queueing and recovers after release", () => {
    const resources = governor(() => 100, { maxConcurrent: 1 });
    const lease = resources.acquire(source);

    expect(() => resources.acquire(source)).toThrow(UpstreamSourceOverloadError);
    expect(resources.sourceSnapshot(source)).toMatchObject({ active: 1, available: 0, counters: { acquired: 1, overloadRejected: 1 } });

    expect(lease.release()).toBe(true);
    expect(lease.release("failure")).toBe(false);
    expect(resources.acquire(source).release()).toBe(true);
    expect(resources.sourceSnapshot(source)).toMatchObject({ active: 0, counters: { acquired: 2, succeeded: 2, failed: 0 } });
  });

  it("accounts an overload rejected by a bounded pre-lease coalescer", () => {
    const resources = governor(() => 1);
    resources.recordExternalOverload(source);

    expect(resources.sourceSnapshot(source)).toMatchObject({ active: 0, counters: { acquired: 0, overloadRejected: 1 } });
  });

  it("records deterministic success, failure, abort and latency metrics", async () => {
    let now = 1_000;
    const resources = governor(() => now, { failureThreshold: 5 });

    await resources.run(source, async () => {
      now += 25;
      return "ok";
    });
    await resources
      .run(source, async () => {
        now += 10;
        throw new Error("upstream failed");
      })
      .catch(() => undefined);
    await resources
      .run(source, async () => {
        now += 5;
        throw new DOMException("left", "AbortError");
      })
      .catch(() => undefined);

    expect(resources.sourceSnapshot(source)).toMatchObject({
      state: "closed",
      active: 0,
      consecutiveFailures: 1,
      counters: { acquired: 3, succeeded: 1, failed: 1, aborted: 1 },
      latency: { lastMs: 5, averageMs: 40 / 3, maxMs: 25 },
      lastSuccessAt: 1_025,
      lastFailureAt: 1_035,
      lastAbortAt: 1_040
    });
    expect(JSON.stringify(resources.snapshot())).not.toContain("upstream failed");
  });

  it("opens, cools down and admits exactly one half-open probe", async () => {
    let now = 10_000;
    const resources = governor(() => now, { failureThreshold: 2, cooldownMs: 500 });
    const fail = () =>
      resources.run(source, async () => {
        throw new Error("HTTP 503");
      });

    await expect(fail()).rejects.toThrow("HTTP 503");
    await expect(fail()).rejects.toThrow("HTTP 503");
    expect(resources.sourceSnapshot(source)).toMatchObject({ state: "open", healthy: false, cooldownRemainingMs: 500 });
    expect(() => resources.acquire(source)).toThrow(UpstreamCircuitOpenError);

    now += 500;
    const probe = resources.acquire(source);
    expect(resources.sourceSnapshot(source)).toMatchObject({ state: "half-open", halfOpenProbeActive: true });
    let blocked: unknown;
    try {
      resources.acquire(source);
    } catch (error) {
      blocked = error;
    }
    expect(blocked).toBeInstanceOf(UpstreamCircuitOpenError);
    expect(blocked).toMatchObject({ retryAt: now + 500 });
    probe.release("success");

    expect(resources.sourceSnapshot(source)).toMatchObject({ state: "closed", healthy: true, consecutiveFailures: 0 });
  });

  it("reopens after a failed half-open probe", async () => {
    let now = 0;
    const resources = governor(() => now, { failureThreshold: 1, cooldownMs: 100 });
    await resources
      .run(source, async () => {
        throw new Error("down");
      })
      .catch(() => undefined);
    now = 100;

    const probe = resources.acquire(source);
    now = 110;
    probe.release("failure");

    expect(resources.sourceSnapshot(source)).toMatchObject({ state: "open", cooldownRemainingMs: 100, counters: { circuitOpened: 2 } });
  });

  it("counts one circuit transition for concurrent failures admitted while closed", () => {
    let now = 10;
    const resources = governor(() => now, { failureThreshold: 1, cooldownMs: 100 });
    const first = resources.acquire(source);
    const second = resources.acquire(source);

    first.release("failure");
    now = 20;
    second.release("failure");

    expect(resources.sourceSnapshot(source)).toMatchObject({
      state: "open",
      cooldownRemainingMs: 90,
      counters: { failed: 2, circuitOpened: 1 }
    });
  });

  it("lets callers ignore domain errors without poisoning the upstream circuit", async () => {
    const resources = governor(() => 1, { failureThreshold: 1 });
    const rejected = new Error("unsupported market type");

    await expect(
      resources.run(
        source,
        async () => {
          throw rejected;
        },
        { classifyError: () => "ignored" }
      )
    ).rejects.toBe(rejected);

    expect(resources.sourceSnapshot(source)).toMatchObject({ state: "closed", consecutiveFailures: 0, counters: { ignored: 1, failed: 0 } });
  });

  it("returns stable sorted aggregate health snapshots", () => {
    const resources = new UpstreamResourceGovernor(
      {
        "okx.public-rest": { maxConcurrent: 1, failureThreshold: 2, cooldownMs: 100 },
        [source]: { maxConcurrent: 2, failureThreshold: 2, cooldownMs: 100 }
      },
      () => 55
    );
    const lease = resources.acquire(source);

    expect(resources.snapshot()).toEqual({
      generatedAt: 55,
      healthy: true,
      totals: { sources: 2, active: 1, overloadRejected: 0, circuitRejected: 0, failed: 0 },
      sources: expect.arrayContaining([expect.objectContaining({ source, active: 1 }), expect.objectContaining({ source: "okx.public-rest", active: 0 })])
    });
    expect(resources.snapshot().sources.map((entry) => entry.source)).toEqual([source, "okx.public-rest"]);
    lease.release();
  });

  it("validates names and budgets and rejects unknown sources", () => {
    expect(() => new UpstreamResourceGovernor({}, Date.now)).toThrow("At least one");
    expect(() => new UpstreamResourceGovernor({ bad: { maxConcurrent: 0, failureThreshold: 1, cooldownMs: 1 } })).toThrow("maxConcurrent");
    const resources = governor(Date.now);
    expect(() => resources.acquire("unknown.public-rest")).toThrow("Unknown public upstream source");
  });
});
