import { describe, expect, it } from "vitest";
import {
  allCustomBlockDefinitions,
  coreBlocks,
  flowBlocks,
  indicatorsBlocks,
  logicBlocks,
  marketBlocks,
  mathBlocks,
  positionBlocks,
  riskBlocks,
  signalsBlocks,
  stateBlocks,
  timeBlocks
} from "../src/strategy/blockDefinitions";

const categories = { coreBlocks, marketBlocks, indicatorsBlocks, mathBlocks, positionBlocks, logicBlocks, timeBlocks, signalsBlocks, riskBlocks, stateBlocks, flowBlocks };

describe("modular Blockly definitions", () => {
  it("keeps every custom block type globally unique and assigned to one category", () => {
    const types = allCustomBlockDefinitions.map((definition) => definition.type);
    expect(new Set(types).size).toBe(types.length);
    expect(Object.values(categories).flat()).toHaveLength(types.length);
    for (const definitions of Object.values(categories)) expect(definitions.length).toBeGreaterThan(0);
  });

  it("keeps named fields and inputs unique within each message row", () => {
    for (const definition of allCustomBlockDefinitions) {
      for (const [key, value] of Object.entries(definition)) {
        if (!/^args\d+$/.test(key) || !Array.isArray(value)) continue;
        const names = value.map((argument) => argument.name).filter((name): name is string => typeof name === "string");
        expect(new Set(names).size, `${definition.type}.${key} has duplicate input names`).toBe(names.length);
      }
    }
  });
});
