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
    case "box": return [`${pad}box ${numText(stmt.top)}..${numText(stmt.bottom)}${stmt.label ? ` "${stmt.label}"` : ""} while ${boolText(stmt.when)}`];
    case "vline": return [`${pad}vline${stmt.label ? ` "${stmt.label}"` : ""} when ${boolText(stmt.when)}`];
    case "ray": return [`${pad}level ${numText(stmt.price)}${stmt.label ? ` "${stmt.label}"` : ""} when ${boolText(stmt.when)}`];
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
    case "for":
      return [`${pad}for ${stmt.var} = ${numText(stmt.from)} to ${numText(stmt.to)} by ${numText(stmt.step)}:`, ...stmt.body.flatMap((inner) => stmtText(inner, depth + 1))];
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
    case "cond": return `(${boolText(expr.cond)} ? ${numText(expr.a)} : ${numText(expr.b)})`;
    case "nz": return `nz(${numText(expr.a)}, ${numText(expr.b)})`;
    case "cum": return `cum(${numText(expr.src)})`;
    case "barssince": return `barssince(${boolText(expr.cond)})`;
    case "varprev": return `var:${expr.name}[1]`;
    case "histn": return `${expr.field}[${numText(expr.offset)}]`;
    case "time": return `time(${expr.session ?? "chart"}${expr.timezone ? `, ${expr.timezone}` : ""})`;
    case "security": return `security(${expr.symbol}, ${expr.timeframe}, ${numText(expr.source)})`;
    case "barindex": return "bar_index";
    case "valuewhen": return `valuewhen(${boolText(expr.cond)}, ${numText(expr.src)}, ${expr.occurrence})`;
    case "extremebars": return `${expr.kind}bars(${numText(expr.period)}, ${numText(expr.source)})`;
    case "linreg": return `linreg(${numText(expr.period)}, ${numText(expr.source)}, ${expr.offset})`;
    case "vwap": return "VWAP";
    case "supertrend": return `Supertrend.${expr.line}(${numText(expr.factor)}, ${numText(expr.period)})`;
    case "dmi": return `DMI.${expr.line}(${numText(expr.period)}, ${numText(expr.smoothing)})`;
    case "mfi": return `MFI(${numText(expr.period)})`;
    case "cmo": return `CMO(${numText(expr.period)}, ${numText(expr.source)})`;
    case "tsi": return `TSI(${numText(expr.short)}/${numText(expr.long)}, ${numText(expr.source)})`;
    case "alma": return `ALMA(${numText(expr.period)}, ${numText(expr.source)}, ${expr.offset}, ${expr.sigma})`;
    case "cog": return `COG(${numText(expr.period)}, ${numText(expr.source)})`;
    case "percentrank": return `percentrank(${numText(expr.period)}, ${numText(expr.source)})`;
    case "sar": return `SAR(${numText(expr.start)}, ${numText(expr.inc)}, ${numText(expr.max)})`;
    case "kc": return `KC.${expr.band}(${numText(expr.period)}, ${numText(expr.mult)})`;
    case "correlation": return `corr(${numText(expr.a)}, ${numText(expr.b)}, ${numText(expr.period)})`;
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
    case "isna": return `na(${numText(expr.a)})`;
  }
}
