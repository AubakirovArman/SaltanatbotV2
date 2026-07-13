import { describe, expect, it } from "vitest";
import { buildPluginManifest, pluginFileName } from "../src/strategy/pluginPackage";
import type { StrategyArtifact } from "../src/strategy/library";

describe("plugin package builder", () => {
  it("includes transitive dependencies before selected artifacts and remaps IDs", () => {
    const indicator = artifact({ id: "indicator:EMA 21", kind: "indicator", name: "EMA 21" });
    const strategy = artifact({ id: "strategy:cross", dependencies: [indicator.id] });
    const result = buildPluginManifest(details(), [strategy, indicator], [strategy.id]);

    expect(result).toMatchObject({ ok: true, includedIds: [indicator.id, strategy.id], autoIncludedIds: [indicator.id] });
    if (!result.ok) return;
    expect(result.manifest.permissions).toEqual(["market.read", "chart.overlay", "trade.intent"]);
    expect(result.manifest.artifacts.map((item) => item.id)).toEqual(["ema-21", "cross"]);
    expect(result.manifest.artifacts[1].dependencies).toEqual(["ema-21"]);
  });

  it("derives alert permission and strips runtime-only artifact fields", () => {
    const result = buildPluginManifest(details(), [artifact({ xml: `${xml()}<block type="alert_message" />`, code: "do not export", history: [{ version: 1 } as never] })], ["strategy:one"]);
    if (!result.ok) throw new Error(result.code);
    expect(result.manifest.permissions).toEqual(["market.read", "trade.intent", "alert.emit"]);
    expect(result.manifest.artifacts[0]).not.toHaveProperty("code");
    expect(result.manifest.artifacts[0]).not.toHaveProperty("history");
  });

  it("rejects empty, missing and cyclic selections", () => {
    expect(buildPluginManifest(details(), [], [])).toEqual({ ok: false, code: "no_artifacts" });
    expect(buildPluginManifest(details(), [artifact({ dependencies: ["indicator:missing"] })], ["strategy:one"])).toEqual({ ok: false, code: "missing_dependency" });
    expect(buildPluginManifest(details(), [
      artifact({ id: "strategy:a", dependencies: ["strategy:b"] }),
      artifact({ id: "strategy:b", dependencies: ["strategy:a"] })
    ], ["strategy:a"])).toEqual({ ok: false, code: "cyclic_dependency" });
  });

  it("creates a bounded portable filename", () => {
    expect(pluginFileName(" EMA Community Pack ")).toBe("ema-community-pack.saltanat-plugin");
    expect(pluginFileName("Қазақша")).toBe("saltanat-plugin.saltanat-plugin");
  });
});

function details() {
  return { id: "community.pack", name: "Community pack", version: "1.0.0", description: "Pack", license: "MIT", publisherName: "Publisher", minAppVersion: "0.1.0" };
}

function artifact(overrides: Partial<StrategyArtifact> = {}): StrategyArtifact {
  return { id: "strategy:one", kind: "strategy", name: "Strategy", description: "Test", xml: xml(), createdAt: 1, updatedAt: 1, ...overrides };
}

function xml() { return '<xml><block type="strategy_start" /></xml>'; }
