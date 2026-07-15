import { afterEach, describe, expect, it, vi } from "vitest";
import { createGracefulShutdown } from "../src/http/gracefulShutdown.js";

afterEach(() => vi.useRealTimers());

describe("graceful shutdown", () => {
  it("quiesces producers, closes resources, and exits when the server drains", async () => {
    let callback: ((error?: Error) => void) | undefined;
    const events: string[] = [];
    const exit = vi.fn();
    const shutdown = createGracefulShutdown({ close: (next) => { callback = next; } }, {
      quiesce: () => events.push("quiesce"),
      closeResources: async () => { events.push("resources"); },
      exit
    });

    shutdown();
    callback?.();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(events).toEqual(["quiesce", "resources"]);
  });

  it("bounds stuck clients and force-closes remaining HTTP connections", async () => {
    vi.useFakeTimers();
    const closeAllConnections = vi.fn();
    const exit = vi.fn();
    const report = vi.fn();
    const shutdown = createGracefulShutdown({ close: () => undefined, closeAllConnections }, {
      quiesce: vi.fn(),
      closeResources: vi.fn(),
      forceAfterMs: 25,
      exit,
      report
    });

    shutdown();
    await vi.advanceTimersByTimeAsync(25);
    expect(closeAllConnections).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledWith("Graceful shutdown deadline reached; closing remaining client connections");
    expect(exit).toHaveBeenCalledWith(0);
  });
});
