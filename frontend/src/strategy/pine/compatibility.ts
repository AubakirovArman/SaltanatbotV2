export const CYCLES_ANALYSIS_WARNINGS = [
  "Pine object/array/table state is executed by a native chart preview; the portable live-strategy runtime still treats those object identities as display-only.",
  "Table typography, percentile pairing, and drawing-object mutation are rendered with equivalent chart/HTML primitives rather than TradingView objects."
];

export function isCyclesAnalysisSource(source: string, name: string) {
  return /cycles analysis/i.test(name) &&
    source.includes("changeInDirectionPercentsInput") &&
    source.includes("showBackgroundInput");
}

/** Upgrade artifacts imported before the native Cycles preview was introduced so
 * the Lab does not keep showing dozens of obsolete generic-converter warnings. */
export function normalizeCyclesAnalysisArtifact<T extends { name: string; description: string; code?: string }>(artifact: T): T {
  if (!artifact.code || !isCyclesAnalysisSource(artifact.code, artifact.name)) return artifact;
  const header = warningHeader(CYCLES_ANALYSIS_WARNINGS);
  const code = artifact.code.replace(/^\/\/ Imported from Pine Script[^\n]*\n(?:\/\/ {2}• .*\n)*\n?/, header);
  const description = artifact.description.replace(
    /Imported from Pine Script(?: \(\d+ fidelity warnings?\))?\.?/,
    `Imported from Pine Script (${CYCLES_ANALYSIS_WARNINGS.length} compatibility notes).`
  );
  return { ...artifact, code, description };
}

export function warningHeader(warnings: string[]) {
  return warnings.length
    ? `// Imported from Pine Script — ${warnings.length} compatibility notes:\n${warnings.map((warning) => `//  • ${warning}`).join("\n")}\n\n`
    : "// Imported from Pine Script\n\n";
}
