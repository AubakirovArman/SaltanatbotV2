import type { BoolExpr, NumExpr, Stmt, StrategyIR } from "./ir";

/**
 * Emit Blockly workspace XML from a StrategyIR, using the same block vocabulary
 * the Strategy Lab compiles back into IR. This is the bridge that makes
 * programmatically-generated strategies (e.g. the Pine Script converter) fully
 * editable as blocks: IR → XML → (user edits) → compileWorkspace → IR.
 *
 * Every construct emitted here MUST have a matching case in compile.ts. The
 * pine.test.ts round-trip test enforces that contract.
 */
export function irToBlocklyXml(ir: StrategyIR): string {
  const defaults = new Map(ir.inputs.map((input) => [input.name, input.value]));
  const init = chain(ir.init ?? [], defaults);
  const rules = chain(ir.body, defaults);
  return `<xml xmlns="https://developers.google.com/blockly/xml">
  <block type="strategy_start" x="24" y="24">
    <field name="NAME">${esc(ir.name)}</field>${init ? `\n    <statement name="INIT">${init}</statement>` : ""}
    <statement name="RULES">${rules}</statement>
  </block>
</xml>`;
}

/** Chain statements with <next> links; returns "" for an empty list. */
type Defaults = Map<string, number>;

function chain(stmts: Stmt[], d: Defaults): string {
  let out = "";
  for (let i = stmts.length - 1; i >= 0; i -= 1) {
    out = stmtXml(stmts[i], out, d);
  }
  return out;
}

function block(type: string, inner: string, next: string): string {
  return `<block type="${type}">${inner}${next ? `<next>${next}</next>` : ""}</block>`;
}

function field(name: string, value: string | number): string {
  return `<field name="${name}">${esc(String(value))}</field>`;
}

function value(name: string, inner: string): string {
  return `<value name="${name}">${inner}</value>`;
}

function statement(name: string, inner: string): string {
  return inner ? `<statement name="${name}">${inner}</statement>` : "";
}

function stmtXml(stmt: Stmt, next: string, d: Defaults): string {
  switch (stmt.k) {
    case "entry":
      return block("signal_entry", field("DIRECTION", stmt.direction) + value("WHEN", boolXml(stmt.when, d)), next);
    case "exit":
      return block("signal_exit", value("WHEN", boolXml(stmt.when, d)), next);
    case "stop":
      return block("risk_stop", field("MODE", stmt.mode) + value("VALUE", numXml(stmt.value, d)), next);
    case "target":
      return block("risk_target", field("MODE", stmt.mode) + value("VALUE", numXml(stmt.value, d)), next);
    case "trail":
      return block("risk_trailing", field("MODE", stmt.mode) + value("VALUE", numXml(stmt.value, d)), next);
    case "size":
      return block("position_size", field("MODE", stmt.mode) + value("VALUE", numXml(stmt.value, d)), next);
    case "setvar":
      return block("var_set", field("NAME", stmt.name) + value("VALUE", numXml(stmt.value, d)), next);
    case "setvarb":
      return block("varb_set", field("NAME", stmt.name) + value("VALUE", boolXml(stmt.value, d)), next);
    case "alert": {
      let inner = field("TEXT", stmt.message);
      if (stmt.args?.a) inner += value("A", numXml(stmt.args.a, d));
      if (stmt.args?.b) inner += value("B", numXml(stmt.args.b, d));
      inner += value("WHEN", boolXml(stmt.when, d));
      return block("alert_message", inner, next);
    }
    case "plot":
      return block(
        "plot_series",
        value("VALUE", numXml(stmt.value, d)) + field("LABEL", stmt.label) + field("COLOR", stmt.color) + field("PANE", stmt.pane === "sub" ? "sub" : "price"),
        next
      );
    case "marker":
      return block("signal_marker", field("DIR", stmt.dir) + field("LABEL", stmt.label) + value("WHEN", boolXml(stmt.when, d)), next);
    case "box":
      return block(
        "draw_box",
        field("LABEL", stmt.label) + field("COLOR", stmt.color) + value("TOP", numXml(stmt.top, d)) + value("BOTTOM", numXml(stmt.bottom, d)) + value("WHEN", boolXml(stmt.when, d)),
        next
      );
    case "vline":
      return block("draw_vline", field("LABEL", stmt.label) + field("COLOR", stmt.color) + value("WHEN", boolXml(stmt.when, d)), next);
    case "ray":
      return block("draw_ray", field("LABEL", stmt.label) + field("COLOR", stmt.color) + value("PRICE", numXml(stmt.price, d)) + value("WHEN", boolXml(stmt.when, d)), next);
    case "if": {
      const elifs = stmt.elifs ?? [];
      const hasElse = !!stmt.else?.length;
      let inner = "";
      if (elifs.length || hasElse) {
        inner += `<mutation elseif="${elifs.length}"${hasElse ? ' else="1"' : ""}></mutation>`;
      }
      inner += value("IF0", boolXml(stmt.cond, d)) + statement("DO0", chain(stmt.then, d));
      elifs.forEach((clause, i) => {
        inner += value(`IF${i + 1}`, boolXml(clause.cond, d)) + statement(`DO${i + 1}`, chain(clause.then, d));
      });
      if (hasElse) inner += statement("ELSE", chain(stmt.else ?? [], d));
      return block("controls_if", inner, next);
    }
    case "repeat":
      return block("controls_repeat_ext", value("TIMES", numXml(stmt.count, d)) + statement("DO", chain(stmt.body, d)), next);
    case "while":
      return block("controls_whileUntil", field("MODE", "WHILE") + value("BOOL", boolXml(stmt.cond, d)) + statement("DO", chain(stmt.body, d)), next);
    case "for":
      return block(
        "for_range",
        field("NAME", stmt.var) + value("FROM", numXml(stmt.from, d)) + value("TO", numXml(stmt.to, d)) + value("BY", numXml(stmt.step, d)) + statement("DO", chain(stmt.body, d)),
        next
      );
  }
}

function numXml(expr: NumExpr, d: Defaults): string {
  switch (expr.k) {
    case "num":
      return block("math_number", field("NUM", expr.v), "");
    case "input":
      // VALUE holds the default; compile.ts takes the first occurrence per name.
      return block("param_number", field("NAME", expr.name) + field("VALUE", d.get(expr.name) ?? 0), "");
    case "var":
      return block("var_get", field("NAME", expr.name), "");
    case "price":
      return expr.offset
        ? block("market_price_offset", field("FIELD", expr.field) + field("BARS", expr.offset), "")
        : block("market_price", field("FIELD", expr.field), "");
    case "ma":
      return block("indicator_ma", field("KIND", expr.kind) + value("PERIOD", numXml(expr.period, d)) + value("SOURCE", numXml(expr.source, d)), "");
    case "rsi":
      return block("indicator_rsi", value("PERIOD", numXml(expr.period, d)) + value("SOURCE", numXml(expr.source, d)), "");
    case "bollinger":
      return block(
        "indicator_bollinger",
        field("BAND", expr.band) + value("PERIOD", numXml(expr.period, d)) + value("DEV", numXml(expr.dev, d)) + value("SOURCE", numXml(expr.source, d)),
        ""
      );
    case "macd":
      return block(
        "indicator_macd",
        field("LINE", expr.line) + value("FAST", numXml(expr.fast, d)) + value("SLOW", numXml(expr.slow, d)) + value("SIGNAL", numXml(expr.signal, d)) + value("SOURCE", numXml(expr.source, d)),
        ""
      );
    case "atr":
      return block("indicator_atr", value("PERIOD", numXml(expr.period, d)), "");
    case "stdev":
      return block("indicator_stdev", value("PERIOD", numXml(expr.period, d)) + value("SOURCE", numXml(expr.source, d)), "");
    case "extreme":
      return block("indicator_extreme", field("KIND", expr.kind) + value("PERIOD", numXml(expr.period, d)) + value("SOURCE", numXml(expr.source, d)), "");
    case "change":
      return block("indicator_change", value("PERIOD", numXml(expr.period, d)) + value("SOURCE", numXml(expr.source, d)), "");
    case "stoch": {
      const smooth = expr.smooth.k === "num" ? Math.max(1, Math.round(expr.smooth.v)) : 3;
      return block("indicator_stoch", field("LINE", expr.line) + value("PERIOD", numXml(expr.period, d)) + field("SMOOTH", smooth), "");
    }
    case "wpr":
      return block("indicator_wpr", value("PERIOD", numXml(expr.period, d)), "");
    case "cci":
      return block("indicator_cci", value("PERIOD", numXml(expr.period, d)), "");
    case "roc":
      return block("indicator_roc", value("PERIOD", numXml(expr.period, d)) + value("SOURCE", numXml(expr.source, d)), "");
    case "minmax":
      return block("math_minmax", field("OP", expr.op) + value("A", numXml(expr.a, d)) + value("B", numXml(expr.b, d)), "");
    case "agg":
      return block("series_agg", field("FN", expr.fn) + value("SOURCE", numXml(expr.src, d)) + value("PERIOD", numXml(expr.period, d)), "");
    case "shift":
      return block("series_shift", value("SOURCE", numXml(expr.src, d)) + field("OFFSET", expr.offset), "");
    case "ctx":
      return block("ctx_read", field("FIELD", expr.key), "");
    case "cond":
      return block("math_cond", value("COND", boolXml(expr.cond, d)) + value("A", numXml(expr.a, d)) + value("B", numXml(expr.b, d)), "");
    case "nz":
      return block("math_nz", value("A", numXml(expr.a, d)) + value("B", numXml(expr.b, d)), "");
    case "cum":
      return block("series_cum", value("SOURCE", numXml(expr.src, d)), "");
    case "barssince":
      return block("series_barssince", value("COND", boolXml(expr.cond, d)), "");
    case "varprev":
      return block("var_prev", field("NAME", expr.name), "");
    case "histn":
      return block("market_hist_dyn", field("FIELD", expr.field) + value("OFFSET", numXml(expr.offset, d)), "");
    case "barindex":
      return block("market_barindex", "", "");
    case "valuewhen":
      return block(
        "indicator_valuewhen",
        field("OCCURRENCE", expr.occurrence) + value("SRC", numXml(expr.src, d)) + value("COND", boolXml(expr.cond, d)),
        ""
      );
    case "extremebars":
      return block("indicator_extremebars", field("KIND", expr.kind) + value("PERIOD", numXml(expr.period, d)) + value("SOURCE", numXml(expr.source, d)), "");
    case "linreg":
      return block("indicator_linreg", field("OFFSET", expr.offset) + value("PERIOD", numXml(expr.period, d)) + value("SOURCE", numXml(expr.source, d)), "");
    case "vwap":
      return block("indicator_vwap", "", "");
    case "supertrend":
      return block("indicator_supertrend", field("LINE", expr.line) + value("FACTOR", numXml(expr.factor, d)) + value("PERIOD", numXml(expr.period, d)), "");
    case "dmi":
      return block("indicator_dmi", field("LINE", expr.line) + value("PERIOD", numXml(expr.period, d)) + value("SMOOTHING", numXml(expr.smoothing, d)), "");
    case "mfi":
      return block("indicator_mfi", value("PERIOD", numXml(expr.period, d)), "");
    case "cmo":
      return block("indicator_cmo", value("PERIOD", numXml(expr.period, d)) + value("SOURCE", numXml(expr.source, d)), "");
    case "tsi":
      return block(
        "indicator_tsi",
        value("SHORT", numXml(expr.short, d)) + value("LONG", numXml(expr.long, d)) + value("SOURCE", numXml(expr.source, d)),
        ""
      );
    case "alma":
      return block(
        "indicator_alma",
        field("OFFSET", expr.offset) + field("SIGMA", expr.sigma) + value("PERIOD", numXml(expr.period, d)) + value("SOURCE", numXml(expr.source, d)),
        ""
      );
    case "cog":
      return block("indicator_cog", value("PERIOD", numXml(expr.period, d)) + value("SOURCE", numXml(expr.source, d)), "");
    case "percentrank":
      return block("indicator_percentrank", value("PERIOD", numXml(expr.period, d)) + value("SOURCE", numXml(expr.source, d)), "");
    case "sar":
      return block(
        "indicator_sar",
        value("START", numXml(expr.start, d)) + value("INC", numXml(expr.inc, d)) + value("MAX", numXml(expr.max, d)),
        ""
      );
    case "kc":
      return block("indicator_kc", field("BAND", expr.band) + value("PERIOD", numXml(expr.period, d)) + value("MULT", numXml(expr.mult, d)), "");
    case "arith": {
      if (expr.op === "%") {
        return block("math_modulo", value("A", numXml(expr.a, d)) + value("B", numXml(expr.b, d)), "");
      }
      const map: Record<string, string> = { "+": "ADD", "-": "MINUS", "*": "MULTIPLY", "/": "DIVIDE", "^": "POWER" };
      return block("math_arithmetic", field("OP", map[expr.op]) + value("A", numXml(expr.a, d)) + value("B", numXml(expr.b, d)), "");
    }
    case "unary": {
      const single = new Set(["abs", "neg", "sign", "sqrt", "log", "log10", "exp"]);
      if (single.has(expr.op)) {
        return block("math_single_op", field("OP", expr.op) + value("NUM", numXml(expr.a, d)), "");
      }
      const map: Record<string, string> = { round: "ROUND", ceil: "ROUNDUP", floor: "ROUNDDOWN" };
      return block("math_round", field("OP", map[expr.op]) + value("NUM", numXml(expr.a, d)), "");
    }
  }
}

function boolXml(expr: BoolExpr, d: Defaults): string {
  switch (expr.k) {
    case "bool":
      return block("logic_boolean", field("BOOL", expr.v ? "TRUE" : "FALSE"), "");
    case "compare": {
      const map: Record<string, string> = { "==": "EQ", "!=": "NEQ", "<": "LT", "<=": "LTE", ">": "GT", ">=": "GTE" };
      return block("logic_compare", field("OP", map[expr.op]) + value("A", numXml(expr.a, d)) + value("B", numXml(expr.b, d)), "");
    }
    case "logic":
      return block("logic_operation", field("OP", expr.op === "or" ? "OR" : "AND") + value("A", boolXml(expr.a, d)) + value("B", boolXml(expr.b, d)), "");
    case "not":
      return block("logic_negate", value("BOOL", boolXml(expr.a, d)), "");
    case "cross": {
      if (expr.dir === "any") {
        // No "any" option on the block — emit (crosses above) OR (crosses below).
        const above: BoolExpr = { k: "cross", dir: "above", a: expr.a, b: expr.b };
        const below: BoolExpr = { k: "cross", dir: "below", a: expr.a, b: expr.b };
        return boolXml({ k: "logic", op: "or", a: above, b: below }, d);
      }
      return block("cross_event", value("A", numXml(expr.a, d)) + field("DIRECTION", expr.dir) + value("B", numXml(expr.b, d)), "");
    }
    case "trend":
      return block("series_trend", field("DIR", expr.dir) + value("PERIOD", numXml(expr.period, d)) + value("SOURCE", numXml(expr.source, d)), "");
    case "between":
      return block("value_between", value("VALUE", numXml(expr.value, d)) + value("LOW", numXml(expr.low, d)) + value("HIGH", numXml(expr.high, d)), "");
    case "session":
      return block("time_session", field("START", expr.start) + field("END", expr.end), "");
    case "dayofweek":
      return block("time_dayofweek", field("DAY", expr.day), "");
    case "isna":
      return block("logic_isna", value("A", numXml(expr.a, d)), "");
    case "varb":
      return block("varb_get", field("NAME", expr.name), "");
  }
}

/** Escape a string for use inside XML text/attribute content. */
function esc(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
