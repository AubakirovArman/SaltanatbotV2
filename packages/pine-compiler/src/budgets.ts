import type { StrategyIR } from "@saltanatbotv2/strategy-core";
import type { PineStmt } from "./ast";
import { PINE_BUDGETS, type PineBudgets } from "./budgetLimits";
import type { PineDiagnostic } from "./diagnostics";
import { PineConvertError } from "./errors";

export { PINE_BUDGETS, type PineBudgets } from "./budgetLimits";

export type PineBudgetLimits = Readonly<Record<keyof PineBudgets, number>>;

export interface PineAstBudgetUsage {
  nodes: number;
  nesting: number;
  loops: number;
  loopNesting: number;
}

export function assertSourceBudgets(source: string, limits: PineBudgetLimits = PINE_BUDGETS): void {
  if (source.length > limits.sourceChars) {
    throw budgetError(
      `Pine source has ${source.length} characters; the limit is ${limits.sourceChars}.`,
      "Reduce the script or split independent indicators before importing."
    );
  }
  const lines = source.length === 0 ? 0 : countLines(source);
  if (lines > limits.sourceLines) {
    throw budgetError(
      `Pine source has ${lines} lines; the limit is ${limits.sourceLines}.`,
      "Remove generated or unused lines before importing."
    );
  }
}

export function inspectAstBudget(ast: PineStmt[]): PineAstBudgetUsage {
  const usage: PineAstBudgetUsage = { nodes: 0, nesting: 0, loops: 0, loopNesting: 0 };

  const visit = (value: unknown, depth: number, activeLoops: number): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth, activeLoops);
      return;
    }
    if (!value || typeof value !== "object") return;

    const record = value as Record<string, unknown>;
    const isAstNode = typeof record.t === "string";
    const isLoop = record.t === "for" || record.t === "while";
    const nextDepth = isAstNode ? depth + 1 : depth;
    const nextLoops = isLoop ? activeLoops + 1 : activeLoops;
    if (isAstNode) {
      usage.nodes += 1;
      usage.nesting = Math.max(usage.nesting, nextDepth);
    }
    if (isLoop) {
      usage.loops += 1;
      usage.loopNesting = Math.max(usage.loopNesting, nextLoops);
    }
    for (const nested of Object.values(record)) visit(nested, nextDepth, nextLoops);
  };

  visit(ast, 0, 0);
  return usage;
}

export function assertAstBudgets(
  ast: PineStmt[],
  limits: PineBudgetLimits = PINE_BUDGETS
): PineAstBudgetUsage {
  const usage = inspectAstBudget(ast);
  assertWithin(usage.nodes, limits.astNodes, "AST nodes", "Simplify repeated expressions and control-flow branches.");
  assertWithin(usage.nesting, limits.astNesting, "AST nesting", "Flatten deeply nested expressions or blocks.");
  assertWithin(usage.loops, limits.loops, "loops", "Consolidate or remove generated loops.");
  assertWithin(usage.loopNesting, limits.loopNesting, "nested loops", "Flatten nested loops before importing.");
  return usage;
}

export function countGeneratedIrNodes(ir: StrategyIR): number {
  let count = 0;
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (typeof record.k === "string") count += 1;
    for (const nested of Object.values(record)) visit(nested);
  };
  visit(ir);
  return count;
}

export function assertGeneratedIrBudget(
  ir: StrategyIR,
  limits: PineBudgetLimits = PINE_BUDGETS
): number {
  const nodes = countGeneratedIrNodes(ir);
  assertWithin(nodes, limits.generatedIrNodes, "generated IR nodes", "Split the script into smaller artifacts before importing.");
  return nodes;
}

function assertWithin(actual: number, limit: number, label: string, remediation: string): void {
  if (actual > limit) throw budgetError(`Pine conversion produced ${actual} ${label}; the limit is ${limit}.`, remediation);
}

function budgetError(message: string, remediation: string): PineConvertError {
  const diagnostic: PineDiagnostic = {
    severity: "error",
    code: "PINE_RESOURCE_BUDGET",
    message,
    remediation
  };
  return new PineConvertError(message, diagnostic);
}

function countLines(source: string): number {
  let lines = 1;
  for (let index = 0; index < source.length; index += 1) {
    if (source.charCodeAt(index) === 10) lines += 1;
  }
  return lines;
}
