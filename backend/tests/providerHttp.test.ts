import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithRetry } from "../src/providers/http.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("public provider fetch retry cancellation", () => {
  it("does not start a request for an already-aborted signal", async () => {
    const failure = new Error("deadline reached");
    const controller = new AbortController();
    controller.abort(failure);
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);

    await expect(fetchWithRetry("https://example.invalid", { signal: controller.signal })).rejects.toBe(failure);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("interrupts rate-limit backoff without retrying after abort", async () => {
    const failure = new Error("deadline reached");
    const controller = new AbortController();
    const fetcher = vi.fn(async () => new Response("limited", { status: 429, headers: { "retry-after": "60" } }));
    vi.stubGlobal("fetch", fetcher);

    const request = fetchWithRetry("https://example.invalid", {
      signal: controller.signal,
      maxRetries: 3,
      maxDelayMs: 8_000
    });
    await until(() => fetcher.mock.calls.length === 1);
    controller.abort(failure);

    await expect(request).rejects.toBe(failure);
    expect(fetcher).toHaveBeenCalledOnce();
  });
});

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("condition was not reached");
}
