import type { BoolExpr, NumExpr } from "@saltanatbotv2/strategy-core";
import { arg } from "./arguments";
import { DRAWING_NEW_RE, PINE_NAMESPACES, normalizeTa } from "./language";
import type { PineArg, PineExpr, PineStmt } from "./parser";

export type PineValue = { t: "num"; e: NumExpr } | { t: "bool"; e: BoolExpr } | { t: "str"; v: string };

export function identName(expr: PineExpr | undefined): string {
  return expr?.t === "ident" ? expr.name : "";
}

export function isNaIdent(expr: PineExpr): boolean {
  return expr.t === "ident" && expr.name === "na";
}

export function isTrueIdent(expr: PineExpr): boolean {
  return expr.t === "ident" && expr.name === "true";
}

export function isFalseIdent(expr: PineExpr): boolean {
  return expr.t === "ident" && expr.name === "false";
}

export function isCosmeticConst(name: string): boolean {
  return [
    "line.style_", "label.style_", "size.", "shape.", "location.", "display.",
    "barmerge.", "extend.", "position.", "xloc.", "yloc.", "plot.style_"
  ].some((prefix) => name.startsWith(prefix));
}

export function isUserObjectFieldName(name: string): boolean {
  if (!name.includes(".")) return false;
  return !PINE_NAMESPACES.has(name.split(".")[0]);
}

const COLLECTION_METHODS = new Set([
  "size", "length", "get", "first", "last", "set", "push", "pop", "shift", "unshift", "clear", "remove", "insert",
  "max", "min", "sum", "range", "sort", "reverse", "slice", "indexof", "includes",
  "rows", "columns", "add_row", "add_col", "put", "delete"
]);

export function isCollectionConstructor(callee: string): boolean {
  return callee === "array.from" || /^array\.new(?:_|$)/.test(callee) || /^matrix\.new(?:_|$)/.test(callee) || /^map\.new(?:_|$)/.test(callee);
}

export function isObjectConstructor(callee: string): boolean {
  if (!/^[A-Za-z_][A-Za-z0-9_]*\.new$/.test(callee)) return false;
  return !["array.", "matrix.", "map.", "color."].some((prefix) => callee.startsWith(prefix)) && !DRAWING_NEW_RE.test(callee);
}

export function methodName(callee: string): string {
  return callee.split(".").at(-1) ?? callee;
}

export function isCollectionCallName(callee: string): boolean {
  if (isCollectionConstructor(callee)) return false;
  if (/^(array|matrix|map)\./.test(callee)) return true;
  const head = callee.split(".")[0];
  if (["ta", "math", "str", "request", "timeframe", "input", "color", "strategy", "ticker", "syminfo"].includes(head)) return false;
  return callee.includes(".") && COLLECTION_METHODS.has(methodName(callee));
}

export function isObjectMethodCallName(callee: string): boolean {
  if (!callee.includes(".") || isCollectionCallName(callee) || DRAWING_NEW_RE.test(callee)) return false;
  const head = callee.split(".")[0];
  if (["ta", "math", "str", "request", "timeframe", "input", "color", "strategy", "ticker", "syminfo"].includes(head)) return false;
  const method = methodName(callee);
  return method.startsWith("set_") || method.startsWith("get_") || method === "delete" || method === "copy";
}

export function collectionReceiver(callee: string, args: PineArg[]): string | undefined {
  if (/^(array|matrix|map)\./.test(callee)) {
    const first = arg(args, 0, "id")?.value ?? arg(args, 0, "array")?.value ?? arg(args, 0, "matrix")?.value ?? arg(args, 0, "map")?.value;
    return first?.t === "ident" ? first.name : undefined;
  }
  const parts = callee.split(".");
  return parts.length > 1 ? parts.slice(0, -1).join(".") : undefined;
}

export function methodArgs(callee: string, args: PineArg[]): PineArg[] {
  return /^(array|matrix|map)\./.test(callee) ? args.slice(1) : args;
}

export function constBool(expr: BoolExpr): boolean | undefined {
  switch (expr.k) {
    case "bool": return expr.v;
    case "not": {
      const value = constBool(expr.a);
      return value === undefined ? undefined : !value;
    }
    case "logic": {
      const a = constBool(expr.a);
      const b = constBool(expr.b);
      if (expr.op === "and") {
        if (a === false || b === false) return false;
        if (a === true && b === true) return true;
      } else {
        if (a === true || b === true) return true;
        if (a === false && b === false) return false;
      }
      return undefined;
    }
    case "compare":
      if (expr.a.k === "num" && expr.b.k === "num") {
        switch (expr.op) {
          case "==": return expr.a.v === expr.b.v;
          case "!=": return expr.a.v !== expr.b.v;
          case ">": return expr.a.v > expr.b.v;
          case ">=": return expr.a.v >= expr.b.v;
          case "<": return expr.a.v < expr.b.v;
          case "<=": return expr.a.v <= expr.b.v;
        }
      }
      return undefined;
    default: return undefined;
  }
}

export function literalColorByte(expr: PineExpr | undefined): number | undefined {
  if (!expr) return undefined;
  const value = expr.t === "num" ? expr.v : expr.t === "unary" && expr.op === "-" && expr.a.t === "num" ? -expr.a.v : undefined;
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.min(255, Math.round(value)));
}

export function boolToNum(expr: BoolExpr): NumExpr {
  return expr.k === "bool" ? { k: "num", v: expr.v ? 1 : 0 } : { k: "num", v: 0 };
}

export function boolToNumericSeries(expr: BoolExpr): NumExpr {
  return { k: "cond", cond: expr, a: { k: "num", v: 1 }, b: { k: "num", v: 0 } };
}

export function collectReassigned(stmts: PineStmt[]): Set<string> {
  const out = new Set<string>();
  const walk = (list: PineStmt[]) => {
    for (const stmt of list) {
      if (stmt.t === "reassign") out.add(stmt.name);
      if (stmt.t === "if") for (const clause of stmt.clauses) walk(clause.body);
      if (stmt.t === "for" || stmt.t === "while") walk(stmt.body);
      if (stmt.t === "multi") walk(stmt.stmts);
    }
  };
  walk(stmts);
  return out;
}

export function isBoolExpr(expr: PineExpr, boolVars: Set<string>, env: Map<string, PineValue>): boolean {
  switch (expr.t) {
    case "binary": return ["and", "or", "==", "!=", "<", "<=", ">", ">="].includes(expr.op);
    case "unary": return expr.op === "not";
    case "ident": {
      if (expr.name === "true" || expr.name === "false" || expr.name.startsWith("barstate.") || expr.name.startsWith("timeframe.is")) return true;
      return env.get(expr.name)?.t === "bool" || boolVars.has(expr.name);
    }
    case "call": {
      const callee = normalizeTa(expr.callee);
      return callee === "na" || callee === "timeframe.change" || ["ta.crossover", "ta.crossunder", "ta.cross", "ta.rising", "ta.falling"].includes(callee);
    }
    case "ternary": return isBoolExpr(expr.a, boolVars, env) && isBoolExpr(expr.b, boolVars, env);
    case "switch": return expr.arms.every((arm) => isBoolExpr(arm.body, boolVars, env));
    default: return false;
  }
}
