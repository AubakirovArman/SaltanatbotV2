import type { BoolExpr, NumExpr, Stmt } from "../ir";
import type { PineExpr } from "./parser";
import type { PineValue } from "./semanticHelpers";

type PineSwitch = Extract<PineExpr, { t: "switch" }>;

export interface SwitchLoweringContext {
  bool(expr: PineExpr): BoolExpr;
  expressionStatement(expr: PineExpr): Stmt[];
  num(expr: PineExpr): NumExpr;
  string(expr: PineExpr): string | undefined;
  value(expr: PineExpr): PineValue;
  warnOnce(key: string, message: string): void;
}

/** Lower a Pine switch used as a numeric, boolean or static-string value. */
export function lowerSwitchValue(ctx: SwitchLoweringContext, expr: PineSwitch): PineValue {
  const defaultArm = expr.arms.find((arm) => arm.match === undefined);
  const cases = expr.arms.filter((arm) => arm.match !== undefined);
  const strings = expr.arms.map((arm) => ctx.string(arm.body));

  if (strings.every((value) => value !== undefined)) {
    const subject = expr.subject ? ctx.string(expr.subject) : undefined;
    if (subject !== undefined) {
      for (const arm of cases) {
        const match = arm.match ? ctx.string(arm.match) : undefined;
        if (match === subject) return { t: "str", v: ctx.string(arm.body) ?? "" };
      }
    }
    return { t: "str", v: defaultArm ? ctx.string(defaultArm.body) ?? "" : strings[0] ?? "" };
  }

  const anyBoolean = expr.arms.some((arm) => ctx.value(arm.body).t === "bool");
  if (anyBoolean) return lowerBooleanSwitch(ctx, expr, cases, defaultArm);
  return lowerNumericSwitch(ctx, expr, cases, defaultArm);
}

/** Lower a Pine switch used for side-effecting statements into an IR if-chain. */
export function lowerSwitchStatement(ctx: SwitchLoweringContext, expr: PineSwitch): Stmt[] {
  const defaultArm = expr.arms.find((arm) => arm.match === undefined);
  const cases = expr.arms.filter((arm) => arm.match !== undefined);
  if (!cases.length) return defaultArm ? ctx.expressionStatement(defaultArm.body) : [];

  const first = cases[0];
  const node: Extract<Stmt, { k: "if" }> = {
    k: "if",
    cond: armCondition(ctx, expr.subject, first.match as PineExpr),
    then: ctx.expressionStatement(first.body)
  };
  const elifs = cases.slice(1).map((arm) => ({
    cond: armCondition(ctx, expr.subject, arm.match as PineExpr),
    then: ctx.expressionStatement(arm.body)
  }));
  if (elifs.length) node.elifs = elifs;
  if (defaultArm) node.else = ctx.expressionStatement(defaultArm.body);
  return [node];
}

function lowerBooleanSwitch(
  ctx: SwitchLoweringContext,
  expr: PineSwitch,
  cases: PineSwitch["arms"],
  defaultArm: PineSwitch["arms"][number] | undefined
): PineValue {
  let result: BoolExpr = defaultArm ? ctx.bool(defaultArm.body) : { k: "bool", v: false };
  for (let index = cases.length - 1; index >= 0; index -= 1) {
    const condition = armCondition(ctx, expr.subject, cases[index].match as PineExpr);
    result = guardedBoolean(condition, ctx.bool(cases[index].body), result);
  }
  return { t: "bool", e: result };
}

function lowerNumericSwitch(
  ctx: SwitchLoweringContext,
  expr: PineSwitch,
  cases: PineSwitch["arms"],
  defaultArm: PineSwitch["arms"][number] | undefined
): PineValue {
  if (!defaultArm) ctx.warnOnce("switchdef", "switch without a default arm returns 0 for unmatched cases (Pine returns na).");
  let result: NumExpr = defaultArm ? ctx.num(defaultArm.body) : { k: "num", v: 0 };
  for (let index = cases.length - 1; index >= 0; index -= 1) {
    result = {
      k: "cond",
      cond: armCondition(ctx, expr.subject, cases[index].match as PineExpr),
      a: ctx.num(cases[index].body),
      b: result
    };
  }
  return { t: "num", e: result };
}

function armCondition(ctx: SwitchLoweringContext, subject: PineExpr | undefined, match: PineExpr): BoolExpr {
  if (!subject) return ctx.bool(match);
  return { k: "compare", op: "==", a: ctx.num(subject), b: ctx.num(match) };
}

function guardedBoolean(condition: BoolExpr, yes: BoolExpr, no: BoolExpr): BoolExpr {
  return {
    k: "logic",
    op: "or",
    a: { k: "logic", op: "and", a: condition, b: yes },
    b: { k: "logic", op: "and", a: { k: "not", a: condition }, b: no }
  };
}
