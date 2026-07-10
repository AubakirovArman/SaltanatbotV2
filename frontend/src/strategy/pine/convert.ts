import type { BoolExpr, NumExpr, Stmt, StrategyIR, StrategyInput } from "../ir";
import { IR_VERSION } from "../ir";
import { PineLexError } from "./lexer";
import { type PineFuncDef, PineParseError, parsePine, type PineArg, type PineExpr, type PineStmt } from "./parser";

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

type Val = { t: "num"; e: NumExpr } | { t: "bool"; e: BoolExpr } | { t: "str"; v: string };

const PRICE_FIELDS = new Set(["open", "high", "low", "close", "volume", "hl2", "hlc3", "ohlc4"]);
/** Pine `na` as a numeric value: 0/0 → NaN, so nz()/na()/isfinite handle it uniformly. */
const NAN_NUM: NumExpr = { k: "arith", op: "/", a: { k: "num", v: 0 }, b: { k: "num", v: 0 } };
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const PLOT_CALLS = new Set(["plot", "hline", "plotshape", "plotchar"]);
/** Drawing-object constructors (label.new, line.new, box.new, …). */
const DRAWING_NEW_RE = /^(label|line|linefill|box|table|polyline)\.new$/;
/** Drawing-object mutators/removers whose effects we can't track (skipped with a warning). */
const DRAWING_MUTATE_RE = /^(label|line|linefill|box|table|polyline)\.(set_\w+|delete|copy|all)$/;

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
  private readonly funcs = new Map<string, PineFuncDef>();
  private readonly inlining = new Set<string>();
  private readonly loopVars = new Set<string>();
  private readonly colorVars = new Map<string, string | undefined>();
  private readonly drawingHandles = new Set<string>();
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
      case "for":
        return [this.forStmt(stmt)];
      case "while":
        return [{ k: "while", cond: this.bool(stmt.cond), body: stmt.body.flatMap((s) => this.stmt(s)), cap: 1000 }];
      case "func":
        this.checkName(stmt.def.name);
        this.funcs.set(stmt.def.name, stmt.def);
        return [];
      case "unsupported":
        // Structural constructs the per-bar scalar IR can never hold fail closed
        // with an honest reason instead of a cascade of confusing follow-up errors.
        if (stmt.what.startsWith("collection")) {
          throw new PineConvertError(
            `This script stores state in collections (${stmt.what.replace("collection ", "")}, line ${stmt.line}) — arrays/matrices/maps can't run in the per-bar trading engine.`
          );
        }
        if (stmt.what === "type block") {
          throw new PineConvertError(
            `This script defines its own data types (\`type\` on line ${stmt.line}) and builds its logic on them — user-defined objects can't run in the per-bar trading engine. Scripts like this are usually visual analytics tools (labels/lines/tables), not convertible trading logic.`
          );
        }
        if (stmt.what.startsWith("for…in")) {
          throw new PineConvertError(
            `for…in iterates a collection (line ${stmt.line}) — arrays/matrices/maps can't run in the per-bar trading engine.`
          );
        }
        this.warn(`Skipped unsupported statement (“${stmt.what}”, line ${stmt.line}).`);
        return [];
    }
  }

  private forStmt(stmt: Extract<PineStmt, { t: "for" }>): Stmt {
    this.checkName(stmt.var);
    this.loopVars.add(stmt.var);
    this.numVars.add(stmt.var);
    const from = this.num(stmt.from);
    const to = this.num(stmt.to);
    const step = stmt.step ? this.num(stmt.step) : { k: "num" as const, v: 1 };
    const body = stmt.body.flatMap((s) => this.stmt(s));
    return { k: "for", var: stmt.var, from, to, step, body, cap: 10_000 };
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
    // `l = line.new(...)` — draws AND binds a handle. Emit the mapped drawing (or a
    // skip-warning) and remember the handle so later set_*/delete calls are understood.
    if (value.t === "call" && DRAWING_NEW_RE.test(value.callee)) {
      this.drawingHandles.add(name);
      return this.exprStatement(value);
    }
    // Color-valued bindings (`col = trendUp ? color.lime : color.red`) are cosmetic —
    // record the resolved color (if constant) and drop the binding.
    if (this.isColorExpr(value)) {
      this.colorVars.set(name, this.colorOf(value));
      return [];
    }
    // String constants (`string GROUP = "Main"`, mode names, concatenations) — bind
    // as compile-time strings so comparisons against them fold to constants.
    const str = this.strVal(value);
    if (str !== undefined) {
      if (this.reassigned.has(name)) {
        throw new PineConvertError(`Variable "${name}" holds text and is reassigned — mutable string state isn't supported.`);
      }
      this.env.set(name, { t: "str", v: str });
      return [];
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
    if (val.t === "str") {
      throw new PineConvertError(`Variable "${name}" holds text and is reassigned — mutable string state isn't supported.`);
    }
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
    if (value.t === "call" && DRAWING_NEW_RE.test(value.callee)) {
      this.drawingHandles.add(name);
      return this.exprStatement(value);
    }
    if (value.t === "ternary" && !isBoolExpr(value, this.boolVars, this.env)) {
      this.numVars.add(name);
      return [this.ternaryToIf(name, value)];
    }
    const val = this.val(value);
    if (val.t === "str") {
      throw new PineConvertError(`Variable "${name}" holds text and is reassigned — mutable string state isn't supported.`);
    }
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
    // `[a, b] = [x, y]` — direct tuple literal.
    if (value.t === "tuplelit") {
      names.forEach((n, i) => {
        this.checkName(n);
        if (i < value.items.length) this.env.set(n, this.val(value.items[i]));
      });
      return [];
    }
    if (value.t !== "call") throw new PineConvertError("Tuple assignment must destructure a function call.");
    // `[a, b] = myFn(...)` — user function returning a tuple.
    if (this.funcs.has(value.callee)) {
      const parts = this.inlineUserFuncTuple(value.callee, value.args);
      names.forEach((n, i) => {
        this.checkName(n);
        if (i < parts.length) this.env.set(n, parts[i]);
      });
      return [];
    }
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
    if (expr.t === "switch") return this.switchStmt(expr);
    if (expr.t !== "call") {
      this.warn("Skipped a bare expression statement with no effect.");
      return [];
    }
    const callee = expr.callee;
    const args = expr.args;
    // A bare call to a user function only computes a value — discarded here.
    if (this.funcs.has(callee)) {
      this.warn(`Skipped bare call to "${callee}()" — its return value isn't used.`);
      return [];
    }

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
      case "bgcolor": {
        // bgcolor(cond ? color : na) — background shading → a full-height box while
        // the condition holds. Non-conditional/unresolvable colors stay display-skips.
        const colorArg = arg(args, 0, "color");
        if (colorArg?.value.t === "ternary") {
          const { cond, a, b } = colorArg.value;
          const aIsNa = isNaIdent(a);
          const bIsNa = isNaIdent(b);
          if (aIsNa !== bIsNa) {
            const when = aIsNa ? ({ k: "not", a: this.bool(cond) } as BoolExpr) : this.bool(cond);
            const hex = this.colorOf(aIsNa ? b : a) ?? "#8f9bb3";
            return [{ k: "box", top: NAN_NUM, bottom: NAN_NUM, when, label: "", color: hex }];
          }
        }
        this.warn("Skipped bgcolor() — only conditional shading (cond ? color : na) is convertible.");
        return [];
      }
      case "runtime.error":
      case "strategy.cancel":
      case "strategy.cancel_all":
      case "fill":
      case "barcolor":
      case "plotcandle":
      case "plotbar":
      case "plotarrow": {
        this.warn(`Skipped display-only/unsupported call: ${callee}().`);
        return [];
      }
      case "label.new":
        return this.mapLabelNew(args);
      case "line.new":
        return this.mapLineNew(args);
      case "box.new":
        return this.mapBoxNew(args);
      default:
        if (DRAWING_MUTATE_RE.test(callee)) {
          this.warnOnce("drawmut", `Drawing updates/removals (${callee} and similar) are ignored — drawings are approximated statically.`);
          return [];
        }
        if (callee.startsWith("label") || callee.startsWith("line") || callee.startsWith("box") || callee.startsWith("table") || callee.startsWith("array") || callee.startsWith("matrix")) {
          this.warn(`Skipped drawing/collection call: ${callee}().`);
          return [];
        }
        throw new PineConvertError(`Unsupported statement call: ${callee}().`);
    }
  }

  // ---------- drawing-object mapping (display-only approximations) ----------

  /** label.new(x, y, text, …) → a chart marker at the bars where this statement
   *  runs. Direction comes from style/yloc; dynamic text falls back to static. */
  private mapLabelNew(args: PineArg[]): Stmt[] {
    const textArg = arg(args, 2, "text");
    let text = textArg ? this.strVal(textArg.value) : undefined;
    if (textArg && text === undefined) {
      this.warnOnce("dyntext", "Dynamic label text (str.* formatting) isn't supported — labels imported without text.");
      text = "";
    }
    const styleName = identName(arg(args, undefined, "style")?.value);
    const ylocName = identName(arg(args, undefined, "yloc")?.value);
    const dir: "up" | "down" = styleName.includes("down") || ylocName.includes("above") ? "down" : "up";
    return [{ k: "marker", dir, label: sanitizeText(text ?? ""), when: { k: "bool", v: true } }];
  }

  /** line.new(x1, y1, x2, y2, …) → a horizontal level (ray) when y1 and y2 are the
   *  same expression; slanted segments have no per-bar representation and are skipped. */
  private mapLineNew(args: PineArg[]): Stmt[] {
    const y1 = arg(args, 1, "y1");
    const y2 = arg(args, 3, "y2");
    if (!y1) {
      this.warn("Skipped line.new() without coordinates.");
      return [];
    }
    if (y2 && JSON.stringify(y1.value) !== JSON.stringify(y2.value)) {
      this.warnOnce("slanted", "Slanted line.new() segments (y1 ≠ y2) can't be drawn per-bar — skipped.");
      return [];
    }
    this.warnOnce("linelevel", "line.new() imported as a horizontal level from the firing bar (x-coordinates/extend are approximated).");
    const color = this.colorOf(arg(args, undefined, "color")?.value) ?? "#8f9bb3";
    return [{ k: "ray", price: this.num(y1.value), when: { k: "bool", v: true }, label: "", color }];
  }

  /** box.new(left, top, right, bottom, …) → a box over the bars where this statement
   *  runs; the drawn top/bottom come from the price arguments, x-args are ignored. */
  private mapBoxNew(args: PineArg[]): Stmt[] {
    const top = arg(args, 1, "top");
    const bottom = arg(args, 3, "bottom");
    if (!top || !bottom) {
      this.warn("Skipped box.new() without top/bottom prices.");
      return [];
    }
    this.warnOnce("boxspan", "box.new() imported as a zone over the bars where it fires (left/right x-coordinates are approximated).");
    const color =
      this.colorOf(arg(args, undefined, "bgcolor")?.value) ?? this.colorOf(arg(args, undefined, "border_color")?.value) ?? "#26a69a";
    return [{ k: "box", top: this.num(top.value), bottom: this.num(bottom.value), when: { k: "bool", v: true }, label: "", color }];
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

  /** Plot values are evaluated per bar in the chart preview, so mutable-var and
   *  dynamic-history reads are fine here (unlike vectorized indicator sources). */
  private plotValue(expr: PineExpr, _what: string): NumExpr {
    return this.num(expr);
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
    // input.color: cosmetic — resolve the default to a hex and treat as a color binding.
    if (kind === "input.color") {
      this.colorVars.set(name, this.colorOf(defArg.value));
      this.warn(`input.color "${name}" fixed to its default (colors aren't tunable here).`);
      return;
    }
    // input.string (mode selectors, group names…): not tunable here — freeze to the
    // default so comparisons against it fold to compile-time constants.
    const strDefault = this.strVal(defArg.value);
    if (kind === "input.string" || (strDefault !== undefined && kind !== "input.bool")) {
      if (strDefault === undefined) throw new PineConvertError(`input.string "${name}" must have a literal text default.`);
      this.env.set(name, { t: "str", v: strDefault });
      this.warn(`input.string "${name}" fixed to its default "${strDefault}" (text inputs aren't tunable here).`);
      return;
    }
    // input.time(timestamp("…")) — resolve the timestamp literal to epoch ms.
    if (defArg.value.t === "call" && defArg.value.callee === "timestamp") {
      const dateArg = defArg.value.args[0]?.value;
      const parsed = dateArg?.t === "str" ? Date.parse(dateArg.v) : Number.NaN;
      if (Number.isFinite(parsed)) {
        if (!this.inputs.some((input) => input.name === name)) this.inputs.push({ name, value: parsed });
        this.env.set(name, { t: "num", e: { k: "input", name } });
        return;
      }
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
    } else {
      throw new PineConvertError(`input "${name}" must have a literal numeric default.`);
    }
    if (!this.inputs.some((input) => input.name === name)) this.inputs.push({ name, value });
    this.env.set(name, { t: "num", e: { k: "input", name } });
  }

  // ---------- expressions ----------

  private val(expr: PineExpr): Val {
    // User functions and switch can yield either type — resolve by evaluating them.
    if (expr.t === "call" && this.funcs.has(expr.callee)) return this.inlineUserFunc(expr.callee, expr.args);
    if (expr.t === "switch") return this.switchVal(expr);
    const str = this.strVal(expr);
    if (str !== undefined) return { t: "str", v: str };
    if (isBoolExpr(expr, this.boolVars, this.env)) return { t: "bool", e: this.bool(expr) };
    return { t: "num", e: this.num(expr) };
  }

  // ---------- user-function inlining ----------

  /**
   * Inline a call to a user function by call-by-value substitution: evaluate the
   * arguments in the caller's scope, bind them (and any immutable body locals) as
   * temporary env entries, then evaluate the return expression. Series semantics
   * are preserved because our expressions are vectorized. Recursion and functions
   * with mutable locals / side effects (:=, if, plot, orders…) are rejected.
   */
  private inlineUserFunc(name: string, callArgs: PineArg[]): Val {
    return this.withInlinedFunc(name, callArgs, (retExpr) => this.val(retExpr));
  }

  /** Inline a tuple-returning function (`f(...) => … [a, b]`) → one Val per element. */
  private inlineUserFuncTuple(name: string, callArgs: PineArg[]): Val[] {
    return this.withInlinedFunc(name, callArgs, (retExpr) => {
      if (retExpr.t !== "tuplelit") throw new PineConvertError(`"${name}()" doesn't return a tuple to destructure.`);
      return retExpr.items.map((item) => this.val(item));
    });
  }

  /** Bind arguments + immutable locals in a temporary scope, evaluate the return, restore. */
  private withInlinedFunc<T>(name: string, callArgs: PineArg[], evalRet: (retExpr: PineExpr) => T): T {
    const def = this.funcs.get(name);
    if (!def) throw new PineConvertError(`Unknown function "${name}".`);
    if (this.inlining.has(name)) throw new PineConvertError(`Recursive function "${name}()" isn't supported.`);
    const positional = callArgs.filter((a) => !a.name);
    if (positional.length > def.params.length) throw new PineConvertError(`${name}() called with too many arguments.`);
    // Resolve each parameter's value in the CALLER's scope (before binding).
    const bound: { name: string; val: Val }[] = [];
    def.params.forEach((param, i) => {
      const supplied = callArgs.find((a) => a.name === param.name)?.value ?? positional[i]?.value ?? param.def;
      if (!supplied) throw new PineConvertError(`${name}() is missing argument "${param.name}".`);
      bound.push({ name: param.name, val: this.val(supplied) });
    });

    this.inlining.add(name);
    const saved = new Map<string, Val | undefined>();
    const numSaved = new Set<string>();
    const boolSaved = new Set<string>();
    const shadow = (n: string, v: Val) => {
      if (!saved.has(n)) saved.set(n, this.env.get(n));
      this.env.set(n, v);
      if (v.t === "num" && !this.numVars.has(n)) numSaved.add(n);
      if (v.t === "bool" && !this.boolVars.has(n)) boolSaved.add(n);
    };
    try {
      for (const b of bound) shadow(b.name, b.val);
      // Multi-line body: bind immutable locals; the last expression is the return value.
      let retExpr = def.ret;
      const body = def.body;
      for (let i = 0; i < body.length; i += 1) {
        const s = body[i];
        const last = i === body.length - 1;
        if (s.t === "assign" && !s.declaredVar) {
          shadow(s.name, this.val(s.value));
        } else if (s.t === "expr" && last) {
          retExpr = s.value;
        } else if (s.t === "func") {
          throw new PineConvertError(`Nested function definitions in "${name}()" aren't supported.`);
        } else {
          throw new PineConvertError(`"${name}()" has control flow or side effects in its body — only value-returning functions can be inlined.`);
        }
      }
      if (!retExpr) throw new PineConvertError(`"${name}()" doesn't return a value.`);
      return evalRet(retExpr);
    } finally {
      for (const [n, v] of saved) {
        if (v === undefined) this.env.delete(n);
        else this.env.set(n, v);
      }
      for (const n of numSaved) this.numVars.delete(n);
      for (const n of boolSaved) this.boolVars.delete(n);
      this.inlining.delete(name);
    }
  }

  // ---------- switch ----------

  /** switch in value position → nested cond (numeric) or nested logic (boolean). */
  private switchVal(expr: Extract<PineExpr, { t: "switch" }>): Val {
    const def = expr.arms.find((a) => a.match === undefined);
    const cases = expr.arms.filter((a) => a.match !== undefined);
    const anyBool = expr.arms.some((a) => this.val(a.body).t === "bool");
    if (anyBool) {
      let acc: BoolExpr = def ? this.bool(def.body) : { k: "bool", v: false };
      for (let i = cases.length - 1; i >= 0; i -= 1) {
        const cond = this.switchArmCond(expr.subject, cases[i].match as PineExpr);
        const then = this.bool(cases[i].body);
        acc = { k: "logic", op: "or", a: { k: "logic", op: "and", a: cond, b: then }, b: { k: "logic", op: "and", a: { k: "not", a: cond }, b: acc } };
      }
      return { t: "bool", e: acc };
    }
    if (!def) this.warnOnce("switchdef", "switch without a default arm returns 0 for unmatched cases (Pine returns na).");
    let acc: NumExpr = def ? this.num(def.body) : { k: "num", v: 0 };
    for (let i = cases.length - 1; i >= 0; i -= 1) {
      const cond = this.switchArmCond(expr.subject, cases[i].match as PineExpr);
      acc = { k: "cond", cond, a: this.num(cases[i].body), b: acc };
    }
    return { t: "num", e: acc };
  }

  private switchArmCond(subject: PineExpr | undefined, match: PineExpr): BoolExpr {
    if (!subject) return this.bool(match);
    return { k: "compare", op: "==", a: this.num(subject), b: this.num(match) };
  }

  /** switch in statement position → if/elif/else running each arm's body statement. */
  private switchStmt(expr: Extract<PineExpr, { t: "switch" }>): Stmt[] {
    const def = expr.arms.find((a) => a.match === undefined);
    const cases = expr.arms.filter((a) => a.match !== undefined);
    if (!cases.length) return def ? this.exprStatement(def.body) : [];
    const first = cases[0];
    const node: Extract<Stmt, { k: "if" }> = {
      k: "if",
      cond: this.switchArmCond(expr.subject, first.match as PineExpr),
      then: this.exprStatement(first.body)
    };
    const elifs = cases.slice(1).map((c) => ({ cond: this.switchArmCond(expr.subject, c.match as PineExpr), then: this.exprStatement(c.body) }));
    if (elifs.length) node.elifs = elifs;
    if (def) node.else = this.exprStatement(def.body);
    return [node];
  }

  private num(expr: PineExpr): NumExpr {
    switch (expr.t) {
      case "tuplelit":
        throw new PineConvertError("A tuple ([a, b]) can't be used as a single number.");
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
        // Numeric conditional → cond node (vectorized; mutable-var interception happens in assign()).
        return { k: "cond", cond: this.bool(expr.cond), a: this.num(expr.a), b: this.num(expr.b) };
      case "switch": {
        const v = this.switchVal(expr);
        if (v.t !== "num") throw new PineConvertError("This switch yields a condition, not a number.");
        return v.e;
      }
      case "index": {
        const offsetExpr = expr.offset;
        const literal = offsetExpr.t === "num" && Number.isInteger(offsetExpr.v) && offsetExpr.v >= 0 ? offsetExpr.v : undefined;
        // x[1] on a mutable var → previous-bar value (varprev). Only offset 1 is representable.
        if (expr.base.t === "ident" && this.numVars.has(expr.base.name) && !this.env.has(expr.base.name)) {
          if (literal === 0) return { k: "var", name: expr.base.name };
          if (literal === 1) return { k: "varprev", name: expr.base.name };
          throw new PineConvertError(`Only the previous bar (${expr.base.name}[1]) is available for a mutable variable, not a further/dynamic offset.`);
        }
        const base = this.num(expr.base);
        if (literal !== undefined) {
          if (containsVar(base)) {
            throw new PineConvertError("History access on a mutable variable (x[1]) isn't supported — variables hold only their latest value.");
          }
          if (literal === 0) return base;
          if (base.k === "price" && !base.offset) return { k: "price", field: base.field, offset: literal };
          return { k: "shift", src: base, offset: literal };
        }
        // Dynamic offset (e.g. close[i] in a loop) — only a plain price field can read it per bar.
        if (base.k === "price" && !base.offset) {
          return { k: "histn", field: base.field, offset: this.num(offsetExpr) };
        }
        throw new PineConvertError(
          "A dynamic history offset (x[i]) is only supported on a raw price field (close[i], high[i], …), not on an indicator or computed series."
        );
      }
      case "call":
        if (this.funcs.has(expr.callee)) {
          const v = this.inlineUserFunc(expr.callee, expr.args);
          if (v.t !== "num") throw new PineConvertError(`"${expr.callee}()" returns a condition, not a number.`);
          return v.e;
        }
        return this.numCall(expr);
    }
  }

  private numIdent(name: string): NumExpr {
    const bound = this.env.get(name);
    if (bound) {
      if (bound.t === "str") throw new PineConvertError(`"${name}" is a text value ("${bound.v}"), not a number.`);
      if (bound.t !== "num") throw new PineConvertError(`"${name}" is a condition, not a number.`);
      return bound.e;
    }
    if (PRICE_FIELDS.has(name)) return { k: "price", field: name as never };
    if (this.numVars.has(name)) return { k: "var", name };
    const constant = MATH_CONSTS[name];
    if (constant !== undefined) return { k: "num", v: constant };
    // `ta.tr` is a built-in series (True Range) used without parentheses.
    if (name === "ta.tr") return this.trueRange();
    if (name.startsWith("ta.")) throw this.unsupportedFn(name);
    if (name === "strategy.position_size") {
      this.warnOnce("possize", "strategy.position_size is mapped to the position DIRECTION sign (+1/-1/0), not the size.");
      return { k: "ctx", key: "position_dir" };
    }
    if (name === "strategy.equity") return { k: "ctx", key: "equity" };
    if (name === "strategy.position_avg_price") return { k: "ctx", key: "entry_price" };
    if (name === "strategy.openprofit") return { k: "ctx", key: "unrealized_pnl" };
    if (name === "strategy.wintrades" || name === "strategy.losstrades" || name === "strategy.closedtrades" || name === "strategy.netprofit") {
      throw new PineConvertError(`${name} (whole-backtest strategy stats) isn't available to a live per-bar engine.`);
    }
    if (name === "bar_index" || name === "last_bar_index" || name === "n") {
      throw new PineConvertError(`${name} (absolute bar count) isn't available — use bars-in-trade or a counter variable instead.`);
    }
    if (name.startsWith("barstate.")) throw new PineConvertError(`${name} isn't available — the engine evaluates one confirmed bar at a time.`);
    if (name === "timenow" || name === "time" || name === "time_close" || name === "time_tradingday") {
      throw new PineConvertError(`${name} (wall-clock/bar time) isn't a supported value — use the session/day-of-week condition blocks.`);
    }
    if (name.startsWith("syminfo.") || name.startsWith("timeframe.")) {
      throw new PineConvertError(`${name} reads symbol/timeframe metadata that isn't available to the engine.`);
    }
    const drawingNs = ["label.", "line.", "linefill.", "box.", "table.", "polyline.", "chart."];
    if (drawingNs.some((prefix) => name.startsWith(prefix))) {
      throw new PineConvertError(`${name} belongs to chart drawing (labels/lines/boxes/tables) — visual objects can't run in the trading engine.`);
    }
    if (this.plotHandles.has(name)) throw new PineConvertError(`"${name}" is a plot handle — it can't be used as a value.`);
    // Drawing handles read as values (the `if na(l)` first-bar idiom) → na.
    if (this.drawingHandles.has(name)) {
      this.warnOnce("handleread", `Drawing handles ("${name}") have no value here — reads yield na.`);
      return NAN_NUM;
    }
    // `someVar.field` — field access on a known binding (user objects).
    if (name.includes(".")) {
      const head = name.split(".")[0];
      if (this.env.has(head) || this.numVars.has(head) || this.boolVars.has(head)) {
        throw new PineConvertError(`"${name}" accesses a field of an object — user-defined objects and collections can't run in the per-bar trading engine.`);
      }
    }
    // `na` as a numeric value → NaN (0/0). nz()/na()/isfinite handling all treat it correctly.
    if (name === "na") return NAN_NUM;
    throw new PineConvertError(`Unknown identifier "${name}" — it was never assigned (or its definition was skipped).`);
  }

  private numCall(expr: Extract<PineExpr, { t: "call" }>): NumExpr {
    const callee = normalizeTa(expr.callee);
    const args = expr.args;
    const period = (i: number, name: string) => this.numArg(args, i, name);

    switch (callee) {
      case "ta.sma":
      case "ta.ema":
      case "ta.rma":
      case "ta.wma":
      case "ta.vwma": {
        const kind = callee.slice(3) as "sma" | "ema" | "rma" | "wma" | "vwma";
        return { k: "ma", kind, period: period(1, "length"), source: this.seriesArg(args, 0, "source") };
      }
      case "ta.hma":
        return this.hma(this.seriesArg(args, 0, "source"), period(1, "length"));
      case "ta.swma":
        return this.swma(this.seriesArg(args, 0, "source"));
      case "ta.rsi":
        return { k: "rsi", period: period(1, "length"), source: this.seriesArg(args, 0, "source") };
      case "ta.atr":
        return { k: "atr", period: period(0, "length") };
      case "ta.tr":
        // Exact True Range: max(high-low, |high-close[1]|, |low-close[1]|).
        return this.trueRange();
      case "ta.stdev":
      case "ta.dev": {
        const src = this.seriesArg(args, 0, "source");
        const len = period(1, "length");
        if (callee === "ta.dev") {
          // Mean absolute deviation: sma(|src - sma(src,len)|, len).
          const mean: NumExpr = { k: "ma", kind: "sma", period: len, source: src };
          return { k: "agg", fn: "avg", src: { k: "unary", op: "abs", a: { k: "arith", op: "-", a: src, b: mean } }, period: len };
        }
        return { k: "stdev", period: len, source: src };
      }
      case "ta.variance": {
        this.warnOnce("variance", "ta.variance computed as stdev²(len).");
        const sd: NumExpr = { k: "stdev", period: period(1, "length"), source: this.seriesArg(args, 0, "source") };
        return { k: "arith", op: "^", a: sd, b: { k: "num", v: 2 } };
      }
      case "ta.sum":
        return { k: "agg", fn: "sum", src: this.seriesArg(args, 0, "source"), period: period(1, "length") };
      case "ta.median":
        return { k: "agg", fn: "median", src: this.seriesArg(args, 0, "source"), period: period(1, "length") };
      case "ta.cum":
        return { k: "cum", src: this.seriesArg(args, 0, "source") };
      case "ta.barssince":
        return { k: "barssince", cond: this.bool(argRequired(args, 0, "condition", "ta.barssince").value) };
      case "ta.bbw": {
        // Bollinger Band Width: (upper - lower) / middle.
        const src = this.seriesArg(args, 0, "source");
        const len = period(1, "length");
        const mult = this.numArg(args, 2, "mult", { k: "num", v: 2 });
        const upper: NumExpr = { k: "bollinger", band: "upper", period: len, dev: mult, source: src };
        const lower: NumExpr = { k: "bollinger", band: "lower", period: len, dev: mult, source: src };
        const middle: NumExpr = { k: "bollinger", band: "middle", period: len, dev: mult, source: src };
        return { k: "arith", op: "/", a: { k: "arith", op: "-", a: upper, b: lower }, b: middle };
      }
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
        return { k: "unary", op: "sqrt", a: this.numArg(args, 0, "number") };
      case "math.sign":
        return { k: "unary", op: "sign", a: this.numArg(args, 0, "number") };
      case "math.log":
        return { k: "unary", op: "log", a: this.numArg(args, 0, "number") };
      case "math.log10":
        return { k: "unary", op: "log10", a: this.numArg(args, 0, "number") };
      case "math.exp":
        return { k: "unary", op: "exp", a: this.numArg(args, 0, "number") };
      case "math.todegrees":
        return { k: "arith", op: "*", a: this.numArg(args, 0, "radians"), b: { k: "num", v: 180 / Math.PI } };
      case "math.toradians":
        return { k: "arith", op: "*", a: this.numArg(args, 0, "degrees"), b: { k: "num", v: Math.PI / 180 } };
      case "math.round_to_mintick":
        this.warnOnce("mintick", "math.round_to_mintick passed through unrounded (tick size isn't known here).");
        return this.numArg(args, 0, "number");
      case "math.avg": {
        if (args.length < 2) throw new PineConvertError("math.avg needs at least two arguments.");
        let sum: NumExpr = this.num(args[0].value);
        for (let i = 1; i < args.length; i += 1) sum = { k: "arith", op: "+", a: sum, b: this.num(args[i].value) };
        return { k: "arith", op: "/", a: sum, b: { k: "num", v: args.length } };
      }
      case "math.sin":
      case "math.cos":
      case "math.tan":
      case "math.asin":
      case "math.acos":
      case "math.atan":
        throw new PineConvertError(`${callee}() (trigonometry) isn't supported — no trig primitive in the strategy engine.`);
      case "math.random":
        throw new PineConvertError("math.random() is non-deterministic and can't run identically in backtest and live.");
      case "nz":
        return { k: "nz", a: this.numArg(args, 0, "source"), b: this.numArg(args, 1, "replacement", { k: "num", v: 0 }) };
      case "fixnan":
        this.warnOnce("fixnan", "fixnan() passed through (warm-up NaNs aren't forward-filled here).");
        return this.numArg(args, 0, "source");
      case "iff": {
        // Pine's legacy iff(cond, a, b) — a numeric ternary.
        const cond = this.bool(argRequired(args, 0, "condition", "iff").value);
        return { k: "cond", cond, a: this.numArg(args, 1, "then"), b: this.numArg(args, 2, "else") };
      }
      case "ta.macd": {
        // Used undestructured (e.g. `ta.macd(...) > 0`) → the MACD line.
        this.warnOnce("macdline", "ta.macd() used in an expression → the MACD line (destructure [m, s, h] for signal/histogram).");
        const src = this.seriesArg(args, 0, "source");
        return { k: "macd", line: "macd", fast: period(1, "fastlen"), slow: period(2, "slowlen"), signal: period(3, "siglen"), source: src };
      }
      case "color.new":
      case "color.rgb":
        throw new PineConvertError("color values can't be used as numbers.");
      default:
        throw this.unsupportedFn(expr.callee);
    }
  }

  /** Friendly, namespace-aware rejection for a function we can't map to the IR. */
  private unsupportedFn(callee: string): PineConvertError {
    const lookahead = ["ta.pivothigh", "ta.pivotlow", "ta.pivot_point_levels"];
    if (lookahead.includes(callee)) {
      return new PineConvertError(`${callee}() looks ahead in time (it confirms a pivot using future bars) — it can't run in a live per-bar engine.`);
    }
    if (callee === "time" || callee === "time_close") {
      return new PineConvertError(`${callee}() (session/time windows) isn't supported — use the "within UTC hours" session condition block instead.`);
    }
    if (callee === "request.security" || callee.startsWith("request.")) {
      return new PineConvertError(`${callee}() pulls external/other-timeframe data — not available in this per-bar engine.`);
    }
    const needsBlock: Record<string, string> = {
      "ta.vwap": "VWAP", "ta.linreg": "linear regression", "ta.valuewhen": "value-when", "ta.highestbars": "highest-bars offset",
      "ta.lowestbars": "lowest-bars offset", "ta.sar": "parabolic SAR", "ta.supertrend": "SuperTrend", "ta.mfi": "MFI",
      "ta.cmo": "CMO", "ta.tsi": "TSI", "ta.kc": "Keltner Channel", "ta.kcw": "Keltner width", "ta.correlation": "correlation",
      "ta.cog": "center of gravity", "ta.alma": "ALMA", "ta.mode": "mode", "ta.percentile_linear_interpolation": "percentile",
      "ta.percentile_nearest_rank": "percentile", "ta.percentrank": "percent-rank", "ta.dmi": "DMI/ADX", "ta.wpr": "Williams %R",
      "ta.rci": "RCI", "ta.range": "range"
    };
    if (needsBlock[callee]) {
      return new PineConvertError(`${callee}() (${needsBlock[callee]}) has no matching indicator primitive yet — rebuild it from the supported blocks, or request native support.`);
    }
    if (callee.startsWith("array.") || callee.startsWith("matrix.") || callee.startsWith("map.")) {
      return new PineConvertError(`${callee}() uses collections (arrays/matrices/maps), which the scalar per-bar IR can't represent.`);
    }
    if (callee.startsWith("str.") || callee.startsWith("format.")) {
      return new PineConvertError(`${callee}() manipulates strings, which aren't part of the numeric strategy IR.`);
    }
    const drawing = ["label.", "line.", "linefill.", "box.", "table.", "polyline.", "chart."];
    if (drawing.some((prefix) => callee.startsWith(prefix))) {
      return new PineConvertError(`${callee}() draws on the chart (labels/lines/boxes/tables) — visual objects can't run in the trading engine. If the script's core logic is computable, remove the drawing code and import the rest.`);
    }
    if (callee.startsWith("ticker.") || callee === "timeframe.period" || callee.startsWith("syminfo.")) {
      return new PineConvertError(`${callee}() reads symbol/timeframe metadata that isn't available to the engine.`);
    }
    return new PineConvertError(`Unsupported function: ${callee}().`);
  }

  /** True Range = max(high - low, |high - close[1]|, |low - close[1]|). */
  private trueRange(): NumExpr {
    const hl: NumExpr = { k: "arith", op: "-", a: { k: "price", field: "high" }, b: { k: "price", field: "low" } };
    const hc: NumExpr = { k: "unary", op: "abs", a: { k: "arith", op: "-", a: { k: "price", field: "high" }, b: { k: "price", field: "close", offset: 1 } } };
    const lc: NumExpr = { k: "unary", op: "abs", a: { k: "arith", op: "-", a: { k: "price", field: "low" }, b: { k: "price", field: "close", offset: 1 } } };
    return { k: "minmax", op: "max", a: hl, b: { k: "minmax", op: "max", a: hc, b: lc } };
  }

  /** Hull MA: wma(2·wma(src, ⌊len/2⌋) − wma(src, len), round(√len)). */
  private hma(src: NumExpr, len: NumExpr): NumExpr {
    const half: NumExpr = { k: "unary", op: "floor", a: { k: "arith", op: "/", a: len, b: { k: "num", v: 2 } } };
    const sqrtLen: NumExpr = { k: "unary", op: "round", a: { k: "unary", op: "sqrt", a: len } };
    const raw: NumExpr = {
      k: "arith",
      op: "-",
      a: { k: "arith", op: "*", a: { k: "num", v: 2 }, b: { k: "ma", kind: "wma", period: half, source: src } },
      b: { k: "ma", kind: "wma", period: len, source: src }
    };
    return { k: "ma", kind: "wma", period: sqrtLen, source: raw };
  }

  /** Symmetric weighted MA of the last 4 bars, weights [1,2,2,1]/6. */
  private swma(src: NumExpr): NumExpr {
    const w = (offset: number, mult: number): NumExpr => ({
      k: "arith",
      op: "*",
      a: offset === 0 ? src : { k: "shift", src, offset },
      b: { k: "num", v: mult / 6 }
    });
    const sum: NumExpr = {
      k: "arith",
      op: "+",
      a: { k: "arith", op: "+", a: w(3, 1), b: w(2, 2) },
      b: { k: "arith", op: "+", a: w(1, 2), b: w(0, 1) }
    };
    return sum;
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
      case "tuplelit":
        throw new PineConvertError("A tuple ([a, b]) can't be used as a condition.");
      case "ident": {
        if (expr.name === "true") return { k: "bool", v: true };
        if (expr.name === "false") return { k: "bool", v: false };
        if (this.boolInputs.has(expr.name)) {
          // input.bool used as a condition: != 0.
          return { k: "compare", op: "!=", a: { k: "input", name: expr.name }, b: { k: "num", v: 0 } };
        }
        const bound = this.env.get(expr.name);
        if (bound) {
          if (bound.t === "str") throw new PineConvertError(`"${expr.name}" is a text value ("${bound.v}"), not a condition.`);
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
        // `x == na` / `x != na` → na test (Pine forbids direct == na, but scripts still write it).
        if (expr.op === "==" || expr.op === "!=") {
          const naSide = isNaIdent(expr.a) ? expr.b : isNaIdent(expr.b) ? expr.a : undefined;
          if (naSide) {
            const test: BoolExpr = { k: "isna", a: this.num(naSide) };
            return expr.op === "==" ? test : { k: "not", a: test };
          }
          // String comparisons (mode selectors vs frozen input.string) fold to constants.
          const strA = this.strVal(expr.a);
          if (strA !== undefined) {
            const strB = this.strVal(expr.b);
            if (strB === undefined) throw new PineConvertError("A text value can only be compared with another text value.");
            return { k: "bool", v: expr.op === "==" ? strA === strB : strA !== strB };
          }
        }
        if (["==", "!=", "<", "<=", ">", ">="].includes(expr.op)) {
          return { k: "compare", op: expr.op as ">", a: this.num(expr.a), b: this.num(expr.b) };
        }
        throw new PineConvertError(`Operator "${expr.op}" doesn't produce a condition.`);
      }
      case "switch": {
        const v = this.switchVal(expr);
        if (v.t !== "bool") throw new PineConvertError("This switch yields a number, not a condition.");
        return v.e;
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
        if (this.funcs.has(expr.callee)) {
          const v = this.inlineUserFunc(expr.callee, expr.args);
          if (v.t !== "bool") throw new PineConvertError(`"${expr.callee}()" returns a number, not a condition.`);
          return v.e;
        }
        const callee = normalizeTa(expr.callee);
        if (callee === "ta.crossover") return { k: "cross", dir: "above", a: this.numArg(expr.args, 0, "a"), b: this.numArg(expr.args, 1, "b") };
        if (callee === "ta.crossunder") return { k: "cross", dir: "below", a: this.numArg(expr.args, 0, "a"), b: this.numArg(expr.args, 1, "b") };
        if (callee === "ta.cross") return { k: "cross", dir: "any", a: this.numArg(expr.args, 0, "a"), b: this.numArg(expr.args, 1, "b") };
        if (callee === "ta.rising" || callee === "ta.falling") return this.risingFalling(callee, expr.args);
        if (callee === "na") return { k: "isna", a: this.num(argRequired(expr.args, 0, "x", "na").value) };
        if (callee === "iff") {
          const cond = this.bool(argRequired(expr.args, 0, "condition", "iff").value);
          return {
            k: "logic",
            op: "or",
            a: { k: "logic", op: "and", a: cond, b: this.bool(argRequired(expr.args, 1, "then", "iff").value) },
            b: { k: "logic", op: "and", a: { k: "not", a: cond }, b: this.bool(argRequired(expr.args, 2, "else", "iff").value) }
          };
        }
        throw this.unsupportedFn(callee);
      }
      case "num":
        // Pine treats a nonzero number as truthy in a few idioms; only 0/1 make sense here.
        return { k: "compare", op: "!=", a: { k: "num", v: expr.v }, b: { k: "num", v: 0 } };
      case "index": {
        // Boolean history: cond[n] → the inlined condition with its series shifted n bars.
        const offsetExpr = expr.offset;
        if (offsetExpr.t !== "num" || !Number.isInteger(offsetExpr.v) || offsetExpr.v < 0) {
          throw new PineConvertError("A condition's history offset [n] must be a non-negative integer literal.");
        }
        return shiftBool(this.bool(expr.base), offsetExpr.v);
      }
      case "str":
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
    if (expr.t === "ident" && this.colorVars.has(expr.name)) return this.colorVars.get(expr.name);
    if (expr.t === "call" && (expr.callee === "color.new" || expr.callee === "color.rgb" || expr.callee === "color.from_gradient")) {
      return this.colorOf(expr.args[0]?.value);
    }
    if (expr.t === "ternary") return this.colorOf(expr.a) ?? this.colorOf(expr.b);
    if (expr.t === "switch") return expr.arms.map((armExpr) => this.colorOf(armExpr.body)).find((hex) => hex !== undefined);
    if (expr.t === "str" && /^#[0-9a-fA-F]{6}$/.test(expr.v)) return expr.v;
    return undefined; // conditional/unknown colors are cosmetic — fall back silently
  }

  /** Resolve an expression to a compile-time string, if it is one: literals,
   *  string-bound identifiers, and `+` concatenations of those. Undefined = not a string. */
  private strVal(expr: PineExpr): string | undefined {
    if (expr.t === "str") return expr.v;
    if (expr.t === "ident") {
      const bound = this.env.get(expr.name);
      return bound?.t === "str" ? bound.v : undefined;
    }
    if (expr.t === "binary" && expr.op === "+") {
      const a = this.strVal(expr.a);
      if (a === undefined) return undefined;
      const b = this.strVal(expr.b);
      return b === undefined ? undefined : a + b;
    }
    return undefined;
  }

  /** Whether an expression is a color (so a `col = …` binding is cosmetic, not numeric). */
  private isColorExpr(expr: PineExpr): boolean {
    if (expr.t === "ident") return expr.name.startsWith("color.") || this.colorVars.has(expr.name);
    if (expr.t === "call") return expr.callee.startsWith("color.");
    if (expr.t === "ternary") return this.isColorExpr(expr.a) && this.isColorExpr(expr.b);
    if (expr.t === "switch") return expr.arms.length > 0 && expr.arms.every((armExpr) => this.isColorExpr(armExpr.body));
    return false;
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

const MATH_CONSTS: Record<string, number> = {
  "math.pi": Math.PI,
  "math.e": Math.E,
  "math.phi": 1.618033988749895,
  "math.rphi": 0.6180339887498949
};

/** Shift a numeric series expression back by n bars (for inlined boolean/numeric history). */
function shiftNum(expr: NumExpr, n: number): NumExpr {
  if (n === 0) return expr;
  if (expr.k === "num" || expr.k === "input") return expr; // constants don't move with history
  if (containsVar(expr)) throw new PineConvertError("History of a mutable-variable expression isn't supported.");
  if (expr.k === "price") return { k: "price", field: expr.field, offset: (expr.offset ?? 0) + n };
  if (expr.k === "shift") return { k: "shift", src: expr.src, offset: expr.offset + n };
  return { k: "shift", src: expr, offset: n };
}

/** Shift an inlined boolean expression back by n bars. Multi-bar primitives (cross,
 *  trend, session) can't be re-based, so they're rejected with a clear message. */
function shiftBool(expr: BoolExpr, n: number): BoolExpr {
  if (n === 0) return expr;
  switch (expr.k) {
    case "bool":
      return expr;
    case "compare":
      return { k: "compare", op: expr.op, a: shiftNum(expr.a, n), b: shiftNum(expr.b, n) };
    case "logic":
      return { k: "logic", op: expr.op, a: shiftBool(expr.a, n), b: shiftBool(expr.b, n) };
    case "not":
      return { k: "not", a: shiftBool(expr.a, n) };
    case "between":
      return { k: "between", value: shiftNum(expr.value, n), low: shiftNum(expr.low, n), high: shiftNum(expr.high, n) };
    case "isna":
      return { k: "isna", a: shiftNum(expr.a, n) };
    default:
      throw new PineConvertError(`The history of this condition (${expr.k}) can't be computed — rewrite it without [n] on that sub-expression.`);
  }
}

function identName(expr: PineExpr | undefined): string {
  return expr?.t === "ident" ? expr.name : "";
}

function isNaIdent(expr: PineExpr): boolean {
  return expr.t === "ident" && expr.name === "na";
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
    case "varprev":
    case "histn":
      // Scalar-only reads (loop counters / mutable state) — never valid as a vectorized series.
      return true;
    case "arith":
    case "minmax":
    case "nz":
      return containsVar(expr.a) || containsVar(expr.b);
    case "unary":
      return containsVar(expr.a);
    case "shift":
    case "cum":
      return containsVar(expr.src);
    case "cond":
      return containsVarInBool(expr.cond) || containsVar(expr.a) || containsVar(expr.b);
    case "barssince":
      return containsVarInBool(expr.cond);
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

/** Whether a BoolExpr transitively reads a mutable variable (used inside cond/barssince). */
function containsVarInBool(expr: BoolExpr): boolean {
  switch (expr.k) {
    case "varb":
      return true;
    case "compare":
    case "cross":
      return containsVar(expr.a) || containsVar(expr.b);
    case "logic":
      return containsVarInBool(expr.a) || containsVarInBool(expr.b);
    case "not":
      return containsVarInBool(expr.a);
    case "trend":
      return containsVar(expr.source) || containsVar(expr.period);
    case "between":
      return containsVar(expr.value) || containsVar(expr.low) || containsVar(expr.high);
    case "isna":
      return containsVar(expr.a);
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
      if (stmt.t === "for" || stmt.t === "while") walk(stmt.body);
      // Function bodies are inlined in their own scope — their locals aren't global vars.
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
      if (callee === "na") return true;
      return ["ta.crossover", "ta.crossunder", "ta.cross", "ta.rising", "ta.falling"].includes(callee);
    }
    case "ternary":
      return isBoolExpr(expr.a, boolVars, env) && isBoolExpr(expr.b, boolVars, env);
    case "switch":
      return expr.arms.every((armExpr) => isBoolExpr(armExpr.body, boolVars, env));
    default:
      return false;
  }
}
