export const logicBlocks = [
  {
    type: "cross_event",
    message0: "%1 crosses %2 %3",
    args0: [
      { type: "input_value", name: "A", check: "Number" },
      {
        type: "field_dropdown",
        name: "DIRECTION",
        options: [
          ["above", "above"],
          ["below", "below"]
        ]
      },
      { type: "input_value", name: "B", check: "Number" }
    ],
    output: "Boolean",
    colour: "#b28f36",
    tooltip: "Detect a cross between two series."
  },
  {
    type: "value_between",
    message0: "%1 between %2 and %3",
    args0: [
      { type: "input_value", name: "VALUE", check: "Number" },
      { type: "input_value", name: "LOW", check: "Number" },
      { type: "input_value", name: "HIGH", check: "Number" }
    ],
    output: "Boolean",
    colour: "#b28f36",
    tooltip: "True when a value is inside a range."
  },
  {
    // Explicit definition (Blockly's built-in uses a %{BKY_…} message that needs
    // the message locale loaded; ours is self-contained so the round-trip works headless).
    type: "logic_negate",
    message0: "not %1",
    args0: [{ type: "input_value", name: "BOOL", check: "Boolean" }],
    output: "Boolean",
    colour: "#b28f36",
    tooltip: "True when the inner condition is false."
  },
  {
    type: "logic_isna",
    message0: "%1 is na",
    args0: [{ type: "input_value", name: "A", check: "Number" }],
    output: "Boolean",
    colour: "#b28f36",
    tooltip: "True when a value is NaN / undefined (na)."
  }
];
