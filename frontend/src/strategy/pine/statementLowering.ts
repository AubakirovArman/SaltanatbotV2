import type { BoolExpr, NumExpr, Stmt } from "../ir";
import { constBool } from "./semanticHelpers";
import type { PineExpr, PineFuncDef, PineStmt } from "./parser";

export interface StatementLoweringContext {
  assign(name: string, value: PineExpr, declaredVar: boolean): Stmt[];
  bool(expr: PineExpr): BoolExpr;
  checkName(name: string): void;
  expressionStatement(expr: PineExpr): Stmt[];
  lower(stmt: PineStmt): Stmt[];
  num(expr: PineExpr): NumExpr;
  registerFunction(definition: PineFuncDef): void;
  registerLoopVariable(name: string): void;
  setMutable(name: string, value: PineExpr): Stmt[];
  tuple(names: string[], value: PineExpr): Stmt[];
  warn(message: string): void;
  warnOnce(key: string, message: string): void;
}

export function lowerStatement(ctx: StatementLoweringContext, statement: PineStmt): Stmt[] {
  switch (statement.t) {
    case "version":
      return [];
    case "assign":
      return ctx.assign(statement.name, statement.value, statement.declaredVar);
    case "reassign":
      return ctx.setMutable(statement.name, desugarCompound(statement));
    case "tuple":
      return ctx.tuple(statement.names, statement.value);
    case "expr":
      return ctx.expressionStatement(statement.value);
    case "if":
      return lowerIfStatement(ctx, statement);
    case "for":
      return [lowerForStatement(ctx, statement)];
    case "while":
      return [{ k: "while", cond: ctx.bool(statement.cond), body: statement.body.flatMap((nested) => ctx.lower(nested)), cap: 1000 }];
    case "func":
      ctx.checkName(statement.def.name);
      ctx.registerFunction(statement.def);
      return [];
    case "multi":
      return statement.stmts.flatMap((nested) => ctx.lower(nested));
    case "unsupported":
      return lowerUnsupported(ctx, statement);
  }
}

function lowerForStatement(ctx: StatementLoweringContext, statement: Extract<PineStmt, { t: "for" }>): Stmt {
  ctx.checkName(statement.var);
  ctx.registerLoopVariable(statement.var);
  return {
    k: "for",
    var: statement.var,
    from: ctx.num(statement.from),
    to: ctx.num(statement.to),
    step: statement.step ? ctx.num(statement.step) : { k: "num", v: 1 },
    body: statement.body.flatMap((nested) => ctx.lower(nested)),
    cap: 10_000
  };
}

function lowerIfStatement(ctx: StatementLoweringContext, statement: Extract<PineStmt, { t: "if" }>): Stmt[] {
  let node: Extract<Stmt, { k: "if" }> | undefined;
  for (const clause of statement.clauses) {
    if (!clause.cond) {
      const body = clause.body.flatMap((nested) => ctx.lower(nested));
      if (!node) return body;
      node.else = body;
      return [node];
    }
    const condition = ctx.bool(clause.cond);
    const folded = constBool(condition);
    if (folded === false) continue;
    const body = clause.body.flatMap((nested) => ctx.lower(nested));
    if (folded === true) {
      if (!node) return body;
      node.else = body;
      return [node];
    }
    if (!node) node = { k: "if", cond: condition, then: body };
    else node.elifs = [...(node.elifs ?? []), { cond: condition, then: body }];
  }
  return node ? [node] : [];
}

function desugarCompound(statement: Extract<PineStmt, { t: "reassign" }>): PineExpr {
  if (statement.op === ":=") return statement.value;
  return { t: "binary", op: statement.op[0], a: { t: "ident", name: statement.name }, b: statement.value };
}

function lowerUnsupported(ctx: StatementLoweringContext, statement: Extract<PineStmt, { t: "unsupported" }>): Stmt[] {
  if (statement.what.startsWith("collection")) {
    ctx.warnOnce("collections", "Collections (arrays/matrices/maps) are imported as opaque visual state; unsupported collection operations are skipped.");
  } else if (statement.what === "type block") {
    ctx.warnOnce("types", "User-defined Pine object types are imported as opaque visual objects.");
  } else if (statement.what.startsWith("for…in")) {
    ctx.warnOnce("forin", "for…in collection loops are skipped; scalar for loops still convert.");
  } else {
    ctx.warn(`Skipped unsupported statement (“${statement.what}”, line ${statement.line}).`);
  }
  return [];
}
