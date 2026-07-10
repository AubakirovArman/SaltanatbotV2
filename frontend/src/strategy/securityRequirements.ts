import type { BoolExpr, NumExpr, Stmt, StrategyIR } from "./ir";
import { securitySeriesKey } from "./securityData";

export interface SecurityRequirement {
  symbol: string;
  timeframe: string;
}

/** Find every request.security-style external series dependency in a strategy IR. */
export function collectSecurityRequirements(ir: StrategyIR): SecurityRequirement[] {
  const out = new Map<string, SecurityRequirement>();
  const add = (expr: Extract<NumExpr, { k: "security" }>) => {
    const req = { symbol: expr.symbol, timeframe: expr.timeframe };
    out.set(securitySeriesKey(req.symbol, req.timeframe), req);
  };

  const num = (expr: NumExpr): void => {
    switch (expr.k) {
      case "num":
      case "input":
      case "var":
      case "price":
      case "ctx":
      case "time":
      case "barindex":
      case "vwap":
        return;
      case "security":
        add(expr);
        num(expr.source);
        return;
      case "ma":
      case "rsi":
      case "stdev":
      case "extreme":
      case "change":
      case "roc":
      case "cmo":
      case "alma":
      case "cog":
      case "percentrank":
      case "linreg":
      case "extremebars":
        num(expr.period);
        num(expr.source);
        return;
      case "agg":
        num(expr.src);
        num(expr.period);
        return;
      case "tsi":
        num(expr.short);
        num(expr.long);
        num(expr.source);
        return;
      case "bollinger":
        num(expr.period);
        num(expr.dev);
        num(expr.source);
        return;
      case "macd":
        num(expr.fast);
        num(expr.slow);
        num(expr.signal);
        num(expr.source);
        return;
      case "atr":
      case "stoch":
      case "wpr":
      case "cci":
      case "mfi":
        num(expr.period);
        if (expr.k === "stoch") num(expr.smooth);
        return;
      case "minmax":
      case "arith":
        num(expr.a);
        num(expr.b);
        return;
      case "unary":
        num(expr.a);
        return;
      case "shift":
      case "cum":
        num(expr.src);
        return;
      case "cond":
        bool(expr.cond);
        num(expr.a);
        num(expr.b);
        return;
      case "nz":
        num(expr.a);
        num(expr.b);
        return;
      case "barssince":
        bool(expr.cond);
        return;
      case "varprev":
        return;
      case "histn":
        num(expr.offset);
        return;
      case "valuewhen":
        bool(expr.cond);
        num(expr.src);
        return;
      case "supertrend":
        num(expr.factor);
        num(expr.period);
        return;
      case "dmi":
        num(expr.period);
        num(expr.smoothing);
        return;
      case "sar":
        num(expr.start);
        num(expr.inc);
        num(expr.max);
        return;
      case "kc":
        num(expr.period);
        num(expr.mult);
        return;
      case "correlation":
        num(expr.a);
        num(expr.b);
        num(expr.period);
        return;
    }
  };

  const bool = (expr: BoolExpr): void => {
    switch (expr.k) {
      case "bool":
      case "session":
      case "dayofweek":
      case "varb":
        return;
      case "compare":
      case "cross":
        num(expr.a);
        num(expr.b);
        return;
      case "logic":
        bool(expr.a);
        bool(expr.b);
        return;
      case "not":
        bool(expr.a);
        return;
      case "trend":
        num(expr.period);
        num(expr.source);
        return;
      case "between":
        num(expr.value);
        num(expr.low);
        num(expr.high);
        return;
      case "isna":
        num(expr.a);
        return;
    }
  };

  const stmt = (node: Stmt): void => {
    switch (node.k) {
      case "entry":
      case "exit":
      case "marker":
      case "vline":
        bool(node.when);
        return;
      case "stop":
      case "target":
      case "trail":
      case "size":
      case "setvar":
        num(node.value);
        return;
      case "setvarb":
        bool(node.value);
        return;
      case "alert":
        bool(node.when);
        Object.values(node.args ?? {}).forEach(num);
        return;
      case "plot":
        num(node.value);
        return;
      case "box":
        num(node.top);
        num(node.bottom);
        bool(node.when);
        return;
      case "ray":
        num(node.price);
        bool(node.when);
        return;
      case "if":
        bool(node.cond);
        node.then.forEach(stmt);
        node.elifs?.forEach((elif) => {
          bool(elif.cond);
          elif.then.forEach(stmt);
        });
        node.else?.forEach(stmt);
        return;
      case "repeat":
        num(node.count);
        node.body.forEach(stmt);
        return;
      case "while":
        bool(node.cond);
        node.body.forEach(stmt);
        return;
      case "for":
        num(node.from);
        num(node.to);
        num(node.step);
        node.body.forEach(stmt);
        return;
    }
  };

  ir.init?.forEach(stmt);
  ir.body.forEach(stmt);
  return [...out.values()];
}
