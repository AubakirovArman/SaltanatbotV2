export const CYCLES_ANALYSIS_WARNINGS = [
  "Core percentage-based cycle detection, crest boundaries, phase shading, and reversal markers use the native chart preview.",
  "Duration/Both direction modes, minimum-duration enforcement, and stagnation visuals are not yet available in the native preview.",
  "Detailed crest labels, the aggregate/percentile table, and the prediction zone are not yet rendered.",
  "Text selectors stay at their Pine defaults; a chart-side editor for custom Pine inputs is not yet available."
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
