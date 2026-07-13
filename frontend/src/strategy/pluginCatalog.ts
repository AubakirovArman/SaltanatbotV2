import type { PluginPermission, VerifiedPlugin } from "@saltanatbotv2/plugin-core";
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
  signatureScheme?: "ECDSA-P256-SHA256";
  signerFingerprint?: string;
  signerPreviousFingerprints?: string[];
  signerTrustedAtImport?: boolean;
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

export type PluginVersionTransition = "new" | "upgrade" | "same_version" | "downgrade" | "duplicate";
export type PluginSignerTransition = "new_signed" | "new_unsigned" | "same" | "rotated" | "changed" | "introduced" | "removed" | "unsigned";

export interface PluginImportAnalysis {
  reference?: InstalledPlugin;
  relatedInstallations: number;
  versionTransition: PluginVersionTransition;
  signerTransition: PluginSignerTransition;
  requiresVersionAcknowledgement: boolean;
  requiresSignerAcknowledgement: boolean;
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
      signatureScheme: provenance.pluginSignatureScheme,
      signerFingerprint: provenance.pluginSignerFingerprint,
      signerPreviousFingerprints: Array.isArray(provenance.pluginSignerPreviousFingerprints)
        ? provenance.pluginSignerPreviousFingerprints.filter((fingerprint) => /^[a-f0-9]{64}$/.test(fingerprint)).slice(0, 8)
        : undefined,
      signerTrustedAtImport: provenance.pluginSignerTrustedAtImport,
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

/** Compare an import with the highest installed version of the same stable package ID. */
export function analyzePluginImport(artifacts: StrategyArtifact[], plugin: VerifiedPlugin): PluginImportAnalysis {
  const related = installedPlugins(artifacts).filter((installed) => installed.id === plugin.manifest.id);
  if (!related.length) {
    return {
      relatedInstallations: 0,
      versionTransition: "new",
      signerTransition: plugin.signature ? "new_signed" : "new_unsigned",
      requiresVersionAcknowledgement: false,
      requiresSignerAcknowledgement: false
    };
  }
  const reference = [...related].sort((left, right) => compareSemver(right.version, left.version) || right.importedAt - left.importedAt)[0];
  const versionComparison = compareSemver(plugin.manifest.version, reference.version);
  const versionTransition: PluginVersionTransition = related.some((installed) => installed.checksum === plugin.checksum)
    ? "duplicate"
    : versionComparison > 0 ? "upgrade" : versionComparison < 0 ? "downgrade" : "same_version";
  const previousSigner = reference.signerFingerprint;
  const nextSigner = plugin.signature?.keyFingerprint;
  const signerTransition: PluginSignerTransition = previousSigner
    ? nextSigner ? previousSigner === nextSigner ? "same" : plugin.signature?.keyTransitions?.some((transition) => transition.previousKeyFingerprint === previousSigner) ? "rotated" : "changed" : "removed"
    : nextSigner ? "introduced" : "unsigned";
  return {
    reference,
    relatedInstallations: related.length,
    versionTransition,
    signerTransition,
    requiresVersionAcknowledgement: versionTransition === "duplicate" || versionTransition === "same_version" || versionTransition === "downgrade",
    requiresSignerAcknowledgement: signerTransition === "changed" || signerTransition === "introduced" || signerTransition === "removed"
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
function compareSemver(left: string, right: string) {
  const leftParts = semverParts(left);
  const rightParts = semverParts(right);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}
function semverParts(value: string) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : [0, 0, 0];
}
