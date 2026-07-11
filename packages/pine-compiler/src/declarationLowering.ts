import type { Stmt } from "@saltanatbotv2/strategy-core";
import { arg } from "./arguments";
import type { PineArg } from "./parser";
import { identName, isTrueIdent } from "./semanticHelpers";
import { sanitizeText } from "./text";

export interface DeclarationMetadata {
  kind: "indicator" | "strategy";
  name?: string;
  overlay: boolean;
}

export interface DeclarationLoweringContext {
  declare(metadata: DeclarationMetadata): void;
  warn(message: string): void;
}

export function lowerDeclaration(
  ctx: DeclarationLoweringContext,
  callee: string,
  args: PineArg[]
): Stmt[] | undefined {
  if (callee !== "indicator" && callee !== "study" && callee !== "strategy") return undefined;
  const title = arg(args, 0, "title")?.value;
  const name = title?.t === "str" ? sanitizeText(title.v) || undefined : undefined;
  const overlay = arg(args, undefined, "overlay");
  ctx.declare({ kind: callee === "strategy" ? "strategy" : "indicator", name, overlay: overlay ? isTrueIdent(overlay.value) : false });
  return callee === "strategy" ? strategyDefaults(ctx, args) : [];
}

function strategyDefaults(ctx: DeclarationLoweringContext, args: PineArg[]): Stmt[] {
  const statements: Stmt[] = [];
  const quantityType = identName(arg(args, undefined, "default_qty_type")?.value);
  const quantityValueExpression = arg(args, undefined, "default_qty_value")?.value;
  const quantityValue = quantityValueExpression?.t === "num" ? quantityValueExpression.v : undefined;
  if (quantityType.endsWith("percent_of_equity") && quantityValue !== undefined) {
    statements.push({ k: "size", mode: "equity_pct", value: { k: "num", v: quantityValue } });
  } else if (quantityType.endsWith("fixed") && quantityValue !== undefined) {
    statements.push({ k: "size", mode: "units", value: { k: "num", v: quantityValue } });
  } else if (quantityType.endsWith("cash")) {
    ctx.warn("strategy.cash sizing isn't supported — set position size explicitly.");
  }
  const pyramiding = arg(args, undefined, "pyramiding")?.value;
  if (pyramiding?.t === "num" && pyramiding.v > 0) ctx.warn(`pyramiding=${pyramiding.v} isn't supported — entries only fire when flat.`);
  if (arg(args, undefined, "process_orders_on_close")) ctx.warn("process_orders_on_close ignored — orders fill at the next bar's open here.");
  return statements;
}
