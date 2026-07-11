import type { BoolExpr } from "../ir";
import type { BlocklySerializationContext } from "./context";
import { block, field, value } from "./xml";

export function serializeBoolean(expr: BoolExpr, ctx: BlocklySerializationContext): string {
  switch (expr.k) {
    case "bool":
      return block("logic_boolean", field("BOOL", expr.v ? "TRUE" : "FALSE"));
    case "compare": {
      const operations: Record<string, string> = { "==": "EQ", "!=": "NEQ", "<": "LT", "<=": "LTE", ">": "GT", ">=": "GTE" };
      return block("logic_compare", field("OP", operations[expr.op]) + value("A", ctx.num(expr.a)) + value("B", ctx.num(expr.b)));
    }
    case "logic":
      return block("logic_operation", field("OP", expr.op === "or" ? "OR" : "AND") + value("A", ctx.bool(expr.a)) + value("B", ctx.bool(expr.b)));
    case "not":
      return block("logic_negate", value("BOOL", ctx.bool(expr.a)));
    case "cross": {
      if (expr.dir === "any") {
        const above: BoolExpr = { k: "cross", dir: "above", a: expr.a, b: expr.b };
        const below: BoolExpr = { k: "cross", dir: "below", a: expr.a, b: expr.b };
        return ctx.bool({ k: "logic", op: "or", a: above, b: below });
      }
      return block("cross_event", value("A", ctx.num(expr.a)) + field("DIRECTION", expr.dir) + value("B", ctx.num(expr.b)));
    }
    case "trend":
      return block("series_trend", field("DIR", expr.dir) + value("PERIOD", ctx.num(expr.period)) + value("SOURCE", ctx.num(expr.source)));
    case "between":
      return block("value_between", value("VALUE", ctx.num(expr.value)) + value("LOW", ctx.num(expr.low)) + value("HIGH", ctx.num(expr.high)));
    case "session":
      return block("time_session", field("START", expr.start) + field("END", expr.end));
    case "dayofweek":
      return block("time_dayofweek", field("DAY", expr.day));
    case "isna":
      return block("logic_isna", value("A", ctx.num(expr.a)));
    case "varb":
      return block("varb_get", field("NAME", expr.name));
  }
}
