// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { compileXmlToIr } from "../src/strategy/compileArtifact";

describe("Blockly compile diagnostics", () => {
  it("links validation failures to exact block ids and types", () => {
    const result = compileXmlToIr('<xml><block type="strategy_start" id="root"><field name="NAME">Invalid</field><statement name="RULES"><block type="plot_series" id="plot"><field name="LABEL">x</field></block></statement></block></xml>');
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ severity: "error", blockId: "root", blockType: "strategy_start", message: expect.stringContaining("no entry rule") })
    ]));
  });

  it("carries complete parameter schemas into canonical IR", () => {
    const xml = '<xml><block type="strategy_start" id="root"><field name="NAME">Params</field><statement name="RULES"><block type="signal_marker"><field name="DIR">up</field><value name="WHEN"><block type="logic_compare"><field name="OP">GT</field><value name="A"><block type="param_number"><field name="NAME">length</field><field name="VALUE">14</field><field name="MIN">2</field><field name="MAX">100</field><field name="STEP">2</field><field name="OPTIMIZE">TRUE</field></block></value><value name="B"><block type="math_number"><field name="NUM">0</field></block></value></block></value></block></statement></block></xml>';
    expect(compileXmlToIr(xml).ir?.inputs).toEqual([{ name: "length", value: 14, defaultValue: 14, min: 2, max: 100, step: 2, optimizationEligible: true }]);
  });

  it("inlines reusable value subgraphs with numeric function parameters", () => {
    const xml = `<xml>
      <variables><variable id="arg-id">value</variable></variables>
      <block type="procedures_defreturn" id="def" x="20" y="200">
        <mutation><arg name="value" varid="arg-id"></arg></mutation><field name="NAME">double</field>
        <value name="RETURN"><block type="math_arithmetic"><field name="OP">ADD</field><value name="A"><block type="variables_get"><field name="VAR" id="arg-id" variabletype="">value</field></block></value><value name="B"><block type="variables_get"><field name="VAR" id="arg-id" variabletype="">value</field></block></value></block></value>
      </block>
      <block type="strategy_start" id="root" x="20" y="20"><field name="NAME">Functions</field><statement name="RULES"><block type="signal_marker"><field name="DIR">up</field><value name="WHEN"><block type="logic_compare"><field name="OP">GT</field><value name="A"><block type="procedures_callreturn"><mutation name="double"><arg name="value"></arg></mutation><value name="ARG0"><block type="math_number"><field name="NUM">3</field></block></value></block></value><value name="B"><block type="math_number"><field name="NUM">5</field></block></value></block></value></block></statement></block>
    </xml>`;
    const compiled = compileXmlToIr(xml);
    expect(compiled.errors).toEqual([]);
    expect(JSON.stringify(compiled.ir?.body)).toContain('"op":"+"');
    expect(JSON.stringify(compiled.ir?.body)).not.toContain("variables_get");
  });
});
