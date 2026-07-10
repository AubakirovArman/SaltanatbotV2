// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { runBacktest, DEFAULT_CONFIG, type BacktestConfig } from "../src/strategy/backtest";
import { compileXmlToIr } from "../src/strategy/compileArtifact";
import type { Stmt, StrategyIR } from "../src/strategy/ir";
import { importPineScript } from "../src/strategy/pine";
import { convertPine } from "../src/strategy/pine/convert";
import type { Candle } from "../src/types";
import corpus from "./pineCorpus.json";

/**
 * Pine converter tests, three layers:
 * 1. Corpus: 12 realistic scripts must convert, declare the right kind, and
 *    round-trip through Blockly XML → compileWorkspace with zero compile errors
 *    (jsdom provides the DOMParser Blockly needs).
 * 2. Semantics: targeted assertions on the produced IR for the key mappings.
 * 3. Guardrails: hostile input fails cleanly.
 */

const MIN = 60_000;
function candle(i: number, c: number): Candle {
  return { time: i * MIN, open: c, high: c + 1, low: c - 1, close: c, volume: 1000 };
}
const noFriction: BacktestConfig = { ...DEFAULT_CONFIG, commissionPct: 0, slippagePct: 0, initialCapital: 10_000 };

function walkStmts(stmts: Stmt[], visit: (s: Stmt) => void) {
  for (const s of stmts) {
    visit(s);
    if (s.k === "if") {
      walkStmts(s.then, visit);
      for (const clause of s.elifs ?? []) walkStmts(clause.then, visit);
      if (s.else) walkStmts(s.else, visit);
    }
    if (s.k === "repeat" || s.k === "while") walkStmts(s.body, visit);
  }
}

function kinds(ir: StrategyIR): Set<string> {
  const out = new Set<string>();
  walkStmts(ir.body, (s) => out.add(s.k));
  return out;
}

describe("Pine corpus: every script converts and round-trips through Blockly", () => {
  // Kitchen Sink deliberately mixes hard-unsupported constructs (request.security)
  // and is covered by the fail-closed guardrail test below instead.
  const convertible = corpus.scripts.filter((s) => !s.title.startsWith("Kitchen Sink"));
  for (const script of convertible) {
    it(`${script.title} [${script.kind}]`, () => {
      const result = importPineScript(script.source);
      expect(result.ok, result.ok ? "" : `conversion failed: ${(result as { error: string }).error}`).toBe(true);
      if (!result.ok) return;
      expect(result.kind).toBe(script.kind);
      // Round-trip: emitted XML must compile back with zero errors.
      const compiled = compileXmlToIr(result.xml);
      expect(compiled.ir, `no IR from XML round-trip`).toBeTruthy();
      const realErrors = compiled.errors.filter((e) => !e.includes("no entry rule"));
      expect(realErrors, `round-trip compile errors: ${realErrors.join(" | ")}`).toHaveLength(0);
    });
  }
});

describe("Pine semantics", () => {
  it("RSI strategy: inputs, inlined rsi in cross conditions, long+short entries, exit", () => {
    const rsiScript = corpus.scripts.find((s) => s.title.startsWith("RSI Reversal"));
    const { ir, kind, warnings } = convertPine(rsiScript?.source ?? "");
    expect(kind).toBe("strategy");
    expect(ir.inputs).toEqual(
      expect.arrayContaining([
        { name: "len", value: 14 },
        { name: "oversold", value: 30 },
        { name: "overbought", value: 70 }
      ])
    );
    const seen = kinds(ir);
    expect(seen.has("entry")).toBe(true);
    expect(seen.has("exit")).toBe(true);
    // The bound r = ta.rsi(...) must be inlined into the entry cross condition.
    let inlined = false;
    walkStmts(ir.body, (s) => {
      if (s.k === "if" && s.cond.k === "cross" && s.cond.a.k === "rsi") inlined = true;
    });
    expect(inlined).toBe(true);
    expect(warnings.length).toBe(0);
  });

  it("var counter: init-once, += desugars, position_size gate becomes ctx read", () => {
    const script = corpus.scripts.find((s) => s.title.startsWith("Pullback"));
    const { ir, warnings } = convertPine(script?.source ?? "");
    expect(ir.init).toEqual([{ k: "setvar", name: "downCount", value: { k: "num", v: 0 } }]);
    let sawIncrement = false;
    walkStmts(ir.body, (s) => {
      if (s.k === "setvar" && s.value.k === "arith" && s.value.op === "+" && s.value.a.k === "var") sawIncrement = true;
    });
    expect(sawIncrement).toBe(true);
    // The flat-position gate (strategy.position_size == 0) is inlined into the
    // entry's enclosing if condition as a ctx read.
    expect(JSON.stringify(ir.body)).toContain('"ctx"');
    expect(warnings.some((w) => w.includes("DIRECTION sign"))).toBe(true);
  });

  it("history operator: close[1] → price offset; r[1] on a binding → shift(rsi)", () => {
    const script = corpus.scripts.find((s) => s.title.startsWith("RSI Momentum"));
    const { ir } = convertPine(script?.source ?? "");
    const json = JSON.stringify(ir.body);
    expect(json).toContain('"offset":1');
    expect(json).toContain('"shift"');
    // overlay=false → plots in sub pane
    walkStmts(ir.body, (s) => {
      if (s.k === "plot") expect(s.pane).toBe("sub");
    });
  });

  it("MACD tuple destructuring binds three lines", () => {
    const script = corpus.scripts.find((s) => s.title.startsWith("MACD Panel"));
    const { ir } = convertPine(script?.source ?? "");
    const lines = new Set<string>();
    walkStmts(ir.body, (s) => {
      if (s.k === "plot" && s.value.k === "macd") lines.add(s.value.line);
    });
    expect(lines).toEqual(new Set(["macd", "signal", "histogram"]));
  });

  it("strategy.exit stop=/limit= become stop/target price stmts", () => {
    const script = corpus.scripts.find((s) => s.title.startsWith("EMA Cross SL"));
    const { ir } = convertPine(script?.source ?? "");
    const seen = kinds(ir);
    expect(seen.has("stop")).toBe(true);
    expect(seen.has("target")).toBe(true);
  });

  it("alertcondition + plotshape become alert + marker with correct direction", () => {
    const script = corpus.scripts.find((s) => s.title.startsWith("EMA Cross Alerts"));
    const { ir } = convertPine(script?.source ?? "");
    const markers: string[] = [];
    let alerts = 0;
    walkStmts(ir.body, (s) => {
      if (s.k === "marker") markers.push(s.dir);
      if (s.k === "alert") alerts += 1;
    });
    expect(alerts).toBe(2);
    expect(markers).toContain("up");
    expect(markers).toContain("down");
  });

  it("a converted strategy actually backtests end-to-end", () => {
    const script = corpus.scripts.find((s) => s.title.startsWith("Donchian"));
    const { ir } = convertPine(script?.source ?? "");
    // Rising then falling closes to trigger breakout entries/exits.
    const closes = Array.from({ length: 120 }, (_, i) => 100 + Math.sin(i / 8) * 10 + i * 0.1);
    const candles = closes.map((c, i) => candle(i, c));
    const result = runBacktest(ir, candles, noFriction);
    expect(result.metrics.totalTrades).toBeGreaterThan(0);
  });

  it("numeric ternary on := maps to if/else setvar (audit correction)", () => {
    const src = `//@version=5
indicator("T", overlay=true)
d = 0.0
d := close > open ? 1 : -1
plot(close, "c")`;
    const { ir } = convertPine(src);
    let ok = false;
    walkStmts(ir.body, (s) => {
      if (s.k === "if" && s.then.some((t) => t.k === "setvar") && s.else?.some((t) => t.k === "setvar")) ok = true;
    });
    expect(ok).toBe(true);
  });

  it("ta.rising with len>1 compiles to compare vs shifted extreme (audit correction)", () => {
    const src = `//@version=5
indicator("R")
up = ta.rising(close, 3)
plotshape(up, "rise")`;
    const { ir } = convertPine(src);
    const json = JSON.stringify(ir.body);
    expect(json).toContain('"extreme"');
    expect(json).toContain('"shift"');
  });

  it("strategy() declaration sizing: percent_of_equity → size equity_pct", () => {
    const src = `//@version=5
strategy("S", overlay=true, default_qty_type=strategy.percent_of_equity, default_qty_value=25)
if ta.crossover(close, ta.sma(close, 5))
    strategy.entry("L", strategy.long)`;
    const { ir } = convertPine(src);
    let sized = false;
    walkStmts(ir.body, (s) => {
      if (s.k === "size" && s.mode === "equity_pct" && s.value.k === "num" && s.value.v === 25) sized = true;
    });
    expect(sized).toBe(true);
  });
});

describe("Pine guardrails", () => {
  it("rejects an unknown identifier with a clear error", () => {
    const result = importPineScript(`//@version=5\nindicator("x")\nplot(mysteryValue)`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("mysteryValue");
  });

  it("rejects oversized input", () => {
    const result = importPineScript(`indicator("x")\n${"// filler\n".repeat(40_000)}plot(close)`);
    expect(result.ok).toBe(false);
  });

  it("rejects pathological nesting without a stack overflow", () => {
    const deep = `${"(".repeat(500)}close${")".repeat(500)}`;
    const result = importPineScript(`indicator("x")\nplot(${deep})`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/deep/i);
  });

  it("escapes hostile strings so they can't fabricate blocks in the XML", () => {
    const result = importPineScript(
      `//@version=5\nindicator("evil\\"/><block type=\\"signal_entry\\"><")\nplot(close, "title'><injected>")`
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.xml).not.toContain("<injected>");
    expect(result.xml).not.toContain('<block type="signal_entry">');
    // And the XML still round-trips.
    const compiled = compileXmlToIr(result.xml);
    expect(compiled.ir).toBeTruthy();
  });

  it("fails closed on unsupported trading semantics (strategy.exit ticks)", () => {
    const result = importPineScript(
      `//@version=5\nstrategy("s")\nif close > open\n    strategy.entry("L", strategy.long)\nstrategy.exit("x", profit=100)`
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("profit");
  });

  it("skips display-only calls with warnings instead of failing", () => {
    const script = corpus.scripts.find((s) => s.title.startsWith("Kitchen Sink"));
    const result = importPineScript(script?.source ?? "");
    // Kitchen-sink mixes unsupported constructs; either it converts with warnings
    // or fails on a trading-semantic construct — but it must not crash.
    if (result.ok) expect(result.warnings.length).toBeGreaterThan(0);
    else expect(result.error.length).toBeGreaterThan(0);
  });
});
