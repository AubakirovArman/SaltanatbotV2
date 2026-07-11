import type { PineExpr, PineFuncDef, PineStmt } from "./parser";

export type PineSymbolKind = "variable" | "tuple" | "loop" | "parameter" | "function";

export interface PineSemanticScope {
  id: number;
  parentId?: number;
  depth: number;
  kind: "program" | "function" | "branch" | "loop";
}

export interface PineSemanticSymbol {
  name: string;
  kind: PineSymbolKind;
  scopeId: number;
  depth: number;
  mutable: boolean;
  shadows?: { scopeId: number; kind: PineSymbolKind };
}

export interface PineSemanticReference {
  name: string;
  scopeId: number;
  resolvedScopeId?: number;
  kind: "value" | "call";
}

export interface PineSemanticAnalysis {
  scopes: readonly PineSemanticScope[];
  symbols: readonly PineSemanticSymbol[];
  references: readonly PineSemanticReference[];
  functions: ReadonlyMap<string, PineFuncDef>;
  reassigned: ReadonlySet<string>;
}

/** Pure pre-lowering pass that records lexical structure and global function symbols. */
export function analyzePine(statements: PineStmt[]): PineSemanticAnalysis {
  const scopes: PineSemanticScope[] = [{ id: 0, depth: 0, kind: "program" }];
  const symbols: PineSemanticSymbol[] = [];
  const references: PineSemanticReference[] = [];
  const functions = new Map<string, PineFuncDef>();
  const reassigned = new Set<string>();
  const frames: Map<string, PineSemanticSymbol>[] = [new Map()];
  let scopeId = 0;

  // Pine user functions are program symbols and may be referenced before their definition.
  walkStatements(statements, (statement) => {
    if (statement.t === "func") functions.set(statement.def.name, statement.def);
    if (statement.t === "reassign") reassigned.add(statement.name);
  });
  for (const definition of functions.values()) declare(definition.name, "function", false, 0);
  visitStatements(statements, 0);

  return { scopes, symbols, references, functions, reassigned };

  function visitStatements(list: PineStmt[], currentScope: number): void {
    for (const statement of list) {
      switch (statement.t) {
        case "assign":
          visitExpression(statement.value, currentScope);
          declare(statement.name, "variable", statement.declaredVar || reassigned.has(statement.name), currentScope);
          break;
        case "reassign":
          reassigned.add(statement.name);
          reference(statement.name, "value", currentScope);
          visitExpression(statement.value, currentScope);
          break;
        case "tuple":
          visitExpression(statement.value, currentScope);
          for (const name of statement.names) declare(name, "tuple", reassigned.has(name), currentScope);
          break;
        case "expr":
          visitExpression(statement.value, currentScope);
          break;
        case "if":
          for (const clause of statement.clauses) {
            if (clause.cond) visitExpression(clause.cond, currentScope);
            withScope("branch", currentScope, (child) => visitStatements(clause.body, child));
          }
          break;
        case "for":
          visitExpression(statement.from, currentScope);
          visitExpression(statement.to, currentScope);
          if (statement.step) visitExpression(statement.step, currentScope);
          withScope("loop", currentScope, (child) => {
            declare(statement.var, "loop", false, child);
            visitStatements(statement.body, child);
          });
          break;
        case "while":
          visitExpression(statement.cond, currentScope);
          withScope("loop", currentScope, (child) => visitStatements(statement.body, child));
          break;
        case "func":
          withScope("function", 0, (child) => {
            for (const parameter of statement.def.params) {
              if (parameter.def) visitExpression(parameter.def, 0);
              declare(parameter.name, "parameter", false, child);
            }
            visitStatements(statement.def.body, child);
            if (statement.def.ret) visitExpression(statement.def.ret, child);
          });
          break;
        case "multi":
          visitStatements(statement.stmts, currentScope);
          break;
        default:
          break;
      }
    }
  }

  function visitExpression(expression: PineExpr, currentScope: number): void {
    switch (expression.t) {
      case "ident": reference(expression.name, "value", currentScope); break;
      case "binary": visitExpression(expression.a, currentScope); visitExpression(expression.b, currentScope); break;
      case "unary": visitExpression(expression.a, currentScope); break;
      case "ternary": visitExpression(expression.cond, currentScope); visitExpression(expression.a, currentScope); visitExpression(expression.b, currentScope); break;
      case "index": visitExpression(expression.base, currentScope); visitExpression(expression.offset, currentScope); break;
      case "field": visitExpression(expression.base, currentScope); break;
      case "method": visitExpression(expression.base, currentScope); for (const argument of expression.args) visitExpression(argument.value, currentScope); break;
      case "call": reference(expression.callee, "call", currentScope); for (const argument of expression.args) visitExpression(argument.value, currentScope); break;
      case "switch":
        if (expression.subject) visitExpression(expression.subject, currentScope);
        for (const arm of expression.arms) { if (arm.match) visitExpression(arm.match, currentScope); visitExpression(arm.body, currentScope); }
        break;
      case "tuplelit": for (const item of expression.items) visitExpression(item, currentScope); break;
      default: break;
    }
  }

  function declare(name: string, kind: PineSymbolKind, mutable: boolean, currentScope: number): void {
    const existing = resolve(name, currentScope);
    const scope = scopes[currentScope];
    const symbol: PineSemanticSymbol = { name, kind, scopeId: currentScope, depth: scope.depth, mutable, shadows: existing && existing.scopeId !== currentScope ? { scopeId: existing.scopeId, kind: existing.kind } : undefined };
    frames[currentScope].set(name, symbol);
    symbols.push(symbol);
  }

  function reference(name: string, kind: "value" | "call", currentScope: number): void {
    const resolved = kind === "call" ? functions.has(name) ? frames[0].get(name) : undefined : resolve(name, currentScope);
    references.push({ name, kind, scopeId: currentScope, resolvedScopeId: resolved?.scopeId });
  }

  function resolve(name: string, currentScope: number): PineSemanticSymbol | undefined {
    let cursor: number | undefined = currentScope;
    while (cursor !== undefined) {
      const found = frames[cursor].get(name);
      if (found) return found;
      cursor = scopes[cursor].parentId;
    }
    return undefined;
  }

  function withScope(kind: PineSemanticScope["kind"], parentId: number, work: (childId: number) => void): void {
    const id = ++scopeId;
    scopes.push({ id, parentId, depth: scopes[parentId].depth + 1, kind });
    frames[id] = new Map();
    work(id);
  }
}

function walkStatements(statements: PineStmt[], visit: (statement: PineStmt) => void): void {
  for (const statement of statements) {
    visit(statement);
    if (statement.t === "if") for (const clause of statement.clauses) walkStatements(clause.body, visit);
    else if (statement.t === "for" || statement.t === "while") walkStatements(statement.body, visit);
    else if (statement.t === "multi") walkStatements(statement.stmts, visit);
  }
}
