import { describe, expect, it } from "vitest";
import { parseStrategyIR } from "../src/trading/strategy/irSchema.js";

/**
 * Deploy-time parity guard for the Pine v6 IR expansion. The frontend converter can
 * now emit cond/nz/cum/barssince/varprev/histn/for/isna, the rma moving-average, and
 * the broadened unary ops. POST /bots runs the IR through parseStrategyIR, so the
 * backend whitelist MUST accept exactly those shapes — otherwise a strategy that
 * converts and backtests in the browser would be rejected the moment it's deployed.
 */

const ir = {
  name: "v6-nodes",
  inputs: [{ name: "len", value: 14 }],
  v: 2,
  init: [{ k: "setvar", name: "acc", value: { k: "arith", op: "/", a: { k: "num", v: 0 }, b: { k: "num", v: 0 } } }],
  body: [
    { k: "setvar", name: "acc", value: { k: "nz", a: { k: "varprev", name: "acc" }, b: { k: "num", v: 0 } } },
    {
      k: "for",
      var: "i",
      from: { k: "num", v: 0 },
      to: { k: "input", name: "len" },
      step: { k: "num", v: 1 },
      cap: 10_000,
      body: [
        {
          k: "setvar",
          name: "acc",
          value: {
            k: "arith",
            op: "+",
            a: { k: "var", name: "acc" },
            b: { k: "histn", field: "close", offset: { k: "var", name: "i" } }
          }
        }
      ]
    },
    { k: "plot", value: { k: "ma", kind: "rma", period: { k: "num", v: 14 }, source: { k: "price", field: "close" } }, label: "rma", color: "#fff" },
    { k: "plot", value: { k: "cum", src: { k: "price", field: "volume" } }, label: "cum", color: "#fff" },
    { k: "plot", value: { k: "barssince", cond: { k: "isna", a: { k: "var", name: "acc" } } }, label: "bs", color: "#fff" },
    {
      k: "plot",
      value: {
        k: "cond",
        cond: { k: "compare", op: ">", a: { k: "var", name: "acc" }, b: { k: "num", v: 0 } },
        a: { k: "num", v: 1 },
        b: { k: "unary", op: "sign", a: { k: "var", name: "acc" } }
      },
      label: "c",
      color: "#fff"
    }
  ]
};

const drawingIr = {
  name: "drawings",
  inputs: [],
  v: 2,
  body: [
    { k: "box", top: { k: "price", field: "high" }, bottom: { k: "price", field: "low" }, when: { k: "bool", v: true }, label: "zone", color: "#26a69a" },
    { k: "vline", when: { k: "bool", v: true }, label: "", color: "#8f9bb3" },
    { k: "ray", price: { k: "num", v: 100 }, when: { k: "bool", v: true }, label: "R", color: "#f7c948" }
  ]
};

describe("backend schema accepts Pine v6 IR nodes", () => {
  it("accepts display-only drawing statements (box/vline/ray)", () => {
    const result = parseStrategyIR(drawingIr);
    expect(result.ok, result.ok ? "" : (result as { error: string }).error).toBe(true);
  });

  it("parses cond/nz/cum/barssince/varprev/histn/for/isna/rma/sign", () => {
    const result = parseStrategyIR(ir);
    expect(result.ok, result.ok ? "" : (result as { error: string }).error).toBe(true);
  });

  it("still rejects an unknown node kind (whitelist stays closed)", () => {
    const bad = { ...ir, body: [{ k: "teleport", value: 1 }] };
    expect(parseStrategyIR(bad).ok).toBe(false);
  });
});
