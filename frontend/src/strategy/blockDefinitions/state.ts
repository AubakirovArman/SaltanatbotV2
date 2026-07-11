export const stateBlocks = [
  {
    type: "var_set",
    message0: "set %1 = %2",
    args0: [
      { type: "field_input", name: "NAME", text: "counter" },
      { type: "input_value", name: "VALUE", check: "Number" }
    ],
    previousStatement: null,
    nextStatement: null,
    colour: "#9469c9",
    tooltip: "Store a value in a named variable for this bar."
  },
  {
    type: "var_change",
    message0: "change %1 by %2",
    args0: [
      { type: "field_input", name: "NAME", text: "counter" },
      { type: "input_value", name: "BY", check: "Number" }
    ],
    previousStatement: null,
    nextStatement: null,
    colour: "#9469c9",
    tooltip: "Increment (or decrement) a stored variable by an amount."
  },
  {
    type: "var_get",
    message0: "var %1",
    args0: [{ type: "field_input", name: "NAME", text: "counter" }],
    output: "Number",
    colour: "#9469c9",
    tooltip: "Read a stored variable."
  },
  {
    type: "varb_set",
    message0: "set flag %1 = %2",
    args0: [
      { type: "field_input", name: "NAME", text: "inTrade" },
      { type: "input_value", name: "VALUE", check: "Boolean" }
    ],
    previousStatement: null,
    nextStatement: null,
    colour: "#9469c9",
    tooltip: "Store a true/false flag."
  },
  {
    type: "varb_get",
    message0: "flag %1",
    args0: [{ type: "field_input", name: "NAME", text: "inTrade" }],
    output: "Boolean",
    colour: "#9469c9",
    tooltip: "Read a stored true/false flag."
  },
  {
    type: "alert_message",
    message0: "alert %1 {a}=%2 {b}=%3 when %4",
    args0: [
      { type: "field_input", name: "TEXT", text: "signal" },
      { type: "input_value", name: "A", check: "Number" },
      { type: "input_value", name: "B", check: "Number" },
      { type: "input_value", name: "WHEN", check: "Boolean" }
    ],
    previousStatement: null,
    nextStatement: null,
    colour: "#9469c9",
    tooltip: 'Emit an alert when a condition fires. Use {a}/{b} in the text to insert the values (e.g. "RSI={a}").'
  },
  {
    type: "var_prev",
    message0: "var %1 (previous bar)",
    args0: [{ type: "field_input", name: "NAME", text: "counter" }],
    output: "Number",
    colour: "#9469c9",
    tooltip: "Read a stored variable's value from the previous bar (x[1])."
  }
];
