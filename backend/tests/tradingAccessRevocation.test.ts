import { describe, expect, it, vi } from "vitest";
import { revokeTradingOwnerAccess } from "../src/trading/routes.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("owner trading access revocation", () => {
  it("awaits suspended runtime shutdown even when durable live disarm throws", async () => {
    const stopping = deferred();
    const steps: string[] = [];
    const stopAndSuspend = vi.fn(() => {
      steps.push("suspend-and-stop");
      return stopping.promise.then(() => { steps.push("stopped"); });
    });
    const revocation = revokeTradingOwnerAccess("owner-a", {
      disconnect: () => { steps.push("disconnect"); },
      stopAndSuspend,
      disarm: () => {
        steps.push("disarm");
        throw new Error("SQLite write failed");
      }
    });
    let settled = false;
    void revocation.then(
      () => { settled = true; },
      () => { settled = true; }
    );

    await Promise.resolve();
    expect(stopAndSuspend).toHaveBeenCalledOnce();
    expect(steps).toEqual(["disconnect", "suspend-and-stop", "disarm"]);
    expect(settled).toBe(false);

    stopping.resolve();
    const error = await revocation.catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([expect.objectContaining({ message: "SQLite write failed" })]);
    expect(steps).toEqual(["disconnect", "suspend-and-stop", "disarm", "stopped"]);
  });
});
