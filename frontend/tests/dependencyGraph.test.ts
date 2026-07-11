import { describe, expect, it } from "vitest";
import { buildArtifactDependencyGraph, canAddDependency } from "../src/strategy/dependencyGraph";
import type { StrategyArtifact } from "../src/strategy/library";

const artifact = (id: string, kind: "strategy" | "indicator", dependencies: string[] = []): StrategyArtifact => ({
  id, kind, name: id, description: "", xml: '<xml><block type="strategy_start" /></xml>', dependencies, createdAt: 1, updatedAt: 1
});

describe("artifact dependency graph", () => {
  it("exposes strategy-to-indicator edges and missing dependencies", () => {
    const graph = buildArtifactDependencyGraph([artifact("strategy:a", "strategy", ["indicator:x", "indicator:missing"]), artifact("indicator:x", "indicator")]);
    expect(graph.edges).toEqual([{ from: "strategy:a", to: "indicator:x" }]);
    expect(graph.missing).toEqual([{ from: "strategy:a", to: "indicator:missing" }]);
  });

  it("rejects self references and cycle-producing dependencies", () => {
    const items = [artifact("indicator:a", "indicator", ["indicator:b"]), artifact("indicator:b", "indicator")];
    expect(canAddDependency(items, "indicator:b", "indicator:a")).toBe(false);
    expect(canAddDependency(items, "indicator:a", "indicator:a")).toBe(false);
    expect(buildArtifactDependencyGraph([artifact("indicator:a", "indicator", ["indicator:b"]), artifact("indicator:b", "indicator", ["indicator:a"])]).cycles[0])
      .toEqual(["indicator:a", "indicator:b", "indicator:a"]);
  });
});
