import type { StrategyArtifact, StrategyArtifactKind } from "./library";
import { createNewArtifact } from "./library";
import type { StrategyTemplate } from "./templates";

export function dedupeArtifactName(name: string, items: StrategyArtifact[]): string {
  const taken = new Set(items.map((item) => item.name));
  if (!taken.has(name)) return name;
  let suffix = 2;
  while (taken.has(`${name} (${suffix})`)) suffix += 1;
  return `${name} (${suffix})`;
}

export function artifactHash(artifact: Pick<StrategyArtifact, "kind" | "name" | "xml" | "code">): string {
  const text = `${artifact.kind}\n${artifact.name}\n${artifact.xml}\n${artifact.code ?? ""}`;
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function stampArtifact(artifact: StrategyArtifact, existing?: StrategyArtifact): StrategyArtifact {
  const hash = artifactHash(artifact);
  const unchanged = existing?.hash === hash;
  return {
    ...artifact,
    hash,
    version: unchanged ? existing?.version ?? artifact.version ?? 1 : (existing?.version ?? 0) + 1
  };
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
      xml: input.xml,
      code: input.code,
      createdAt: now,
      updatedAt: now
    };
  });
}
