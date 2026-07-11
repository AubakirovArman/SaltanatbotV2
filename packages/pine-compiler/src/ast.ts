/** Package-level public parser AST facade. Lowering code imports from here instead of coupling
 * consumers to the parser implementation module. */
export type { PineArg, PineExpr, PineFuncDef, PineStmt } from "./parser";
import type { PineStmt } from "./parser";

export type PineAst = PineStmt[];
