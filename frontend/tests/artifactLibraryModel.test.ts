import { describe, expect, it } from "vitest";
import {
  artifactHash,
  artifactIrHash,
  createPineArtifacts,
  createTemplateCopy,
  dedupeArtifactName,
  diffArtifactVersions,
  rollbackArtifact,
  upsertArtifact
} from "../src/strategy/artifactLibraryModel";
import type { StrategyArtifact } from "../src/strategy/library";
import { importPineScript } from "../src/strategy/pine";

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
  it("fingerprints canonical IR independently of artifact presentation metadata", () => {
    const ir = { v: 4 as const, name: "A", inputs: [], body: [] };
    expect(artifactIrHash(ir)).toMatch(/^ir[0-9a-f]{8}$/);
    expect(artifactIrHash({ ...ir, name: "B" })).not.toBe(artifactIrHash(ir));
  });
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
    expect(changed.history).toMatchObject([{ version: 4, xml: "<xml />" }]);
  });

  it("diffs and rolls back immutable revisions as a new semantic version", () => {
    const original = artifact({ hash: artifactHash(artifact()), irHash: "ir-old", version: 1, semanticVersion: "1.0.0" });
    const changed = upsertArtifact([original], { ...original, xml: "<xml>changed</xml>", code: "new line", irHash: "ir-new" }, 40)[0];
    expect(diffArtifactVersions(changed, 1)).toMatchObject({ fromVersion: 1, toVersion: 2, added: ["new line"] });
    const restored = rollbackArtifact([changed], changed.id, 1, 50)[0];
    expect(restored).toMatchObject({ version: 3, semanticVersion: "1.0.2", xml: "<xml />", irHash: "ir-old" });
    expect(restored.history).toHaveLength(2);
  });

  it("deduplicates a Pine import against the library and within its batch", () => {
    const converted = importPineScript('//@version=6\nindicator("Momentum")\nplot(close)');
    if (!converted.ok) throw new Error(converted.error);
    const created = createPineArtifacts([
      { ...converted, kind: "indicator", name: "Momentum", xml: "a", code: "a", warnings: [] },
      { ...converted, kind: "strategy", name: "Momentum", xml: "b", code: "b", warnings: ["approx"] }
    ], [artifact()], 100);

    expect(created.map((item) => item.name)).toEqual(["Momentum (2)", "Momentum (3)"]);
    expect(created.map((item) => item.id)).toEqual(["indicator:pine-100-0", "strategy:pine-100-1"]);
    expect(created[1].description).toContain("1 fidelity warning");
    expect(created[0].pine).toMatchObject({ source: converted.source, language: { profile: "v6" } });
    expect(created[0].pine?.report.overall).toBe("display-only");
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
