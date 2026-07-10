import type { BoolExpr, NumExpr, Stmt, StrategyIR } from "./ir";

/** Human-readable pseudocode for the compiled IR (drives the Lab preview). */
export function irToText(ir: StrategyIR): string {
  const lines: string[] = [];
  lines.push(`strategy "${ir.name}"`);
  if (ir.inputs.length) {
    lines.push(`inputs: ${ir.inputs.map((input) => `${input.name}=${input.value}`).join(", ")}`);
  }
  if (ir.init?.length) {
    lines.push("on start:");
    for (const stmt of ir.init) lines.push(...stmtText(stmt, 1));
  }
  lines.push("rules:");
  for (const stmt of ir.body) lines.push(...stmtText(stmt, 1));
  return lines.join("\n");
}

function stmtText(stmt: Stmt, depth: number): string[] {
  const pad = "  ".repeat(depth);
  switch (stmt.k) {
    case "entry": return [`${pad}enter ${stmt.direction} when ${boolText(stmt.when)}`];
    case "exit": return [`${pad}exit when ${boolText(stmt.when)}`];
    case "stop": return [`${pad}stop-loss ${stmt.mode} ${numText(stmt.value)}`];
    case "target": return [`${pad}take-profit ${stmt.mode} ${numText(stmt.value)}`];
    case "trail": return [`${pad}trailing-stop ${stmt.mode} ${numText(stmt.value)}`];
    case "marker": return [`${pad}mark ${stmt.dir === "up" ? "▲" : "▼"}${stmt.label ? ` "${stmt.label}"` : ""} when ${boolText(stmt.when)}`];
    case "size": return [`${pad}size ${stmt.mode} ${numText(stmt.value)}`];
    case "setvar": return [`${pad}set ${stmt.name} = ${numText(stmt.value)}`];
    case "setvarb": return [`${pad}set flag ${stmt.name} = ${boolText(stmt.value)}`];
    case "alert": return [`${pad}alert "${stmt.message}"${stmt.args ? ` {${Object.entries(stmt.args).map(([k, v]) => `${k}=${numText(v)}`).join(", ")}}` : ""} when ${boolText(stmt.when)}`];
    case "plot": return [`${pad}plot ${numText(stmt.value)} as "${stmt.label}"${stmt.pane === "sub" ? " [sub]" : ""}`];
    case "if": {
      const out = [`${pad}if ${boolText(stmt.cond)}:`, ...stmt.then.flatMap((inner) => stmtText(inner, depth + 1))];
      for (const clause of stmt.elifs ?? []) {
        out.push(`${pad}else if ${boolText(clause.cond)}:`, ...clause.then.flatMap((inner) => stmtText(inner, depth + 1)));
      }
      if (stmt.else) out.push(`${pad}else:`, ...stmt.else.flatMap((inner) => stmtText(inner, depth + 1)));
      return out;
    }
    case "repeat":
      return [`${pad}repeat ${numText(stmt.count)}x:`, ...stmt.body.flatMap((inner) => stmtText(inner, depth + 1))];
    case "while":
      return [`${pad}while ${boolText(stmt.cond)} (max ${stmt.cap}):`, ...stmt.body.flatMap((inner) => stmtText(inner, depth + 1))];
  }
}

function numText(expr: NumExpr): string {
  switch (expr.k) {
    case "num": return String(expr.v);
    case "input": return expr.name;
    case "var": return `var:${expr.name}`;
    case "price": return expr.offset ? `${expr.field}[${expr.offset}]` : expr.field;
    case "ma": return `${expr.kind.toUpperCase()}(${numText(expr.period)}, ${numText(expr.source)})`;
    case "rsi": return `RSI(${numText(expr.period)}, ${numText(expr.source)})`;
    case "bollinger": return `BB.${expr.band}(${numText(expr.period)}, ${numText(expr.dev)})`;
    case "macd": return `MACD.${expr.line}(${numText(expr.fast)}/${numText(expr.slow)}/${numText(expr.signal)})`;
    case "atr": return `ATR(${numText(expr.period)})`;
    case "stdev": return `StdDev(${numText(expr.period)}, ${numText(expr.source)})`;
    case "extreme": return `${expr.kind}(${numText(expr.period)}, ${numText(expr.source)})`;
    case "change": return `change(${numText(expr.period)}, ${numText(expr.source)})`;
    case "stoch": return `Stoch.%${expr.line.toUpperCase()}(${numText(expr.period)})`;
    case "wpr": return `W%R(${numText(expr.period)})`;
    case "cci": return `CCI(${numText(expr.period)})`;
    case "roc": return `ROC(${numText(expr.period)}, ${numText(expr.source)})`;
    case "minmax": return `${expr.op}(${numText(expr.a)}, ${numText(expr.b)})`;
    case "arith": return `(${numText(expr.a)} ${expr.op} ${numText(expr.b)})`;
    case "unary": return `${expr.op}(${numText(expr.a)})`;
    case "agg": return `${expr.fn}(${numText(expr.src)}, ${numText(expr.period)})`;
    case "shift": return `${numText(expr.src)}[-${expr.offset}]`;
    case "ctx": return `pos.${expr.key}`;
  }
}

function boolText(expr: BoolExpr): string {
  switch (expr.k) {
    case "bool": return String(expr.v);
    case "compare": return `${numText(expr.a)} ${expr.op} ${numText(expr.b)}`;
    case "logic": return `(${boolText(expr.a)} ${expr.op} ${boolText(expr.b)})`;
    case "not": return `not ${boolText(expr.a)}`;
    case "cross": return `${numText(expr.a)} crosses ${expr.dir} ${numText(expr.b)}`;
    case "trend": return `${numText(expr.source)} ${expr.dir} over ${numText(expr.period)}`;
    case "between": return `${numText(expr.value)} in [${numText(expr.low)}, ${numText(expr.high)}]`;
    case "session": return `session ${expr.start}–${expr.end}h`;
    case "dayofweek": return `day == ${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][expr.day]}`;
    case "varb": return `flag:${expr.name}`;
  }
}
