import type { BoolExpr, NumExpr, Stmt } from "../ir";
import { arg } from "./arguments";
import { PineConvertError } from "./errors";
import { isConstNum } from "./expressionHistory";
import type { PineArg } from "./parser";
import { identName } from "./semanticHelpers";

export interface StrategyCallLoweringContext {
  bool(expr: import("./parser").PineExpr): BoolExpr;
  markEntry(direction: "long" | "short"): void;
  markExplicitExit(): void;
  num(expr: import("./parser").PineExpr): NumExpr;
  warn(message: string): void;
  warnOnce(key: string, message: string): void;
}

/** Return undefined when the callee is not a strategy command. */
export function lowerStrategyCall(
  ctx: StrategyCallLoweringContext,
  callee: string,
  args: PineArg[]
): Stmt[] | undefined {
  switch (callee) {
    case "strategy.entry":
    case "strategy.order":
      return lowerEntry(ctx, callee, args);
    case "strategy.close":
    case "strategy.close_all":
      ctx.markExplicitExit();
      return [{ k: "exit", when: optionalWhen(ctx, args) }];
    case "strategy.exit":
      return lowerExit(ctx, args);
    case "strategy.cancel":
    case "strategy.cancel_all":
      ctx.warn(`Skipped unsupported pending-order command: ${callee}().`);
      return [];
    default:
      if (callee.startsWith("strategy.risk.")) {
        throw new PineConvertError(`${callee}() can't be preserved by the current per-bar engine; importing it would weaken trading risk controls.`);
      }
      return undefined;
  }
}

function lowerEntry(ctx: StrategyCallLoweringContext, callee: string, args: PineArg[]): Stmt[] {
  if (callee === "strategy.order") ctx.warn("strategy.order treated as strategy.entry (market entry).");
  const directionName = identName(arg(args, 1, "direction")?.value) || "strategy.long";
  const direction: "long" | "short" = directionName.endsWith("short") ? "short" : "long";
  ctx.markEntry(direction);
  const statements: Stmt[] = [{ k: "entry", direction, when: optionalWhen(ctx, args) }];
  const quantity = arg(args, undefined, "qty");
  if (quantity) statements.push({ k: "size", mode: "units", value: ctx.num(quantity.value) });
  return statements;
}

function lowerExit(ctx: StrategyCallLoweringContext, args: PineArg[]): Stmt[] {
  const statements: Stmt[] = [];
  const stopArg = arg(args, undefined, "stop");
  const limitArg = arg(args, undefined, "limit");
  if (stopArg) {
    const stop = ctx.num(stopArg.value);
    if (!isConstNum(stop)) ctx.warnOnce("exitfreeze", "strategy.exit stop/limit prices are frozen at entry here (Pine re-evaluates them every bar).");
    statements.push({ k: "stop", mode: "price", value: stop });
  }
  if (limitArg) statements.push({ k: "target", mode: "price", value: ctx.num(limitArg.value) });
  for (const unsupported of ["profit", "loss", "trail_price", "trail_points", "trail_offset"]) {
    if (arg(args, undefined, unsupported)) {
      throw new PineConvertError(
        `strategy.exit ${unsupported}= (tick-based) is not supported — use stop=/limit= absolute prices, or rebuild with stop-loss/take-profit blocks.`
      );
    }
  }
  if (statements.length) ctx.markExplicitExit();
  else ctx.warn("strategy.exit had no stop=/limit= — nothing converted.");
  return statements;
}

function optionalWhen(ctx: StrategyCallLoweringContext, args: PineArg[]): BoolExpr {
  const when = arg(args, undefined, "when");
  return when ? ctx.bool(when.value) : { k: "bool", v: true };
}
