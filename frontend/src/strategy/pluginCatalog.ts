import type { PluginPermission } from "@saltanatbotv2/plugin-core";
import type { StrategyArtifact } from "./library";

export interface InstalledPlugin {
  key: string;
  id: string;
  name: string;
  version: string;
  publisher: string;
  publisherUrl?: string;
  license?: string;
  minAppVersion?: string;
  permissions: PluginPermission[];
  checksum: string;
  importedAt: number;
  artifacts: StrategyArtifact[];
  modifiedArtifacts: number;
}

export interface PluginRemovalAnalysis {
  installation?: InstalledPlugin;
  blockingArtifacts: StrategyArtifact[];
  remainingArtifacts: StrategyArtifact[];
  removedArtifactIds: string[];
  canRemove: boolean;
}

/** Reconstruct installed packages from persisted artifact provenance, including legacy imports. */
export function installedPlugins(artifacts: StrategyArtifact[]): InstalledPlugin[] {
  const groups = new Map<string, StrategyArtifact[]>();
  for (const artifact of artifacts) {
    const provenance = artifact.provenance;
    if (provenance?.source !== "plugin" || !provenance.pluginId || !provenance.manifestHash) continue;
    const key = pluginInstallationKey(provenance.pluginId, provenance.manifestHash, provenance.importedAt ?? 0);
    const group = groups.get(key) ?? [];
    group.push(artifact);
    groups.set(key, group);
  }
  return [...groups.entries()].map(([key, members]) => {
    const provenance = members[0].provenance!;
    return {
      key,
      id: provenance.pluginId!,
      name: provenance.pluginName ?? provenance.pluginId!,
      version: provenance.pluginVersion ?? "0.0.0",
      publisher: provenance.publisher ?? "",
      publisherUrl: provenance.publisherUrl,
      license: provenance.pluginLicense,
      minAppVersion: provenance.pluginMinAppVersion,
      permissions: provenance.pluginPermissions ? [...provenance.pluginPermissions] : [],
      checksum: provenance.manifestHash!,
      importedAt: provenance.importedAt ?? 0,
      artifacts: [...members].sort((left, right) => compareText(left.name, right.name)),
      modifiedArtifacts: members.filter((artifact) => (artifact.history?.length ?? 0) > 0).length
    };
  }).sort((left, right) => right.importedAt - left.importedAt || compareText(left.name, right.name));
}

export function analyzePluginRemoval(artifacts: StrategyArtifact[], key: string): PluginRemovalAnalysis {
  const installation = installedPlugins(artifacts).find((plugin) => plugin.key === key);
  if (!installation) return { blockingArtifacts: [], remainingArtifacts: artifacts, removedArtifactIds: [], canRemove: false };
  const removedIds = new Set(installation.artifacts.map((artifact) => artifact.id));
  const blockingArtifacts = artifacts.filter((artifact) => !removedIds.has(artifact.id) && artifact.dependencies?.some((dependency) => removedIds.has(dependency)));
  return {
    installation,
    blockingArtifacts,
    remainingArtifacts: blockingArtifacts.length ? artifacts : artifacts.filter((artifact) => !removedIds.has(artifact.id)),
    removedArtifactIds: [...removedIds],
    canRemove: blockingArtifacts.length === 0
  };
}

export function removeArtifactScopedValues<T>(values: Record<string, T>, artifactIds: string[]): Record<string, T> {
  const removed = new Set(artifactIds);
  return Object.fromEntries(Object.entries(values).filter(([id]) => !removed.has(id)));
}

function pluginInstallationKey(id: string, checksum: string, importedAt: number) {
  return `${id}\u0000${checksum}\u0000${importedAt}`;
}

function compareText(left: string, right: string) { return left === right ? 0 : left < right ? -1 : 1; }
