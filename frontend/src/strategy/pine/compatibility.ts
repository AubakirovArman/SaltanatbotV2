export const CYCLES_ANALYSIS_WARNINGS = [
  "Core percentage-based cycle detection, crest labels, phase shading, aggregate/percentile statistics, prediction zone, and reversal markers use the native chart preview.",
  "Duration/Both direction modes, minimum-duration enforcement, and stagnation visuals are not yet available in the native preview.",
  "Numeric and boolean Pine inputs are editable from the chart; text selectors currently stay at their imported defaults."
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
