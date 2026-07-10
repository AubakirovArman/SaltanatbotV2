// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { runBacktest, DEFAULT_CONFIG, type BacktestConfig } from "../src/strategy/backtest";
import { compileXmlToIr } from "../src/strategy/compileArtifact";
import type { BoolExpr, NumExpr, Stmt, StrategyIR } from "../src/strategy/ir";
import { importPineScript } from "../src/strategy/pine";
import { convertPine } from "../src/strategy/pine/convert";
import type { Candle } from "../src/types";
import v6corpus from "./pineV6Corpus.json";

/**
 * Pine v6 near-total-coverage tests for the expanded converter: user functions,
 * for/while loops, switch, expression ternaries, nz/na, math/ta breadth, and the
 * previous-bar operator on mutable vars. Every convertible script must also
 * round-trip through Blockly XML → compileWorkspace with zero errors, so the new
 * IR nodes stay first-class blocks (editable, backtestable, live-runnable).
 */

const MIN = 60_000;
function candle(i: number, o: number, h: number, l: number, c: number): Candle {
  return { time: i * MIN, open: o, high: h, low: l, close: c, volume: 1000 + i };
}
function closesToCandles(closes: number[]): Candle[] {
  return closes.map((c, i) => {
    const prev = i > 0 ? closes[i - 1] : c;
    return candle(i, prev, Math.max(prev, c) + 1, Math.min(prev, c) - 1, c);
  });
}
const noFriction: BacktestConfig = { ...DEFAULT_CONFIG, commissionPct: 0, slippagePct: 0, initialCapital: 10_000 };

/** Recurse the full statement tree, including for/while bodies (unlike the base helper). */
function walkStmts(stmts: Stmt[], visit: (s: Stmt) => void): void {
  for (const s of stmts) {
    visit(s);
    if (s.k === "if") {
      walkStmts(s.then, visit);
      for (const clause of s.elifs ?? []) walkStmts(clause.then, visit);
      if (s.else) walkStmts(s.else, visit);
    }
    if (s.k === "repeat" || s.k === "while" || s.k === "for") walkStmts(s.body, visit);
  }
}
function json(ir: StrategyIR): string {
  return JSON.stringify(ir);
}
/** Convert + assert the emitted XML compiles back with no real errors (round-trip). */
function roundTrips(source: string): StrategyIR {
  const result = importPineScript(source);
  expect(result.ok, result.ok ? "" : `conversion failed: ${(result as { error: string }).error}`).toBe(true);
  if (!result.ok) throw new Error(result.error);
  const compiled = compileXmlToIr(result.xml);
  const realErrors = compiled.errors.filter((e) => !e.includes("no entry rule"));
  expect(realErrors, `round-trip errors: ${realErrors.join(" | ")}`).toHaveLength(0);
  expect(compiled.ir).toBeTruthy();
  // Return the direct-conversion IR (importPineScript exposes only XML/code).
  return convertPine(source).ir;
}

describe("Pine v6: user functions (inlining)", () => {
  it("single-expression function is inlined at every call site", () => {
    const ir = roundTrips(`//@version=6
indicator("F", overlay=true)
avgPrice(a, b) => (a + b) / 2
plot(avgPrice(high, low), "mid")`);
    // The body should contain the inlined arithmetic, no leftover call.
    expect(json(ir)).toContain('"arith"');
    expect(json(ir)).not.toContain("avgPrice");
  });

  it("multi-line function with immutable locals returns its final expression", () => {
    const ir = roundTrips(`//@version=6
indicator("F2")
zscore(src, len) =>
    mean = ta.sma(src, len)
    sd = ta.stdev(src, len)
    (src - mean) / sd
plot(zscore(close, 20), "z")`);
    const j = json(ir);
    expect(j).toContain('"stdev"');
    expect(j).toContain('"ma"');
  });

  it("boolean-returning function used as a condition", () => {
    const ir = roundTrips(`//@version=6
strategy("F3")
isBull(fast, slow) => ta.crossover(fast, slow)
if isBull(ta.ema(close, 9), ta.ema(close, 21))
    strategy.entry("L", strategy.long)`);
    let sawCross = false;
    walkStmts(ir.body, (s) => {
      if (s.k === "if" && s.cond.k === "cross") sawCross = true;
    });
    expect(sawCross).toBe(true);
  });

  it("default parameter values are used when an argument is omitted", () => {
    const ir = roundTrips(`//@version=6
indicator("F4")
scaled(x, k = 2) => x * k
plot(scaled(close), "s")`);
    expect(json(ir)).toContain('"v":2');
  });

  it("rejects recursion with a clear message", () => {
    const result = importPineScript(`//@version=6
indicator("R")
f(x) => f(x) + 1
plot(f(close))`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/recursiv/i);
  });
});

describe("Pine v6: for / while loops", () => {
  it("for-loop accumulation compiles to a for stmt and backtests", () => {
    const ir = roundTrips(`//@version=6
strategy("Loop")
sum = 0.0
for i = 0 to 4
    sum := sum + close[i]
avg = sum / 5
if close > avg
    strategy.entry("L", strategy.long)
if close < avg
    strategy.close("L")`);
    let sawFor = false;
    walkStmts(ir.body, (s) => {
      if (s.k === "for") sawFor = true;
    });
    expect(sawFor).toBe(true);
    const candles = closesToCandles(Array.from({ length: 80 }, (_, i) => 100 + Math.sin(i / 6) * 8));
    const result = runBacktest(ir, candles, noFriction);
    expect(result.metrics.totalTrades).toBeGreaterThan(0);
  });

  it("descending for-loop (to < from) still runs (Pine direction inference)", () => {
    const ir = roundTrips(`//@version=6
indicator("Down")
total = 0.0
for i = 3 to 0
    total := total + i
plotshape(total > 5, "hi")`);
    // Loop body accumulates 3+2+1+0 = 6 each bar → var total ends at 6.
    const candles = closesToCandles([100, 101, 102, 103, 104]);
    const result = runBacktest(ir, candles, noFriction);
    // No trades (indicator), but it must run without error.
    expect(result.metrics.totalTrades).toBe(0);
  });

  it("while-loop maps to a bounded while stmt", () => {
    const ir = roundTrips(`//@version=6
indicator("W")
n = 0.0
while n < 3
    n := n + 1
plotshape(n > 2, "n")`);
    let sawWhile = false;
    walkStmts(ir.body, (s) => {
      if (s.k === "while") sawWhile = true;
    });
    expect(sawWhile).toBe(true);
  });
});

describe("Pine v6: switch", () => {
  it("expression switch with subject → nested cond", () => {
    const ir = roundTrips(`//@version=6
indicator("Sw")
mode = 2
factor = switch mode
    1 => 0.5
    2 => 1.0
    => 2.0
plot(close * factor, "f")`);
    expect(json(ir)).toContain('"cond"');
  });

  it("subjectless switch (boolean arms) selects by condition", () => {
    const ir = roundTrips(`//@version=6
indicator("Sw2")
sig = switch
    close > open => 1
    close < open => -1
    => 0
plot(sig, "s")`);
    expect(json(ir)).toContain('"cond"');
  });

  it("statement-position switch becomes if/elif/else", () => {
    const ir = roundTrips(`//@version=6
strategy("Sw3")
dir = close > open ? 1 : -1
switch dir
    1 => strategy.entry("L", strategy.long)
    -1 => strategy.close("L")`);
    let sawEntry = false;
    let sawExit = false;
    walkStmts(ir.body, (s) => {
      if (s.k === "entry") sawEntry = true;
      if (s.k === "exit") sawExit = true;
    });
    expect(sawEntry).toBe(true);
    expect(sawExit).toBe(true);
  });
});

describe("Pine v6: expression ternary, nz, na", () => {
  it("ternary inside an expression maps to a cond node (not an error)", () => {
    const ir = roundTrips(`//@version=6
indicator("Tern")
src = close > open ? high : low
plot(ta.sma(src, 10), "s")`);
    expect(json(ir)).toContain('"cond"');
  });

  it("nested ternary chains", () => {
    const ir = roundTrips(`//@version=6
indicator("Tern2")
v = close > 100 ? 3 : close > 50 ? 2 : 1
plot(v, "v")`);
    const j = json(ir);
    expect(j.match(/"cond"/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("nz(x) and nz(x, y) map to the nz node", () => {
    const ir = roundTrips(`//@version=6
indicator("Nz")
delta = nz(close - close[1], 0)
plot(delta, "d")`);
    expect(json(ir)).toContain('"nz"');
  });

  it("na(x) becomes an isna test", () => {
    const ir = roundTrips(`//@version=6
indicator("Na")
x = ta.sma(close, 200)
plotshape(na(x), "warmup")`);
    expect(json(ir)).toContain('"isna"');
  });

  it("recursive var with x[1] and nz (running accumulator)", () => {
    const ir = roundTrips(`//@version=6
indicator("Rec")
var float acc = na
acc := nz(acc[1], 0) + close
plotshape(acc > 100, "big")`);
    expect(json(ir)).toContain('"varprev"');
    // Running sum of closes: after n bars acc = sum of closes.
    const candles = closesToCandles([10, 20, 30, 40]);
    const result = runBacktest(ir, candles, noFriction);
    expect(result.metrics.totalTrades).toBe(0); // indicator, but runs cleanly
  });
});

describe("Pine v6: math + ta breadth", () => {
  it("math.sign / log / sqrt / exp map to unary ops", () => {
    const ir = roundTrips(`//@version=6
indicator("M")
a = math.sign(close - open)
b = math.sqrt(math.abs(close))
c = math.log(close)
plot(a + b + c, "m")`);
    const j = json(ir);
    expect(j).toContain('"op":"sign"');
    expect(j).toContain('"op":"sqrt"');
    expect(j).toContain('"op":"log"');
  });

  it("math.pi constant is inlined", () => {
    const ir = roundTrips(`//@version=6
indicator("Pi")
plot(close * math.pi, "p")`);
    expect(json(ir)).toContain(String(Math.PI));
  });

  it("ta.rma maps to an rma moving average", () => {
    const ir = roundTrips(`//@version=6
indicator("Rma")
plot(ta.rma(close, 14), "r")`);
    expect(json(ir)).toContain('"kind":"rma"');
  });

  it("ta.tr expands to an exact true-range expression", () => {
    const ir = roundTrips(`//@version=6
indicator("TR")
plot(ta.tr, "tr")`);
    const j = json(ir);
    expect(j).toContain('"minmax"');
    expect(j).toContain('"field":"high"');
  });

  it("ta.sum and ta.median map to aggregation nodes", () => {
    const ir = roundTrips(`//@version=6
indicator("Agg")
plot(ta.sum(volume, 20) + ta.median(close, 10), "a")`);
    const j = json(ir);
    expect(j).toContain('"fn":"sum"');
    expect(j).toContain('"fn":"median"');
  });

  it("ta.cum and ta.barssince map to their nodes", () => {
    const ir = roundTrips(`//@version=6
indicator("Cum")
plot(ta.cum(volume), "c")
plot(ta.barssince(close > open), "b")`);
    const j = json(ir);
    expect(j).toContain('"cum"');
    expect(j).toContain('"barssince"');
  });

  it("ta.hma composes and backtests without error", () => {
    const ir = roundTrips(`//@version=6
strategy("Hma")
h = ta.hma(close, 16)
if ta.crossover(close, h)
    strategy.entry("L", strategy.long)
if ta.crossunder(close, h)
    strategy.close("L")`);
    const candles = closesToCandles(Array.from({ length: 120 }, (_, i) => 100 + Math.sin(i / 7) * 10 + i * 0.05));
    const result = runBacktest(ir, candles, noFriction);
    expect(result.metrics.totalTrades).toBeGreaterThan(0);
  });

  it("ta.bbw composes from bollinger bands", () => {
    const ir = roundTrips(`//@version=6
indicator("BBW")
plot(ta.bbw(close, 20, 2), "w")`);
    const j = json(ir);
    expect(j).toContain('"bollinger"');
  });

  it("iff() legacy conditional maps to a cond node", () => {
    const ir = roundTrips(`//@version=6
indicator("Iff")
plot(iff(close > open, high, low), "i")`);
    expect(json(ir)).toContain('"cond"');
  });
});

describe("Pine v6: fail-closed on genuinely impossible constructs", () => {
  const impossible: { name: string; source: string; match: RegExp }[] = [
    {
      name: "request.security (other timeframe)",
      source: `//@version=6\nindicator("x")\nhtf = request.security(syminfo.tickerid, "D", close)\nplot(htf)`,
      match: /request\.security|external|timeframe/i
    },
    {
      name: "arrays",
      source: `//@version=6\nindicator("x")\nvar a = array.new_float(0)\nplot(array.size(a))`,
      match: /collection|array/i
    },
    {
      name: "ta.pivothigh (look-ahead)",
      source: `//@version=6\nindicator("x")\nph = ta.pivothigh(high, 5, 5)\nplot(ph)`,
      match: /look|ahead|pivot/i
    },
    {
      name: "math.random (non-deterministic)",
      source: `//@version=6\nindicator("x")\nplot(math.random(0, 1))`,
      match: /random|deterministic/i
    },
    {
      name: "trigonometry",
      source: `//@version=6\nindicator("x")\nplot(math.sin(close))`,
      match: /trig/i
    },
    {
      name: "bar_index",
      source: `//@version=6\nindicator("x")\nplot(bar_index)`,
      match: /bar count|bar_index/i
    },
    {
      name: "barstate",
      source: `//@version=6\nindicator("x")\nplotshape(barstate.islast, "last")`,
      match: /barstate|confirmed/i
    },
    {
      name: "str.* strings",
      source: `//@version=6\nindicator("x")\nplot(str.length(syminfo.ticker))`,
      match: /string|metadata/i
    },
    {
      name: "ta.vwap (needs native block)",
      source: `//@version=6\nindicator("x")\nplot(ta.vwap)`,
      match: /vwap|native|primitive/i
    }
  ];
  for (const c of impossible) {
    it(`rejects ${c.name} with a clear message`, () => {
      const result = importPineScript(c.source);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(c.match);
    });
  }
});

describe("Pine v6 corpus: robustness + breadth", () => {
  // 31 real-world v6/v5/v4 scripts spanning indicators, strategies, functions,
  // loops, switch, recursion, and constructs that MUST be rejected (request.security,
  // arrays/matrices/maps, look-ahead pivots, native-only indicators).
  it("never crashes: each script converts+round-trips OR fails with a clear error", () => {
    let converted = 0;
    for (const script of v6corpus.scripts) {
      let result: ReturnType<typeof importPineScript>;
      try {
        result = importPineScript(script.source);
      } catch (cause) {
        throw new Error(`"${script.title}" threw instead of failing cleanly: ${(cause as Error).message}`);
      }
      if (result.ok) {
        converted += 1;
        const compiled = compileXmlToIr(result.xml);
        const realErrors = compiled.errors.filter((e) => !e.includes("no entry rule"));
        expect(realErrors, `"${script.title}" converted but the Blockly round-trip failed: ${realErrors.join(" | ")}`).toHaveLength(0);
      } else {
        expect(result.error.length, `"${script.title}" rejected with an empty message`).toBeGreaterThan(0);
      }
    }
    // Breadth guard: everything computable in a per-bar scalar IR must convert.
    // (The rest are genuine limitations — MTF data, collections, look-ahead, native-only indicators.)
    expect(converted).toBeGreaterThanOrEqual(19);
  });

  it("REJECT-tagged scripts (structurally impossible) all fail closed", () => {
    for (const script of v6corpus.scripts.filter((s) => s.title.includes("REJECT"))) {
      const result = importPineScript(script.source);
      expect(result.ok, `"${script.title}" should have been rejected`).toBe(false);
    }
  });

  // Real-world script conventions (from the awesome-pinescript corpus): string
  // constants for input groups/modes, frozen input.string selectors, input.color,
  // hex color literals, and `const` type modifiers must all convert.
  it("string constants, input.string mode selector, input.color, hex colors, const", () => {
    const ir = roundTrips(`//@version=6
indicator("Modes", overlay=true)
var const string MODE_FAST = "Fast"
string MODE_SLOW = "Slow"
string GROUP_MAIN = "Main " + "settings"
mode = input.string(MODE_FAST, "Mode", options=[MODE_FAST, MODE_SLOW], group=GROUP_MAIN)
len = input.int(9, "Length", group=GROUP_MAIN)
lineCol = input.color(color.green, "Line")
maVal = mode == MODE_FAST ? ta.ema(close, len) : ta.sma(close, len * 2)
plot(maVal, "ma", color=#26a69a)`);
    const j = JSON.stringify(ir);
    // mode == MODE_FAST folds to a constant condition inside the cond node.
    expect(j).toContain('"cond"');
    expect(ir.inputs.map((i) => i.name)).toEqual(["len"]);
  });

  it("structural constructs fail closed with honest reasons (not parse gibberish)", () => {
    const cases: { src: string; match: RegExp }[] = [
      { src: '//@version=6\nindicator("t")\ntype point\n    float x\n    float y\nplot(close)', match: /user-defined|data types/i },
      { src: '//@version=6\nindicator("t")\narray<float> xs = array.new<float>()\nplot(close)', match: /collection|array/i },
      { src: '//@version=6\nindicator("t")\nfloat[] xs = array.new_float(0)\nplot(close)', match: /collection|array/i },
      { src: '//@version=6\nindicator("t")\nvalue = close\nplot(value.rounded)', match: /object|collection/i },
      { src: '//@version=6\nindicator("t")\nplot(box.all)', match: /drawing|visual/i },
      { src: '//@version=6\nindicator("t")\ninSession = time("60", "0800-1200")\nplot(inSession)', match: /session/i }
    ];
    for (const c of cases) {
      const result = importPineScript(c.src);
      expect(result.ok, `should reject: ${c.src.split("\n")[2]}`).toBe(false);
      if (!result.ok) expect(result.error).toMatch(c.match);
    }
  });

  // Mirrors what the import dialog does for a mixed paste + multi-file batch: convert
  // each source independently → indicator()/strategy() route to the right artifact
  // kind, names come from the script, and invalid scripts fail without sinking the batch.
  it("batch import: mixed indicator + strategy + invalid convert independently", () => {
    const sources = [
      '//@version=6\nindicator("Fast RSI")\nplot(ta.rsi(close, 7), "rsi")',
      '//@version=6\nstrategy("Cross Bot")\nif ta.crossover(close, ta.sma(close, 20))\n    strategy.entry("L", strategy.long)',
      '//@version=6\nindicator("HTF")\nplot(request.security(syminfo.tickerid, "D", close))'
    ];
    const results = sources.map((s) => importPineScript(s));
    const ok = results.filter((r): r is Extract<typeof r, { ok: true }> => r.ok);
    expect(ok).toHaveLength(2);
    expect(ok.map((r) => `${r.kind}:${r.name}`)).toEqual(["indicator:Fast RSI", "strategy:Cross Bot"]);
    const failed = results.find((r) => !r.ok);
    expect(failed && !failed.ok && failed.error).toMatch(/request\.security|external|timeframe/i);
  });
});
