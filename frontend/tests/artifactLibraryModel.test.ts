import { describe, expect, it } from "vitest";
import {
  artifactHash,
  createPineArtifacts,
  createTemplateCopy,
  dedupeArtifactName,
  upsertArtifact
} from "../src/strategy/artifactLibraryModel";
import type { StrategyArtifact } from "../src/strategy/library";

const artifact = (overrides: Partial<StrategyArtifact> = {}): StrategyArtifact => ({
  id: "strategy:one",
  kind: "strategy",
  name: "Momentum",
  description: "Test",
  xml: "<xml />",
  code: "",
  createdAt: 10,
  updatedAt: 10,
  ...overrides
});

describe("artifact library model", () => {
  it("deduplicates names deterministically", () => {
    const items = [artifact(), artifact({ id: "strategy:two", name: "Momentum (2)" })];
    expect(dedupeArtifactName("Momentum", items)).toBe("Momentum (3)");
    expect(dedupeArtifactName("Breakout", items)).toBe("Breakout");
  });

  it("keeps the version for unchanged content and increments changed content", () => {
    const original = artifact({ hash: artifactHash(artifact()), version: 4 });
    const unchanged = upsertArtifact([original], { ...original, updatedAt: 20 }, 30)[0];
    const changed = upsertArtifact([original], { ...original, xml: "<xml>changed</xml>" }, 40)[0];

    expect(unchanged).toMatchObject({ version: 4, createdAt: 10, updatedAt: 30 });
    expect(changed).toMatchObject({ version: 5, createdAt: 10, updatedAt: 40 });
    expect(changed.hash).not.toBe(original.hash);
  });

  it("deduplicates a Pine import against the library and within its batch", () => {
    const created = createPineArtifacts([
      { kind: "indicator", name: "Momentum", xml: "a", code: "a", warnings: [] },
      { kind: "strategy", name: "Momentum", xml: "b", code: "b", warnings: ["approx"] }
    ], [artifact()], 100);

    expect(created.map((item) => item.name)).toEqual(["Momentum (2)", "Momentum (3)"]);
    expect(created.map((item) => item.id)).toEqual(["indicator:pine-100-0", "strategy:pine-100-1"]);
    expect(created[1].description).toContain("1 fidelity warning");
  });

  it("creates an editable template copy without mutating the template identity", () => {
    const copy = createTemplateCopy({
      id: "template:one",
      name: "Momentum",
      description: "Template",
      category: "Momentum",
      tags: [],
      xml: "<xml />"
    }, [artifact()], 200);

    expect(copy).toMatchObject({
      id: "strategy:tpl-copy-200",
      name: "Momentum (2)",
      kind: "strategy",
      createdAt: 200,
      updatedAt: 200
    });
  });
});
