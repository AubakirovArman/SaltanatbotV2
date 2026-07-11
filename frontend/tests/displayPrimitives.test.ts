import { describe, expect, it } from "vitest";
import { compileXmlToIr } from "../src/strategy/compileArtifact";
import { previewStrategy } from "../src/strategy/backtest";
import type { StrategyIR } from "../src/strategy/ir";
import { irToBlocklyXml } from "../src/strategy/irToXml";

const ir: StrategyIR = {
  v: 4,
  name: "Display primitives",
  inputs: [],
  body: [
    {
      k: "projection",
      left: { k: "time" },
      right: { k: "arith", op: "+", a: { k: "time" }, b: { k: "num", v: 120_000 } },
      top: { k: "price", field: "high" },
      bottom: { k: "price", field: "low" },
      when: { k: "bool", v: true },
      label: "Forecast",
      color: "#4db6ff"
    },
    {
      k: "metric",
      table: "Statistics",
      column: "Current",
      label: "Close",
      value: { k: "price", field: "close" },
      when: { k: "bool", v: true }
    },
    {
      k: "marker",
      dir: "up",
      label: "Preview",
      when: { k: "bool", v: false }
    }
  ]
};

describe("display-only IR primitives", () => {
  it("round-trips through Blockly and previews projection/table data", () => {
    const compiled = compileXmlToIr(irToBlocklyXml(ir));
    expect(compiled.errors).toEqual([]);
    expect(compiled.ir?.body.map((stmt) => stmt.k)).toEqual(["projection", "metric", "marker"]);

    const candles = [100, 105].map((close, index) => ({
      time: index * 60_000,
      open: close,
      high: close + 2,
      low: close - 2,
      close,
      volume: 100
    }));
    const preview = previewStrategy(compiled.ir as StrategyIR, candles);
    expect(preview.shapes.boxes.at(-1)).toMatchObject({ t1: 60_000, t2: 180_000, label: "Forecast" });
    expect(preview.tables).toEqual([{ id: "Statistics", columns: ["Current"], rows: [{ label: "Close", values: [105] }] }]);
  });
});
