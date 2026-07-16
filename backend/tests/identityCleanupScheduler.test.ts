import { afterEach, describe, expect, it, vi } from "vitest";
import { createIdentityCleanupScheduler } from "../src/identity/cleanupScheduler.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("identity cleanup scheduler", () => {
  it("runs immediately, stays single-flight and drains during shutdown", async () => {
    vi.useFakeTimers();
    let release: (() => void) | undefined;
    const cleanup = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    const scheduler = createIdentityCleanupScheduler({ cleanup }, { intervalMs: 1_000, limit: 25 });

    scheduler.start();
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledWith(25);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(cleanup).toHaveBeenCalledTimes(1);

    scheduler.quiesce();
    const drained = scheduler.drain();
    release?.();
    await drained;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it("continues after a bounded cleanup failure and reports it once", async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const cleanup = vi.fn().mockRejectedValueOnce(new Error("database unavailable")).mockResolvedValue(undefined);
    const scheduler = createIdentityCleanupScheduler({ cleanup }, { intervalMs: 1_000, onError });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(cleanup).toHaveBeenCalledTimes(2);
    scheduler.quiesce();
    await scheduler.drain();
  });

  it("is a no-op when database identity is disabled", async () => {
    vi.useFakeTimers();
    const scheduler = createIdentityCleanupScheduler(undefined, {
      intervalMs: 1_000
    });
    scheduler.start();
    scheduler.trigger();
    await vi.advanceTimersByTimeAsync(5_000);
    scheduler.quiesce();
    await scheduler.drain();
  });
});
