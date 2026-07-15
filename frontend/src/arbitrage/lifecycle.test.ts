import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchOpportunityLifecycle } from "./lifecycle.js";

afterEach(() => vi.unstubAllGlobals());

describe("browser opportunity lifecycle client", () => {
  it("sends bounded filters and parses the read-only envelope", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "https://scanner.example");
      expect(url.searchParams.get("kind")).toBe("basis");
      expect(url.searchParams.get("actionable")).toBe("true");
      return Response.json(fixture());
    });
    vi.stubGlobal("fetch", fetcher);

    await expect(fetchOpportunityLifecycle({ kind: "basis", actionable: true })).resolves.toMatchObject({ readOnly: true, executionPermission: false });
  });

  it("rejects a forged execution permission", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ ...fixture(), executionPermission: true }))
    );
    await expect(fetchOpportunityLifecycle()).rejects.toThrow(/safety envelope/);
  });
});

function fixture() {
  return {
    schemaVersion: 1,
    readOnly: true,
    executionPermission: false,
    generatedAt: 2_000,
    runtime: { acceptedSnapshots: 0, rejectedSnapshots: 0 },
    summary: { universeCount: 0, retainedRoutes: 0, matchedRoutes: 0, returnedRoutes: 0, routesTruncated: false, retainedEvents: 0, matchedEvents: 0, returnedEvents: 0, eventsTruncated: false, nextEventSequence: 1 },
    universes: [],
    routes: [],
    events: []
  };
}
