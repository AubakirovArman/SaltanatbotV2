export const flowBlocks = [
  {
    type: "flow_if",
    message0: "if %1 do %2",
    args0: [
      { type: "input_value", name: "COND", check: "Boolean" },
      { type: "input_statement", name: "DO" }
    ],
    previousStatement: null,
    nextStatement: null,
    colour: "#bd58a4",
    tooltip: "Run inner blocks only when the condition is true."
  },
  {
    type: "for_range",
    message0: "for %1 from %2 to %3 by %4 do %5",
    args0: [
      { type: "field_input", name: "NAME", text: "i" },
      { type: "input_value", name: "FROM", check: "Number" },
      { type: "input_value", name: "TO", check: "Number" },
      { type: "input_value", name: "BY", check: "Number" },
      { type: "input_statement", name: "DO" }
    ],
    previousStatement: null,
    nextStatement: null,
    colour: "#bd58a4",
    tooltip: "Counted loop: run inner blocks for each value of the counter (bounded)."
  }
];
