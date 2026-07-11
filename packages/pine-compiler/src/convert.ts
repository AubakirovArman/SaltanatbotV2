import type { BoolExpr, NumExpr, Stmt, StrategyIR, StrategyInput } from "@saltanatbotv2/strategy-core";
import { IR_VERSION } from "@saltanatbotv2/strategy-core";
import { arg, argRequired } from "./arguments";
import { diagnosticFromMessage, type PineDiagnostic } from "./diagnostics";
import { PineConvertError } from "./errors";
import { containsVar } from "./expressionHistory";
import {
  COLOR_HEX,
  NAME_RE,
  PRICE_FIELDS
} from "./language";
import { PineLexError } from "./lexer";
import { PineParseError, parsePine, type PineArg, type PineExpr, type PineStmt } from "./parser";
import { type PlotHandleValue } from "./drawingLowering";
import { lowerNumericCall, type NumericCallLoweringContext } from "./numericCallLowering";
import { lowerBooleanCall, type BooleanCallLoweringContext } from "./booleanCallLowering";
import { lowerNumericExpression, type NumericExpressionLoweringContext } from "./numericExpressionLowering";
import { lowerBooleanExpression, type BooleanExpressionLoweringContext } from "./booleanExpressionLowering";
import { lowerBooleanIdentifier, lowerNumericIdentifier, type IdentifierLoweringContext } from "./identifierLowering";
import { lowerSwitchStatement, lowerSwitchValue, type SwitchLoweringContext } from "./switchLowering";
import {
  inlineUserFunction,
  inlineUserFunctionSafely,
  inlineUserFunctionTuple,
  type UserFunctionInliningContext,
  type UserFunctionInliningState
} from "./userFunctionInlining";
import { lowerValue, type ValueLoweringContext } from "./valueLowering";
import { lowerStrategyCall, type StrategyCallLoweringContext } from "./strategyCallLowering";
import { lowerStatement, type StatementLoweringContext } from "./statementLowering";
import { lowerTupleAssignment, type TupleLoweringContext } from "./tupleLowering";
import { lowerAssignment, lowerMutableAssignment, type AssignmentLoweringContext } from "./assignmentLowering";
import { lowerDeclaration, type DeclarationLoweringContext } from "./declarationLowering";
import { lowerPlotStatement, type PlotStatementLoweringContext } from "./plotStatementLowering";
import { lowerAlertStatement, type AlertStatementLoweringContext } from "./alertStatementLowering";
import { lowerDrawingStatement, type DrawingStatementLoweringContext } from "./drawingStatementLowering";
import { PineSymbolTable } from "./symbolTable";
import { analyzePine, type PineSemanticAnalysis } from "./semanticAnalysis";
import {
  boolToNumericSeries,
  collectionReceiver,
  isBoolExpr,
  isCosmeticConst,
  isFalseIdent,
  isTrueIdent,
  isUserObjectFieldName,
  literalColorByte,
  methodArgs,
  methodName,
  type PineValue
} from "./semanticHelpers";

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
  diagnostics: PineDiagnostic[];
}

export { PineConvertError } from "./errors";

type Val = PineValue;
type PlotHandle = PlotHandleValue;

/** Pine `na` as a numeric value: 0/0 → NaN, so nz()/na()/isfinite handle it uniformly. */
const NAN_NUM: NumExpr = { k: "arith", op: "/", a: { k: "num", v: 0 }, b: { k: "num", v: 0 } };

export function convertPine(source: string): PineResult {
  let ast: PineStmt[];
  try {
    ast = parsePine(source);
  } catch (cause) {
    if (cause instanceof PineLexError || cause instanceof PineParseError) throw new PineConvertError(cause.message);
    throw cause;
  }
  return new Converter(analyzePine(ast)).run(ast);
}

class Converter {
  private kind: "indicator" | "strategy" = "indicator";
  private name = "Imported Pine";
  private overlay = false; // Pine default for indicator() AND strategy()
  private readonly symbols = new PineSymbolTable();
  private readonly env = this.symbols.values;
  private readonly plotHandles = new Set<string>();
  private readonly plotHandleValues = new Map<string, PlotHandle>();
  private readonly numVars = this.symbols.numericVariables;
  private readonly boolVars = this.symbols.booleanVariables;
  private readonly boolInputs = new Set<string>();
  private readonly funcs = this.symbols.functions;
  private readonly inlining = new Set<string>();
  private readonly loopVars = new Set<string>();
  private readonly colorVars = new Map<string, string | undefined>();
  private readonly drawingHandles = new Set<string>();
  private readonly collectionVars = new Set<string>();
  private readonly opaqueVars = new Set<string>();
  private readonly collectionLengths = new Map<string, NumExpr>();
  private readonly matrixRows = new Map<string, NumExpr>();
  private readonly matrixColumns = new Map<string, NumExpr>();
  private readonly inputs: StrategyInput[] = [];
  private readonly init: Extract<Stmt, { k: "setvar" }>[] = [];
  private readonly warnings: string[] = [];
  private readonly warned = new Set<string>();
  private readonly reassigned: ReadonlySet<string>;
  private declared = false;
  private hasLongEntry = false;
  private hasShortEntry = false;
  private hasExplicitExit = false;

  constructor(analysis: PineSemanticAnalysis) {
    this.reassigned = analysis.reassigned;
    for (const [name, definition] of analysis.functions) this.funcs.set(name, definition);
  }

  run(ast: PineStmt[]): PineResult {
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
    return {
      kind: this.kind,
      name: this.name,
      ir,
      warnings: this.warnings,
      diagnostics: this.warnings.map((warning) => diagnosticFromMessage(warning, "warning", "PINE_COMPATIBILITY_WARNING"))
    };
  }

  // ---------- statements ----------

  private stmt(stmt: PineStmt): Stmt[] {
    return lowerStatement(this.statementContext(), stmt);
  }

  private statementContext(): StatementLoweringContext {
    return {
      assign: (name, value, declaredVar) => this.assign(name, value, declaredVar),
      bool: (value) => this.bool(value),
      checkName: (name) => this.checkName(name),
      expressionStatement: (value) => this.exprStatement(value),
      lower: (value) => this.stmt(value),
      num: (value) => this.num(value),
      registerFunction: (definition) => this.funcs.set(definition.name, definition),
      registerLoopVariable: (name) => {
        this.loopVars.add(name);
        this.numVars.add(name);
      },
      scope: (work) => this.symbols.withScope(work),
      setMutable: (name, value) => this.setMutable(name, value),
      tuple: (names, value) => this.tuple(names, value),
      warn: (message) => this.warn(message),
      warnOnce: (key, message) => this.warnOnce(key, message)
    };
  }

  private assign(name: string, value: PineExpr, declaredVar: boolean): Stmt[] {
    return lowerAssignment(this.assignmentContext(), name, value, declaredVar);
  }

  private setMutable(name: string, value: PineExpr): Stmt[] {
    return lowerMutableAssignment(this.assignmentContext(), name, value);
  }

  private assignmentContext(): AssignmentLoweringContext {
    return {
      addBooleanVariable: (name) => this.boolVars.add(name),
      addDrawingHandle: (name) => this.drawingHandles.add(name),
      addInit: (statement) => this.init.push(statement),
      addNumericVariable: (name) => this.numVars.add(name),
      addOpaqueVariable: (name) => this.opaqueVars.add(name),
      bind: (name, value) => this.env.set(name, value),
      bindColor: (name, color) => this.colorVars.set(name, color),
      bindDrawingCollection: (name) => this.collectionVars.add(name),
      bindPlotHandle: (name, plot) => {
        this.plotHandles.add(name);
        if (plot) this.plotHandleValues.set(name, { value: plot.value, pane: plot.pane ?? "price", label: plot.label });
      },
      bool: (value) => this.bool(value),
      checkName: (name) => this.checkName(name),
      color: (value) => this.colorOf(value),
      expressionStatement: (value) => this.exprStatement(value),
      isBooleanExpression: (value) => isBoolExpr(value, this.boolVars, this.env),
      isBooleanVariable: (name) => this.boolVars.has(name),
      isColorExpression: (value) => this.isColorExpr(value),
      isDrawingCollection: (value) => this.isDrawingCollectionIdent(value),
      isNumericVariable: (name) => this.numVars.has(name),
      isReassigned: (name) => this.reassigned.has(name),
      num: (value) => this.num(value),
      registerCollection: (name, value) => this.registerCollection(name, value),
      registerInput: (name, value) => this.registerInput(name, value),
      storageName: (name) => this.storageName(name),
      string: (value) => this.strVal(value),
      value: (value) => this.val(value),
      warn: (message) => this.warn(message),
      warnOnce: (key, message) => this.warnOnce(key, message)
    };
  }

  private tuple(names: string[], value: PineExpr): Stmt[] {
    return lowerTupleAssignment(this.tupleContext(), names, value);
  }

  private tupleContext(): TupleLoweringContext {
    return {
      bind: (name, bound) => this.env.set(name, bound),
      checkName: (name) => this.checkName(name),
      hasUserFunction: (name) => this.funcs.has(name),
      inlineUserFunctionTuple: (name, args) => this.inlineUserFuncTuple(name, args),
      keltner: (args, band) => this.kcNode(args, band),
      numArg: (args, position, name, fallback) => this.numArg(args, position, name, fallback),
      value: (expression) => this.val(expression)
    };
  }

  // ---------- call statements (plot / strategy.* / alerts / declarations) ----------

  private exprStatement(expr: PineExpr): Stmt[] {
    if (expr.t === "switch") return this.switchStmt(expr);
    if (expr.t === "method" || expr.t === "field") {
      this.warnOnce("opaqueexpr", "Object/collection field and method statements are imported as opaque visual operations and skipped.");
      return [];
    }
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
    const strategyStatements = lowerStrategyCall(this.strategyCallContext(), callee, args);
    if (strategyStatements !== undefined) return strategyStatements;
    const declarationStatements = lowerDeclaration(this.declarationContext(), callee, args);
    if (declarationStatements !== undefined) return declarationStatements;
    const plotStatements = lowerPlotStatement(this.plotStatementContext(), callee, args);
    if (plotStatements !== undefined) return plotStatements;
    const alertStatements = lowerAlertStatement(this.alertStatementContext(), callee, args);
    if (alertStatements !== undefined) return alertStatements;
    const drawingStatements = lowerDrawingStatement(this.drawingStatementContext(), callee, args);
    if (drawingStatements !== undefined) return drawingStatements;
    throw new PineConvertError(`Unsupported statement call: ${callee}().`);
  }

  private strategyCallContext(): StrategyCallLoweringContext {
    return {
      bool: (value) => this.bool(value),
      markEntry: (direction) => {
        if (direction === "long") this.hasLongEntry = true;
        else this.hasShortEntry = true;
      },
      markExplicitExit: () => { this.hasExplicitExit = true; },
      num: (value) => this.num(value),
      warn: (message) => this.warn(message),
      warnOnce: (key, message) => this.warnOnce(key, message)
    };
  }

  private declarationContext(): DeclarationLoweringContext {
    return {
      declare: ({ kind, name, overlay }) => {
        this.declared = true;
        this.kind = kind;
        if (name) this.name = name;
        this.overlay = overlay;
      },
      warn: (message) => this.warn(message)
    };
  }

  private plotStatementContext(): PlotStatementLoweringContext {
    return {
      bool: (value) => this.bool(value),
      color: (value) => this.colorOf(value),
      isBooleanExpression: (value) => isBoolExpr(value, this.boolVars, this.env),
      num: (value) => this.num(value),
      pane: () => this.overlay ? "price" : "sub",
      warnOnce: (key, message) => this.warnOnce(key, message)
    };
  }

  private alertStatementContext(): AlertStatementLoweringContext {
    return {
      bool: (value) => this.bool(value),
      warn: (message) => this.warn(message),
      warnOnce: (key, message) => this.warnOnce(key, message)
    };
  }

  private drawingStatementContext(): DrawingStatementLoweringContext {
    return {
      nan: NAN_NUM,
      bool: (expr) => this.bool(expr),
      num: (expr) => this.num(expr),
      color: (expr) => this.colorOf(expr),
      string: (expr) => this.strVal(expr),
      isColor: (expr) => this.isColorExpr(expr),
      plotHandle: (expr) => expr?.t === "ident" ? this.plotHandleValues.get(expr.name) : undefined,
      hasDrawingHandle: (name) => this.drawingHandles.has(name),
      warn: (message) => this.warn(message),
      warnOnce: (key, message) => this.warnOnce(key, message)
    };
  }
  private registerInput(name: string, call: Extract<PineExpr, { t: "call" }>): void {
    this.checkName(name);
    const kind = call.callee;
    const defArg = arg(call.args, 0, "defval");
    if (!defArg) throw new PineConvertError(`${kind}() for "${name}" needs a default value.`);
    if (kind === "input.source" || (kind === "input" && defArg.value.t === "ident" && PRICE_FIELDS.has(defArg.value.name))) {
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
    if (kind === "input.bool" || (kind === "input" && (isTrueIdent(defArg.value) || isFalseIdent(defArg.value)))) {
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
    return lowerValue(this.valueContext(), expr);
  }

  private valueContext(): ValueLoweringContext {
    return {
      bool: (value) => this.bool(value),
      hasUserFunction: (name) => this.funcs.has(name),
      inlineUserFunction: (name, args) => this.inlineUserFunc(name, args),
      isBooleanExpression: (value) => isBoolExpr(value, this.boolVars, this.env),
      num: (value) => this.num(value),
      string: (value) => this.strVal(value),
      switchValue: (value) => this.switchVal(value)
    };
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
    return inlineUserFunction(this.userFunctionState(), this.userFunctionContext(), name, callArgs);
  }

  private inlineUserFuncSafely(name: string, callArgs: PineArg[]): Val {
    return inlineUserFunctionSafely(this.userFunctionState(), this.userFunctionContext(), name, callArgs);
  }

  /** Inline a tuple-returning function (`f(...) => … [a, b]`) → one Val per element. */
  private inlineUserFuncTuple(name: string, callArgs: PineArg[]): Val[] {
    return inlineUserFunctionTuple(this.userFunctionState(), this.userFunctionContext(), name, callArgs);
  }

  private userFunctionState(): UserFunctionInliningState {
    return {
      environment: this.env,
      functions: this.funcs,
      inlining: this.inlining,
      scope: (work) => this.symbols.withScope(work)
    };
  }

  private userFunctionContext(): UserFunctionInliningContext {
    return {
      value: (value) => this.val(value),
      warnOnce: (key, message) => this.warnOnce(key, message)
    };
  }

  // ---------- switch ----------

  /** switch in value position → nested cond (numeric) or nested logic (boolean). */
  private switchVal(expr: Extract<PineExpr, { t: "switch" }>): Val {
    return lowerSwitchValue(this.switchContext(), expr);
  }

  /** switch in statement position → if/elif/else running each arm's body statement. */
  private switchStmt(expr: Extract<PineExpr, { t: "switch" }>): Stmt[] {
    return lowerSwitchStatement(this.switchContext(), expr);
  }

  private switchContext(): SwitchLoweringContext {
    return {
      bool: (value) => this.bool(value),
      expressionStatement: (value) => this.exprStatement(value),
      num: (value) => this.num(value),
      string: (value) => this.strVal(value),
      value: (value) => this.val(value),
      warnOnce: (key, message) => this.warnOnce(key, message)
    };
  }

  private num(expr: PineExpr): NumExpr {
    return lowerNumericExpression(this.numericExpressionContext(), expr);
  }

  private numericExpressionContext(): NumericExpressionLoweringContext {
    return {
      bool: (value) => this.bool(value),
      hasBoundValue: (name) => this.env.has(name),
      isIntegerLike: (value) => this.isIntish(value),
      isMutableNumber: (name) => this.numVars.has(name),
      num: (value) => this.num(value),
      resolveCall: (value) => {
        if (this.funcs.has(value.callee)) {
          const result = this.inlineUserFuncSafely(value.callee, value.args);
          if (result.t !== "num") throw new PineConvertError(`"${value.callee}()" returns a condition, not a number.`);
          return result.e;
        }
        return this.numCall(value);
      },
      resolveField: (value) => this.numField(value),
      resolveIdentifier: (name) => this.numIdent(name),
      resolveMethod: (value) => this.numMethod(value),
      resolveSwitch: (value) => {
        const result = this.switchVal(value);
        if (result.t !== "num") throw new PineConvertError("This switch yields a condition, not a number.");
        return result.e;
      },
      warnOnce: (key, message) => this.warnOnce(key, message)
    };
  }

  private numIdent(name: string): NumExpr {
    return lowerNumericIdentifier(this.identifierContext(), name);
  }

  private numCall(expr: Extract<PineExpr, { t: "call" }>): NumExpr {
    return lowerNumericCall(this.numericCallContext(), expr);
  }

  private numericCallContext(): NumericCallLoweringContext {
    return {
      bool: (value) => this.bool(value),
      collectionCallNum: (callee, args) => this.collectionCallNum(callee, args),
      constPositiveInt: (value, fallback) => this.constPositiveInt(value, fallback),
      contextString: (value) => this.contextString(value),
      hma: (source, length) => this.hma(source, length),
      kcNode: (args, band) => this.kcNode(args, band),
      literalArg: (args, position, name, fn, fallback) => this.literalArg(args, position, name, fn, fallback),
      num: (value) => this.num(value),
      numArg: (args, position, name, fallback) => this.numArg(args, position, name, fallback),
      opaqueNum: (key, message) => this.opaqueNum(key, message),
      securityVal: (args) => this.securityVal(args),
      seriesArg: (args, position, name) => this.seriesArg(args, position, name),
      strVal: (value) => this.strVal(value),
      swma: (source) => this.swma(source),
      timeCall: (args) => this.timeCall(args),
      trueRange: () => this.trueRange(),
      unsupportedFn: (callee) => this.unsupportedFn(callee),
      warnOnce: (key, message) => this.warnOnce(key, message)
    };
  }
  private securityVal(args: PineArg[]): Val {
    const symbol = this.contextStringArg(args, 0, "symbol", "request.security", "current");
    const timeframe = this.contextStringArg(args, 1, "timeframe", "request.security", "chart");
    const expression = argRequired(args, 2, "expression", "request.security").value;
    const value = this.val(expression);
    if (value.t === "str") throw new PineConvertError("request.security() expression returned text, not a numeric/boolean series.");
    this.warnOnce(
      "requestsecurity",
      "request.security() imported as an external-series block. Preview/backtest use attached external candles when available, otherwise fall back to the current chart."
    );
    const source = value.t === "bool" ? boolToNumericSeries(value.e) : value.e;
    const wrapped: NumExpr = { k: "security", symbol, timeframe, source };
    if (value.t === "bool") return { t: "bool", e: { k: "compare", op: "!=", a: wrapped, b: { k: "num", v: 0 } } };
    return { t: "num", e: wrapped };
  }

  private timeCall(args: PineArg[]): NumExpr {
    const sessionArg = arg(args, 1, "session");
    const timezoneArg = arg(args, 2, "timezone");
    const session = sessionArg ? this.strVal(sessionArg.value) : undefined;
    const timezone = timezoneArg ? this.strVal(timezoneArg.value) : undefined;
    if (sessionArg && session === undefined) {
      throw new PineConvertError("time() session argument must be a literal/input.session string.");
    }
    if (timezoneArg && timezone === undefined) {
      throw new PineConvertError("time() timezone argument must be a literal/input.string value like GMT-4.");
    }
    if (session) this.warnOnce("timefn", "time() imported as a UTC/GMT-offset session filter; exchange calendars and DST are not modeled yet.");
    return {
      k: "time",
      ...(session ? { session } : {}),
      ...(timezone ? { timezone } : {})
    };
  }

  private contextStringArg(args: PineArg[], position: number, name: string, fn: string, fallback: string): string {
    const found = arg(args, position, name);
    if (!found) return fallback;
    const special = this.contextString(found.value);
    if (special !== undefined) return special;
    const literal = this.strVal(found.value);
    if (literal !== undefined) return literal.slice(0, name === "symbol" ? 64 : 32);
    throw new PineConvertError(`${fn}() ${name} must be a static string, input.timeframe/session, syminfo.ticker[id], or timeframe.period.`);
  }

  private contextString(expr: PineExpr): string | undefined {
    if (expr.t !== "ident") return undefined;
    if (expr.name === "syminfo.ticker" || expr.name === "syminfo.tickerid") return "current";
    if (expr.name === "timeframe.period") return "chart";
    return undefined;
  }

  private constPositiveInt(expr: NumExpr, fallback: number): number {
    if (expr.k === "num") return Math.max(1, Math.round(expr.v));
    if (expr.k === "input") {
      const value = this.inputs.find((input) => input.name === expr.name)?.value;
      return Math.max(1, Math.round(value ?? fallback));
    }
    return Math.max(1, Math.round(fallback));
  }

  /** Friendly, namespace-aware rejection for a function we can't map to the IR. */
  private unsupportedFn(callee: string): PineConvertError {
    const lookahead = ["ta.pivothigh", "ta.pivotlow", "ta.pivot_point_levels"];
    if (lookahead.includes(callee)) {
      return new PineConvertError(`${callee}() looks ahead in time (it confirms a pivot using future bars) — it can't run in a live per-bar engine.`);
    }
    if (callee.startsWith("request.")) {
      return new PineConvertError(`${callee}() is not supported yet; only request.security() has an import approximation.`);
    }
    const needsBlock: Record<string, string> = {
      "ta.kcw": "Keltner width", "ta.correlation": "correlation", "ta.mode": "mode",
      "ta.percentile_linear_interpolation": "percentile", "ta.percentile_nearest_rank": "percentile",
      "ta.wpr": "Williams %R", "ta.rci": "RCI", "ta.range": "range"
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
    return lowerBooleanExpression(this.booleanExpressionContext(), expr);
  }

  private booleanExpressionContext(): BooleanExpressionLoweringContext {
    return {
      bool: (value) => this.bool(value),
      isBooleanExpression: (value) => isBoolExpr(value, this.boolVars, this.env),
      num: (value) => this.num(value),
      resolveCall: (value) => lowerBooleanCall(this.booleanCallContext(), value),
      resolveIdentifier: (name) => this.boolIdent(name),
      resolveString: (value) => this.strVal(value),
      resolveSwitch: (value) => {
        const result = this.switchVal(value);
        if (result.t !== "bool") throw new PineConvertError("This switch yields a number, not a condition.");
        return result.e;
      },
      warnOnce: (key, message) => this.warnOnce(key, message)
    };
  }

  private boolIdent(name: string): BoolExpr {
    return lowerBooleanIdentifier(this.identifierContext(), name);
  }

  private identifierContext(): IdentifierLoweringContext {
    return {
      addBooleanVariable: (name) => this.boolVars.add(name),
      addNumericVariable: (name) => this.numVars.add(name),
      boundValue: (name) => this.boundValue(name),
      hasBooleanInput: (name) => this.boolInputs.has(name),
      hasBooleanVariable: (name) => this.boolVars.has(name),
      hasDrawingHandle: (name) => this.drawingHandles.has(name),
      hasNumericVariable: (name) => this.numVars.has(name),
      hasOpaqueState: (name) => this.collectionVars.has(name) || this.opaqueVars.has(name),
      hasPlotHandle: (name) => this.plotHandles.has(name),
      storageName: (name) => this.storageName(name, false),
      trueRange: () => this.trueRange(),
      unsupportedFunction: (name) => this.unsupportedFn(name),
      warnOnce: (key, message) => this.warnOnce(key, message)
    };
  }

  private booleanCallContext(): BooleanCallLoweringContext {
    return {
      bool: (value) => this.bool(value),
      hasUserFunction: (name) => this.funcs.has(name),
      inlineUserFunction: (name, args) => this.inlineUserFuncSafely(name, args),
      num: (value) => this.num(value),
      numArg: (args, position, name) => this.numArg(args, position, name),
      numCall: (value) => this.numCall(value),
      securityVal: (args) => this.securityVal(args),
      seriesArg: (args, position, name) => this.seriesArg(args, position, name),
      timeCall: (args) => this.timeCall(args),
      warnOnce: (key, message) => this.warnOnce(key, message)
    };
  }

  // ---------- helpers ----------

  private registerCollection(name: string, call: Extract<PineExpr, { t: "call" }>): void {
    this.collectionVars.add(name);
    const callee = call.callee;
    const first = arg(call.args, 0, "size")?.value ?? arg(call.args, 0, "rows")?.value;
    if (callee.startsWith("array.")) {
      this.collectionLengths.set(name, callee === "array.from" ? { k: "num", v: call.args.length } : first ? this.num(first) : { k: "num", v: 0 });
    } else if (callee.startsWith("matrix.")) {
      const rows = arg(call.args, 0, "rows")?.value;
      const columns = arg(call.args, 1, "columns")?.value;
      this.matrixRows.set(name, rows ? this.num(rows) : { k: "num", v: 0 });
      this.matrixColumns.set(name, columns ? this.num(columns) : { k: "num", v: 0 });
    }
    this.warnOnce("collections", "Collections (arrays/matrices/maps) are imported as opaque visual state; supported scalar reads are approximated.");
  }

  private isDrawingCollectionIdent(expr: PineExpr): boolean {
    return expr.t === "ident" && /^(box|label|line|linefill|table|polyline)\.all$/.test(expr.name);
  }

  private numField(_expr: Extract<PineExpr, { t: "field" }>): NumExpr {
    this.warnOnce("objfield", "User-defined object fields are imported as opaque values; dependent visuals may be approximated.");
    return NAN_NUM;
  }

  private numMethod(expr: Extract<PineExpr, { t: "method" }>): NumExpr {
    const baseName = expr.base.t === "ident" ? expr.base.name : undefined;
    if (baseName) return this.collectionMethodNum(baseName, expr.name, expr.args);
    this.warnOnce("objmethod", "Object/collection methods on computed values are imported as opaque visual operations.");
    return this.methodFallback(expr.name);
  }

  private collectionCallNum(callee: string, args: PineArg[]): NumExpr {
    const method = methodName(callee);
    const receiver = collectionReceiver(callee, args);
    if (receiver) return this.collectionMethodNum(receiver, method, methodArgs(callee, args));
    this.warnOnce("collections", "Collections (arrays/matrices/maps) are imported as opaque visual state; supported scalar reads are approximated.");
    return this.methodFallback(method);
  }

  private collectionMethodNum(receiver: string, method: string, args: PineArg[]): NumExpr {
    if (method === "size" || method === "length") return this.collectionLength(receiver);
    if (method === "rows") return this.matrixRows.get(receiver) ?? { k: "num", v: 0 };
    if (method === "columns") return this.matrixColumns.get(receiver) ?? { k: "num", v: 0 };
    if (method === "get") {
      const index = arg(args, 0, "index")?.value;
      return this.collectionGet(receiver, index);
    }
    if (method === "first" || method === "last") return this.collectionGet(receiver, { t: "num", v: method === "first" ? 0 : -1 });
    if (method === "indexof") return { k: "num", v: 0 };
    if (method === "max" || method === "sum") return { k: "num", v: 1 };
    if (method === "min") return { k: "num", v: 0 };
    if (method === "range") return { k: "num", v: 1 };
    this.warnOnce("collectionmut", "Collection mutations/sorts/slices are skipped; scalar reads use safe approximations.");
    return this.methodFallback(method);
  }

  private collectionLength(receiver: string): NumExpr {
    if (this.collectionLengths.has(receiver)) return this.collectionLengths.get(receiver) as NumExpr;
    if (receiver === "MPArray") {
      const len = this.env.get("amountOfColumns");
      if (len?.t === "num") return { k: "arith", op: "+", a: len.e, b: { k: "num", v: 2 } };
      return { k: "num", v: 34 };
    }
    if (receiver === "occurenceArray") {
      const len = this.env.get("amountOfColumns");
      if (len?.t === "num") return { k: "arith", op: "+", a: len.e, b: { k: "num", v: 1 } };
      return { k: "num", v: 33 };
    }
    return { k: "num", v: 0 };
  }

  private collectionGet(receiver: string, indexExpr: PineExpr | undefined): NumExpr {
    if (receiver === "MPArray") {
      const top = this.env.get("MPTop");
      const step = this.env.get("ColumnSize");
      const index: NumExpr = indexExpr ? this.num(indexExpr) : { k: "num", v: 0 };
      if (top?.t === "num" && step?.t === "num") {
        this.warnOnce("mparray", "Market Profile level array reconstructed from MPTop and ColumnSize.");
        return { k: "arith", op: "-", a: top.e, b: { k: "arith", op: "*", a: step.e, b: index } };
      }
    }
    if (receiver === "occurenceArray") return { k: "num", v: 1 };
    this.warnOnce("collectionget", "Collection get() reads without a scalar reconstruction return na.");
    return NAN_NUM;
  }

  private methodFallback(method: string): NumExpr {
    if (method === "size" || method === "rows" || method === "columns" || method === "indexof") return { k: "num", v: 0 };
    if (method === "first" || method === "last") return NAN_NUM;
    if (method === "range" || method === "sum" || method === "max") return { k: "num", v: 1 };
    if (method === "min") return { k: "num", v: 0 };
    return NAN_NUM;
  }

  private opaqueNum(key: string, message: string): NumExpr {
    this.warnOnce(key, message);
    return NAN_NUM;
  }

  private numArg(args: PineArg[], position: number, name: string, fallback?: NumExpr): NumExpr {
    const found = arg(args, position, name);
    if (!found) {
      if (fallback) return fallback;
      throw new PineConvertError(`Missing argument "${name}".`);
    }
    return this.num(found.value);
  }

  /** An argument that must be a compile-time numeric literal (IR node parameters
   *  that aren't per-bar series: occurrences, offsets, sigmas…). */
  private literalArg(args: PineArg[], position: number, name: string, fn: string, fallback: number): number {
    const found = arg(args, position, name);
    if (!found) return fallback;
    const v = found.value;
    if (v.t === "num") return v.v;
    if (v.t === "unary" && v.op === "-" && v.a.t === "num") return -v.a.v;
    throw new PineConvertError(`${fn}() ${name} must be a literal number (not a series or input).`);
  }

  /** ta.kc(source, length, mult) → one Keltner band. The middle line is EMA(close)
   *  here, so a non-close source is ignored with a warning. */
  private kcNode(args: PineArg[], band: "upper" | "middle" | "lower"): NumExpr {
    const src = args[0]?.value;
    if (!(src && src.t === "ident" && src.name === "close")) {
      this.warnOnce("kcsrc", "ta.kc bands are computed from EMA(close) here (the passed source is ignored).");
    }
    if (arg(args, 3, "useTrueRange")) this.warnOnce("kctr", "ta.kc useTrueRange ignored — bands always use ATR (True Range) here.");
    return { k: "kc", band, period: this.numArg(args, 1, "length"), mult: this.numArg(args, 2, "mult") };
  }

  private colorOf(expr: PineExpr | undefined): string | undefined {
    if (!expr) return undefined;
    if (expr.t === "ident" && expr.name.startsWith("color.")) return COLOR_HEX[expr.name.slice(6)] ?? "#4db6ff";
    if (expr.t === "ident" && this.colorVars.has(expr.name)) return this.colorVars.get(expr.name);
    if (expr.t === "ident") {
      const bound = this.boundValue(expr.name);
      if (bound?.t === "str" && /^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.test(bound.v)) return bound.v.slice(0, 7);
    }
    if (expr.t === "call" && expr.callee === "color.rgb") {
      const nums = [0, 1, 2].map((idx) => literalColorByte(expr.args[idx]?.value));
      if (nums.every((value) => value !== undefined)) {
        return `#${nums.map((value) => (value as number).toString(16).padStart(2, "0")).join("")}`;
      }
      return "#4db6ff";
    }
    if (expr.t === "call" && (expr.callee === "color.new" || expr.callee === "color.from_gradient")) {
      return this.colorOf(expr.args[0]?.value);
    }
    if (expr.t === "ternary") return this.colorOf(expr.a) ?? this.colorOf(expr.b);
    if (expr.t === "switch") return expr.arms.map((armExpr) => this.colorOf(armExpr.body)).find((hex) => hex !== undefined);
    const hexMatch = expr.t === "str" ? /^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.exec(expr.v) : null;
    if (hexMatch) return `#${hexMatch[1]}`;
    return undefined; // conditional/unknown colors are cosmetic — fall back silently
  }

  /** Resolve an expression to a compile-time string, if it is one: literals,
   *  string-bound identifiers, and `+` concatenations of those. Undefined = not a string. */
  private strVal(expr: PineExpr): string | undefined {
    if (expr.t === "str") return expr.v;
    if (expr.t === "field" || expr.t === "method") return undefined;
    if (expr.t === "ident") {
      const target = this.storageName(expr.name, false);
      const bound = this.boundValue(expr.name);
      if (!bound && (this.colorVars.has(expr.name) || this.colorVars.has(target))) return this.colorVars.get(expr.name) ?? this.colorVars.get(target) ?? "#4db6ff";
      if (!bound && isCosmeticConst(expr.name)) return expr.name;
      if (!bound && (expr.name === "syminfo.ticker" || expr.name === "syminfo.tickerid")) return "current";
      if (!bound && expr.name === "timeframe.period") return "chart";
      return bound?.t === "str" ? bound.v : undefined;
    }
    if (expr.t === "call" && (expr.callee === "input.symbol" || expr.callee === "input.timeframe" || expr.callee === "input.session")) {
      const def = arg(expr.args, 0, "defval")?.value;
      return def ? this.strVal(def) : undefined;
    }
    if (expr.t === "call" && (expr.callee === "str.tostring" || expr.callee === "str.format")) {
      this.warnOnce("dyntext", "Dynamic string formatting is cosmetic during import and may be omitted from labels.");
      return "";
    }
    if (expr.t === "call" && this.funcs.has(expr.callee)) {
      const value = this.inlineUserFunc(expr.callee, expr.args);
      return value.t === "str" ? value.v : undefined;
    }
    if (expr.t === "call" && expr.callee.startsWith("color.")) return this.colorOf(expr);
    if (expr.t === "ternary") {
      const a = this.strVal(expr.a);
      const b = this.strVal(expr.b);
      if (a === undefined || b === undefined) return undefined;
      try {
        const cond = this.bool(expr.cond);
        if (cond.k === "bool") return cond.v ? a : b;
      } catch (cause) {
        if (!(cause instanceof PineConvertError)) throw cause;
      }
      this.warnOnce("strternary", "Dynamic text ternaries are fixed to their imported branch; text state is cosmetic in the strategy engine.");
      return a;
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
    if (expr.t === "str") return /^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.test(expr.v);
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

  private storageName(name: string, warn = true): string {
    if (!isUserObjectFieldName(name)) return name;
    if (warn) {
      this.warnOnce(
        "objstate",
        "User-defined object fields are flattened into scalar state variables; collection/object fidelity is approximate."
      );
    }
    return name.replace(/\./g, "_");
  }

  private boundValue(name: string): Val | undefined {
    return this.env.get(name) ?? this.env.get(this.storageName(name, false));
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
