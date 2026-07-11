import type { BoolExpr, NumExpr, Stmt, StrategyIR } from "@saltanatbotv2/strategy-core";

export const DYNAMIC_WARMUP_BARS = 200;

interface WarmupEstimate {
  bars: number;
  dynamic: boolean;
}

const fixed = (bars = 0): WarmupEstimate => ({ bars, dynamic: false });

function merge(...estimates: WarmupEstimate[]): WarmupEstimate {
  return {
    bars: Math.max(0, ...estimates.map((estimate) => estimate.bars)),
    dynamic: estimates.some((estimate) => estimate.dynamic)
  };
}

function dynamic(...estimates: WarmupEstimate[]): WarmupEstimate {
  const merged = merge(...estimates);
  return { ...merged, dynamic: true };
}

function constant(expr: NumExpr, params: Map<string, number>): number {
  switch (expr.k) {
    case "num":
      return expr.v;
    case "input":
      return params.get(expr.name) ?? NaN;
    case "arith": {
      const a = constant(expr.a, params);
      const b = constant(expr.b, params);
      switch (expr.op) {
        case "+": return a + b;
        case "-": return a - b;
        case "*": return a * b;
        case "/": return b === 0 ? NaN : a / b;
        case "%": return b === 0 ? NaN : a % b;
        case "^": return a ** b;
      }
      return NaN;
    }
    case "unary": {
      const value = constant(expr.a, params);
      switch (expr.op) {
        case "neg": return -value;
        case "abs": return Math.abs(value);
        case "round": return Math.round(value);
        case "floor": return Math.floor(value);
        case "ceil": return Math.ceil(value);
        case "sign": return Math.sign(value);
        case "log": return Math.log(value);
        case "log10": return Math.log10(value);
        case "exp": return Math.exp(value);
        case "sqrt": return Math.sqrt(value);
      }
      return NaN;
    }
    default:
      return NaN;
  }
}

function period(expr: NumExpr, params: Map<string, number>): WarmupEstimate {
  const value = constant(expr, params);
  return Number.isFinite(value) ? fixed(Math.max(1, Math.round(value))) : dynamic();
}

function numberWarmup(expr: NumExpr, params: Map<string, number>): WarmupEstimate {
  switch (expr.k) {
    case "num":
    case "input":
    case "var":
    case "ctx":
    case "time":
    case "barindex":
    case "vwap":
      return fixed();
    case "varprev":
      return fixed(1);
    case "price":
      return fixed(expr.offset ?? 0);
    case "histn":
      return dynamic(numberWarmup(expr.offset, params));
    case "security":
      return dynamic(numberWarmup(expr.source, params));
    case "cond":
      return merge(conditionWarmup(expr.cond, params), numberWarmup(expr.a, params), numberWarmup(expr.b, params));
    case "nz":
    case "minmax":
    case "arith":
      return merge(numberWarmup(expr.a, params), numberWarmup(expr.b, params));
    case "unary":
      return numberWarmup(expr.a, params);
    case "shift": {
      const source = numberWarmup(expr.src, params);
      return { bars: source.bars + Math.max(0, expr.offset), dynamic: source.dynamic };
    }
    case "cum":
      return numberWarmup(expr.src, params);
    case "barssince":
      return conditionWarmup(expr.cond, params);
    case "valuewhen":
      return dynamic(conditionWarmup(expr.cond, params), numberWarmup(expr.src, params));
    case "ma":
    case "rsi":
    case "stdev":
    case "extreme":
    case "change":
    case "roc":
    case "extremebars":
    case "linreg":
    case "cmo":
    case "alma":
    case "cog":
    case "percentrank":
      return merge(period(expr.period, params), numberWarmup(expr.source, params));
    case "atr":
    case "wpr":
    case "cci":
    case "mfi":
      return period(expr.period, params);
    case "bollinger":
      return merge(period(expr.period, params), numberWarmup(expr.source, params), numberWarmup(expr.dev, params));
    case "macd": {
      const slow = period(expr.slow, params);
      const signal = period(expr.signal, params);
      return merge(
        numberWarmup(expr.source, params),
        numberWarmup(expr.fast, params),
        { bars: slow.bars + signal.bars, dynamic: slow.dynamic || signal.dynamic }
      );
    }
    case "stoch": {
      const base = period(expr.period, params);
      const smooth = period(expr.smooth, params);
      return { bars: base.bars + smooth.bars, dynamic: base.dynamic || smooth.dynamic };
    }
    case "agg":
      return merge(period(expr.period, params), numberWarmup(expr.src, params));
    case "supertrend":
      return merge(period(expr.period, params), numberWarmup(expr.factor, params));
    case "dmi": {
      const base = period(expr.period, params);
      const smoothing = period(expr.smoothing, params);
      return { bars: base.bars + smoothing.bars, dynamic: base.dynamic || smoothing.dynamic };
    }
    case "tsi": {
      const short = period(expr.short, params);
      const long = period(expr.long, params);
      return merge(numberWarmup(expr.source, params), {
        bars: short.bars + long.bars,
        dynamic: short.dynamic || long.dynamic
      });
    }
    case "sar":
      return dynamic(
        numberWarmup(expr.start, params),
        numberWarmup(expr.inc, params),
        numberWarmup(expr.max, params)
      );
    case "kc":
      return merge(period(expr.period, params), numberWarmup(expr.mult, params));
    case "correlation":
      return merge(period(expr.period, params), numberWarmup(expr.a, params), numberWarmup(expr.b, params));
  }
}

function conditionWarmup(expr: BoolExpr, params: Map<string, number>): WarmupEstimate {
  switch (expr.k) {
    case "bool":
    case "session":
    case "dayofweek":
    case "varb":
      return fixed();
    case "compare":
    case "cross":
      return merge(numberWarmup(expr.a, params), numberWarmup(expr.b, params));
    case "logic":
      return merge(conditionWarmup(expr.a, params), conditionWarmup(expr.b, params));
    case "not":
      return conditionWarmup(expr.a, params);
    case "trend":
      return merge(period(expr.period, params), numberWarmup(expr.source, params));
    case "between":
      return merge(
        numberWarmup(expr.value, params),
        numberWarmup(expr.low, params),
        numberWarmup(expr.high, params)
      );
    case "isna":
      return numberWarmup(expr.a, params);
  }
}

function statementsWarmup(statements: Stmt[], params: Map<string, number>): WarmupEstimate {
  const estimates: WarmupEstimate[] = [];
  for (const statement of statements) {
    switch (statement.k) {
      case "entry":
      case "exit":
      case "marker":
      case "alert":
      case "vline":
        estimates.push(conditionWarmup(statement.when, params));
        break;
      case "stop":
      case "target":
      case "trail":
      case "size":
      case "setvar":
      case "plot":
        estimates.push(numberWarmup(statement.value, params));
        break;
      case "setvarb":
        estimates.push(conditionWarmup(statement.value, params));
        break;
      case "box":
        estimates.push(
          numberWarmup(statement.top, params),
          numberWarmup(statement.bottom, params),
          conditionWarmup(statement.when, params)
        );
        break;
      case "projection":
        estimates.push(
          numberWarmup(statement.left, params),
          numberWarmup(statement.right, params),
          numberWarmup(statement.top, params),
          numberWarmup(statement.bottom, params),
          conditionWarmup(statement.when, params)
        );
        break;
      case "metric":
        estimates.push(numberWarmup(statement.value, params), conditionWarmup(statement.when, params));
        break;
      case "ray":
        estimates.push(numberWarmup(statement.price, params), conditionWarmup(statement.when, params));
        break;
      case "if":
        estimates.push(conditionWarmup(statement.cond, params), statementsWarmup(statement.then, params));
        for (const clause of statement.elifs ?? []) {
          estimates.push(conditionWarmup(clause.cond, params), statementsWarmup(clause.then, params));
        }
        if (statement.else) estimates.push(statementsWarmup(statement.else, params));
        break;
      case "repeat":
        estimates.push(numberWarmup(statement.count, params), statementsWarmup(statement.body, params));
        break;
      case "while":
        estimates.push(conditionWarmup(statement.cond, params), statementsWarmup(statement.body, params));
        break;
      case "for":
        estimates.push(
          numberWarmup(statement.from, params),
          numberWarmup(statement.to, params),
          numberWarmup(statement.step, params),
          statementsWarmup(statement.body, params)
        );
        break;
    }
  }
  return merge(...estimates);
}

/** Estimate the history excluded from metrics while indicators warm up. */
export function estimateWarmupBars(ir: StrategyIR): number {
  const params = new Map(ir.inputs.map((input) => [input.name, input.value]));
  const estimate = merge(statementsWarmup(ir.init ?? [], params), statementsWarmup(ir.body, params));
  return Math.max(1, estimate.bars, estimate.dynamic ? DYNAMIC_WARMUP_BARS : 0);
}
