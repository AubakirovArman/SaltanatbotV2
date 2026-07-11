// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { runBacktest, previewStrategy, DEFAULT_CONFIG, type BacktestConfig } from "../src/strategy/backtest";
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

  it("accepts if conditions where and/or is split onto its own continuation line", () => {
    const ir = roundTrips(`//@version=6
indicator("continued if", overlay=true)
if (
    close > open
    )
    and
    (
    high > low
    )
    plotshape(true, "ok")`);

    expect(json(ir)).toContain('"marker"');
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

  it("string ternary selectors stay compile-time text instead of numeric series", () => {
    const ir = roundTrips(`//@version=6
indicator("String Ternary")
BULL = "Bull"
BEAR = "Bear"
mode = input.string(BULL, "Mode", options=[BULL, BEAR])
category = mode == BULL ? "Peak" : "Trough"
plotshape(category == "Peak", "peak")`);

    expect(json(ir)).toContain('"marker"');
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

  it("request.security imports as an editable external-series block", () => {
    const result = importPineScript(`//@version=6
indicator("HTF")
htf = request.security(syminfo.tickerid, "D", ta.rsi(close, 14))
plot(htf, "daily rsi")`);
    expect(result.ok, result.ok ? "" : result.error).toBe(true);
    if (!result.ok) return;
    expect(result.warnings.join(" ")).toMatch(/request\.security|external-series|external candles|current chart/i);
    const compiled = compileXmlToIr(result.xml);
    expect(compiled.errors.filter((e) => !e.includes("no entry rule"))).toHaveLength(0);
    const ir = convertPine(`//@version=6
indicator("HTF")
htf = request.security(syminfo.tickerid, "D", ta.rsi(close, 14))
plot(htf, "daily rsi")`).ir;
    expect(json(ir)).toContain('"security"');
  });

  it("time(session) imports as timestamp-or-na and can be used as a condition", () => {
    const ir = roundTrips(`//@version=6
indicator("Session")
inSession = time("60", "0800-1200:23456")
plotshape(inSession, "session")`);
    expect(json(ir)).toContain('"time"');
  });
});

describe("Pine v6: fail-closed on genuinely impossible constructs", () => {
  const impossible: { name: string; source: string; match: RegExp }[] = [
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
      name: "str.* strings",
      source: `//@version=6\nindicator("x")\nplot(str.length(syminfo.ticker))`,
      match: /string|metadata/i
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

describe("Pine v6: opaque visual/collection constructs import with warnings", () => {
  const convertible: { name: string; source: string; match: RegExp }[] = [
    {
      name: "arrays",
      source: `//@version=6\nindicator("x")\nvar a = array.new_float(0)\nplot(array.size(a))`,
      match: /collection|array/i
    },
    {
      name: "barstate",
      source: `//@version=6\nindicator("x")\nplotshape(barstate.islast, "last")`,
      match: /barstate|last-bar/i
    },
    {
      name: "user object type",
      source: `//@version=6\nindicator("t")\ntype point\n    float x\n    float y\nplot(close)`,
      match: /object|type/i
    },
    {
      name: "drawing collection",
      source: `//@version=6\nindicator("t")\nplot(box.all)`,
      match: /drawing|opaque|visual/i
    }
  ];
  for (const c of convertible) {
    it(`imports ${c.name} with a fidelity warning`, () => {
      const result = importPineScript(c.source);
      expect(result.ok, result.ok ? "" : result.error).toBe(true);
      if (!result.ok) return;
      expect(result.warnings.join(" ")).toMatch(c.match);
      const compiled = compileXmlToIr(result.xml);
      expect(compiled.errors.filter((e) => !e.includes("no entry rule"))).toHaveLength(0);
    });
  }
});

describe("Pine v6: user object field state", () => {
  it("flattens mutable object fields instead of rejecting dotted identifiers", () => {
    const result = importPineScript(`//@version=6
indicator("Object State")
type state
    float level
    bool active
var state s = state.new()
s.level := high
s.active := close > open
plot(s.level, "level")
plotshape(s.active, "active")`);

    expect(result.ok, result.ok ? "" : result.error).toBe(true);
    if (!result.ok) return;
    expect(result.warnings.join(" ")).toMatch(/flattened|object fields/i);
    const compiled = compileXmlToIr(result.xml);
    expect(compiled.errors.filter((e) => !e.includes("no entry rule"))).toHaveLength(0);
  });
});

describe("Pine v6 corpus: robustness + breadth", () => {
  // 31 real-world v6/v5/v4 scripts spanning indicators, strategies, functions,
  // loops, switch, recursion, visual collections, MTF approximations, and hard
  // rejects for genuinely unsafe/non-deterministic constructs.
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
    // Breadth guard: everything computable or safely display-approximated must convert.
    expect(converted).toBeGreaterThanOrEqual(19);
  });

  it("REJECT-tagged look-ahead scripts still fail closed", () => {
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

  it("structural constructs import as editable approximations (not parse gibberish)", () => {
    const cases: { src: string; match: RegExp }[] = [
      { src: '//@version=6\nindicator("t")\ntype point\n    float x\n    float y\nplot(close)', match: /type|object/i },
      { src: '//@version=6\nindicator("t")\narray<float> xs = array.new<float>()\nplot(close)', match: /collection|array/i },
      { src: '//@version=6\nindicator("t")\nfloat[] xs = array.new_float(0)\nplot(close)', match: /collection|array/i },
      { src: '//@version=6\nindicator("t")\nvalue = close\nplot(value.rounded)', match: /object|field|opaque/i },
      { src: '//@version=6\nindicator("t")\nplot(box.all)', match: /drawing|visual|opaque/i }
    ];
    for (const c of cases) {
      const result = importPineScript(c.src);
      expect(result.ok, `should import: ${c.src.split("\n")[2]}`).toBe(true);
      if (result.ok) expect(result.warnings.join(" ")).toMatch(c.match);
    }
  });

  // Chart drawing primitives: box/vline/ray statements render in the preview and
  // round-trip through Blockly; bgcolor(cond ? color : na) converts to shading.
  it("bgcolor conditional shading converts to a full-height box and previews as runs", () => {
    const ir = roundTrips(`//@version=6
indicator("Shade", overlay=true)
bull = close > open
bgcolor(bull ? color.new(color.green, 85) : na)
plot(close, "c")`);
    const boxes = ir.body.filter((s) => s.k === "box");
    expect(boxes).toHaveLength(1);
    // 2 bull bars, 1 bear, 2 bull → two shaded runs.
    const candles = [
      candle(0, 100, 102, 99, 101), candle(1, 101, 103, 100, 102), candle(2, 102, 103, 99, 100),
      candle(3, 100, 103, 99, 102), candle(4, 102, 105, 101, 104)
    ];
    const preview = previewStrategy(ir, candles);
    expect(preview.shapes.boxes).toHaveLength(2);
    expect(preview.shapes.boxes[0].t1).toBe(candles[0].time);
    expect(preview.shapes.boxes[0].t2).toBe(candles[1].time);
    // bgcolor boxes shade the full pane: non-finite edges.
    expect(Number.isFinite(preview.shapes.boxes[0].top)).toBe(false);
  });

  it("fill() between assigned plots converts to band shading", () => {
    const { ir, warnings } = convertPine(`//@version=6
indicator("Fill", overlay=true)
upper = plot(high, "upper", color=color.blue)
lower = plot(low, "lower", color=color.red)
fill(upper, lower, color=color.new(color.blue, 85))`);

    expect(warnings.join(" ")).toMatch(/fill/i);
    expect(json(ir)).toContain('"box"');
    const roundTripped = roundTrips(`//@version=6
indicator("Fill", overlay=true)
upper = plot(high, "upper", color=color.blue)
lower = plot(low, "lower", color=color.red)
fill(upper, lower, color=color.new(color.blue, 85))`);
    expect(json(roundTripped)).toContain('"box"');
  });

  it("gradient fill() uses explicit top/bottom series when Pine supplies them", () => {
    const ir = roundTrips(`//@version=6
indicator("Gradient Fill", overlay=true)
mid = plot(hl2, "mid")
trend = plot(ta.sma(close, 5), "trend")
fill(mid, trend, high, low, color.green, color.red)`);
    const box = ir.body.find((stmt) => stmt.k === "box");

    expect(box).toBeTruthy();
    expect(json(ir)).toContain('"field":"high"');
    expect(json(ir)).toContain('"field":"low"');
  });

  it("box tracks run extremes; vline and ray anchor at their firing bars", () => {
    const ir: StrategyIR = {
      name: "draw",
      inputs: [],
      v: 2,
      body: [
        { k: "box", top: { k: "price", field: "high" }, bottom: { k: "price", field: "low" }, when: { k: "compare", op: ">", a: { k: "price", field: "close" }, b: { k: "price", field: "open" } }, label: "zone", color: "#26a69a" },
        { k: "vline", when: { k: "compare", op: "<", a: { k: "price", field: "close" }, b: { k: "price", field: "open" } }, label: "", color: "#8f9bb3" },
        { k: "ray", price: { k: "price", field: "high" }, when: { k: "compare", op: "<", a: { k: "price", field: "close" }, b: { k: "price", field: "open" } }, label: "R", color: "#f7c948" }
      ]
    };
    const candles = [
      candle(0, 100, 105, 99, 104), candle(1, 104, 110, 103, 108), candle(2, 108, 109, 101, 102),
      candle(3, 102, 107, 101, 106)
    ];
    const preview = previewStrategy(ir, candles);
    // Bull run bars 0-1 → one box spanning both with high=110, low=99; bar 3 opens a second run.
    expect(preview.shapes.boxes).toHaveLength(2);
    expect(preview.shapes.boxes[0].top).toBe(110);
    expect(preview.shapes.boxes[0].bottom).toBe(99);
    // Bar 2 is the only bear bar → one vline + one ray at its high.
    expect(preview.shapes.vlines).toHaveLength(1);
    expect(preview.shapes.vlines[0].time).toBe(candles[2].time);
    expect(preview.shapes.rays).toHaveLength(1);
    expect(preview.shapes.rays[0].price).toBe(109);
  });

  // Simple drawing-object patterns (no collections) map to display primitives:
  // label.new → marker (text renders on chart), horizontal line.new → ray, box.new → box.
  it("label.new / line.new / box.new map to marker / ray / box with warnings", () => {
    const ir = roundTrips(`//@version=6
indicator("Draw", overlay=true)
sup = ta.lowest(low, 20)
if ta.crossover(close, ta.sma(close, 10))
    label.new(bar_index, high, "breakout", style=label.style_label_down)
    line.new(bar_index, sup, bar_index + 10, sup, color=color.gray, extend=extend.right)
    box.new(bar_index, high, bar_index + 5, low, bgcolor=color.new(color.green, 80))
plot(close, "c")`);
    const kinds = new Set<string>();
    walkStmts(ir.body, (s) => kinds.add(s.k));
    expect(kinds.has("marker")).toBe(true);
    expect(kinds.has("ray")).toBe(true);
    expect(kinds.has("box")).toBe(true);
    // The label text must survive into the marker.
    let text = "";
    walkStmts(ir.body, (s) => {
      if (s.k === "marker") text = s.label;
    });
    expect(text).toBe("breakout");
  });

  it("drawing handles: binding, set_*/delete mutations, and na(handle) idiom convert with warnings", () => {
    const result = importPineScript(`//@version=6
indicator("Handles", overlay=true)
var line supLine = na
level = ta.lowest(low, 50)
if na(supLine)
    supLine := line.new(bar_index, level, bar_index + 1, level, color=color.gray)
line.set_y1(supLine, level)
line.delete(supLine)
plot(close, "c")`);
    expect(result.ok, result.ok ? "" : (result as { error: string }).error).toBe(true);
    if (!result.ok) return;
    expect(result.warnings.some((w) => /ignored|approximated/i.test(w))).toBe(true);
  });

  it("slanted line.new segments are skipped with a warning, not mis-drawn", () => {
    const { ir, warnings } = convertPine(`//@version=6
indicator("Slant")
if close > open
    line.new(bar_index - 5, low, bar_index, high)
plot(close, "c")`);
    let sawRay = false;
    walkStmts(ir.body, (s) => {
      if (s.k === "ray") sawRay = true;
    });
    expect(sawRay).toBe(false);
    expect(warnings.some((w) => /slanted/i.test(w))).toBe(true);
  });

  it("vertical line.new segments map to chart event lines", () => {
    const { ir, warnings } = convertPine(`//@version=6
indicator("Cycles", overlay=true)
if close > open
    line.new(bar_index, close, bar_index, close + 1, xloc.bar_index, extend.both, color.gray)`);
    let sawVline = false;
    walkStmts(ir.body, (s) => {
      if (s.k === "vline") sawVline = true;
    });
    expect(sawVline).toBe(true);
    expect(warnings.some((w) => /vertical/i.test(w))).toBe(true);
    expect(warnings.some((w) => /slanted/i.test(w))).toBe(false);
  });

  it("time-based boxes and numeric table cells map to projection/table primitives", () => {
    const { ir } = convertPine(`//@version=6
indicator("Display", overlay=true)
var table stats = table.new(position.top_right, 2, 2)
if barstate.isconfirmed
    box.new(time, high, time + 86400000, low, xloc=xloc.bar_time, bgcolor=color.new(color.blue, 80))
    table.cell(stats, 1, 0, str.tostring(close))
plot(close)`);
    const kinds = new Set<string>();
    walkStmts(ir.body, (stmt) => kinds.add(stmt.k));
    expect(kinds.has("projection")).toBe(true);
    expect(kinds.has("metric")).toBe(true);
  });

  // Wave 3: native ta.* nodes — the "practically any indicator" expansion.
  it("wave-3 ta.* functions convert, round-trip, and preview finite values", () => {
    const ir = roundTrips(`//@version=6
indicator("Wave3", overlay=false)
[st, dir] = ta.supertrend(3, 10)
[dip, dim, adx] = ta.dmi(14, 14)
[kmid, kup, klow] = ta.kc(close, 20, 2)
lastHigh = ta.valuewhen(ta.crossover(close, ta.sma(close, 10)), high, 0)
reg = ta.linreg(close, 14, 0)
plot(st, "st")
plot(adx, "adx")
plot(kup, "kc")
plot(lastHigh, "vw")
plot(reg, "lr")
plot(ta.vwap, "vwap")
plot(ta.mfi(hlc3, 14), "mfi")
plot(ta.cmo(close, 9), "cmo")
plot(ta.tsi(close, 13, 25), "tsi")
plot(ta.alma(close, 21, 0.85, 6), "alma")
plot(ta.cog(close, 10), "cog")
plot(ta.percentrank(close, 20), "pr")
plot(ta.sar(0.02, 0.02, 0.2), "sar")
plot(ta.highestbars(high, 10), "hb")
plot(bar_index, "bi")`);
    const j = JSON.stringify(ir);
    for (const kind of ["supertrend", "dmi", "kc", "valuewhen", "linreg", "vwap", "mfi", "cmo", "tsi", "alma", "cog", "percentrank", "sar", "extremebars", "barindex"]) {
      expect(j, `missing node ${kind}`).toContain(`"${kind}"`);
    }
    // Preview must produce finite values once warm (no NaN-poisoned math).
    const closes = Array.from({ length: 120 }, (_, i) => 100 + Math.sin(i / 7) * 10 + i * 0.05);
    const candles = closesToCandles(closes);
    const preview = previewStrategy(ir, candles);
    for (const plot of preview.plots) {
      const tail = plot.points.slice(-5);
      expect(tail.length, `plot ${plot.label} has no points`).toBeGreaterThan(0);
      for (const pt of tail) expect(Number.isFinite(pt.value), `plot ${plot.label} not finite`).toBe(true);
    }
  });

  it("supertrend direction flips between +1/-1 and percentrank stays in 0..100", () => {
    const ir = roundTrips(`//@version=6
indicator("Rng")
[st, dir] = ta.supertrend(2, 7)
plot(dir, "dir")
plot(ta.percentrank(close, 14), "pr")`);
    const closes = Array.from({ length: 150 }, (_, i) => 100 + Math.sin(i / 9) * 15);
    const preview = previewStrategy(ir, closesToCandles(closes));
    const dirPlot = preview.plots.find((p) => p.label === "dir");
    const prPlot = preview.plots.find((p) => p.label === "pr");
    const dirs = new Set((dirPlot?.points ?? []).map((pt) => pt.value));
    expect(dirs.has(1) && dirs.has(-1), "supertrend never flipped").toBe(true);
    for (const pt of prPlot?.points ?? []) {
      expect(pt.value).toBeGreaterThanOrEqual(0);
      expect(pt.value).toBeLessThanOrEqual(100);
    }
  });

  it("box run inside a loop body is not fragmented by same-bar re-execution (review fix)", () => {
    const ir: StrategyIR = {
      name: "loopbox",
      inputs: [],
      v: 2,
      body: [
        {
          k: "repeat",
          count: { k: "num", v: 3 },
          body: [
            { k: "box", top: { k: "price", field: "high" }, bottom: { k: "price", field: "low" }, when: { k: "bool", v: true }, label: "", color: "#26a69a" }
          ]
        }
      ]
    };
    const candles = closesToCandles([100, 101, 102, 103]);
    const preview = previewStrategy(ir, candles);
    // One continuous run over all bars — not fragmented into per-iteration slivers.
    expect(preview.shapes.boxes).toHaveLength(1);
    expect(preview.shapes.boxes[0].t1).toBe(candles[0].time);
    expect(preview.shapes.boxes[0].t2).toBe(candles[3].time);
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
    expect(ok).toHaveLength(3);
    expect(ok.map((r) => `${r.kind}:${r.name}`)).toEqual(["indicator:Fast RSI", "strategy:Cross Bot", "indicator:HTF"]);
    expect(ok[2].warnings.join(" ")).toMatch(/request\.security|external-series|external candles|current chart/i);
  });
});
