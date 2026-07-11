// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { encodeStrategyFile, parseStrategyFile } from "../src/strategy/strategyFile";
import type { StrategyArtifact } from "../src/strategy/library";

const artifact: StrategyArtifact = {
  id: "strategy:test",
  kind: "strategy",
  name: "Verified strategy",
  description: "Portable",
  xml: '<xml><block type="strategy_start" /></xml>',
  code: "strategy Verified strategy",
  version: 3,
  semanticVersion: "0.3.0",
  schemaVersion: 2,
  hash: "abc123",
  irHash: "irdef456",
  parameters: [{ name: "length", value: 14, defaultValue: 14, min: 2, max: 100, step: 1, optimizationEligible: true }],
  dependencies: ["indicator:ema"],
  provenance: { source: "wizard" },
  createdAt: 1,
  updatedAt: 2
};

describe("verified strategy files", () => {
  it("round-trips schema, checksum, parameters, dependencies and provenance", async () => {
    const raw = await encodeStrategyFile(artifact, 10);
    await expect(parseStrategyFile(raw)).resolves.toMatchObject({
      kind: "strategy",
      semanticVersion: "0.3.0",
      contentHash: "abc123",
      irHash: "irdef456",
      parameters: [{ name: "length", min: 2, max: 100 }],
      dependencies: ["indicator:ema"],
      provenance: { source: "wizard", exportedFromId: "strategy:test" }
    });
  });

  it("rejects tampering and migrates legacy v1 envelopes explicitly", async () => {
    const raw = await encodeStrategyFile(artifact, 10);
    await expect(parseStrategyFile(raw.replace("Verified strategy", "Tampered strategy"))).resolves.toBeUndefined();
    await expect(parseStrategyFile(JSON.stringify({ format: "saltanatbotv2.strategy", version: 1, name: "Legacy", description: "", xml: artifact.xml })))
      .resolves.toMatchObject({ schemaVersion: 1, provenance: { source: "legacy-v1" } });
  });

  it("rejects checksum-valid files with unsafe parameter metadata", async () => {
    const invalid = { ...artifact, parameters: [{ name: "length", value: 14, min: 100, max: 2, step: -1 }] } as StrategyArtifact;
    await expect(parseStrategyFile(await encodeStrategyFile(invalid))).resolves.toBeUndefined();
  });
});
