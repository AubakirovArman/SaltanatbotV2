import { describe, expect, it, vi } from "vitest";
import { SharedAbortableWork } from "../src/arbitrage/sharedAbortableWork.js";

describe("SharedAbortableWork", () => {
  it("never subscribes a later caller to an aborted producer that is still unwinding", async () => {
    let releaseAbortedProducer!: () => void;
    const abortedProducerGate = new Promise<void>((resolve) => {
      releaseAbortedProducer = resolve;
    });
    let firstSharedSignal: AbortSignal | undefined;
    const start = vi.fn(async (signal: AbortSignal) => {
      if (!firstSharedSignal) {
        firstSharedSignal = signal;
        await abortedProducerGate;
        return "stale";
      }
      return "fresh";
    });
    const work = new SharedAbortableWork<string, string>(2);
    const firstSubscriber = new AbortController();

    const first = work.run("same-key", start, firstSubscriber.signal);
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
    firstSubscriber.abort(new Error("first caller left"));
    await expect(first).rejects.toThrow("first caller left");
    expect(firstSharedSignal?.aborted).toBe(true);

    await expect(work.run("same-key", start)).resolves.toBe("fresh");
    expect(start).toHaveBeenCalledTimes(2);

    releaseAbortedProducer();
    await vi.waitFor(() => expect(work.activeCount()).toBe(0));
  });
});
