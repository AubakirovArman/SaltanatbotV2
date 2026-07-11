// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { compileXmlToIr } from "../src/strategy/compileArtifact";
import { buildWizardXml, DEFAULT_WIZARD_SPEC } from "../src/strategy/wizard";

describe("guided strategy wizard", () => {
  for (const signal of ["ema-cross", "rsi-threshold", "price-breakout"] as const) {
    it(`emits ordinary editable and compilable Blockly XML for ${signal}`, () => {
      const xml = buildWizardXml({ ...DEFAULT_WIZARD_SPEC, signal, name: `Wizard ${signal}` });
      expect(xml).toContain('type="strategy_start"');
      expect(xml).toContain('type="signal_entry"');
      const compiled = compileXmlToIr(xml);
      expect(compiled.errors).toEqual([]);
      expect(compiled.ir?.name).toBe(`Wizard ${signal}`);
      expect(compiled.ir?.body.map((statement) => statement.k)).toEqual(["entry", "stop", "target"]);
    });
  }
});
