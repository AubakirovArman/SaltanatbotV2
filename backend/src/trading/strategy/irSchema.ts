import { z } from "zod";
import { IR_VERSION, type StrategyIR } from "./ir.js";

/**
 * Structural whitelist for the strategy IR crossing the client -> backend trust
 * boundary. The evaluator runs whatever IR reaches it, so `POST /bots` must
 * reject anything that isn't a known node shape BEFORE it is persisted/executed.
 * This replaces the previous `z.record(string, unknown)` hole.
 *
 * Every node is a strict discriminated union on `k` (unknown fields rejected).
 * Recursion is via z.lazy; overall size/depth is bounded separately by
 * `irWithinBounds` so a pathological payload can't blow the stack during parse.
 */

const MAX_NODES = 4000;
const MAX_DEPTH = 48;
const MAX_ARRAY = 512;

const priceField = z.enum(["open", "high", "low", "close", "volume", "hl2", "hlc3", "ohlc4"]);
const maKind = z.enum(["sma", "ema", "wma", "vwma", "rma"]);
const finite = z.number().finite();
const label = z.string().max(200);

// Recursive expression/statement schemas. z.lazy defers evaluation so these can
// reference one another before their consts are fully initialized.
const numExpr: z.ZodType<unknown> = z.lazy(() =>
  z.discriminatedUnion("k", [
    z.object({ k: z.literal("num"), v: finite }).strict(),
    z.object({ k: z.literal("input"), name: z.string().max(64) }).strict(),
    z.object({ k: z.literal("var"), name: z.string().max(64) }).strict(),
    z.object({ k: z.literal("price"), field: priceField, offset: z.number().int().nonnegative().max(100_000).optional() }).strict(),
    z.object({ k: z.literal("ma"), kind: maKind, period: numExpr, source: numExpr }).strict(),
    z.object({ k: z.literal("rsi"), period: numExpr, source: numExpr }).strict(),
    z.object({ k: z.literal("bollinger"), band: z.enum(["upper", "middle", "lower"]), period: numExpr, dev: numExpr, source: numExpr }).strict(),
    z.object({ k: z.literal("macd"), line: z.enum(["macd", "signal", "histogram"]), fast: numExpr, slow: numExpr, signal: numExpr, source: numExpr }).strict(),
    z.object({ k: z.literal("atr"), period: numExpr }).strict(),
    z.object({ k: z.literal("stdev"), period: numExpr, source: numExpr }).strict(),
    z.object({ k: z.literal("extreme"), kind: z.enum(["highest", "lowest"]), period: numExpr, source: numExpr }).strict(),
    z.object({ k: z.literal("change"), period: numExpr, source: numExpr }).strict(),
    z.object({ k: z.literal("stoch"), line: z.enum(["k", "d"]), period: numExpr, smooth: numExpr }).strict(),
    z.object({ k: z.literal("wpr"), period: numExpr }).strict(),
    z.object({ k: z.literal("cci"), period: numExpr }).strict(),
    z.object({ k: z.literal("roc"), period: numExpr, source: numExpr }).strict(),
    z.object({ k: z.literal("minmax"), op: z.enum(["min", "max"]), a: numExpr, b: numExpr }).strict(),
    z.object({ k: z.literal("arith"), op: z.enum(["+", "-", "*", "/", "%", "^"]), a: numExpr, b: numExpr }).strict(),
    z.object({ k: z.literal("unary"), op: z.enum(["neg", "abs", "round", "floor", "ceil", "sign", "log", "log10", "exp", "sqrt"]), a: numExpr }).strict(),
    z.object({ k: z.literal("agg"), fn: z.enum(["sum", "avg", "min", "max", "stdev", "median"]), src: numExpr, period: numExpr }).strict(),
    z.object({ k: z.literal("shift"), src: numExpr, offset: z.number().int().min(0).max(100_000) }).strict(),
    z.object({ k: z.literal("ctx"), key: z.enum(["position_dir", "entry_price", "unrealized_pnl", "unrealized_pnl_pct", "bars_in_position", "last_trade_pnl", "consecutive_losses", "trades_today", "realized_today", "equity"]) }).strict(),
    z.object({ k: z.literal("cond"), cond: boolExpr, a: numExpr, b: numExpr }).strict(),
    z.object({ k: z.literal("nz"), a: numExpr, b: numExpr }).strict(),
    z.object({ k: z.literal("cum"), src: numExpr }).strict(),
    z.object({ k: z.literal("barssince"), cond: boolExpr }).strict(),
    z.object({ k: z.literal("varprev"), name: z.string().max(64) }).strict(),
    z.object({ k: z.literal("histn"), field: priceField, offset: numExpr }).strict(),
    z.object({ k: z.literal("barindex") }).strict(),
    z.object({ k: z.literal("valuewhen"), cond: boolExpr, src: numExpr, occurrence: z.number().int().min(0).max(100) }).strict(),
    z.object({ k: z.literal("extremebars"), kind: z.enum(["highest", "lowest"]), period: numExpr, source: numExpr }).strict(),
    z.object({ k: z.literal("linreg"), period: numExpr, source: numExpr, offset: z.number().int().min(0).max(500) }).strict(),
    z.object({ k: z.literal("vwap") }).strict(),
    z.object({ k: z.literal("supertrend"), line: z.enum(["value", "dir"]), factor: numExpr, period: numExpr }).strict(),
    z.object({ k: z.literal("dmi"), line: z.enum(["plus", "minus", "adx"]), period: numExpr, smoothing: numExpr }).strict(),
    z.object({ k: z.literal("mfi"), period: numExpr }).strict(),
    z.object({ k: z.literal("cmo"), period: numExpr, source: numExpr }).strict(),
    z.object({ k: z.literal("tsi"), short: numExpr, long: numExpr, source: numExpr }).strict(),
    z.object({ k: z.literal("alma"), period: numExpr, source: numExpr, offset: z.number().min(0).max(1), sigma: z.number().min(0.1).max(100) }).strict(),
    z.object({ k: z.literal("cog"), period: numExpr, source: numExpr }).strict(),
    z.object({ k: z.literal("percentrank"), period: numExpr, source: numExpr }).strict(),
    z.object({ k: z.literal("sar"), start: numExpr, inc: numExpr, max: numExpr }).strict(),
    z.object({ k: z.literal("kc"), band: z.enum(["upper", "middle", "lower"]), period: numExpr, mult: numExpr }).strict()
  ])
);

const boolExpr: z.ZodType<unknown> = z.lazy(() =>
  z.discriminatedUnion("k", [
    z.object({ k: z.literal("bool"), v: z.boolean() }).strict(),
    z.object({ k: z.literal("compare"), op: z.enum([">", "<", ">=", "<=", "==", "!="]), a: numExpr, b: numExpr }).strict(),
    z.object({ k: z.literal("logic"), op: z.enum(["and", "or"]), a: boolExpr, b: boolExpr }).strict(),
    z.object({ k: z.literal("not"), a: boolExpr }).strict(),
    z.object({ k: z.literal("cross"), dir: z.enum(["above", "below", "any"]), a: numExpr, b: numExpr }).strict(),
    z.object({ k: z.literal("trend"), dir: z.enum(["rising", "falling"]), period: numExpr, source: numExpr }).strict(),
    z.object({ k: z.literal("between"), value: numExpr, low: numExpr, high: numExpr }).strict(),
    z.object({ k: z.literal("session"), start: z.number().int().min(0).max(23), end: z.number().int().min(0).max(23) }).strict(),
    z.object({ k: z.literal("dayofweek"), day: z.number().int().min(0).max(6) }).strict(),
    z.object({ k: z.literal("varb"), name: z.string().max(64) }).strict(),
    z.object({ k: z.literal("isna"), a: numExpr }).strict()
  ])
);

const stmt: z.ZodType<unknown> = z.lazy(() =>
  z.discriminatedUnion("k", [
    z.object({ k: z.literal("entry"), direction: z.enum(["long", "short"]), when: boolExpr }).strict(),
    z.object({ k: z.literal("exit"), when: boolExpr }).strict(),
    z.object({ k: z.literal("stop"), mode: z.enum(["price", "percent", "atr"]), value: numExpr }).strict(),
    z.object({ k: z.literal("target"), mode: z.enum(["price", "percent", "atr"]), value: numExpr }).strict(),
    z.object({ k: z.literal("trail"), mode: z.enum(["percent", "atr"]), value: numExpr }).strict(),
    z.object({ k: z.literal("size"), mode: z.enum(["units", "equity_pct", "risk_pct"]), value: numExpr }).strict(),
    z.object({ k: z.literal("setvar"), name: z.string().max(64), value: numExpr }).strict(),
    z.object({ k: z.literal("setvarb"), name: z.string().max(64), value: boolExpr }).strict(),
    z.object({ k: z.literal("alert"), message: z.string().max(512), when: boolExpr, args: z.record(z.string().max(32), numExpr).optional() }).strict(),
    z.object({ k: z.literal("plot"), value: numExpr, label, color: z.string().max(32), pane: z.enum(["price", "sub"]).optional() }).strict(),
    z.object({ k: z.literal("marker"), dir: z.enum(["up", "down"]), label, when: boolExpr }).strict(),
    z.object({ k: z.literal("box"), top: numExpr, bottom: numExpr, when: boolExpr, label, color: z.string().max(32) }).strict(),
    z.object({ k: z.literal("vline"), when: boolExpr, label, color: z.string().max(32) }).strict(),
    z.object({ k: z.literal("ray"), price: numExpr, when: boolExpr, label, color: z.string().max(32) }).strict(),
    z
      .object({
        k: z.literal("if"),
        cond: boolExpr,
        then: z.array(stmt).max(MAX_ARRAY),
        elifs: z.array(z.object({ cond: boolExpr, then: z.array(stmt).max(MAX_ARRAY) }).strict()).max(MAX_ARRAY).optional(),
        else: z.array(stmt).max(MAX_ARRAY).optional()
      })
      .strict(),
    z.object({ k: z.literal("repeat"), count: numExpr, body: z.array(stmt).max(MAX_ARRAY) }).strict(),
    z.object({ k: z.literal("while"), cond: boolExpr, body: z.array(stmt).max(MAX_ARRAY), cap: z.number().int().min(1).max(1000) }).strict(),
    z.object({ k: z.literal("for"), var: z.string().max(64), from: numExpr, to: numExpr, step: numExpr, body: z.array(stmt).max(MAX_ARRAY), cap: z.number().int().min(1).max(10_000) }).strict()
  ])
);

const strategyInput = z.object({ name: z.string().max(64), value: finite }).strict();

const strategyIRSchema = z
  .object({
    name: z.string().max(200),
    inputs: z.array(strategyInput).max(200),
    body: z.array(stmt).max(MAX_ARRAY),
    // The "on start (once)" section — setvar-only initialization.
    init: z.array(z.object({ k: z.literal("setvar"), name: z.string().max(64), value: numExpr }).strict()).max(MAX_ARRAY).optional(),
    // Reject strategies stamped with a NEWER schema than this backend understands.
    v: z.number().int().min(1).max(IR_VERSION).optional()
  })
  .strict();

/**
 * Iterative size/depth guard run BEFORE zod parse. Protects against both memory
 * blowup (huge node count) and stack overflow (pathological nesting) from a
 * hostile payload — zod's recursive parse would otherwise recurse to that depth.
 */
function irWithinBounds(root: unknown): { ok: true } | { ok: false; reason: string } {
  let nodes = 0;
  const stack: Array<{ v: unknown; depth: number }> = [{ v: root, depth: 0 }];
  while (stack.length) {
    const { v, depth } = stack.pop() as { v: unknown; depth: number };
    if (depth > MAX_DEPTH) return { ok: false, reason: "IR nesting too deep" };
    if (Array.isArray(v)) {
      if (v.length > MAX_ARRAY) return { ok: false, reason: "IR array too large" };
      for (const item of v) stack.push({ v: item, depth: depth + 1 });
    } else if (v && typeof v === "object") {
      nodes += 1;
      if (nodes > MAX_NODES) return { ok: false, reason: "IR too large" };
      for (const val of Object.values(v as Record<string, unknown>)) stack.push({ v: val, depth: depth + 1 });
    }
  }
  return { ok: true };
}

export function parseStrategyIR(input: unknown): { ok: true; ir: StrategyIR } | { ok: false; error: string } {
  const bound = irWithinBounds(input);
  if (!bound.ok) return { ok: false, error: bound.reason };
  const parsed = strategyIRSchema.safeParse(input);
  if (!parsed.success) {
    const error = parsed.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join(".") || "ir"}: ${issue.message}`)
      .join("; ");
    return { ok: false, error: error || "invalid IR" };
  }
  return { ok: true, ir: parsed.data as StrategyIR };
}
