import type { PluginManifest, PluginPermission } from "@saltanatbotv2/plugin-core";
import type { StrategyArtifact } from "./library";

export interface PluginPackageDetails {
  id: string;
  name: string;
  version: string;
  description: string;
  license: string;
  publisherName: string;
  publisherUrl?: string;
  minAppVersion: string;
}

export type PluginBuildError = "no_artifacts" | "missing_dependency" | "cyclic_dependency";

export type PluginBuildResult =
  | { ok: true; manifest: PluginManifest; includedIds: string[]; autoIncludedIds: string[] }
  | { ok: false; code: PluginBuildError };

/** Build a deterministic declarative package and automatically include transitive dependencies. */
export function buildPluginManifest(
  details: PluginPackageDetails,
  artifacts: StrategyArtifact[],
  selectedIds: string[]
): PluginBuildResult {
  const byId = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  const selected = [...new Set(selectedIds)].filter((id) => byId.has(id));
  if (!selected.length) return { ok: false, code: "no_artifacts" };
  const included = new Set<string>();
  const visiting = new Set<string>();
  const ordered: string[] = [];
  const visit = (id: string): PluginBuildError | undefined => {
    if (included.has(id)) return;
    if (visiting.has(id)) return "cyclic_dependency";
    const artifact = byId.get(id);
    if (!artifact) return "missing_dependency";
    visiting.add(id);
    for (const dependency of artifact.dependencies ?? []) {
      const error = visit(dependency);
      if (error) return error;
    }
    visiting.delete(id);
    included.add(id);
    ordered.push(id);
  };
  for (const id of selected) {
    const error = visit(id);
    if (error) return { ok: false, code: error };
  }

  const packageIds = packageArtifactIds(ordered.map((id) => byId.get(id)!));
  const packaged = ordered.map((id) => {
    const artifact = byId.get(id)!;
    return {
      id: packageIds.get(id)!,
      kind: artifact.kind,
      name: artifact.name,
      description: artifact.description ?? "",
      xml: artifact.xml,
      schemaVersion: artifact.schemaVersion ?? 2,
      semanticVersion: artifact.semanticVersion ?? "0.1.0",
      parameters: artifact.parameters?.map((parameter) => ({ ...parameter })) ?? [],
      dependencies: (artifact.dependencies ?? []).map((dependency) => packageIds.get(dependency)!)
    };
  });
  const permissions: PluginPermission[] = ["market.read"];
  if (packaged.some((artifact) => artifact.kind === "indicator")) permissions.push("chart.overlay");
  if (packaged.some((artifact) => artifact.kind === "strategy")) permissions.push("trade.intent");
  if (packaged.some((artifact) => /<block\b[^>]*\btype=["']alert_message["']/i.test(artifact.xml))) permissions.push("alert.emit");
  return {
    ok: true,
    includedIds: ordered,
    autoIncludedIds: ordered.filter((id) => !selected.includes(id)),
    manifest: {
      id: details.id,
      name: details.name,
      version: details.version,
      description: details.description,
      license: details.license,
      publisher: { name: details.publisherName, url: details.publisherUrl || undefined },
      minAppVersion: details.minAppVersion,
      permissions,
      artifacts: packaged
    }
  };
}

function packageArtifactIds(artifacts: StrategyArtifact[]) {
  const result = new Map<string, string>();
  const used = new Set<string>();
  for (const artifact of artifacts) {
    const base = slug(artifact.id.replace(/^(indicator|strategy):/, "")) || slug(artifact.name) || artifact.kind;
    let id = base;
    let suffix = 2;
    while (used.has(id)) id = `${base}-${suffix++}`;
    used.add(id);
    result.set(artifact.id, id);
  }
  return result;
}

export function pluginFileName(name: string) {
  return `${slug(name) || "saltanat-plugin"}.saltanat-plugin`;
}

function slug(value: string) { return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80); }
