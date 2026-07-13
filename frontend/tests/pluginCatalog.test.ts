import { describe, expect, it } from "vitest";
import { analyzePluginRemoval, installedPlugins, removeArtifactScopedValues } from "../src/strategy/pluginCatalog";
import type { StrategyArtifact } from "../src/strategy/library";

describe("installed plugin catalog", () => {
  it("groups one installation and retains its package metadata", () => {
    const artifacts = [pluginArtifact("indicator:a", "Alpha"), pluginArtifact("strategy:b", "Beta", { dependencies: ["indicator:a"], history: [{ version: 1 } as never] })];
    const catalog = installedPlugins(artifacts);
    expect(catalog).toHaveLength(1);
    expect(catalog[0]).toMatchObject({ id: "community.pack", name: "Community pack", version: "1.2.0", publisher: "Publisher", license: "MIT", permissions: ["market.read", "chart.overlay", "trade.intent"], signatureScheme: "ECDSA-P256-SHA256", signerFingerprint: "f".repeat(64), signerTrustedAtImport: true, modifiedArtifacts: 1 });
    expect(catalog[0].artifacts.map((artifact) => artifact.name)).toEqual(["Alpha", "Beta"]);
  });

  it("keeps repeated imports as separate installations", () => {
    const first = pluginArtifact("indicator:a", "Alpha");
    const second = pluginArtifact("indicator:b", "Beta", { provenance: { ...first.provenance!, importedAt: 20 } });
    expect(installedPlugins([first, second]).map((plugin) => plugin.importedAt)).toEqual([20, 10]);
  });

  it("blocks removal when an artifact outside the package depends on it", () => {
    const dependency = pluginArtifact("indicator:a", "Alpha");
    const local = artifact("strategy:local", "Local", { dependencies: [dependency.id] });
    const key = installedPlugins([dependency, local])[0].key;
    const analysis = analyzePluginRemoval([dependency, local], key);
    expect(analysis.canRemove).toBe(false);
    expect(analysis.blockingArtifacts.map((item) => item.id)).toEqual([local.id]);
    expect(analysis.remainingArtifacts).toHaveLength(2);
  });

  it("removes only the selected installation when there are no external dependents", () => {
    const first = pluginArtifact("indicator:a", "Alpha");
    const second = pluginArtifact("indicator:b", "Beta", { provenance: { ...first.provenance!, importedAt: 20 } });
    const local = artifact("strategy:local", "Local");
    const key = installedPlugins([first, second, local]).find((plugin) => plugin.importedAt === 10)!.key;
    const analysis = analyzePluginRemoval([first, second, local], key);
    expect(analysis.canRemove).toBe(true);
    expect(analysis.removedArtifactIds).toEqual([first.id]);
    expect(analysis.remainingArtifacts.map((item) => item.id)).toEqual([second.id, local.id]);
    expect(removeArtifactScopedValues({ [first.id]: { period: 10 }, [second.id]: { period: 20 } }, analysis.removedArtifactIds)).toEqual({ [second.id]: { period: 20 } });
  });
});

function pluginArtifact(id: string, name: string, overrides: Partial<StrategyArtifact> = {}) {
  return artifact(id, name, {
    provenance: {
      source: "plugin",
      importedAt: 10,
      pluginId: "community.pack",
      pluginName: "Community pack",
      pluginVersion: "1.2.0",
      publisher: "Publisher",
      publisherUrl: "https://example.com",
      pluginLicense: "MIT",
      pluginMinAppVersion: "0.1.0",
      pluginPermissions: ["market.read", "chart.overlay", "trade.intent"],
      pluginSignatureScheme: "ECDSA-P256-SHA256",
      pluginSignerFingerprint: "f".repeat(64),
      pluginSignerTrustedAtImport: true,
      manifestHash: "a".repeat(64)
    },
    ...overrides
  });
}

function artifact(id: string, name: string, overrides: Partial<StrategyArtifact> = {}): StrategyArtifact {
  return { id, kind: id.startsWith("indicator:") ? "indicator" : "strategy", name, description: "Test", xml: '<xml><block type="strategy_start" /></xml>', createdAt: 1, updatedAt: 1, ...overrides };
}
