import type * as Blockly from "blockly/core";
import type { BoolExpr } from "../ir";
import { addError, type CompilerContext } from "./context";
import { compileNum, numInput } from "./numeric";

export function compileBool(block: Blockly.Block | null, ctx: CompilerContext): BoolExpr {
  if (!block) return { k: "bool", v: false };
  switch (block.type) {
    case "logic_boolean":
      return { k: "bool", v: block.getFieldValue("BOOL") === "TRUE" };
    case "logic_compare": {
      const map: Record<string, ">" | "<" | ">=" | "<=" | "==" | "!="> = {
        EQ: "==",
        NEQ: "!=",
        LT: "<",
        LTE: "<=",
        GT: ">",
        GTE: ">="
      };
      return { k: "compare", op: map[block.getFieldValue("OP")] ?? "==", a: numInput(block, "A", ctx), b: numInput(block, "B", ctx) };
    }
    case "logic_operation":
      return { k: "logic", op: block.getFieldValue("OP") === "OR" ? "or" : "and", a: boolInput(block, "A", ctx), b: boolInput(block, "B", ctx) };
    case "logic_negate":
      return { k: "not", a: boolInput(block, "BOOL", ctx) };
    case "cross_event":
      return { k: "cross", dir: block.getFieldValue("DIRECTION") === "below" ? "below" : "above", a: numInput(block, "A", ctx, true), b: numInput(block, "B", ctx, true) };
    case "series_trend":
      return { k: "trend", dir: block.getFieldValue("DIR") === "falling" ? "falling" : "rising", period: numInput(block, "PERIOD", ctx, true), source: numInput(block, "SOURCE", ctx, true) };
    case "value_between":
      return { k: "between", value: numInput(block, "VALUE", ctx), low: numInput(block, "LOW", ctx), high: numInput(block, "HIGH", ctx) };
    case "logic_isna":
      return { k: "isna", a: numInput(block, "A", ctx) };
    case "position_is": {
      const state = block.getFieldValue("STATE");
      const target = state === "long" ? 1 : state === "short" ? -1 : 0;
      return { k: "compare", op: "==", a: { k: "ctx", key: "position_dir" }, b: { k: "num", v: target } };
    }
    case "time_session":
      return { k: "session", start: Number(block.getFieldValue("START")) || 0, end: Number(block.getFieldValue("END")) || 23 };
    case "time_dayofweek":
      return { k: "dayofweek", day: Math.min(6, Math.max(0, Number(block.getFieldValue("DAY")) || 0)) };
    case "varb_get": {
      const varName = (block.getFieldValue("NAME") as string) || "flag";
      ctx.usedVars.add(varName);
      return { k: "varb", name: varName };
    }
    default:
      addError(ctx, `Expected a condition but found: ${block.type}`, block);
      return { k: "bool", v: false };
  }
}

export function boolInput(block: Blockly.Block, name: string, ctx: CompilerContext): BoolExpr {
  return compileBool(block.getInputTargetBlock(name), ctx);
}
