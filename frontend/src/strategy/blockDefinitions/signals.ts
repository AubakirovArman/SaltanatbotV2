export const signalsBlocks = [
  {
    type: "signal_marker",
    message0: "mark %1 %2 when %3",
    args0: [
      {
        type: "field_dropdown",
        name: "DIR",
        options: [
          ["▲ up", "up"],
          ["▼ down", "down"]
        ]
      },
      { type: "field_input", name: "LABEL", text: "" },
      { type: "input_value", name: "WHEN", check: "Boolean" }
    ],
    previousStatement: null,
    nextStatement: null,
    colour: "#bd58a4",
    tooltip: "Draw an arrow signal on the chart when the condition fires (no trade)."
  },
  {
    type: "signal_entry",
    message0: "enter %1 when %2",
    args0: [
      {
        type: "field_dropdown",
        name: "DIRECTION",
        options: [
          ["long", "long"],
          ["short", "short"]
        ]
      },
      { type: "input_value", name: "WHEN", check: "Boolean" }
    ],
    previousStatement: null,
    nextStatement: null,
    colour: "#bd58a4",
    tooltip: "Open a position in a direction when the condition is true."
  },
  {
    type: "signal_exit",
    message0: "exit when %1",
    args0: [{ type: "input_value", name: "WHEN", check: "Boolean" }],
    previousStatement: null,
    nextStatement: null,
    colour: "#bd58a4",
    tooltip: "Close the open position when the condition is true."
  },
  {
    type: "trade_action",
    message0: "%1 when %2",
    args0: [
      {
        type: "field_dropdown",
        name: "ACTION",
        options: [
          ["buy", "buy"],
          ["sell", "sell"],
          ["exit", "exit"],
          ["alert", "alert"]
        ]
      },
      { type: "input_value", name: "WHEN", check: "Boolean" }
    ],
    previousStatement: null,
    nextStatement: null,
    colour: "#bd58a4",
    tooltip: "Legacy action block (buy/sell/exit/alert)."
  }
];
