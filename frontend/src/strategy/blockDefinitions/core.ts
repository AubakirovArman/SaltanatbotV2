export const coreBlocks = [
  {
    type: "strategy_start",
    message0: "strategy %1",
    args0: [{ type: "field_input", name: "NAME", text: "Momentum Breakout" }],
    message1: "on start (once)",
    message2: "%1",
    args2: [{ type: "input_statement", name: "INIT" }],
    message3: "rules",
    message4: "%1",
    args4: [{ type: "input_statement", name: "RULES" }],
    colour: "#5f7285",
    tooltip: "Entry point. 'On start' runs once at bot start (set initial variables); 'rules' run every bar."
  }
];
