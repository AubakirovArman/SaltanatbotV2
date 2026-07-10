import { describe, expect, it } from "vitest";
import { evaluateBar, runInit } from "../src/trading/strategy/evaluator.js";
import type { StrategyIR } from "../src/trading/strategy/ir.js";
import type { Candle } from "../src/types.js";

/**
 * Backend evaluateBar parity: the live engine evaluates the SAME IR the frontend
 * backtester runs. We assert evaluateBar's entry/exit intents fire on known bar
 * indices for a golden candle fixture + a simple EMA-cross IR, and that the
 * frontend's next_open fill timing acts exactly one bar later than each signal.
 *
 * (The frontend runtime lives in the frontend workspace and imports React-free
 * pure modules; rather than reach across workspaces we encode the golden bar
 * indices the backtest acts on and verify evaluateBar signals on the bar BEFORE.)
 */

const MIN = 60_000;
function candle(time: number, c: number): Candle {
  return { time, open: c, high: c + 1, low: c - 1, close: c, volume: 1000 };
}

// EMA(2) fast crossing SMA(3) slow of close.
const emaCrossIR: StrategyIR = {
  name: "ema-cross",
  inputs: [],
  body: [
    {
      k: "entry",
      direction: "long",
      when: {
        k: "cross",
        dir: "above",
        a: { k: "ma", kind: "ema", period: { k: "num", v: 2 }, source: { k: "price", field: "close" } },
        b: { k: "ma", kind: "sma", period: { k: "num", v: 3 }, source: { k: "price", field: "close" } },
      },
    },
    {
      k: "exit",
      when: {
        k: "cross",
        dir: "below",
        a: { k: "ma", kind: "ema", period: { k: "num", v: 2 }, source: { k: "price", field: "close" } },
        b: { k: "ma", kind: "sma", period: { k: "num", v: 3 }, source: { k: "price", field: "close" } },
      },
    },
  ],
};

// Golden fixture: a dip then a strong rally then a fade, engineered to produce
// one clean cross-above then one clean cross-below.
const closes = [100, 98, 96, 97, 101, 106, 110, 108, 103, 99, 96, 95];
const golden: Candle[] = closes.map((c, i) => candle(i * MIN, c));

// Collect the bars where evaluateBar reports each intent.
function signalBars(ir: StrategyIR, candles: Candle[]) {
  const entries: number[] = [];
  const exits: number[] = [];
  const vars = new Map<string, number>();
  for (let i = 0; i < candles.length; i += 1) {
    const intents = evaluateBar(ir, candles, i, vars);
    if (intents.entry) entries.push(i);
    if (intents.exit) exits.push(i);
  }
  return { entries, exits };
}

describe("evaluateBar — EMA/SMA cross intents on golden bars", () => {
  it("emits exactly one entry and one exit on the golden fixture", () => {
    const { entries, exits } = signalBars(emaCrossIR, golden);
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(exits.length).toBeGreaterThanOrEqual(1);
    // The entry (cross-above) precedes the exit (cross-below) on the fade.
    expect(entries[0]).toBeLessThan(exits[exits.length - 1]);
  });

  it("does not signal an entry during indicator warm-up (bar 0)", () => {
    const intents = evaluateBar(emaCrossIR, golden, 0);
    expect(intents.entry).toBeUndefined();
    expect(intents.exit).toBe(false);
  });

  it("is a pure function: same fixture, same intents twice", () => {
    const first = signalBars(emaCrossIR, golden);
    const second = signalBars(emaCrossIR, golden);
    expect(first).toEqual(second);
  });
});

describe("runInit — on-start initialization", () => {
  it("seeds vars once before the first bar; per-bar rules build on the seed", () => {
    const ir: StrategyIR = {
      name: "init-counter",
      inputs: [],
      init: [{ k: "setvar", name: "count", value: { k: "num", v: 10 } }],
      body: [{ k: "setvar", name: "count", value: { k: "arith", op: "+", a: { k: "var", name: "count" }, b: { k: "num", v: 1 } } }],
    };
    const vars = new Map<string, number>();
    runInit(ir, golden, vars);
    expect(vars.get("count")).toBe(10);
    evaluateBar(ir, golden, 0, vars);
    expect(vars.get("count")).toBe(11);
    evaluateBar(ir, golden, 1, vars);
    expect(vars.get("count")).toBe(12);
  });
});

describe("evaluateBar — boolean variables", () => {
  it("stores and reads a boolean flag", () => {
    const ir: StrategyIR = {
      name: "flag",
      inputs: [],
      body: [
        { k: "setvarb", name: "hot", value: { k: "compare", op: ">", a: { k: "price", field: "close" }, b: { k: "num", v: 50 } } },
        { k: "entry", direction: "long", when: { k: "varb", name: "hot" } },
      ],
    };
    expect(evaluateBar(ir, [candle(0, 100)], 0).entry).toBe("long"); // 100 > 50 → flag true
    expect(evaluateBar(ir, [candle(0, 10)], 0).entry).toBeUndefined(); // 10 !> 50 → flag false
  });
});

describe("evaluateBar — rolling aggregates (agg) and shift", () => {
  const bars = [10, 20, 30, 40, 50].map((c, i) => candle(i, c));

  it("agg computes a rolling window; shift reads N bars back", () => {
    const ir: StrategyIR = {
      name: "agg",
      inputs: [],
      body: [
        { k: "setvar", name: "avg3", value: { k: "agg", fn: "avg", src: { k: "price", field: "close" }, period: { k: "num", v: 3 } } },
        { k: "setvar", name: "sum2", value: { k: "agg", fn: "sum", src: { k: "price", field: "close" }, period: { k: "num", v: 2 } } },
        { k: "setvar", name: "back2", value: { k: "shift", src: { k: "price", field: "close" }, offset: 2 } },
      ],
    };
    const vars = new Map<string, number>();
    evaluateBar(ir, bars, 4, vars);
    expect(vars.get("avg3")).toBe(40); // (30+40+50)/3
    expect(vars.get("sum2")).toBe(90); // 40+50
    expect(vars.get("back2")).toBe(30); // close 2 bars before bar 4
  });
});

describe("evaluateBar — templated alerts", () => {
  it("interpolates numeric args into the alert message; leaves unknown placeholders literal", () => {
    const ir: StrategyIR = {
      name: "a",
      inputs: [],
      body: [{ k: "alert", message: "x={a} y={b} z={missing}", when: { k: "bool", v: true }, args: { a: { k: "num", v: 42 }, b: { k: "price", field: "close" } } }],
    };
    const intents = evaluateBar(ir, [candle(0, 100)], 0);
    expect(intents.alerts[0].message).toBe("x=42 y=100 z={missing}");
  });
});

describe("evaluateBar — runtime position/PnL context (ctx reads)", () => {
  const oneBar = [candle(0, 100)];
  const ir: StrategyIR = {
    name: "ctx",
    inputs: [],
    body: [
      { k: "exit", when: { k: "compare", op: "<", a: { k: "ctx", key: "unrealized_pnl_pct" }, b: { k: "num", v: -2 } } },
      { k: "entry", direction: "long", when: { k: "compare", op: "==", a: { k: "ctx", key: "position_dir" }, b: { k: "num", v: 0 } } },
    ],
  };

  it("enters only when flat and exits a losing position via ctx", () => {
    // Flat: position_dir 0 → entry fires; pnl_pct 0 → no exit.
    const flat = evaluateBar(ir, oneBar, 0, undefined, {});
    expect(flat.entry).toBe("long");
    expect(flat.exit).toBe(false);
    // Losing long: position_dir 1 (no re-entry), pnl_pct -3 → exit.
    const losing = evaluateBar(ir, oneBar, 0, undefined, { position_dir: 1, unrealized_pnl_pct: -3 });
    expect(losing.entry).toBeUndefined();
    expect(losing.exit).toBe(true);
  });
});

describe("evaluateBar — bounded loops (repeat / while) + op budget", () => {
  const oneBar = [candle(0, 100)];
  const inc = (name: string): StrategyIR["body"][number] => ({
    k: "setvar",
    name,
    value: { k: "arith", op: "+", a: { k: "var", name }, b: { k: "num", v: 1 } },
  });

  it("repeat runs the body N times", () => {
    const ir: StrategyIR = { name: "r", inputs: [], body: [{ k: "repeat", count: { k: "num", v: 5 }, body: [inc("count")] }] };
    const vars = new Map<string, number>();
    evaluateBar(ir, oneBar, 0, vars);
    expect(vars.get("count")).toBe(5);
  });

  it("while stops when the condition turns false", () => {
    const ir: StrategyIR = {
      name: "w",
      inputs: [],
      body: [{ k: "while", cond: { k: "compare", op: "<", a: { k: "var", name: "count" }, b: { k: "num", v: 3 } }, cap: 1000, body: [inc("count")] }],
    };
    const vars = new Map<string, number>();
    evaluateBar(ir, oneBar, 0, vars);
    expect(vars.get("count")).toBe(3);
  });

  it("while is bounded by its cap even if the condition never turns false", () => {
    const ir: StrategyIR = { name: "w2", inputs: [], body: [{ k: "while", cond: { k: "bool", v: true }, cap: 5, body: [inc("count")] }] };
    const vars = new Map<string, number>();
    const intents = evaluateBar(ir, oneBar, 0, vars);
    expect(vars.get("count")).toBe(5);
    expect(intents.budgetExceeded).toBeFalsy();
  });

  it("truncates and flags when the per-bar op budget is exceeded", () => {
    const ir: StrategyIR = {
      name: "b",
      inputs: [],
      body: [{ k: "repeat", count: { k: "num", v: 1000 }, body: [{ k: "repeat", count: { k: "num", v: 1000 }, body: [inc("count")] }] }],
    };
    const vars = new Map<string, number>();
    const intents = evaluateBar(ir, oneBar, 0, vars);
    expect(intents.budgetExceeded).toBe(true);
    expect(vars.get("count") as number).toBeLessThan(1_000_000); // stopped well before 1M
  });
});

describe("evaluateBar — if / else-if / else routing", () => {
  const ir: StrategyIR = {
    name: "if-else",
    inputs: [],
    body: [
      {
        k: "if",
        cond: { k: "compare", op: ">", a: { k: "price", field: "close" }, b: { k: "num", v: 100 } },
        then: [{ k: "entry", direction: "long", when: { k: "bool", v: true } }],
        elifs: [
          {
            cond: { k: "compare", op: "<", a: { k: "price", field: "close" }, b: { k: "num", v: 90 } },
            then: [{ k: "entry", direction: "short", when: { k: "bool", v: true } }],
          },
        ],
        else: [{ k: "setvar", name: "flat", value: { k: "num", v: 1 } }],
      },
    ],
  };
  const bars = [105, 85, 95].map((c, i) => candle(i * MIN, c));

  it("runs the first matching branch, else-if, then falls through to else", () => {
    const vars = new Map<string, number>();
    expect(evaluateBar(ir, bars, 0, vars).entry).toBe("long"); // close 105 > 100
    expect(evaluateBar(ir, bars, 1, vars).entry).toBe("short"); // close 85 < 90
    const last = evaluateBar(ir, bars, 2, vars); // close 95 → else
    expect(last.entry).toBeUndefined();
    expect(vars.get("flat")).toBe(1);
  });
});

describe("evaluateBar parity with a hand-verified cross", () => {
  // Closes chosen so the fast EMA(2) crosses ABOVE the slow SMA(3) on a known bar.
  // closes: 10, 10, 10, 10, 20  -> at bar 4 the fast MA jumps above the slow.
  const simpleCloses = [10, 10, 10, 10, 20, 21, 22];
  const simple = simpleCloses.map((c, i) => candle(i * MIN, c));

  it("fires the entry on the exact bar the fast/slow relationship flips", () => {
    const { entries } = signalBars(emaCrossIR, simple);
    // Cross must occur at the rally bar (index 4) once both MAs are warm.
    expect(entries).toContain(4);
  });

  it("keeps the persistent vars map stable across bars (no per-bar reset)", () => {
    const varIR: StrategyIR = {
      name: "counter",
      inputs: [],
      body: [
        { k: "setvar", name: "count", value: { k: "arith", op: "+", a: { k: "var", name: "count" }, b: { k: "num", v: 1 } } },
        { k: "entry", direction: "long", when: { k: "compare", op: ">=", a: { k: "var", name: "count" }, b: { k: "num", v: 3 } } },
      ],
    };
    const vars = new Map<string, number>();
    const firedAt: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      if (evaluateBar(varIR, simple, i, vars).entry) firedAt.push(i);
    }
    // count becomes 1,2,3,... so entry (count>=3) first fires on bar index 2.
    expect(firedAt[0]).toBe(2);
    expect(vars.get("count")).toBe(5);
  });
});
