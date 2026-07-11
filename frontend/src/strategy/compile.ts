import * as Blockly from "blockly/core";
import { IR_VERSION } from "./ir";
import type { BoolExpr, NumExpr, Stmt, StrategyIR } from "./ir";
import { addError, type CompilerContext as Ctx, type CompileDiagnostic, procName } from "./compiler/context";
import { boolInput } from "./compiler/boolean";
import { numInput, procedureArguments } from "./compiler/numeric";

export type { CompileDiagnostic } from "./compiler/context";

export interface CompileResult {
  ir?: StrategyIR;
  errors: string[];
  /** Non-blocking advisories (e.g. reading a variable that is never set). */
  warnings?: string[];
  diagnostics?: CompileDiagnostic[];
}

/** Compile a Blockly workspace into a safe JSON-IR (no eval, no code strings). */
export function compileWorkspace(workspace: Blockly.Workspace): CompileResult {
  const ctx: Ctx = { inputs: new Map(), errors: [], diagnostics: [], vars: new Set(), usedVars: new Set(), procs: new Map(), callStack: new Set(), procArgs: [] };
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
    if (stmt.k !== "setvar") addError(ctx, "The 'on start' section only accepts 'set variable' blocks.", root.getInputTargetBlock("INIT") ?? root);
  }
  const init = initStmts.filter((stmt): stmt is Extract<Stmt, { k: "setvar" }> => stmt.k === "setvar");
  const body = compileStatements(root.getInputTargetBlock("RULES"), ctx);

  const hasEntry = containsStmt(body, "entry");
  const hasMarker = containsStmt(body, "marker");
  if (!hasEntry && !hasMarker) {
    addError(ctx, "Strategy has no entry rule — add a Buy/Sell, Entry, or Mark signal.", root);
  }

  // Reading a variable that is never set reads 0 silently — flag the likely typo.
  const warnings: string[] = [];
  for (const name of ctx.usedVars) {
    if (!ctx.vars.has(name)) warnings.push(`Variable "${name}" is read but never set — it will always be 0.`);
  }

  return {
    ir: { name, inputs: [...ctx.inputs.values()], body, init: init.length ? init : undefined, v: IR_VERSION },
    errors: ctx.errors,
    diagnostics: ctx.diagnostics.length ? ctx.diagnostics : undefined,
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
      // Inline the called function's body with compile-time numeric argument substitution.
      const name = procName(block);
      const def = ctx.procs.get(name);
      if (!def) {
        addError(ctx, `Unknown function: ${name || "(unnamed)"}`, block);
        return undefined;
      }
      if (ctx.callStack.has(name)) {
        addError(ctx, `Recursive function not allowed: ${name}`, block);
        return undefined;
      }
      if (ctx.callStack.size >= 20) {
        addError(ctx, `Functions nested too deep near "${name}".`, block);
        return undefined;
      }
      ctx.procArgs.push(procedureArguments(def, block, ctx));
      ctx.callStack.add(name);
      const body = compileStatements(def.getInputTargetBlock("STACK"), ctx);
      ctx.callStack.delete(name);
      ctx.procArgs.pop();
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
      addError(ctx, `Unsupported action block: ${block.type}`, block);
      return undefined;
  }
}

function riskMode(block: Blockly.Block): "price" | "percent" | "atr" {
  const mode = block.getFieldValue("MODE");
  return mode === "price" || mode === "atr" ? mode : "percent";
}

function sizeMode(block: Blockly.Block): "units" | "equity_pct" | "risk_pct" {
  const mode = block.getFieldValue("MODE");
  return mode === "units" || mode === "risk_pct" ? mode : "equity_pct";
}
