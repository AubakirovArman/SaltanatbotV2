import type { StrategyArtifact } from "./library";

export interface ArtifactDependencyGraph {
  nodes: Array<{ id: string; name: string; kind: StrategyArtifact["kind"] }>;
  edges: Array<{ from: string; to: string }>;
  missing: Array<{ from: string; to: string }>;
  cycles: string[][];
}

export function buildArtifactDependencyGraph(artifacts: readonly StrategyArtifact[]): ArtifactDependencyGraph {
  const ids = new Set(artifacts.map((artifact) => artifact.id));
  const edges: ArtifactDependencyGraph["edges"] = [];
  const missing: ArtifactDependencyGraph["missing"] = [];
  for (const artifact of artifacts) {
    for (const dependency of artifact.dependencies ?? []) {
      (ids.has(dependency) ? edges : missing).push({ from: artifact.id, to: dependency });
    }
  }
  return {
    nodes: artifacts.map(({ id, name, kind }) => ({ id, name, kind })),
    edges,
    missing,
    cycles: findCycles(artifacts, ids)
  };
}

export function canAddDependency(artifacts: readonly StrategyArtifact[], from: string, to: string): boolean {
  if (from === to || !artifacts.some((artifact) => artifact.id === to)) return false;
  const next = artifacts.map((artifact) => artifact.id === from
    ? { ...artifact, dependencies: [...new Set([...(artifact.dependencies ?? []), to])] }
    : artifact);
  return buildArtifactDependencyGraph(next).cycles.length === 0;
}

function findCycles(artifacts: readonly StrategyArtifact[], ids: Set<string>): string[][] {
  const adjacency = new Map(artifacts.map((artifact) => [artifact.id, (artifact.dependencies ?? []).filter((id) => ids.has(id))]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  const visit = (id: string) => {
    if (visiting.has(id)) {
      const start = stack.indexOf(id);
      cycles.push([...stack.slice(start), id]);
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    stack.push(id);
    for (const dependency of adjacency.get(id) ?? []) visit(dependency);
    stack.pop();
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of adjacency.keys()) visit(id);
  return cycles;
}
