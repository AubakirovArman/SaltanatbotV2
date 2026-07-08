import * as Blockly from "blockly/core";
import type { BoolExpr, MaKind, NumExpr, Stmt, StrategyInput, StrategyIR } from "./ir";
import type { PriceField } from "./ta";

interface Ctx {
  inputs: Map<string, StrategyInput>;
  errors: string[];
  vars: Set<string>;
}

export interface CompileResult {
  ir?: StrategyIR;
  errors: string[];
}

/** Compile a Blockly workspace into a safe JSON-IR (no eval, no code strings). */
export function compileWorkspace(workspace: Blockly.Workspace): CompileResult {
  const ctx: Ctx = { inputs: new Map(), errors: [], vars: new Set() };
  const root = workspace.getTopBlocks(true).find((block) => block.type === "strategy_start");
  if (!root) {
    return { errors: ["Add a Strategy block to define entry rules."] };
  }
  const name = (root.getFieldValue("NAME") as string) || "Untitled strategy";
  const body = compileStatements(root.getInputTargetBlock("RULES"), ctx);

  const hasEntry = body.some((stmt) => stmt.k === "entry" || (stmt.k === "if" && stmt.then.some((s) => s.k === "entry")));
  const hasMarker = body.some((stmt) => stmt.k === "marker" || (stmt.k === "if" && stmt.then.some((s) => s.k === "marker")));
  if (!hasEntry && !hasMarker) {
    ctx.errors.push("Strategy has no entry rule — add a Buy/Sell, Entry, or Mark signal.");
  }

  return {
    ir: { name, inputs: [...ctx.inputs.values()], body },
    errors: ctx.errors
  };
}

function compileStatements(first: Blockly.Block | null, ctx: Ctx): Stmt[] {
  const out: Stmt[] = [];
  let block: Blockly.Block | null = first;
  while (block) {
    if (block.isEnabled()) {
      const stmt = compileStatement(block, ctx);
      if (stmt) out.push(stmt);
    }
    block = block.getNextBlock();
  }
  return out;
}

function compileStatement(block: Blockly.Block, ctx: Ctx): Stmt | undefined {
  switch (block.type) {
    case "trade_action": {
      const action = block.getFieldValue("ACTION");
      const when = boolInput(block, "WHEN", ctx);
      if (action === "buy") return { k: "entry", direction: "long", when };
      if (action === "sell") return { k: "entry", direction: "short", when };
      if (action === "exit") return { k: "exit", when };
      return { k: "alert", message: "signal", when };
    }
    case "signal_entry":
      return { k: "entry", direction: block.getFieldValue("DIRECTION") === "short" ? "short" : "long", when: boolInput(block, "WHEN", ctx) };
    case "signal_exit":
      return { k: "exit", when: boolInput(block, "WHEN", ctx) };
    case "risk_stop":
      return { k: "stop", mode: riskMode(block), value: numInput(block, "VALUE", ctx) };
    case "risk_target":
      return { k: "target", mode: riskMode(block), value: numInput(block, "VALUE", ctx) };
    case "risk_trailing":
      return { k: "trail", mode: block.getFieldValue("MODE") === "atr" ? "atr" : "percent", value: numInput(block, "VALUE", ctx) };
    case "signal_marker":
      return {
        k: "marker",
        dir: block.getFieldValue("DIR") === "down" ? "down" : "up",
        label: (block.getFieldValue("LABEL") as string) ?? "",
        when: boolInput(block, "WHEN", ctx)
      };
    case "position_size":
      return { k: "size", mode: sizeMode(block), value: numInput(block, "VALUE", ctx) };
    case "var_set": {
      const varName = (block.getFieldValue("NAME") as string) || "x";
      ctx.vars.add(varName);
      return { k: "setvar", name: varName, value: numInput(block, "VALUE", ctx) };
    }
    case "alert_message":
      return { k: "alert", message: (block.getFieldValue("TEXT") as string) || "alert", when: boolInput(block, "WHEN", ctx) };
    case "flow_if":
      return { k: "if", cond: boolInput(block, "COND", ctx), then: compileStatements(block.getInputTargetBlock("DO"), ctx) };
    case "plot_series":
      return {
        k: "plot",
        value: numInput(block, "VALUE", ctx),
        label: (block.getFieldValue("LABEL") as string) || "series",
        color: (block.getFieldValue("COLOR") as string) || "#4db6ff"
      };
    default:
      ctx.errors.push(`Unsupported action block: ${block.type}`);
      return undefined;
  }
}

function compileNum(block: Blockly.Block | null, ctx: Ctx): NumExpr {
  if (!block) return { k: "num", v: 0 };
  switch (block.type) {
    case "math_number":
      return { k: "num", v: Number(block.getFieldValue("NUM")) || 0 };
    case "math_arithmetic": {
      const op = arithOp(block.getFieldValue("OP"), ctx);
      return { k: "arith", op, a: numInput(block, "A", ctx), b: numInput(block, "B", ctx) };
    }
    case "math_round": {
      const map: Record<string, "round" | "floor" | "ceil"> = { ROUND: "round", ROUNDUP: "ceil", ROUNDDOWN: "floor" };
      return { k: "unary", op: map[block.getFieldValue("OP")] ?? "round", a: numInput(block, "NUM", ctx) };
    }
    case "market_price":
      return { k: "price", field: priceField(block.getFieldValue("FIELD")) };
    case "market_price_offset":
      return { k: "price", field: priceField(block.getFieldValue("FIELD")), offset: Math.max(0, Number(block.getFieldValue("BARS")) || 0) };
    case "indicator_ma":
      return { k: "ma", kind: (block.getFieldValue("KIND") as MaKind) ?? "sma", period: numInput(block, "PERIOD", ctx), source: numInput(block, "SOURCE", ctx) };
    case "indicator_rsi":
      return { k: "rsi", period: numInput(block, "PERIOD", ctx), source: numInput(block, "SOURCE", ctx) };
    case "indicator_bollinger":
      return {
        k: "bollinger",
        band: (block.getFieldValue("BAND") as "upper" | "middle" | "lower") ?? "middle",
        period: numInput(block, "PERIOD", ctx),
        dev: numInput(block, "DEV", ctx),
        source: numInput(block, "SOURCE", ctx)
      };
    case "indicator_macd":
      return {
        k: "macd",
        line: (block.getFieldValue("LINE") as "macd" | "signal" | "histogram") ?? "macd",
        fast: numInput(block, "FAST", ctx),
        slow: numInput(block, "SLOW", ctx),
        signal: numInput(block, "SIGNAL", ctx),
        source: numInput(block, "SOURCE", ctx)
      };
    case "indicator_atr":
      return { k: "atr", period: numInput(block, "PERIOD", ctx) };
    case "indicator_stdev":
      return { k: "stdev", period: numInput(block, "PERIOD", ctx), source: numInput(block, "SOURCE", ctx) };
    case "indicator_extreme":
      return { k: "extreme", kind: block.getFieldValue("KIND") === "lowest" ? "lowest" : "highest", period: numInput(block, "PERIOD", ctx), source: numInput(block, "SOURCE", ctx) };
    case "indicator_change":
      return { k: "change", period: numInput(block, "PERIOD", ctx), source: numInput(block, "SOURCE", ctx) };
    case "indicator_stoch":
      return {
        k: "stoch",
        line: block.getFieldValue("LINE") === "d" ? "d" : "k",
        period: numInput(block, "PERIOD", ctx),
        smooth: { k: "num", v: Math.max(1, Number(block.getFieldValue("SMOOTH")) || 3) }
      };
    case "indicator_wpr":
      return { k: "wpr", period: numInput(block, "PERIOD", ctx) };
    case "indicator_cci":
      return { k: "cci", period: numInput(block, "PERIOD", ctx) };
    case "indicator_roc":
      return { k: "roc", period: numInput(block, "PERIOD", ctx), source: numInput(block, "SOURCE", ctx) };
    case "math_minmax":
      return { k: "minmax", op: block.getFieldValue("OP") === "min" ? "min" : "max", a: numInput(block, "A", ctx), b: numInput(block, "B", ctx) };
    case "param_number": {
      const paramName = (block.getFieldValue("NAME") as string) || "param";
      if (!ctx.inputs.has(paramName)) {
        ctx.inputs.set(paramName, { name: paramName, value: Number(block.getFieldValue("VALUE")) || 0 });
      }
      return { k: "input", name: paramName };
    }
    case "var_get":
      return { k: "var", name: (block.getFieldValue("NAME") as string) || "x" };
    default:
      ctx.errors.push(`Unsupported value block: ${block.type}`);
      return { k: "num", v: 0 };
  }
}

function compileBool(block: Blockly.Block | null, ctx: Ctx): BoolExpr {
  if (!block) return { k: "bool", v: false };
  switch (block.type) {
    case "logic_boolean":
      return { k: "bool", v: block.getFieldValue("BOOL") === "TRUE" };
    case "logic_compare": {
      const map: Record<string, ">" | "<" | ">=" | "<=" | "==" | "!="> = {
        EQ: "==", NEQ: "!=", LT: "<", LTE: "<=", GT: ">", GTE: ">="
      };
      return { k: "compare", op: map[block.getFieldValue("OP")] ?? "==", a: numInput(block, "A", ctx), b: numInput(block, "B", ctx) };
    }
    case "logic_operation":
      return { k: "logic", op: block.getFieldValue("OP") === "OR" ? "or" : "and", a: boolInput(block, "A", ctx), b: boolInput(block, "B", ctx) };
    case "logic_negate":
      return { k: "not", a: boolInput(block, "BOOL", ctx) };
    case "cross_event":
      return { k: "cross", dir: block.getFieldValue("DIRECTION") === "below" ? "below" : "above", a: numInput(block, "A", ctx), b: numInput(block, "B", ctx) };
    case "series_trend":
      return { k: "trend", dir: block.getFieldValue("DIR") === "falling" ? "falling" : "rising", period: numInput(block, "PERIOD", ctx), source: numInput(block, "SOURCE", ctx) };
    case "value_between":
      return { k: "between", value: numInput(block, "VALUE", ctx), low: numInput(block, "LOW", ctx), high: numInput(block, "HIGH", ctx) };
    case "time_session":
      return { k: "session", start: Number(block.getFieldValue("START")) || 0, end: Number(block.getFieldValue("END")) || 23 };
    case "time_dayofweek":
      return { k: "dayofweek", day: Math.min(6, Math.max(0, Number(block.getFieldValue("DAY")) || 0)) };
    default:
      ctx.errors.push(`Expected a condition but found: ${block.type}`);
      return { k: "bool", v: false };
  }
}

function numInput(block: Blockly.Block, name: string, ctx: Ctx): NumExpr {
  return compileNum(block.getInputTargetBlock(name), ctx);
}

function boolInput(block: Blockly.Block, name: string, ctx: Ctx): BoolExpr {
  return compileBool(block.getInputTargetBlock(name), ctx);
}

function arithOp(field: string, ctx: Ctx): "+" | "-" | "*" | "/" | "%" {
  switch (field) {
    case "ADD": return "+";
    case "MINUS": return "-";
    case "MULTIPLY": return "*";
    case "DIVIDE": return "/";
    default:
      ctx.errors.push(`Unsupported math operator: ${field}`);
      return "+";
  }
}

function priceField(field: string): PriceField {
  const allowed: PriceField[] = ["open", "high", "low", "close", "volume", "hl2", "hlc3", "ohlc4"];
  return allowed.includes(field as PriceField) ? (field as PriceField) : "close";
}

function riskMode(block: Blockly.Block): "price" | "percent" | "atr" {
  const mode = block.getFieldValue("MODE");
  return mode === "price" || mode === "atr" ? mode : "percent";
}

function sizeMode(block: Blockly.Block): "units" | "equity_pct" | "risk_pct" {
  const mode = block.getFieldValue("MODE");
  return mode === "units" || mode === "risk_pct" ? mode : "equity_pct";
}
