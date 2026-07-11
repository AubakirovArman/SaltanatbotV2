import { describe, expect, it } from "vitest";
import { CYCLES_ANALYSIS_WARNINGS, normalizeCyclesAnalysisArtifact } from "../src/strategy/pine/compatibility";

describe("Cycles Analysis compatibility notes", () => {
  it("upgrades obsolete generic warning headers on saved artifacts", () => {
    const artifact = normalizeCyclesAnalysisArtifact({
      name: "Cycles Analysis",
      description: "Imported from Pine Script (42 fidelity warnings).",
      code: "// Imported from Pine Script — 42 fidelity warnings:\n//  • old warning\n\ninput changeInDirectionPercentsInput = 30\ninput showBackgroundInput = 1"
    });

    expect(artifact.description).toContain(`${CYCLES_ANALYSIS_WARNINGS.length} compatibility notes`);
    expect(artifact.code).toContain(`${CYCLES_ANALYSIS_WARNINGS.length} compatibility notes`);
    expect(artifact.code).not.toContain("old warning");
  });
});
