import { describe, expect, it } from "vitest";
import { serializeBoolean } from "../src/strategy/blocklySerialization/boolean";
import type { BlocklySerializationContext } from "../src/strategy/blocklySerialization/context";
import { irToBlocklyXml } from "../src/strategy/blocklySerialization";
import { serializeNumeric } from "../src/strategy/blocklySerialization/numeric";
import { serializeStatements } from "../src/strategy/blocklySerialization/statement";
import { block, escapeXml, field } from "../src/strategy/blocklySerialization/xml";
import { compileXmlToIr } from "../src/strategy/compileArtifact";
import type { StrategyIR } from "../src/strategy/ir";

function context(defaults = new Map<string, number>()): BlocklySerializationContext {
  const ctx = {} as BlocklySerializationContext;
  Object.assign(ctx, {
    defaults,
    num: (expr: Parameters<BlocklySerializationContext["num"]>[0]) => serializeNumeric(expr, ctx),
    bool: (expr: Parameters<BlocklySerializationContext["bool"]>[0]) => serializeBoolean(expr, ctx),
    chain: (statements: Parameters<BlocklySerializationContext["chain"]>[0]) => serializeStatements(statements, ctx)
  });
  return ctx;
}

describe("Blockly serialization", () => {
  it("escapes every XML-sensitive character in fields and block types", () => {
    expect(escapeXml(`<&>"'`)).toBe("&lt;&amp;&gt;&quot;&apos;");
    expect(field("N&", `<x>`)).toBe('<field name="N&amp;">&lt;x&gt;</field>');
    expect(block('x"', "")).toBe('<block type="x&quot;"></block>');
  });

  it("serializes numeric recursion with input defaults", () => {
    const ctx = context(new Map([["period", 21]]));
    expect(serializeNumeric({
      k: "ma",
      kind: "ema",
      period: { k: "input", name: "period" },
      source: { k: "price", field: "close" }
    }, ctx)).toContain('<field name="VALUE">21</field>');
  });

  it("expands any-direction crosses into an editable boolean OR", () => {
    const xml = serializeBoolean({
      k: "cross", dir: "any", a: { k: "price", field: "close" }, b: { k: "num", v: 100 }
    }, context());
    expect(xml).toContain('type="logic_operation"');
    expect(xml.match(/type="cross_event"/g)).toHaveLength(2);
  });

  it("chains statements and nested control flow with next links", () => {
    const xml = serializeStatements([
      { k: "setvar", name: "counter", value: { k: "num", v: 1 } },
      { k: "if", cond: { k: "bool", v: true }, then: [{ k: "alert", message: "go", when: { k: "bool", v: true } }] }
    ], context());
    expect(xml).toContain("<next>");
    expect(xml).toContain('type="controls_if"');
    expect(xml).toContain('<statement name="DO0">');
  });

  it("round-trips a representative editable strategy through Blockly", () => {
    const ir: StrategyIR = {
      v: 4,
      name: `A&B <strategy>`,
      inputs: [{ name: "period", value: 20 }],
      init: [{ k: "setvar", name: "counter", value: { k: "num", v: 0 } }],
      body: [
        { k: "size", mode: "equity_pct", value: { k: "num", v: 10 } },
        { k: "entry", direction: "long", when: {
          k: "cross", dir: "above",
          a: { k: "price", field: "close" },
          b: { k: "ma", kind: "ema", period: { k: "input", name: "period" }, source: { k: "price", field: "close" } }
        } },
        { k: "alert", message: `buy & verify`, when: { k: "bool", v: true } }
      ]
    };
    const xml = irToBlocklyXml(ir);
    expect(xml).toContain("A&amp;B &lt;strategy&gt;");
    expect(xml).toContain("buy &amp; verify");
    const compiled = compileXmlToIr(xml);
    expect(compiled.errors).toEqual([]);
    expect(compiled.ir?.name).toBe(ir.name);
    expect(compiled.ir?.body.map((statement) => statement.k)).toEqual(["size", "entry", "alert"]);
  });
});
