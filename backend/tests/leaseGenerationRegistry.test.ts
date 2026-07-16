import { describe, expect, it } from "vitest";
import { LeaseGenerationRegistry } from "../src/workers/leaseGenerationRegistry.js";

describe("research worker lease generation tracking", () => {
  it("keeps a reclaimed job separate from its stale execution", () => {
    const registry = new LeaseGenerationRegistry<string>();
    registry.add("job-a", "lease-old", "old worker");
    registry.add("job-a", "lease-new", "new worker");

    expect(registry.size).toBe(2);
    expect(registry.delete("job-a", "lease-old")).toBe(true);
    expect(registry.size).toBe(1);
    expect([...registry.values()]).toEqual(["new worker"]);
  });
});
