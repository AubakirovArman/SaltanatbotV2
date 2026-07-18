import type { GaPromotionBundle } from "./gaEvolutionClient";
import { irToBlocklyXml } from "./irToXml";
import type { StrategyIR } from "./ir";
import { ARTIFACT_SCHEMA_VERSION } from "./library";
import type { PortableStrategyArtifact } from "./strategyFile";

const MAX_PROVENANCE_NOTE_LENGTH = 1_600;

/**
 * Convert a server-promoted evolution candidate through the same portable
 * import boundary as files, the wizard and the local generator. Provenance is
 * recorded twice: machine-readable (source "generator" + candidate fingerprint
 * as parentHash) and human-readable (seed, dataset fingerprint, engine and
 * generator versions, lineage depth and OOS evidence in the description).
 */
export function promotedGaCandidateToPortableArtifact(bundle: GaPromotionBundle, description: string): PortableStrategyArtifact {
  const ir = parsePromotedIr(bundle.ir);
  return {
    kind: "strategy",
    name: ir.name,
    description: `${description}\n${gaProvenanceNote(bundle)}`.slice(0, MAX_PROVENANCE_NOTE_LENGTH),
    xml: irToBlocklyXml(ir),
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    semanticVersion: "0.1.0",
    parameters: ir.inputs.map((input) => ({ ...input })),
    dependencies: [],
    provenance: { source: "generator", parentHash: bundle.fingerprint.slice(0, 128) }
  };
}

/** One bounded line of provenance evidence for the artifact description. */
export function gaProvenanceNote(bundle: GaPromotionBundle): string {
  const provenance = bundle.provenance;
  const parts = [`fingerprint ${bundle.fingerprint}`];
  if (provenance.seed !== undefined) parts.push(`seed ${provenance.seed}`);
  if (provenance.datasetFingerprint) parts.push(`dataset ${provenance.datasetFingerprint}`);
  if (provenance.engineVersion) parts.push(`engine ${provenance.engineVersion}`);
  if (provenance.generatorVersion) parts.push(`generator ${provenance.generatorVersion}`);
  if (provenance.lineage.length > 0) parts.push(`lineage ${provenance.lineage.length}`);
  const report = provenance.oosReport;
  if (report) {
    const worstGap = Object.values(report.gapPct).reduce((worst, gap) => (Number.isFinite(gap) && Math.abs(gap) > Math.abs(worst) ? gap : worst), 0);
    parts.push(`oos gap ${worstGap.toFixed(2)} overfit=${report.overfit} unstable=${report.unstable}`);
  }
  return parts.join(" · ");
}

/**
 * Structural gate before Blockly serialization: the server already validated
 * the IR, but a promoted bundle crosses the network, so the importer fails
 * closed on anything that is not a plausible StrategyIR document.
 */
function parsePromotedIr(value: Record<string, unknown>): StrategyIR {
  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (!name || name.length > 200 || !Array.isArray(value.inputs) || !Array.isArray(value.body)) {
    throw new Error("Promoted candidate IR is not a valid strategy document.");
  }
  for (const input of value.inputs) {
    const entry = input as { name?: unknown; value?: unknown };
    if (!entry || typeof entry.name !== "string" || typeof entry.value !== "number" || !Number.isFinite(entry.value)) {
      throw new Error("Promoted candidate IR inputs are invalid.");
    }
  }
  return value as unknown as StrategyIR;
}
