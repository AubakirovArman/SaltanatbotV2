import type { ArtifactRevision, StrategyArtifact, StrategyArtifactKind } from "./library";
import { ARTIFACT_SCHEMA_VERSION, createNewArtifact, normalizeArtifact } from "./library";
import type { StrategyIR } from "./ir";
import type { StrategyTemplate } from "./templates";

export function dedupeArtifactName(name: string, items: StrategyArtifact[]): string {
  const taken = new Set(items.map((item) => item.name));
  if (!taken.has(name)) return name;
  let suffix = 2;
  while (taken.has(`${name} (${suffix})`)) suffix += 1;
  return `${name} (${suffix})`;
}

export function artifactHash(artifact: Pick<StrategyArtifact, "kind" | "name" | "description" | "xml" | "code" | "parameters" | "dependencies">): string {
  const text = `${artifact.kind}\n${artifact.name}\n${artifact.description}\n${artifact.xml}\n${artifact.code ?? ""}\n${JSON.stringify(artifact.parameters ?? [])}\n${JSON.stringify(artifact.dependencies ?? [])}`;
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Stable non-security fingerprint of the canonical compiled IR. */
export function artifactIrHash(ir: StrategyIR): string {
  let hash = 2166136261;
  const text = JSON.stringify(ir);
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `ir${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function stampArtifact(artifact: StrategyArtifact, existing?: StrategyArtifact): StrategyArtifact {
  const hash = artifactHash(artifact);
  const unchanged = existing?.hash === hash;
  const version = unchanged ? existing?.version ?? artifact.version ?? 1 : (existing?.version ?? 0) + 1;
  const history = existing && !unchanged
    ? [...(existing.history ?? []), artifactRevision(existing)].slice(-30)
    : artifact.history ?? existing?.history ?? [];
  return {
    ...normalizeArtifact(artifact),
    hash,
    version,
    semanticVersion: !existing ? artifact.semanticVersion ?? "0.1.0" : unchanged ? existing.semanticVersion ?? artifact.semanticVersion ?? "0.1.0" : nextPatchVersion(existing.semanticVersion),
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    history
  };
}

export function rollbackArtifact(items: StrategyArtifact[], id: string, version: number, now = Date.now()): StrategyArtifact[] {
  const artifact = items.find((item) => item.id === id);
  const revision = artifact?.history?.find((item) => item.version === version);
  if (!artifact || !revision) return items;
  const restored: StrategyArtifact = {
    ...artifact,
    name: revision.name,
    description: revision.description,
    xml: revision.xml,
    code: revision.code,
    irHash: revision.irHash,
    parameters: revision.parameters,
    dependencies: revision.dependencies,
    updatedAt: now
  };
  return items.map((item) => item.id === id ? stampArtifact(restored, artifact) : item);
}

export interface ArtifactDiff {
  fromVersion: number;
  toVersion: number;
  added: string[];
  removed: string[];
  metadataChanged: string[];
}

export function diffArtifactVersions(artifact: StrategyArtifact, fromVersion: number): ArtifactDiff | undefined {
  const from = artifact.history?.find((item) => item.version === fromVersion);
  if (!from) return undefined;
  const before = new Set((from.code ?? from.xml).split("\n"));
  const after = new Set((artifact.code ?? artifact.xml).split("\n"));
  const metadataChanged = [
    from.name !== artifact.name ? "name" : undefined,
    from.description !== artifact.description ? "description" : undefined,
    from.irHash !== artifact.irHash ? "irHash" : undefined,
    JSON.stringify(from.parameters ?? []) !== JSON.stringify(artifact.parameters ?? []) ? "parameters" : undefined,
    JSON.stringify(from.dependencies ?? []) !== JSON.stringify(artifact.dependencies ?? []) ? "dependencies" : undefined
  ].filter((item): item is string => item !== undefined);
  return {
    fromVersion,
    toVersion: artifact.version ?? fromVersion,
    added: [...after].filter((line) => !before.has(line)),
    removed: [...before].filter((line) => !after.has(line)),
    metadataChanged
  };
}

function artifactRevision(artifact: StrategyArtifact): ArtifactRevision {
  return {
    version: artifact.version ?? 1,
    semanticVersion: artifact.semanticVersion ?? "0.1.0",
    hash: artifact.hash ?? artifactHash(artifact),
    irHash: artifact.irHash,
    name: artifact.name,
    description: artifact.description,
    xml: artifact.xml,
    code: artifact.code,
    parameters: artifact.parameters?.map((item) => ({ ...item })),
    dependencies: artifact.dependencies ? [...artifact.dependencies] : [],
    savedAt: artifact.updatedAt
  };
}

function nextPatchVersion(version = "0.0.0") {
  const [major, minor, patch] = version.split(".").map((part) => Number(part) || 0);
  return `${major}.${minor}.${patch + 1}`;
}

export function upsertArtifact(items: StrategyArtifact[], artifact: StrategyArtifact, now = Date.now()): StrategyArtifact[] {
  const existing = items.find((item) => item.id === artifact.id);
  const stamped = stampArtifact(artifact, existing);
  if (!existing) return [stamped, ...items];
  return items.map((item) => item.id === artifact.id
    ? { ...stamped, createdAt: item.createdAt, updatedAt: now }
    : item);
}

export function createArtifactCopy(kind: StrategyArtifactKind, items: StrategyArtifact[]): StrategyArtifact {
  return createNewArtifact(kind, items.filter((item) => item.kind === kind).length + 1);
}

export function createTemplateCopy(template: StrategyTemplate, items: StrategyArtifact[], now = Date.now()): StrategyArtifact {
  return {
    id: `strategy:tpl-copy-${now}`,
    kind: "strategy",
    name: dedupeArtifactName(template.name, items),
    description: template.description,
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    semanticVersion: "0.1.0",
    history: [],
    dependencies: [],
    provenance: { source: "local", parentId: template.id },
    xml: template.xml,
    code: "",
    createdAt: now,
    updatedAt: now
  };
}

export interface PineArtifactInput {
  kind: "indicator" | "strategy";
  name: string;
  xml: string;
  code: string;
  warnings: string[];
  source: string;
  language: import("@saltanatbotv2/pine-compiler").PineLanguageProfile;
  diagnostics: import("@saltanatbotv2/pine-compiler").PineDiagnostic[];
  report: import("@saltanatbotv2/pine-compiler").PineConversionReport;
  sourceMap: import("@saltanatbotv2/pine-compiler").PineSourceMapEntry[];
}

export function createPineArtifacts(inputs: PineArtifactInput[], items: StrategyArtifact[], now = Date.now()): StrategyArtifact[] {
  const taken = new Set(items.map((item) => item.name));
  return inputs.map((input, index) => {
    let name = input.name;
    let suffix = 2;
    while (taken.has(name)) name = `${input.name} (${suffix++})`;
    taken.add(name);
    return {
      id: `${input.kind}:pine-${now}-${index}`,
      kind: input.kind,
      name,
      description: `Imported from Pine Script${input.warnings.length ? ` (${input.warnings.length} fidelity warning${input.warnings.length === 1 ? "" : "s"})` : ""}.`,
      schemaVersion: ARTIFACT_SCHEMA_VERSION,
      semanticVersion: "0.1.0",
      history: [],
      dependencies: [],
      provenance: { source: "pine", importedAt: now },
      xml: input.xml,
      code: input.code,
      pine: {
        source: input.source,
        language: input.language,
        diagnostics: input.diagnostics,
        report: input.report,
        sourceMap: input.sourceMap
      },
      createdAt: now,
      updatedAt: now
    };
  });
}
