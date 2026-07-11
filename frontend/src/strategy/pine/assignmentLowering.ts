import type { BoolExpr, NumExpr, Stmt } from "../ir";
import { PineConvertError } from "./errors";
import { isConstNum } from "./expressionHistory";
import { DRAWING_NEW_RE, PLOT_CALLS } from "./language";
import type { PineExpr } from "./parser";
import { boolToNum, isCollectionConstructor, isObjectConstructor, type PineValue } from "./semanticHelpers";

export interface AssignmentLoweringContext {
  addBooleanVariable(name: string): void;
  addDrawingHandle(name: string): void;
  addInit(statement: Extract<Stmt, { k: "setvar" }>): void;
  addNumericVariable(name: string): void;
  addOpaqueVariable(name: string): void;
  bind(name: string, value: PineValue): void;
  bindColor(name: string, color: string | undefined): void;
  bindDrawingCollection(name: string): void;
  bindPlotHandle(name: string, plot: Extract<Stmt, { k: "plot" }> | undefined): void;
  bool(expr: PineExpr): BoolExpr;
  checkName(name: string): void;
  color(expr: PineExpr): string | undefined;
  expressionStatement(expr: PineExpr): Stmt[];
  isBooleanExpression(expr: PineExpr): boolean;
  isBooleanVariable(name: string): boolean;
  isColorExpression(expr: PineExpr): boolean;
  isDrawingCollection(expr: PineExpr): boolean;
  isNumericVariable(name: string): boolean;
  isReassigned(name: string): boolean;
  num(expr: PineExpr): NumExpr;
  registerCollection(name: string, call: Extract<PineExpr, { t: "call" }>): void;
  registerInput(name: string, call: Extract<PineExpr, { t: "call" }>): void;
  storageName(name: string): string;
  string(expr: PineExpr): string | undefined;
  value(expr: PineExpr): PineValue;
  warn(message: string): void;
  warnOnce(key: string, message: string): void;
}

export function lowerAssignment(
  ctx: AssignmentLoweringContext,
  name: string,
  value: PineExpr,
  declaredVar: boolean
): Stmt[] {
  const target = prepareTarget(ctx, name);
  if (value.t === "call" && (value.callee.startsWith("input.") || value.callee === "input")) {
    ctx.registerInput(target, value);
    return [];
  }
  if (value.t === "call" && PLOT_CALLS.has(value.callee)) {
    const statements = ctx.expressionStatement(value);
    ctx.bindPlotHandle(target, statements.find((node): node is Extract<Stmt, { k: "plot" }> => node.k === "plot"));
    return statements;
  }
  const special = lowerSpecialBinding(ctx, target, value);
  if (special) return special;
  if (ctx.isColorExpression(value)) {
    ctx.bindColor(target, ctx.color(value));
    return [];
  }
  const stringValue = ctx.string(value);
  if (stringValue !== undefined) {
    ctx.bind(target, { t: "str", v: stringValue });
    if (ctx.isReassigned(name) || ctx.isReassigned(target)) warnMutableString(ctx);
    return [];
  }
  const mutable = declaredVar || ctx.isReassigned(name) || ctx.isReassigned(target);
  if (!mutable) {
    ctx.bind(target, ctx.value(value));
    return [];
  }
  if (value.t === "ternary" && !ctx.isBooleanExpression(value)) {
    ctx.addNumericVariable(target);
    return [numericTernary(ctx, target, value)];
  }
  return initializeMutable(ctx, target, ctx.value(value), declaredVar);
}

export function lowerMutableAssignment(ctx: AssignmentLoweringContext, name: string, value: PineExpr): Stmt[] {
  const target = prepareTarget(ctx, name);
  const special = lowerSpecialBinding(ctx, target, value);
  if (special) return special;
  if (value.t === "ternary" && !ctx.isBooleanExpression(value)) {
    ctx.addNumericVariable(target);
    return [numericTernary(ctx, target, value)];
  }
  const resolved = ctx.value(value);
  if (resolved.t === "str") {
    ctx.bind(target, resolved);
    warnMutableString(ctx);
    return [];
  }
  if (ctx.isBooleanVariable(target) || (resolved.t === "bool" && !ctx.isNumericVariable(target))) {
    if (resolved.t !== "bool") throw new PineConvertError(`Variable "${target}" mixes boolean and numeric values.`);
    ctx.addBooleanVariable(target);
    return [{ k: "setvarb", name: target, value: resolved.e }];
  }
  if (resolved.t !== "num") throw new PineConvertError(`Variable "${target}" mixes boolean and numeric values.`);
  ctx.addNumericVariable(target);
  return [{ k: "setvar", name: target, value: resolved.e }];
}

function prepareTarget(ctx: AssignmentLoweringContext, name: string): string {
  const target = ctx.storageName(name);
  ctx.checkName(target);
  return target;
}

function lowerSpecialBinding(ctx: AssignmentLoweringContext, target: string, value: PineExpr): Stmt[] | undefined {
  if (value.t === "call" && DRAWING_NEW_RE.test(value.callee)) {
    ctx.addDrawingHandle(target);
    return ctx.expressionStatement(value);
  }
  if (ctx.isDrawingCollection(value)) {
    ctx.bindDrawingCollection(target);
    ctx.warnOnce("drawall", "Drawing object collections (box.all/label.all/line.all) are imported as opaque visual state.");
    return [];
  }
  if (value.t === "call" && isCollectionConstructor(value.callee)) {
    ctx.registerCollection(target, value);
    return [];
  }
  if (value.t === "call" && isObjectConstructor(value.callee)) {
    ctx.addOpaqueVariable(target);
    ctx.warnOnce("objects", "User-defined Pine objects are imported as opaque visual state; scalar plots are preserved where possible.");
    return [];
  }
  return undefined;
}

function initializeMutable(ctx: AssignmentLoweringContext, target: string, value: PineValue, declaredVar: boolean): Stmt[] {
  if (value.t === "str") {
    ctx.bind(target, value);
    warnMutableString(ctx);
    return [];
  }
  if (value.t === "bool") {
    ctx.addBooleanVariable(target);
    if (declaredVar) {
      ctx.addInit({ k: "setvar", name: target, value: boolToNum(value.e) });
      if (value.e.k !== "bool") ctx.warn(`var "${target}" initialized to false — series initializers run per-bar in Pine but once here.`);
      return [];
    }
    return [{ k: "setvarb", name: target, value: value.e }];
  }
  ctx.addNumericVariable(target);
  if (declaredVar) {
    if (!isConstNum(value.e)) ctx.warn(`var "${target}" is initialized from the first history bar here (Pine uses the first live bar).`);
    ctx.addInit({ k: "setvar", name: target, value: value.e });
    return [];
  }
  return [{ k: "setvar", name: target, value: value.e }];
}

function numericTernary(ctx: AssignmentLoweringContext, name: string, value: Extract<PineExpr, { t: "ternary" }>): Stmt {
  return {
    k: "if",
    cond: ctx.bool(value.cond),
    then: [{ k: "setvar", name, value: ctx.num(value.a) }],
    else: [{ k: "setvar", name, value: ctx.num(value.b) }]
  };
}

function warnMutableString(ctx: AssignmentLoweringContext): void {
  ctx.warnOnce("mutstr", "Mutable text/style variables are fixed to their imported values; drawing style edits are cosmetic.");
}
