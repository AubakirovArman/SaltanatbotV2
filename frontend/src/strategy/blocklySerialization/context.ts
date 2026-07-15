import type { BoolExpr, NumExpr, Stmt, StrategyInput } from "../ir";

export type InputDefinitions = ReadonlyMap<string, StrategyInput>;

export interface BlocklySerializationContext {
  bool(expr: BoolExpr): string;
  chain(statements: Stmt[]): string;
  inputs: InputDefinitions;
  num(expr: NumExpr): string;
}
