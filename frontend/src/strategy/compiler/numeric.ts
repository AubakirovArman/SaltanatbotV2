import type * as Blockly from "blockly/core";
import type { CtxKey, MaKind, NumExpr } from "../ir";
import type { PriceField } from "../ta";
import { addError, procName, type CompilerContext } from "./context";
import { boolInput, compileBool } from "./boolean";

export function compileNum(block: Blockly.Block | null, ctx: CompilerContext, vec = false): NumExpr {
  if (!block) return { k: "num", v: 0 };
  switch (block.type) {
    case "math_number":
      return { k: "num", v: Number(block.getFieldValue("NUM")) || 0 };
    case "math_arithmetic": {
      const op = arithOp(block.getFieldValue("OP"), ctx);
      return { k: "arith", op, a: numInput(block, "A", ctx, vec), b: numInput(block, "B", ctx, vec) };
    }
    case "math_round": {
      const map: Record<string, "round" | "floor" | "ceil"> = { ROUND: "round", ROUNDUP: "ceil", ROUNDDOWN: "floor" };
      return { k: "unary", op: map[block.getFieldValue("OP")] ?? "round", a: numInput(block, "NUM", ctx, vec) };
    }
    case "market_price":
      return { k: "price", field: priceField(block.getFieldValue("FIELD")) };
    case "market_price_offset":
      return { k: "price", field: priceField(block.getFieldValue("FIELD")), offset: Math.max(0, Number(block.getFieldValue("BARS")) || 0) };
    case "market_hist_dyn": {
      // Dynamic offset (may read a loop counter) — scalar-only, forbidden as a series input.
      if (vec) addError(ctx, "Dynamic history (variable bars-ago) can't be used inside an indicator/series input.", block);
      return { k: "histn", field: priceField(block.getFieldValue("FIELD")), offset: numInput(block, "OFFSET", ctx) };
    }
    case "market_time": {
      const session = ((block.getFieldValue("SESSION") as string) || "").trim();
      const timezone = ((block.getFieldValue("TIMEZONE") as string) || "").trim();
      return {
        k: "time",
        ...(session ? { session } : {}),
        ...(timezone ? { timezone } : {})
      };
    }
    case "market_security":
      return {
        k: "security",
        symbol: ((block.getFieldValue("SYMBOL") as string) || "current").slice(0, 64),
        timeframe: ((block.getFieldValue("TIMEFRAME") as string) || "chart").slice(0, 32),
        source: numInput(block, "SOURCE", ctx, true)
      };
    case "indicator_ma":
      return { k: "ma", kind: (block.getFieldValue("KIND") as MaKind) ?? "sma", period: numInput(block, "PERIOD", ctx, true), source: numInput(block, "SOURCE", ctx, true) };
    case "indicator_rsi":
      return { k: "rsi", period: numInput(block, "PERIOD", ctx, true), source: numInput(block, "SOURCE", ctx, true) };
    case "indicator_bollinger":
      return {
        k: "bollinger",
        band: (block.getFieldValue("BAND") as "upper" | "middle" | "lower") ?? "middle",
        period: numInput(block, "PERIOD", ctx, true),
        dev: numInput(block, "DEV", ctx, true),
        source: numInput(block, "SOURCE", ctx, true)
      };
    case "indicator_macd":
      return {
        k: "macd",
        line: (block.getFieldValue("LINE") as "macd" | "signal" | "histogram") ?? "macd",
        fast: numInput(block, "FAST", ctx, true),
        slow: numInput(block, "SLOW", ctx, true),
        signal: numInput(block, "SIGNAL", ctx, true),
        source: numInput(block, "SOURCE", ctx, true)
      };
    case "indicator_atr":
      return { k: "atr", period: numInput(block, "PERIOD", ctx, true) };
    case "indicator_stdev":
      return { k: "stdev", period: numInput(block, "PERIOD", ctx, true), source: numInput(block, "SOURCE", ctx, true) };
    case "indicator_extreme":
      return { k: "extreme", kind: block.getFieldValue("KIND") === "lowest" ? "lowest" : "highest", period: numInput(block, "PERIOD", ctx, true), source: numInput(block, "SOURCE", ctx, true) };
    case "indicator_change":
      return { k: "change", period: numInput(block, "PERIOD", ctx, true), source: numInput(block, "SOURCE", ctx, true) };
    case "indicator_stoch":
      return {
        k: "stoch",
        line: block.getFieldValue("LINE") === "d" ? "d" : "k",
        period: numInput(block, "PERIOD", ctx, true),
        smooth: { k: "num", v: Math.max(1, Number(block.getFieldValue("SMOOTH")) || 3) }
      };
    case "indicator_wpr":
      return { k: "wpr", period: numInput(block, "PERIOD", ctx, true) };
    case "indicator_cci":
      return { k: "cci", period: numInput(block, "PERIOD", ctx, true) };
    case "indicator_roc":
      return { k: "roc", period: numInput(block, "PERIOD", ctx, true), source: numInput(block, "SOURCE", ctx, true) };
    case "market_barindex":
      return { k: "barindex" };
    case "indicator_supertrend":
      return {
        k: "supertrend",
        line: block.getFieldValue("LINE") === "dir" ? "dir" : "value",
        factor: numInput(block, "FACTOR", ctx, true),
        period: numInput(block, "PERIOD", ctx, true)
      };
    case "indicator_dmi": {
      const line = block.getFieldValue("LINE");
      return {
        k: "dmi",
        line: line === "minus" || line === "adx" ? line : "plus",
        period: numInput(block, "PERIOD", ctx, true),
        smoothing: numInput(block, "SMOOTHING", ctx, true)
      };
    }
    case "indicator_vwap":
      return { k: "vwap" };
    case "indicator_linreg":
      return {
        k: "linreg",
        period: numInput(block, "PERIOD", ctx, true),
        source: numInput(block, "SOURCE", ctx, true),
        offset: Math.min(500, Math.max(0, Math.round(Number(block.getFieldValue("OFFSET")) || 0)))
      };
    case "indicator_valuewhen":
      return {
        k: "valuewhen",
        cond: boolInput(block, "COND", ctx),
        src: numInput(block, "SRC", ctx, true),
        occurrence: Math.min(100, Math.max(0, Math.round(Number(block.getFieldValue("OCCURRENCE")) || 0)))
      };
    case "indicator_extremebars":
      return {
        k: "extremebars",
        kind: block.getFieldValue("KIND") === "lowest" ? "lowest" : "highest",
        period: numInput(block, "PERIOD", ctx, true),
        source: numInput(block, "SOURCE", ctx, true)
      };
    case "indicator_mfi":
      return { k: "mfi", period: numInput(block, "PERIOD", ctx, true) };
    case "indicator_cmo":
      return { k: "cmo", period: numInput(block, "PERIOD", ctx, true), source: numInput(block, "SOURCE", ctx, true) };
    case "indicator_tsi":
      return {
        k: "tsi",
        short: numInput(block, "SHORT", ctx, true),
        long: numInput(block, "LONG", ctx, true),
        source: numInput(block, "SOURCE", ctx, true)
      };
    case "indicator_alma":
      return {
        k: "alma",
        period: numInput(block, "PERIOD", ctx, true),
        source: numInput(block, "SOURCE", ctx, true),
        offset: Math.min(1, Math.max(0, Number(block.getFieldValue("OFFSET")) || 0)),
        sigma: Math.min(100, Math.max(0.1, Number(block.getFieldValue("SIGMA")) || 6))
      };
    case "indicator_cog":
      return { k: "cog", period: numInput(block, "PERIOD", ctx, true), source: numInput(block, "SOURCE", ctx, true) };
    case "indicator_percentrank":
      return { k: "percentrank", period: numInput(block, "PERIOD", ctx, true), source: numInput(block, "SOURCE", ctx, true) };
    case "indicator_sar":
      return {
        k: "sar",
        start: numInput(block, "START", ctx, true),
        inc: numInput(block, "INC", ctx, true),
        max: numInput(block, "MAX", ctx, true)
      };
    case "indicator_kc":
      return {
        k: "kc",
        band: (block.getFieldValue("BAND") as "upper" | "middle" | "lower") ?? "middle",
        period: numInput(block, "PERIOD", ctx, true),
        mult: numInput(block, "MULT", ctx, true)
      };
    case "indicator_correlation":
      return {
        k: "correlation",
        a: numInput(block, "A", ctx, true),
        b: numInput(block, "B", ctx, true),
        period: numInput(block, "PERIOD", ctx, true)
      };
    case "math_minmax":
      return { k: "minmax", op: block.getFieldValue("OP") === "min" ? "min" : "max", a: numInput(block, "A", ctx, vec), b: numInput(block, "B", ctx, vec) };
    case "math_single_op": {
      const ops = new Set(["neg", "abs", "sign", "sqrt", "log", "log10", "exp"]);
      const op = block.getFieldValue("OP") as string;
      return { k: "unary", op: (ops.has(op) ? op : "abs") as "abs", a: numInput(block, "NUM", ctx, vec) };
    }
    case "math_modulo":
      return { k: "arith", op: "%", a: numInput(block, "A", ctx, vec), b: numInput(block, "B", ctx, vec) };
    case "series_agg":
      return {
        k: "agg",
        fn: (block.getFieldValue("FN") as "sum" | "avg" | "min" | "max" | "stdev" | "median") ?? "avg",
        src: numInput(block, "SOURCE", ctx, true),
        period: numInput(block, "PERIOD", ctx, true)
      };
    case "series_shift":
      return { k: "shift", src: numInput(block, "SOURCE", ctx, true), offset: Math.max(0, Number(block.getFieldValue("OFFSET")) || 0) };
    case "series_cum":
      return { k: "cum", src: numInput(block, "SOURCE", ctx, true) };
    case "series_barssince":
      return { k: "barssince", cond: boolInput(block, "COND", ctx) };
    case "math_cond":
      return { k: "cond", cond: boolInput(block, "COND", ctx), a: numInput(block, "A", ctx, vec), b: numInput(block, "B", ctx, vec) };
    case "math_nz":
      return { k: "nz", a: numInput(block, "A", ctx, vec), b: numInput(block, "B", ctx, vec) };
    case "var_prev": {
      const varName = (block.getFieldValue("NAME") as string) || "x";
      ctx.usedVars.add(varName);
      if (vec) addError(ctx, `Variable "${varName}" can't be used inside an indicator/series input.`, block);
      return { k: "varprev", name: varName };
    }
    case "param_number": {
      const paramName = (block.getFieldValue("NAME") as string) || "param";
      if (!ctx.inputs.has(paramName)) {
        const value = finiteField(block, "VALUE", 0);
        const min = finiteField(block, "MIN", value);
        const max = finiteField(block, "MAX", value);
        const step = finiteField(block, "STEP", 1);
        if (min > max) addError(ctx, `Input "${paramName}" minimum must be less than or equal to maximum.`, block);
        if (step <= 0) addError(ctx, `Input "${paramName}" step must be positive.`, block);
        if (value < min || value > max) addError(ctx, `Input "${paramName}" default must be within [${min}, ${max}].`, block);
        ctx.inputs.set(paramName, {
          name: paramName,
          value,
          defaultValue: value,
          min,
          max,
          step: step > 0 ? step : 1,
          optimizationEligible: block.getFieldValue("OPTIMIZE") !== "FALSE"
        });
      }
      return { k: "input", name: paramName };
    }
    case "var_get": {
      const varName = (block.getFieldValue("NAME") as string) || "x";
      ctx.usedVars.add(varName);
      if (vec) {
        addError(ctx, `Variable "${varName}" can't be used inside an indicator, cross, or series input — a variable has only its latest value, not a history.`, block);
      }
      return { k: "var", name: varName };
    }
    case "variables_get": {
      const id = String(block.getFieldValue("VAR") ?? "");
      const name = block.getField("VAR")?.getText() ?? id;
      for (let index = ctx.procArgs.length - 1; index >= 0; index -= 1) {
        const value = ctx.procArgs[index].get(id) ?? ctx.procArgs[index].get(name);
        if (value) return value;
      }
      addError(ctx, `Function parameter "${name}" is not bound at this call site.`, block);
      return { k: "num", v: 0 };
    }
    case "procedures_callreturn": {
      // Inline a value-returning function's RETURN expression at the call site.
      const name = procName(block);
      const def = ctx.procs.get(name);
      if (!def) {
        addError(ctx, `Unknown function: ${name || "(unnamed)"}`, block);
        return { k: "num", v: 0 };
      }
      if (ctx.callStack.has(name) || ctx.callStack.size >= 20) {
        addError(ctx, `Recursive or too-deeply-nested function: ${name}`, block);
        return { k: "num", v: 0 };
      }
      ctx.procArgs.push(procedureArguments(def, block, ctx, vec));
      ctx.callStack.add(name);
      const ret = compileNum(def.getInputTargetBlock("RETURN"), ctx, vec);
      ctx.callStack.delete(name);
      ctx.procArgs.pop();
      return ret;
    }
    case "ctx_read": {
      const keys: CtxKey[] = ["position_dir", "entry_price", "unrealized_pnl", "unrealized_pnl_pct", "bars_in_position", "last_trade_pnl", "consecutive_losses", "trades_today", "realized_today", "equity"];
      const key = block.getFieldValue("FIELD") as CtxKey;
      if (vec) addError(ctx, "Position/PnL reads can't be used inside an indicator or series input — they are single values, not history.", block);
      return { k: "ctx", key: keys.includes(key) ? key : "position_dir" };
    }
    default:
      addError(ctx, `Unsupported value block: ${block.type}`, block);
      return { k: "num", v: 0 };
  }
}

export function finiteField(block: Blockly.Block, name: string, fallback: number) {
  const value = Number(block.getFieldValue(name));
  return Number.isFinite(value) ? value : fallback;
}

export function procedureArguments(definition: Blockly.Block, call: Blockly.Block, ctx: CompilerContext, vec = false): Map<string, NumExpr> {
  // Blockly 13 exposes procedure parameters as variable models. Older
  // releases also supplied `getVars()`, so retain it as a compatibility
  // fallback for artifacts created with those versions.
  const models = definition.getVarModels();
  const legacyVars = (definition as unknown as { getVars?: () => string[] }).getVars?.() ?? [];
  const parameters = models.length ? models.map((model) => ({ id: model.getId(), name: model.getName() })) : legacyVars.map((value) => ({ id: value, name: definition.workspace.getVariableMap().getVariableById(value)?.getName() ?? value }));
  const map = new Map<string, NumExpr>();
  parameters.forEach(({ id, name }, index) => {
    const expression = compileNum(call.getInputTargetBlock(`ARG${index}`), ctx, vec);
    map.set(id, expression);
    if (name) map.set(name, expression);
  });
  return map;
}

export function numInput(block: Blockly.Block, name: string, ctx: CompilerContext, vec = false): NumExpr {
  return compileNum(block.getInputTargetBlock(name), ctx, vec);
}

export function arithOp(field: string, ctx: CompilerContext): "+" | "-" | "*" | "/" | "%" | "^" {
  switch (field) {
    case "ADD":
      return "+";
    case "MINUS":
      return "-";
    case "MULTIPLY":
      return "*";
    case "DIVIDE":
      return "/";
    case "POWER":
      return "^";
    default:
      addError(ctx, `Unsupported math operator: ${field}`);
      return "+";
  }
}

export function priceField(field: string): PriceField {
  const allowed: PriceField[] = ["open", "high", "low", "close", "volume", "hl2", "hlc3", "ohlc4"];
  return allowed.includes(field as PriceField) ? (field as PriceField) : "close";
}
