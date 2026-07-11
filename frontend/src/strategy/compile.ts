import * as Blockly from "blockly/core";
import { IR_VERSION } from "./ir";
import type { BoolExpr, CtxKey, MaKind, NumExpr, Stmt, StrategyInput, StrategyIR } from "./ir";
import type { PriceField } from "./ta";

interface Ctx {
  inputs: Map<string, StrategyInput>;
  errors: string[];
  /** Variable names written by a `set variable` block anywhere in the strategy. */
  vars: Set<string>;
  /** Variable names read by a `get variable` block — checked against `vars`. */
  usedVars: Set<string>;
  /** Procedure definitions by name, for compile-time inlining of function calls. */
  procs: Map<string, Blockly.Block>;
  /** Function names currently being expanded, to detect recursion. */
  callStack: Set<string>;
}

function procName(block: Blockly.Block): string {
  const withCall = block as unknown as { getProcedureCall?: () => string };
  return withCall.getProcedureCall?.() ?? (block.getFieldValue("NAME") as string) ?? "";
}

function hasProcParams(def: Blockly.Block): boolean {
  const withVars = def as unknown as { getVars?: () => string[] };
  return (withVars.getVars?.().length ?? 0) > 0;
}

export interface CompileResult {
  ir?: StrategyIR;
  errors: string[];
  /** Non-blocking advisories (e.g. reading a variable that is never set). */
  warnings?: string[];
}

/** Compile a Blockly workspace into a safe JSON-IR (no eval, no code strings). */
export function compileWorkspace(workspace: Blockly.Workspace): CompileResult {
  const ctx: Ctx = { inputs: new Map(), errors: [], vars: new Set(), usedVars: new Set(), procs: new Map(), callStack: new Set() };
  // Index function definitions so calls can be inlined at compile time (no runtime cost).
  for (const type of ["procedures_defnoreturn", "procedures_defreturn"]) {
    for (const def of workspace.getBlocksByType(type, false)) {
      const name = (def.getFieldValue("NAME") as string) || "";
      if (name && !ctx.procs.has(name)) ctx.procs.set(name, def);
    }
  }
  const root = workspace.getTopBlocks(true).find((block) => block.type === "strategy_start");
  if (!root) {
    return { errors: ["Add a Strategy block to define entry rules."] };
  }
  const name = (root.getFieldValue("NAME") as string) || "Untitled strategy";
  // "On start (once)" section — only `set variable` blocks are meaningful here.
  const initStmts = compileStatements(root.getInputTargetBlock("INIT"), ctx);
  for (const stmt of initStmts) {
    if (stmt.k !== "setvar") ctx.errors.push("The 'on start' section only accepts 'set variable' blocks.");
  }
  const init = initStmts.filter((stmt): stmt is Extract<Stmt, { k: "setvar" }> => stmt.k === "setvar");
  const body = compileStatements(root.getInputTargetBlock("RULES"), ctx);

  const hasEntry = containsStmt(body, "entry");
  const hasMarker = containsStmt(body, "marker");
  if (!hasEntry && !hasMarker) {
    ctx.errors.push("Strategy has no entry rule — add a Buy/Sell, Entry, or Mark signal.");
  }

  // Reading a variable that is never set reads 0 silently — flag the likely typo.
  const warnings: string[] = [];
  for (const name of ctx.usedVars) {
    if (!ctx.vars.has(name)) warnings.push(`Variable "${name}" is read but never set — it will always be 0.`);
  }

  return {
    ir: { name, inputs: [...ctx.inputs.values()], body, init: init.length ? init : undefined, v: IR_VERSION },
    errors: ctx.errors,
    warnings: warnings.length ? warnings : undefined
  };
}

/** Whether any statement (recursing into if/elseif/else branches) has the given kind. */
function containsStmt(stmts: Stmt[], kind: "entry" | "marker"): boolean {
  return stmts.some((stmt) => {
    if (stmt.k === kind) return true;
    if (stmt.k === "if") {
      return containsStmt(stmt.then, kind) || (stmt.elifs?.some((clause) => containsStmt(clause.then, kind)) ?? false) || (stmt.else ? containsStmt(stmt.else, kind) : false);
    }
    return false;
  });
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
    case "var_change": {
      // Desugar "change x by n" to "set x = x + n" — no new IR node needed.
      const varName = (block.getFieldValue("NAME") as string) || "x";
      ctx.vars.add(varName);
      return { k: "setvar", name: varName, value: { k: "arith", op: "+", a: { k: "var", name: varName }, b: numInput(block, "BY", ctx) } };
    }
    case "varb_set": {
      const varName = (block.getFieldValue("NAME") as string) || "flag";
      ctx.vars.add(varName);
      return { k: "setvarb", name: varName, value: boolInput(block, "VALUE", ctx) };
    }
    case "alert_message": {
      // Optional {a}/{b} value slots interpolated into the message text at fire time.
      const args: Record<string, NumExpr> = {};
      if (block.getInputTargetBlock("A")) args.a = numInput(block, "A", ctx);
      if (block.getInputTargetBlock("B")) args.b = numInput(block, "B", ctx);
      const alert: Extract<Stmt, { k: "alert" }> = {
        k: "alert",
        message: (block.getFieldValue("TEXT") as string) || "alert",
        when: boolInput(block, "WHEN", ctx)
      };
      if (Object.keys(args).length) alert.args = args;
      return alert;
    }
    case "flow_if":
      return { k: "if", cond: boolInput(block, "COND", ctx), then: compileStatements(block.getInputTargetBlock("DO"), ctx) };
    case "controls_if": {
      // Blockly's built-in if/else-if/else block: IF0/DO0, IF1/DO1, …, ELSE.
      const clauses: { cond: BoolExpr; then: Stmt[] }[] = [];
      let idx = 0;
      while (block.getInput(`IF${idx}`)) {
        clauses.push({ cond: boolInput(block, `IF${idx}`, ctx), then: compileStatements(block.getInputTargetBlock(`DO${idx}`), ctx) });
        idx += 1;
      }
      if (!clauses.length) return undefined;
      const elseStmts = block.getInput("ELSE") ? compileStatements(block.getInputTargetBlock("ELSE"), ctx) : [];
      const node: Extract<Stmt, { k: "if" }> = { k: "if", cond: clauses[0].cond, then: clauses[0].then };
      if (clauses.length > 1) node.elifs = clauses.slice(1);
      if (elseStmts.length) node.else = elseStmts;
      return node;
    }
    case "controls_repeat_ext":
      return { k: "repeat", count: numInput(block, "TIMES", ctx), body: compileStatements(block.getInputTargetBlock("DO"), ctx) };
    case "procedures_callnoreturn": {
      // Inline the called function's body (parameterless), wrapped in if(true) so a
      // single Stmt is returned. Recursion / parameters are rejected.
      const name = procName(block);
      const def = ctx.procs.get(name);
      if (!def) {
        ctx.errors.push(`Unknown function: ${name || "(unnamed)"}`);
        return undefined;
      }
      if (hasProcParams(def)) {
        ctx.errors.push(`Function "${name}" has parameters — parameters aren't supported yet.`);
        return undefined;
      }
      if (ctx.callStack.has(name)) {
        ctx.errors.push(`Recursive function not allowed: ${name}`);
        return undefined;
      }
      if (ctx.callStack.size >= 20) {
        ctx.errors.push(`Functions nested too deep near "${name}".`);
        return undefined;
      }
      ctx.callStack.add(name);
      const body = compileStatements(def.getInputTargetBlock("STACK"), ctx);
      ctx.callStack.delete(name);
      return { k: "if", cond: { k: "bool", v: true }, then: body };
    }
    case "controls_whileUntil": {
      const cond = boolInput(block, "BOOL", ctx);
      const until = block.getFieldValue("MODE") === "UNTIL";
      // Bounded by a hard iteration cap (and the per-bar op budget) for deterministic live execution.
      return { k: "while", cond: until ? { k: "not", a: cond } : cond, body: compileStatements(block.getInputTargetBlock("DO"), ctx), cap: 1000 };
    }
    case "for_range": {
      const name = (block.getFieldValue("NAME") as string) || "i";
      ctx.vars.add(name);
      return {
        k: "for",
        var: name,
        from: numInput(block, "FROM", ctx),
        to: numInput(block, "TO", ctx),
        step: numInput(block, "BY", ctx),
        body: compileStatements(block.getInputTargetBlock("DO"), ctx),
        cap: 10_000
      };
    }
    case "plot_series":
      // Plots are display-only and evaluated per bar in the chart preview (scalar),
      // never in the live/backtest series path — so stateful reads (vars, ctx,
      // dynamic history) are allowed here, unlike vectorized indicator sources.
      return {
        k: "plot",
        value: numInput(block, "VALUE", ctx, false),
        label: (block.getFieldValue("LABEL") as string) || "series",
        color: (block.getFieldValue("COLOR") as string) || "#4db6ff",
        pane: block.getFieldValue("PANE") === "sub" ? "sub" : "price"
      };
    case "draw_box":
      // Display-only (like plot): scalar per-bar evaluation, stateful reads allowed.
      return {
        k: "box",
        top: numInput(block, "TOP", ctx),
        bottom: numInput(block, "BOTTOM", ctx),
        when: boolInput(block, "WHEN", ctx),
        label: (block.getFieldValue("LABEL") as string) ?? "",
        color: (block.getFieldValue("COLOR") as string) || "#26a69a"
      };
    case "draw_vline":
      return {
        k: "vline",
        when: boolInput(block, "WHEN", ctx),
        label: (block.getFieldValue("LABEL") as string) ?? "",
        color: (block.getFieldValue("COLOR") as string) || "#8f9bb3"
      };
    case "draw_projection":
      return {
        k: "projection",
        left: numInput(block, "LEFT", ctx),
        right: numInput(block, "RIGHT", ctx),
        top: numInput(block, "TOP", ctx),
        bottom: numInput(block, "BOTTOM", ctx),
        when: boolInput(block, "WHEN", ctx),
        label: (block.getFieldValue("LABEL") as string) ?? "",
        color: (block.getFieldValue("COLOR") as string) || "#4db6ff"
      };
    case "table_metric":
      return {
        k: "metric",
        table: (block.getFieldValue("TABLE") as string) || "Statistics",
        column: (block.getFieldValue("COLUMN") as string) || "Value",
        label: (block.getFieldValue("LABEL") as string) || "Metric",
        value: numInput(block, "VALUE", ctx, false),
        when: boolInput(block, "WHEN", ctx)
      };
    case "draw_ray":
      return {
        k: "ray",
        price: numInput(block, "PRICE", ctx),
        when: boolInput(block, "WHEN", ctx),
        label: (block.getFieldValue("LABEL") as string) ?? "",
        color: (block.getFieldValue("COLOR") as string) || "#f7c948"
      };
    default:
      ctx.errors.push(`Unsupported action block: ${block.type}`);
      return undefined;
  }
}

/**
 * Compile a numeric block. `vec` marks a "vectorized" position — one whose value
 * is computed as a whole aligned series (indicator source/period, cross/trend
 * operands, minmax operands, plot value). A `get variable` in such a position
 * evaluates to an all-NaN series (a variable has only its latest scalar value,
 * not a per-bar history), so we reject it at compile time instead of silently
 * producing NaN. `vec` is inherited through arith/round and forced on for
 * indicator/series inputs.
 */
function compileNum(block: Blockly.Block | null, ctx: Ctx, vec = false): NumExpr {
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
      if (vec) ctx.errors.push("Dynamic history (variable bars-ago) can't be used inside an indicator/series input.");
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
      if (vec) ctx.errors.push(`Variable "${varName}" can't be used inside an indicator/series input.`);
      return { k: "varprev", name: varName };
    }
    case "param_number": {
      const paramName = (block.getFieldValue("NAME") as string) || "param";
      if (!ctx.inputs.has(paramName)) {
        ctx.inputs.set(paramName, { name: paramName, value: Number(block.getFieldValue("VALUE")) || 0 });
      }
      return { k: "input", name: paramName };
    }
    case "var_get": {
      const varName = (block.getFieldValue("NAME") as string) || "x";
      ctx.usedVars.add(varName);
      if (vec) {
        ctx.errors.push(`Variable "${varName}" can't be used inside an indicator, cross, or series input — a variable has only its latest value, not a history.`);
      }
      return { k: "var", name: varName };
    }
    case "procedures_callreturn": {
      // Inline a value-returning function's RETURN expression at the call site.
      const name = procName(block);
      const def = ctx.procs.get(name);
      if (!def) {
        ctx.errors.push(`Unknown function: ${name || "(unnamed)"}`);
        return { k: "num", v: 0 };
      }
      if (hasProcParams(def)) {
        ctx.errors.push(`Function "${name}" has parameters — parameters aren't supported yet.`);
        return { k: "num", v: 0 };
      }
      if (ctx.callStack.has(name) || ctx.callStack.size >= 20) {
        ctx.errors.push(`Recursive or too-deeply-nested function: ${name}`);
        return { k: "num", v: 0 };
      }
      ctx.callStack.add(name);
      const ret = compileNum(def.getInputTargetBlock("RETURN"), ctx, vec);
      ctx.callStack.delete(name);
      return ret;
    }
    case "ctx_read": {
      const keys: CtxKey[] = ["position_dir", "entry_price", "unrealized_pnl", "unrealized_pnl_pct", "bars_in_position", "last_trade_pnl", "consecutive_losses", "trades_today", "realized_today", "equity"];
      const key = block.getFieldValue("FIELD") as CtxKey;
      if (vec) ctx.errors.push("Position/PnL reads can't be used inside an indicator or series input — they are single values, not history.");
      return { k: "ctx", key: keys.includes(key) ? key : "position_dir" };
    }
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
      ctx.errors.push(`Expected a condition but found: ${block.type}`);
      return { k: "bool", v: false };
  }
}

function numInput(block: Blockly.Block, name: string, ctx: Ctx, vec = false): NumExpr {
  return compileNum(block.getInputTargetBlock(name), ctx, vec);
}

function boolInput(block: Blockly.Block, name: string, ctx: Ctx): BoolExpr {
  return compileBool(block.getInputTargetBlock(name), ctx);
}

function arithOp(field: string, ctx: Ctx): "+" | "-" | "*" | "/" | "%" | "^" {
  switch (field) {
    case "ADD": return "+";
    case "MINUS": return "-";
    case "MULTIPLY": return "*";
    case "DIVIDE": return "/";
    case "POWER": return "^";
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
