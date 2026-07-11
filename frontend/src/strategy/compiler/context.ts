import type * as Blockly from "blockly/core";
import type { NumExpr, StrategyInput } from "../ir";

export interface CompileDiagnostic {
  severity: "error" | "warning";
  message: string;
  blockId?: string;
  blockType?: string;
}

export interface CompilerContext {
  inputs: Map<string, StrategyInput>;
  errors: string[];
  diagnostics: CompileDiagnostic[];
  /** Variable names written by a `set variable` block anywhere in the strategy. */
  vars: Set<string>;
  /** Variable names read by a `get variable` block — checked against `vars`. */
  usedVars: Set<string>;
  /** Procedure definitions by name, for compile-time inlining of function calls. */
  procs: Map<string, Blockly.Block>;
  /** Function names currently being expanded, to detect recursion. */
  callStack: Set<string>;
  procArgs: Array<Map<string, NumExpr>>;
}

export function procName(block: Blockly.Block): string {
  const withCall = block as unknown as { getProcedureCall?: () => string };
  return withCall.getProcedureCall?.() ?? (block.getFieldValue("NAME") as string) ?? "";
}

export function addError(ctx: CompilerContext, message: string, block?: Blockly.Block | null) {
  ctx.errors.push(message);
  ctx.diagnostics.push({ severity: "error", message, blockId: block?.id, blockType: block?.type });
}
