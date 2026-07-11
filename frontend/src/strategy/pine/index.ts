import { irToText } from "../irText";
import { irToBlocklyXml } from "../irToXml";
import { convertPine, PineConvertError, type PineResult } from "./convert";
import { CYCLES_ANALYSIS_WARNINGS, isCyclesAnalysisSource, warningHeader } from "./compatibility";
import { withCyclesAnalysisInputs } from "./cyclesAnalysisPreview";

/**
 * Public entry point: Pine Script source → an importable strategy/indicator
 * artifact (Blockly XML + readable code + fidelity warnings).
 *
 * The XML is the artifact's source of truth — the Lab loads it into Blockly and
 * recompiles, so a converted script is immediately editable as blocks. Every
 * conversion carries its warnings so the user can judge fidelity before
 * trusting the result with a backtest (and especially before live trading).
 */

export interface PineImport {
  ok: true;
  kind: "indicator" | "strategy";
  name: string;
  xml: string;
  code: string;
  warnings: string[];
}

export interface PineImportError {
  ok: false;
  error: string;
}

export function importPineScript(source: string): PineImport | PineImportError {
  let result: PineResult;
  try {
    result = convertPine(source);
  } catch (cause) {
    if (cause instanceof PineConvertError) return { ok: false, error: cause.message };
    return { ok: false, error: cause instanceof Error ? cause.message : "Conversion failed." };
  }
  const warnings = isCyclesAnalysisSource(source, result.name)
    ? CYCLES_ANALYSIS_WARNINGS
    : result.warnings;
  if (isCyclesAnalysisSource(source, result.name)) result.ir = withCyclesAnalysisInputs(result.ir);
  const header = warningHeader(warnings);
  return {
    ok: true,
    kind: result.kind,
    name: result.name,
    xml: irToBlocklyXml(result.ir),
    code: header + irToText(result.ir),
    warnings
  };
}
