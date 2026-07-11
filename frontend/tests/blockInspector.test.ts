import { describe, expect, it } from "vitest";
import { blockCatalog, blockInspectorDoc } from "../src/strategy/blockCatalog";

describe("block inspector contracts", () => {
  it("provides inputs, output, example and pitfalls for every documented block", () => {
    for (const type of Object.keys(blockCatalog)) {
      const doc = blockInspectorDoc(type);
      expect(doc?.inputs.length, type).toBeGreaterThan(0);
      expect(doc?.output.length, type).toBeGreaterThan(0);
      expect(doc?.example.length, type).toBeGreaterThan(0);
      expect(doc?.pitfalls.length, type).toBeGreaterThan(0);
    }
  });
});
