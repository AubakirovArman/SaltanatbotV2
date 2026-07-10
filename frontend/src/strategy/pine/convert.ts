import type { BoolExpr, NumExpr, Stmt, StrategyIR, StrategyInput } from "../ir";
import { IR_VERSION } from "../ir";
import { PineLexError } from "./lexer";
import { PineParseError, parsePine, type PineArg, type PineExpr, type PineStmt } from "./parser";

/**
 * Semantic mapping: Pine AST → StrategyIR.
 *
 * Core idea: a Pine immutable binding (`x = ta.sma(close, 20)`) is INLINED at
 * every use site — our IR expressions are vectorized per-bar series, so
 * substitution preserves series semantics exactly. Mutable state (a name that
 * is ever reassigned with := / +=) maps to setvar/var: `var x = C` initializes
 * once (init section), a plain `x = C` declaration re-initializes every bar at
 * its position in the body — both matching Pine's execution model.
 *
 * Fidelity policy (fail closed): anything that would silently change TRADING
 * semantics is a hard error; display-only constructs (fill, bgcolor, labels…)
 * are skipped with a warning. Every approximation gets a warning.
 */

export interface PineResult {
  kind: "indicator" | "strategy";
  name: string;
  ir: StrategyIR;
  warnings: string[];
}

export class PineConvertError extends Error {}

type Val = { t: "num"; e: NumExpr } | { t: "bool"; e: BoolExpr };

const PRICE_FIELDS = new Set(["open", "high", "low", "close", "volume", "hl2", "hlc3", "ohlc4"]);
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const PLOT_CALLS = new Set(["plot", "hline", "plotshape", "plotchar"]);

const COLOR_HEX: Record<string, string> = {
  red: "#ef5350",
  green: "#26a69a",
  lime: "#23c97a",
  blue: "#4db6ff",
  aqua: "#26c6da",
  teal: "#26a69a",
  orange: "#ff9800",
  yellow: "#f7c948",
  purple: "#bd58a4",
  fuchsia: "#e040fb",
  maroon: "#c05f5f",
  navy: "#3949ab",
  olive: "#9e9d24",
  silver: "#b0bec5",
  gray: "#8f9bb3",
  white: "#eceff1",
  black: "#263238"
};

export function convertPine(source: string): PineResult {
  let ast: PineStmt[];
  try {
    ast = parsePine(source);
  } catch (cause) {
    if (cause instanceof PineLexError || cause instanceof PineParseError) throw new PineConvertError(cause.message);
    throw cause;
  }
  return new Converter().run(ast);
}

class Converter {
  private kind: "indicator" | "strategy" = "indicator";
  private name = "Imported Pine";
  private overlay = false; // Pine default for indicator() AND strategy()
  private readonly env = new Map<string, Val>();
  private readonly plotHandles = new Set<string>();
  private readonly numVars = new Set<string>();
  private readonly boolVars = new Set<string>();
  private readonly boolInputs = new Set<string>();
  private readonly inputs: StrategyInput[] = [];
  private readonly init: Extract<Stmt, { k: "setvar" }>[] = [];
  private readonly warnings: string[] = [];
  private readonly warned = new Set<string>();
  private reassigned = new Set<string>();
  private declared = false;
  private hasLongEntry = false;
  private hasShortEntry = false;
  private hasExplicitExit = false;

  run(ast: PineStmt[]): PineResult {
    this.reassigned = collectReassigned(ast);
    const body: Stmt[] = [];
    for (const stmt of ast) {
      body.push(...this.stmt(stmt));
    }
    if (!this.declared) {
      this.warn("No indicator()/strategy() declaration found — importing as an indicator.");
    }
    if (this.hasLongEntry && this.hasShortEntry && !this.hasExplicitExit) {
      this.warn(
        "Stop-and-reverse: in Pine an opposite entry reverses the position, but here entries only fire when flat — add explicit exit conditions."
      );
    }
    const ir: StrategyIR = {
      name: this.name,
      inputs: this.inputs,
      body,
      init: this.init.length ? this.init : undefined,
      v: IR_VERSION
    };
    return { kind: this.kind, name: this.name, ir, warnings: this.warnings };
  }

  // ---------- statements ----------

  private stmt(stmt: PineStmt): Stmt[] {
    switch (stmt.t) {
      case "version":
        return [];
      case "assign":
        return this.assign(stmt.name, stmt.value, stmt.declaredVar);
      case "reassign":
        return this.setMutable(stmt.name, this.desugarCompound(stmt));
      case "tuple":
        return this.tuple(stmt.names, stmt.value);
      case "expr":
        return this.exprStatement(stmt.value);
      case "if":
        return [this.ifStmt(stmt)];
      case "unsupported":
        this.warn(`Skipped unsupported statement (“${stmt.what}”, line ${stmt.line}).`);
        return [];
    }
  }

  private desugarCompound(stmt: Extract<PineStmt, { t: "reassign" }>): PineExpr {
    if (stmt.op === ":=") return stmt.value;
    const op = stmt.op[0];
    return { t: "binary", op, a: { t: "ident", name: stmt.name }, b: stmt.value };
  }

  private assign(name: string, value: PineExpr, declaredVar: boolean): Stmt[] {
    this.checkName(name);
    // input.*() bindings become strategy inputs regardless of mutability.
    if (value.t === "call" && (value.callee.startsWith("input.") || value.callee === "input")) {
      this.registerInput(name, value);
      return [];
    }
    // `p = plot(...)` binds a plot handle (only useful for fill(), which we skip).
    if (value.t === "call" && PLOT_CALLS.has(value.callee)) {
      this.plotHandles.add(name);
      return this.exprStatement(value);
    }
    const mutable = declaredVar || this.reassigned.has(name);
    if (!mutable) {
      this.env.set(name, this.val(value));
      return [];
    }
    // Numeric ternary initializer for a mutable maps losslessly to if/else setvars.
    if (value.t === "ternary" && !isBoolExpr(value, this.boolVars, this.env)) {
      this.numVars.add(name);
      return [this.ternaryToIf(name, value)];
    }
    const val = this.val(value);
    if (val.t === "bool") {
      this.boolVars.add(name);
      if (declaredVar) {
        this.init.push({ k: "setvar", name, value: boolToNum(val.e) });
        if (val.e.k !== "bool") this.warn(`var "${name}" initialized to false — series initializers run per-bar in Pine but once here.`);
        return [];
      }
      return [{ k: "setvarb", name, value: val.e }];
    }
    this.numVars.add(name);
    if (declaredVar) {
      if (!isConstNum(val.e)) {
        this.warn(`var "${name}" is initialized from the first history bar here (Pine uses the first live bar).`);
      }
      this.init.push({ k: "setvar", name, value: val.e });
      return [];
    }
    return [{ k: "setvar", name, value: val.e }];
  }

  private setMutable(name: string, value: PineExpr): Stmt[] {
    this.checkName(name);
    if (value.t === "ternary" && !isBoolExpr(value, this.boolVars, this.env)) {
      this.numVars.add(name);
      return [this.ternaryToIf(name, value)];
    }
    const val = this.val(value);
    if (this.boolVars.has(name) || (val.t === "bool" && !this.numVars.has(name))) {
      if (val.t !== "bool") throw new PineConvertError(`Variable "${name}" mixes boolean and numeric values.`);
      this.boolVars.add(name);
      return [{ k: "setvarb", name, value: val.e }];
    }
    if (val.t !== "num") throw new PineConvertError(`Variable "${name}" mixes boolean and numeric values.`);
    this.numVars.add(name);
    return [{ k: "setvar", name, value: val.e }];
  }

  /** `x := c ? a : b` → if c { x = a } else { x = b } (audit: lossless mapping). */
  private ternaryToIf(name: string, value: Extract<PineExpr, { t: "ternary" }>): Stmt {
    return {
      k: "if",
      cond: this.bool(value.cond),
      then: [{ k: "setvar", name, value: this.num(value.a) }],
      else: [{ k: "setvar", name, value: this.num(value.b) }]
    };
  }

  private tuple(names: string[], value: PineExpr): Stmt[] {
    if (value.t !== "call") throw new PineConvertError("Tuple assignment must destructure a function call.");
    const callee = normalizeTa(value.callee);
    let parts: NumExpr[];
    if (callee === "ta.macd") {
      const src = this.numArg(value.args, 0, "source", { k: "price", field: "close" });
      const fast = this.numArg(value.args, 1, "fastlen");
      const slow = this.numArg(value.args, 2, "slowlen");
      const signal = this.numArg(value.args, 3, "siglen");
      parts = [
        { k: "macd", line: "macd", fast, slow, signal, source: src },
        { k: "macd", line: "signal", fast, slow, signal, source: src },
        { k: "macd", line: "histogram", fast, slow, signal, source: src }
      ];
    } else if (callee === "ta.bb") {
      const src = this.numArg(value.args, 0, "series");
      const period = this.numArg(value.args, 1, "length");
      const dev = this.numArg(value.args, 2, "mult");
      parts = [
        { k: "bollinger", band: "middle", period, dev, source: src },
        { k: "bollinger", band: "upper", period, dev, source: src },
        { k: "bollinger", band: "lower", period, dev, source: src }
      ];
    } else {
      throw new PineConvertError(`Tuple destructuring is only supported for ta.macd and ta.bb (got ${value.callee}).`);
    }
    names.forEach((n, i) => {
      this.checkName(n);
      if (i < parts.length) this.env.set(n, { t: "num", e: parts[i] });
    });
    return [];
  }

  private ifStmt(stmt: Extract<PineStmt, { t: "if" }>): Stmt {
    const clauses = stmt.clauses;
    const first = clauses[0];
    if (!first?.cond) throw new PineConvertError("if without a condition.");
    const node: Extract<Stmt, { k: "if" }> = {
      k: "if",
      cond: this.bool(first.cond),
      then: first.body.flatMap((s) => this.stmt(s))
    };
    const elifs: { cond: BoolExpr; then: Stmt[] }[] = [];
    for (const clause of clauses.slice(1)) {
      if (clause.cond) elifs.push({ cond: this.bool(clause.cond), then: clause.body.flatMap((s) => this.stmt(s)) });
      else node.else = clause.body.flatMap((s) => this.stmt(s));
    }
    if (elifs.length) node.elifs = elifs;
    return node;
  }

  // ---------- call statements (plot / strategy.* / alerts / declarations) ----------

  private exprStatement(expr: PineExpr): Stmt[] {
    if (expr.t !== "call") {
      this.warn("Skipped a bare expression statement with no effect.");
      return [];
    }
    const callee = expr.callee;
    const args = expr.args;

    switch (callee) {
      case "indicator":
      case "study":
      case "strategy":
        return this.declaration(callee, args);
      case "plot": {
        const series = this.plotValue(argRequired(args, 0, "series", "plot").value, "plot");
        const titleArg = arg(args, 1, "title");
        const label = titleArg?.value.t === "str" ? sanitizeText(titleArg.value.v) : "plot";
        const color = this.colorOf(arg(args, 2, "color")?.value) ?? "#4db6ff";
        return [{ k: "plot", value: series, label, color, pane: this.plotPane() }];
      }
      case "hline": {
        const level = this.num(argRequired(args, 0, "price", "hline").value);
        const titleArg = arg(args, 1, "title");
        const label = titleArg?.value.t === "str" ? sanitizeText(titleArg.value.v) : "level";
        const color = this.colorOf(arg(args, 2, "color")?.value) ?? "#8f9bb3";
        return [{ k: "plot", value: level, label, color, pane: this.plotPane() }];
      }
      case "plotshape":
      case "plotchar": {
        const cond = this.bool(argRequired(args, 0, "series", callee).value);
        const titleArg = arg(args, 1, "title");
        const textArg = arg(args, undefined, "text");
        const label = sanitizeText(
          (textArg?.value.t === "str" ? textArg.value.v : undefined) ?? (titleArg?.value.t === "str" ? titleArg.value.v : "")
        );
        const styleName = identName(arg(args, undefined, "style")?.value);
        const locationName = identName(arg(args, undefined, "location")?.value);
        // Style wins; location breaks ties (belowbar = buy-style marker under the bar).
        const dir: "up" | "down" = styleName.includes("down")
          ? "down"
          : styleName.includes("up")
            ? "up"
            : locationName.includes("below")
              ? "up"
              : "down";
        return [{ k: "marker", dir, label, when: cond }];
      }
      case "alertcondition": {
        const cond = this.bool(argRequired(args, 0, "condition", "alertcondition").value);
        const titleArg = arg(args, 1, "title");
        const messageArg = arg(args, 2, "message");
        const message = sanitizeText(
          (messageArg?.value.t === "str" ? messageArg.value.v : undefined) ?? (titleArg?.value.t === "str" ? titleArg.value.v : "alert")
        );
        if (message.includes("{{")) this.warnOnce("tmpl", "TradingView {{placeholders}} in alert messages are kept as literal text.");
        return [{ k: "alert", message: message || "alert", when: cond }];
      }
      case "alert": {
        const messageArg = arg(args, 0, "message");
        const message = messageArg?.value.t === "str" ? sanitizeText(messageArg.value.v) : "alert";
        if (messageArg && messageArg.value.t !== "str") this.warn('alert() message must be a plain string — used "alert".');
        return [{ k: "alert", message: message || "alert", when: { k: "bool", v: true } }];
      }
      case "strategy.entry":
      case "strategy.order": {
        if (callee === "strategy.order") this.warn("strategy.order treated as strategy.entry (market entry).");
        const dirArg = arg(args, 1, "direction");
        const dirName = identName(dirArg?.value) || "strategy.long";
        const direction: "long" | "short" = dirName.endsWith("short") ? "short" : "long";
        if (direction === "long") this.hasLongEntry = true;
        else this.hasShortEntry = true;
        const whenArg = arg(args, undefined, "when"); // v4 compat
        const when = whenArg ? this.bool(whenArg.value) : ({ k: "bool", v: true } as BoolExpr);
        const out: Stmt[] = [{ k: "entry", direction, when }];
        const qtyArg = arg(args, undefined, "qty");
        if (qtyArg) out.push({ k: "size", mode: "units", value: this.num(qtyArg.value) });
        return out;
      }
      case "strategy.close":
      case "strategy.close_all": {
        this.hasExplicitExit = true;
        const whenArg = arg(args, undefined, "when");
        return [{ k: "exit", when: whenArg ? this.bool(whenArg.value) : { k: "bool", v: true } }];
      }
      case "strategy.exit": {
        const out: Stmt[] = [];
        const stopArg = arg(args, undefined, "stop");
        const limitArg = arg(args, undefined, "limit");
        if (stopArg) {
          const stop = this.num(stopArg.value);
          if (!isConstNum(stop)) this.warnOnce("exitfreeze", "strategy.exit stop/limit prices are frozen at entry here (Pine re-evaluates them every bar).");
          out.push({ k: "stop", mode: "price", value: stop });
        }
        if (limitArg) out.push({ k: "target", mode: "price", value: this.num(limitArg.value) });
        for (const bad of ["profit", "loss", "trail_price", "trail_points", "trail_offset"]) {
          if (arg(args, undefined, bad)) {
            throw new PineConvertError(
              `strategy.exit ${bad}= (tick-based) is not supported — use stop=/limit= absolute prices, or rebuild with stop-loss/take-profit blocks.`
            );
          }
        }
        if (out.length) this.hasExplicitExit = true;
        else this.warn("strategy.exit had no stop=/limit= — nothing converted.");
        return out;
      }
      case "strategy.cancel":
      case "strategy.cancel_all":
      case "fill":
      case "bgcolor":
      case "barcolor":
      case "plotcandle":
      case "plotbar":
      case "plotarrow": {
        this.warn(`Skipped display-only/unsupported call: ${callee}().`);
        return [];
      }
      default:
        if (callee.startsWith("label") || callee.startsWith("line") || callee.startsWith("box") || callee.startsWith("table") || callee.startsWith("array") || callee.startsWith("matrix")) {
          this.warn(`Skipped drawing/collection call: ${callee}().`);
          return [];
        }
        throw new PineConvertError(`Unsupported statement call: ${callee}().`);
    }
  }

  /** indicator()/strategy() declaration: name, overlay, and sizing defaults. */
  private declaration(callee: string, args: PineArg[]): Stmt[] {
    this.declared = true;
    this.kind = callee === "strategy" ? "strategy" : "indicator";
    const nameArg = arg(args, 0, "title");
    if (nameArg?.value.t === "str") this.name = sanitizeText(nameArg.value.v) || this.name;
    const overlayArg = arg(args, undefined, "overlay");
    this.overlay = overlayArg ? isTrueIdent(overlayArg.value) : false;

    const out: Stmt[] = [];
    if (callee === "strategy") {
      const qtyType = identName(arg(args, undefined, "default_qty_type")?.value);
      const qtyValueArg = arg(args, undefined, "default_qty_value");
      const qtyValue = qtyValueArg?.value.t === "num" ? qtyValueArg.value.v : undefined;
      if (qtyType.endsWith("percent_of_equity") && qtyValue !== undefined) {
        out.push({ k: "size", mode: "equity_pct", value: { k: "num", v: qtyValue } });
      } else if (qtyType.endsWith("fixed") && qtyValue !== undefined) {
        out.push({ k: "size", mode: "units", value: { k: "num", v: qtyValue } });
      } else if (qtyType.endsWith("cash")) {
        this.warn("strategy.cash sizing isn't supported — set position size explicitly.");
      }
      const pyramidingArg = arg(args, undefined, "pyramiding");
      if (pyramidingArg?.value.t === "num" && pyramidingArg.value.v > 0) {
        this.warn(`pyramiding=${pyramidingArg.value.v} isn't supported — entries only fire when flat.`);
      }
      if (arg(args, undefined, "process_orders_on_close")) {
        this.warn("process_orders_on_close ignored — orders fill at the next bar's open here.");
      }
    }
    return out;
  }

  private plotPane(): "price" | "sub" {
    return this.overlay ? "price" : "sub";
  }

  /** Plot values can't contain mutable vars (scalar-only) — fail with a clear message. */
  private plotValue(expr: PineExpr, what: string): NumExpr {
    const node = this.num(expr);
    if (containsVar(node)) {
      throw new PineConvertError(
        `${what}() of a mutable variable isn't supported — variables are single values, not series. Plot the underlying expression instead.`
      );
    }
    return node;
  }

  private registerInput(name: string, call: Extract<PineExpr, { t: "call" }>): void {
    this.checkName(name);
    const kind = call.callee;
    const defArg = arg(call.args, 0, "defval");
    if (!defArg) throw new PineConvertError(`${kind}() for "${name}" needs a default value.`);
    if (kind === "input.source" || (kind === "input" && defArg.value.t === "ident")) {
      const field = defArg.value.t === "ident" && PRICE_FIELDS.has(defArg.value.name) ? defArg.value.name : "close";
      this.env.set(name, { t: "num", e: { k: "price", field: field as never } });
      this.warn(`input.source "${name}" fixed to ${field} (source inputs aren't tunable here).`);
      return;
    }
    let value: number;
    if (kind === "input.bool") {
      value = isTrueIdent(defArg.value) ? 1 : 0;
      this.boolInputs.add(name);
      this.warn(`input.bool "${name}" imported as a 0/1 numeric input.`);
    } else if (defArg.value.t === "num") {
      value = defArg.value.v;
    } else if (defArg.value.t === "unary" && defArg.value.op === "-" && defArg.value.a.t === "num") {
      value = -defArg.value.a.v;
    } else if (defArg.value.t === "str") {
      throw new PineConvertError(`input "${name}" has a text default — only numeric/boolean inputs are supported.`);
    } else {
      throw new PineConvertError(`input "${name}" must have a literal numeric default.`);
    }
    if (!this.inputs.some((input) => input.name === name)) this.inputs.push({ name, value });
    this.env.set(name, { t: "num", e: { k: "input", name } });
  }

  // ---------- expressions ----------

  private val(expr: PineExpr): Val {
    if (isBoolExpr(expr, this.boolVars, this.env)) return { t: "bool", e: this.bool(expr) };
    return { t: "num", e: this.num(expr) };
  }

  private num(expr: PineExpr): NumExpr {
    switch (expr.t) {
      case "num":
        return { k: "num", v: expr.v };
      case "str":
        throw new PineConvertError("A text value can't be used as a number.");
      case "ident":
        return this.numIdent(expr.name);
      case "unary":
        if (expr.op === "-") return { k: "unary", op: "neg", a: this.num(expr.a) };
        throw new PineConvertError("'not' can't be used as a number.");
      case "binary": {
        if (["+", "-", "*", "/", "%"].includes(expr.op)) {
          if (expr.op === "/" && this.isIntish(expr.a) && this.isIntish(expr.b)) {
            this.warnOnce("intdiv", "Pine integer division truncates (7/2=3); here it stays fractional — wrap with math.floor if the script relies on truncation.");
          }
          return { k: "arith", op: expr.op as "+", a: this.num(expr.a), b: this.num(expr.b) };
        }
        throw new PineConvertError(`Operator "${expr.op}" doesn't produce a number.`);
      }
      case "ternary":
        throw new PineConvertError(
          "Conditional values (cond ? a : b) inside expressions aren't supported — assign them to a variable with := in an if/else first."
        );
      case "index": {
        const offsetExpr = expr.offset;
        if (offsetExpr.t !== "num" || !Number.isInteger(offsetExpr.v) || offsetExpr.v < 0) {
          throw new PineConvertError("History offset [n] must be a non-negative integer literal.");
        }
        const offset = offsetExpr.v;
        const base = this.num(expr.base);
        if (containsVar(base)) {
          throw new PineConvertError("History access on a mutable variable (x[1]) isn't supported — variables hold only their latest value.");
        }
        if (offset === 0) return base;
        if (base.k === "price" && !base.offset) return { k: "price", field: base.field, offset };
        return { k: "shift", src: base, offset };
      }
      case "call":
        return this.numCall(expr);
    }
  }

  private numIdent(name: string): NumExpr {
    const bound = this.env.get(name);
    if (bound) {
      if (bound.t !== "num") throw new PineConvertError(`"${name}" is a condition, not a number.`);
      return bound.e;
    }
    if (PRICE_FIELDS.has(name)) return { k: "price", field: name as never };
    if (this.numVars.has(name)) return { k: "var", name };
    if (name === "strategy.position_size") {
      this.warnOnce("possize", "strategy.position_size is mapped to the position DIRECTION sign (+1/-1/0), not the size.");
      return { k: "ctx", key: "position_dir" };
    }
    if (name === "strategy.equity") return { k: "ctx", key: "equity" };
    if (name === "strategy.position_avg_price") return { k: "ctx", key: "entry_price" };
    if (name === "strategy.openprofit") return { k: "ctx", key: "unrealized_pnl" };
    if (this.plotHandles.has(name)) throw new PineConvertError(`"${name}" is a plot handle — it can't be used as a value.`);
    if (name === "na") throw new PineConvertError("na is not supported — give variables explicit numeric defaults.");
    throw new PineConvertError(`Unknown identifier "${name}" — it was never assigned (or its definition was skipped).`);
  }

  private numCall(expr: Extract<PineExpr, { t: "call" }>): NumExpr {
    const callee = normalizeTa(expr.callee);
    const args = expr.args;
    const period = (i: number, name: string) => this.numArg(args, i, name);

    switch (callee) {
      case "ta.sma":
      case "ta.ema":
      case "ta.wma":
      case "ta.vwma": {
        const kind = callee.slice(3) as "sma" | "ema" | "wma" | "vwma";
        return { k: "ma", kind, period: period(1, "length"), source: this.seriesArg(args, 0, "source") };
      }
      case "ta.rsi":
        return { k: "rsi", period: period(1, "length"), source: this.seriesArg(args, 0, "source") };
      case "ta.atr":
        return { k: "atr", period: period(0, "length") };
      case "ta.tr":
        this.warnOnce("tr", "ta.tr approximated as ATR(1).");
        return { k: "atr", period: { k: "num", v: 1 } };
      case "ta.stdev":
        return { k: "stdev", period: period(1, "length"), source: this.seriesArg(args, 0, "source") };
      case "ta.highest":
      case "ta.lowest": {
        const kind = callee === "ta.highest" ? "highest" : "lowest";
        if (args.length === 1) {
          return { k: "extreme", kind, period: period(0, "length"), source: { k: "price", field: kind === "highest" ? "high" : "low" } };
        }
        return { k: "extreme", kind, period: period(1, "length"), source: this.seriesArg(args, 0, "source") };
      }
      case "ta.change":
        return { k: "change", period: args.filter((a) => !a.name).length > 1 ? period(1, "length") : { k: "num", v: 1 }, source: this.seriesArg(args, 0, "source") };
      case "ta.mom":
        return { k: "change", period: period(1, "length"), source: this.seriesArg(args, 0, "source") };
      case "ta.cci": {
        const src = args[0]?.value;
        if (!(src && src.t === "ident" && src.name === "hlc3")) this.warnOnce("cci", "ta.cci computed from hlc3 here (the passed source is ignored).");
        return { k: "cci", period: period(1, "length") };
      }
      case "ta.roc":
        return { k: "roc", period: period(1, "length"), source: this.seriesArg(args, 0, "source") };
      case "ta.wpr":
        return { k: "wpr", period: period(0, "length") };
      case "ta.stoch":
        this.warnOnce("stoch", "ta.stoch imported as raw %K of close/high/low.");
        return { k: "stoch", line: "k", period: this.numArg(args, 3, "length", { k: "num", v: 14 }), smooth: { k: "num", v: 1 } };
      case "ta.vwap":
        throw new PineConvertError("ta.vwap is not supported in strategy logic yet.");
      case "math.abs":
        return { k: "unary", op: "abs", a: this.numArg(args, 0, "number") };
      case "math.round": {
        if (args.filter((a) => !a.name).length > 1) this.warnOnce("roundprec", "math.round precision argument ignored (rounds to whole numbers).");
        return { k: "unary", op: "round", a: this.numArg(args, 0, "number") };
      }
      case "math.floor":
        return { k: "unary", op: "floor", a: this.numArg(args, 0, "number") };
      case "math.ceil":
        return { k: "unary", op: "ceil", a: this.numArg(args, 0, "number") };
      case "math.max":
      case "math.min": {
        const op = callee === "math.max" ? "max" : "min";
        if (args.length < 2) throw new PineConvertError(`${callee} needs at least two arguments.`);
        let acc: NumExpr = this.num(args[0].value);
        for (let i = 1; i < args.length; i += 1) acc = { k: "minmax", op, a: acc, b: this.num(args[i].value) };
        return acc;
      }
      case "math.pow":
        return { k: "arith", op: "^", a: this.numArg(args, 0, "base"), b: this.numArg(args, 1, "exponent") };
      case "math.sqrt":
        return { k: "arith", op: "^", a: this.numArg(args, 0, "number"), b: { k: "num", v: 0.5 } };
      case "math.avg": {
        if (args.length < 2) throw new PineConvertError("math.avg needs at least two arguments.");
        let sum: NumExpr = this.num(args[0].value);
        for (let i = 1; i < args.length; i += 1) sum = { k: "arith", op: "+", a: sum, b: this.num(args[i].value) };
        return { k: "arith", op: "/", a: sum, b: { k: "num", v: args.length } };
      }
      case "nz": {
        this.warnOnce("nz", "nz() passed through (warm-up bars stay empty instead of becoming the fallback).");
        return this.numArg(args, 0, "source");
      }
      case "color.new":
        throw new PineConvertError("color values can't be used as numbers.");
      default:
        throw new PineConvertError(`Unsupported function: ${expr.callee}().`);
    }
  }

  /** Indicator source/series argument: mutable vars are rejected (scalar-only). */
  private seriesArg(args: PineArg[], position: number, name: string): NumExpr {
    const node = this.numArg(args, position, name, { k: "price", field: "close" });
    if (containsVar(node)) {
      throw new PineConvertError("Using a mutable variable as an indicator source isn't supported — variables hold only their latest value.");
    }
    return node;
  }

  private bool(expr: PineExpr): BoolExpr {
    switch (expr.t) {
      case "ident": {
        if (expr.name === "true") return { k: "bool", v: true };
        if (expr.name === "false") return { k: "bool", v: false };
        if (this.boolInputs.has(expr.name)) {
          // input.bool used as a condition: != 0.
          return { k: "compare", op: "!=", a: { k: "input", name: expr.name }, b: { k: "num", v: 0 } };
        }
        const bound = this.env.get(expr.name);
        if (bound) {
          if (bound.t !== "bool") throw new PineConvertError(`"${expr.name}" is a number, not a condition.`);
          return bound.e;
        }
        if (this.boolVars.has(expr.name)) return { k: "varb", name: expr.name };
        throw new PineConvertError(`Unknown condition "${expr.name}".`);
      }
      case "unary":
        if (expr.op === "not") return { k: "not", a: this.bool(expr.a) };
        throw new PineConvertError("A negative number isn't a condition.");
      case "binary": {
        if (expr.op === "and" || expr.op === "or") return { k: "logic", op: expr.op, a: this.bool(expr.a), b: this.bool(expr.b) };
        if (["==", "!=", "<", "<=", ">", ">="].includes(expr.op)) {
          return { k: "compare", op: expr.op as ">", a: this.num(expr.a), b: this.num(expr.b) };
        }
        throw new PineConvertError(`Operator "${expr.op}" doesn't produce a condition.`);
      }
      case "ternary": {
        const c = this.bool(expr.cond);
        return {
          k: "logic",
          op: "or",
          a: { k: "logic", op: "and", a: c, b: this.bool(expr.a) },
          b: { k: "logic", op: "and", a: { k: "not", a: c }, b: this.bool(expr.b) }
        };
      }
      case "call": {
        const callee = normalizeTa(expr.callee);
        if (callee === "ta.crossover") return { k: "cross", dir: "above", a: this.numArg(expr.args, 0, "a"), b: this.numArg(expr.args, 1, "b") };
        if (callee === "ta.crossunder") return { k: "cross", dir: "below", a: this.numArg(expr.args, 0, "a"), b: this.numArg(expr.args, 1, "b") };
        if (callee === "ta.cross") return { k: "cross", dir: "any", a: this.numArg(expr.args, 0, "a"), b: this.numArg(expr.args, 1, "b") };
        if (callee === "ta.rising" || callee === "ta.falling") return this.risingFalling(callee, expr.args);
        if (callee === "na") throw new PineConvertError("na() checks aren't supported — warm-up bars are handled automatically.");
        throw new PineConvertError(`Unsupported condition function: ${expr.callee}().`);
      }
      case "num":
      case "str":
      case "index":
        throw new PineConvertError("Expected a condition (true/false expression).");
    }
  }

  /**
   * Pine ta.rising(src, len) is true iff src exceeds EVERY one of the previous
   * len values. len==1 matches our trend node; for len>1 compare against the
   * highest/lowest of the shifted window (audit correction).
   */
  private risingFalling(callee: string, args: PineArg[]): BoolExpr {
    const src = this.seriesArg(args, 0, "source");
    const len = this.numArg(args, 1, "length");
    const rising = callee === "ta.rising";
    if (len.k === "num" && len.v === 1) {
      return { k: "trend", dir: rising ? "rising" : "falling", period: { k: "num", v: 1 }, source: src };
    }
    const window: NumExpr = { k: "extreme", kind: rising ? "highest" : "lowest", period: len, source: { k: "shift", src, offset: 1 } };
    return { k: "compare", op: rising ? ">" : "<", a: src, b: window };
  }

  // ---------- helpers ----------

  private numArg(args: PineArg[], position: number, name: string, fallback?: NumExpr): NumExpr {
    const found = arg(args, position, name);
    if (!found) {
      if (fallback) return fallback;
      throw new PineConvertError(`Missing argument "${name}".`);
    }
    return this.num(found.value);
  }

  private colorOf(expr: PineExpr | undefined): string | undefined {
    if (!expr) return undefined;
    if (expr.t === "ident" && expr.name.startsWith("color.")) return COLOR_HEX[expr.name.slice(6)] ?? "#4db6ff";
    if (expr.t === "call" && expr.callee === "color.new") return this.colorOf(expr.args[0]?.value);
    if (expr.t === "str" && /^#[0-9a-fA-F]{6}$/.test(expr.v)) return expr.v;
    return undefined; // conditional/unknown colors are cosmetic — fall back silently
  }

  /** Integer-ish operands for the Pine int-division warning. */
  private isIntish(expr: PineExpr): boolean {
    if (expr.t === "num") return Number.isInteger(expr.v);
    if (expr.t === "ident") {
      const bound = this.env.get(expr.name);
      return bound?.t === "num" && bound.e.k === "input" && Number.isInteger(this.inputs.find((i) => i.name === (bound.e as { name: string }).name)?.value ?? 0.5);
    }
    return false;
  }

  private checkName(name: string): void {
    if (!NAME_RE.test(name)) throw new PineConvertError(`Identifier "${name}" has unsupported characters.`);
    if (PRICE_FIELDS.has(name)) throw new PineConvertError(`"${name}" is a built-in price name and can't be reassigned.`);
  }

  private warn(message: string): void {
    this.warnings.push(message);
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.warnings.push(message);
  }
}

// ---------- module helpers ----------

/** Positional/named argument lookup (positional index counts unnamed args only). */
function arg(args: PineArg[], position: number | undefined, name: string): PineArg | undefined {
  const named = args.find((a) => a.name === name);
  if (named) return named;
  if (position === undefined) return undefined;
  const positional = args.filter((a) => !a.name);
  return positional[position];
}

function argRequired(args: PineArg[], position: number, name: string, fn: string): PineArg {
  const found = arg(args, position, name);
  if (!found) throw new PineConvertError(`${fn}() is missing its "${name}" argument.`);
  return found;
}

/** v4 bare names (sma, crossover, study…) → v5 namespaced equivalents. */
function normalizeTa(callee: string): string {
  if (callee.includes(".")) return callee;
  const v4ta = new Set([
    "sma", "ema", "wma", "vwma", "rsi", "atr", "tr", "stdev", "highest", "lowest", "change", "mom", "cci", "roc",
    "wpr", "stoch", "vwap", "crossover", "crossunder", "cross", "rising", "falling", "macd", "bb"
  ]);
  if (v4ta.has(callee)) return `ta.${callee}`;
  const v4math = new Set(["abs", "round", "floor", "ceil", "max", "min", "pow", "sqrt", "avg"]);
  if (v4math.has(callee)) return `math.${callee}`;
  return callee;
}

function identName(expr: PineExpr | undefined): string {
  return expr?.t === "ident" ? expr.name : "";
}

function isTrueIdent(expr: PineExpr): boolean {
  return expr.t === "ident" && expr.name === "true";
}

/** Encode a BoolExpr as 0/1 for the numeric-only init section. */
function boolToNum(expr: BoolExpr): NumExpr {
  if (expr.k === "bool") return { k: "num", v: expr.v ? 1 : 0 };
  return { k: "num", v: 0 };
}

/** Constant (num / negated num) check — used for init and exit-freeze warnings. */
function isConstNum(expr: NumExpr): boolean {
  if (expr.k === "num" || expr.k === "input") return true;
  if (expr.k === "unary") return isConstNum(expr.a);
  if (expr.k === "arith") return isConstNum(expr.a) && isConstNum(expr.b);
  return false;
}

/** Whether a NumExpr contains a mutable-variable read anywhere. */
function containsVar(expr: NumExpr): boolean {
  switch (expr.k) {
    case "var":
      return true;
    case "arith":
    case "minmax":
      return containsVar(expr.a) || containsVar(expr.b);
    case "unary":
      return containsVar(expr.a);
    case "shift":
      return containsVar(expr.src);
    case "agg":
      return containsVar(expr.src) || containsVar(expr.period);
    case "ma":
    case "rsi":
    case "stdev":
    case "extreme":
    case "change":
    case "roc":
      return containsVar(expr.source) || containsVar(expr.period);
    case "bollinger":
      return containsVar(expr.source) || containsVar(expr.period) || containsVar(expr.dev);
    case "macd":
      return containsVar(expr.source) || containsVar(expr.fast) || containsVar(expr.slow) || containsVar(expr.signal);
    default:
      return false;
  }
}

/** Pre-scan: every name that is ever reassigned (:=, +=…) anywhere in the script. */
function collectReassigned(stmts: PineStmt[]): Set<string> {
  const out = new Set<string>();
  const walk = (list: PineStmt[]) => {
    for (const stmt of list) {
      if (stmt.t === "reassign") out.add(stmt.name);
      if (stmt.t === "if") for (const clause of stmt.clauses) walk(clause.body);
    }
  };
  walk(stmts);
  return out;
}

/** Strip XML-unsafe control characters and lone surrogates from user text. */
function sanitizeText(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f || (code >= 0xd800 && code <= 0xdfff)) continue;
    out += ch;
  }
  return out.normalize("NFC").slice(0, 200);
}

/** Detect whether a Pine expression is boolean-typed in our mapping. */
function isBoolExpr(expr: PineExpr, boolVars: Set<string>, env: Map<string, Val>): boolean {
  switch (expr.t) {
    case "binary":
      return ["and", "or", "==", "!=", "<", "<=", ">", ">="].includes(expr.op);
    case "unary":
      return expr.op === "not";
    case "ident": {
      if (expr.name === "true" || expr.name === "false") return true;
      const bound = env.get(expr.name);
      if (bound) return bound.t === "bool";
      return boolVars.has(expr.name);
    }
    case "call": {
      const callee = normalizeTa(expr.callee);
      return ["ta.crossover", "ta.crossunder", "ta.cross", "ta.rising", "ta.falling"].includes(callee);
    }
    case "ternary":
      return isBoolExpr(expr.a, boolVars, env) && isBoolExpr(expr.b, boolVars, env);
    default:
      return false;
  }
}
