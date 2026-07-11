import type { BoolExpr, NumExpr, Stmt } from "../ir";

export type InputDefaults = ReadonlyMap<string, number>;

export interface BlocklySerializationContext {
  bool(expr: BoolExpr): string;
  chain(statements: Stmt[]): string;
  defaults: InputDefaults;
  num(expr: NumExpr): string;
}
