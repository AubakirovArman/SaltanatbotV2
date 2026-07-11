import type { BoolExpr, Stmt } from "@saltanatbotv2/strategy-core";
import { arg, argRequired } from "./arguments";
import type { PineArg, PineExpr } from "./parser";
import { sanitizeText } from "./text";

export interface AlertStatementLoweringContext {
  bool(expr: PineExpr): BoolExpr;
  warn(message: string): void;
  warnOnce(key: string, message: string): void;
}

export function lowerAlertStatement(
  ctx: AlertStatementLoweringContext,
  callee: string,
  args: PineArg[]
): Stmt[] | undefined {
  if (callee === "alertcondition") {
    const title = arg(args, 1, "title")?.value;
    const messageArg = arg(args, 2, "message")?.value;
    const message = sanitizeText(messageArg?.t === "str" ? messageArg.v : title?.t === "str" ? title.v : "alert") || "alert";
    if (message.includes("{{")) ctx.warnOnce("tmpl", "TradingView {{placeholders}} in alert messages are kept as literal text.");
    return [{ k: "alert", message, when: ctx.bool(argRequired(args, 0, "condition", "alertcondition").value) }];
  }
  if (callee === "alert") {
    const messageArg = arg(args, 0, "message")?.value;
    const message = messageArg?.t === "str" ? sanitizeText(messageArg.v) : "alert";
    if (messageArg && messageArg.t !== "str") ctx.warn('alert() message must be a plain string — used "alert".');
    return [{ k: "alert", message: message || "alert", when: { k: "bool", v: true } }];
  }
  return undefined;
}
