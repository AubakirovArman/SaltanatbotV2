import { IR_VERSION, type StrategyIR } from "@saltanatbotv2/strategy-core";
import { GENERATOR_LIMITS, type CandidateValidation, type CandidateValidationFlags } from "./types.js";

const ALLOWED_NODE_KINDS = new Set(["num", "input", "price", "ma", "rsi", "bollinger", "macd", "extreme", "roc", "cross", "size", "stop", "target", "entry", "exit"]);

/** Generator-specific fail-closed validation; this is narrower than the full StrategyIR schema. */
export function validateGeneratedStrategy(ir: StrategyIR): CandidateValidation {
  const inputNames = new Set<string>();
  let finiteInputs = ir.inputs.length <= GENERATOR_LIMITS.maxIrInputs;
  let boundedInputs = finiteInputs;
  for (const input of ir.inputs) {
    const values = [input.value, input.defaultValue ?? input.value, input.min ?? input.value, input.max ?? input.value, input.step ?? 1];
    if (!input.name || input.name.length > 64 || inputNames.has(input.name) || !values.every(Number.isFinite)) finiteInputs = false;
    inputNames.add(input.name);
    if ((input.min !== undefined && input.value < input.min) || (input.max !== undefined && input.value > input.max) || (input.min !== undefined && input.max !== undefined && input.min > input.max) || (input.step !== undefined && input.step <= 0)) boundedInputs = false;
  }

  const scan = scanNodes(ir, inputNames);
  const entries = ir.body.filter((statement) => statement.k === "entry");
  const exits = ir.body.filter((statement) => statement.k === "exit");
  const stops = ir.body.filter((statement) => statement.k === "stop");
  const targets = ir.body.filter((statement) => statement.k === "target");
  const sizes = ir.body.filter((statement) => statement.k === "size");
  const flags: CandidateValidationFlags = {
    schemaVersion: ir.v === IR_VERSION,
    finiteInputs,
    boundedInputs,
    supportedGrammar: scan.supportedGrammar && scan.allInputsDeclared,
    entryAndExit: entries.length === 1 && exits.length === 1 && (entries[0]?.direction === "long" || entries[0]?.direction === "short"),
    riskControls: stops.length === 1 && targets.length === 1 && sizes.length === 1,
    withinNodeBudget: scan.nodes <= GENERATOR_LIMITS.maxIrNodes && ir.body.length <= 8
  };
  const issues = Object.entries(flags)
    .filter(([, passed]) => !passed)
    .map(([flag]) => flag);
  return { valid: issues.length === 0, flags, issues };
}

function scanNodes(ir: StrategyIR, inputNames: ReadonlySet<string>): { nodes: number; supportedGrammar: boolean; allInputsDeclared: boolean } {
  const stack: unknown[] = [...ir.body];
  let nodes = 0;
  let supportedGrammar = true;
  let allInputsDeclared = true;
  while (stack.length) {
    const value = stack.pop();
    if (Array.isArray(value)) {
      stack.push(...value);
      continue;
    }
    if (!value || typeof value !== "object") continue;
    nodes += 1;
    if (nodes > GENERATOR_LIMITS.maxIrNodes) break;
    const object = value as Record<string, unknown>;
    if (typeof object.k === "string" && !ALLOWED_NODE_KINDS.has(object.k)) supportedGrammar = false;
    if (object.k === "input" && (typeof object.name !== "string" || !inputNames.has(object.name))) allInputsDeclared = false;
    stack.push(...Object.values(object));
  }
  return { nodes, supportedGrammar, allInputsDeclared };
}
