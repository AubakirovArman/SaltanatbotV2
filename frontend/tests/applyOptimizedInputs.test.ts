import * as Blockly from "blockly/core";
import { describe, expect, it } from "vitest";
import { applyOptimizedInputs } from "../src/strategy/applyOptimizedInputs";
import { registerStrategyBlocks } from "../src/strategy/blocks";

function parameterBlock(name: string, value: number, min: number, max: number, reject?: number) {
  const fields: Record<string, string> = { NAME: name, VALUE: String(value), MIN: String(min), MAX: String(max) };
  return {
    type: "param_number",
    getFieldValue: (field: string) => fields[field],
    setFieldValue: (next: string, field: string) => {
      if (field === "VALUE" && Number(next) === reject) throw new Error("field rejected");
      fields[field] = String(next);
    }
  };
}

describe("applyOptimizedInputs", () => {
  it("writes every matching Blockly input so compile/save paths see the assignment", () => {
    const first = parameterBlock("length", 14, 2, 100);
    const duplicate = parameterBlock("length", 14, 2, 100);
    const workspace = { getAllBlocks: () => [first, duplicate] } as never;

    expect(applyOptimizedInputs(workspace, { length: 21 })).toBe(2);
    expect(first.getFieldValue("VALUE")).toBe("21");
    expect(duplicate.getFieldValue("VALUE")).toBe("21");
  });

  it("fails before mutation for missing/out-of-bounds inputs and rolls back a rejected write", () => {
    const first = parameterBlock("length", 14, 2, 100);
    const rejecting = parameterBlock("length", 14, 2, 100, 21);
    const workspace = { getAllBlocks: () => [first, rejecting] } as never;

    expect(() => applyOptimizedInputs(workspace, { missing: 3 })).toThrow(/missing/);
    expect(() => applyOptimizedInputs(workspace, { length: 101 })).toThrow(/outside/);
    expect(() => applyOptimizedInputs(workspace, { length: 21 })).toThrow(/field rejected/);
    expect(first.getFieldValue("VALUE")).toBe("14");
    expect(rejecting.getFieldValue("VALUE")).toBe("14");
  });

  it("groups duplicate Blockly input updates into one undo transaction", async () => {
    registerStrategyBlocks();
    const workspace = new Blockly.Workspace();
    const first = workspace.newBlock("param_number");
    const duplicate = workspace.newBlock("param_number");
    first.setFieldValue("length", "NAME");
    duplicate.setFieldValue("length", "NAME");
    first.setFieldValue("14", "VALUE");
    duplicate.setFieldValue("14", "VALUE");
    workspace.clearUndo();

    expect(applyOptimizedInputs(workspace as never, { length: 21 })).toBe(2);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect([first, duplicate].map((block) => block.getFieldValue("VALUE"))).toEqual([21, 21]);
    workspace.undo(false);
    expect([first, duplicate].map((block) => block.getFieldValue("VALUE"))).toEqual([14, 14]);
    workspace.dispose();
  });
});
