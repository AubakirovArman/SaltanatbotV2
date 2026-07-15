import { irToBlocklyXml } from "./irToXml";
import { ARTIFACT_SCHEMA_VERSION } from "./library";
import type { GeneratedStrategyCandidate } from "./generator";
import type { PortableStrategyArtifact } from "./strategyFile";

/** Convert a validated generator result through the same portable import boundary as files and the wizard. */
export function generatedCandidateToPortableArtifact(candidate: GeneratedStrategyCandidate, description: string): PortableStrategyArtifact {
  if (!candidate.validation.valid) throw new Error(`Cannot import an invalid generated strategy: ${candidate.validation.issues.join(", ")}`);
  return {
    kind: "strategy",
    name: candidate.ir.name,
    description,
    xml: irToBlocklyXml(candidate.ir),
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    semanticVersion: "0.1.0",
    parameters: candidate.ir.inputs.map((input) => ({ ...input })),
    dependencies: [],
    provenance: { source: "generator" }
  };
}
