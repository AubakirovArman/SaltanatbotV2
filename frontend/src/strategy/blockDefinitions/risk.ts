export const riskBlocks = [
  {
    type: "risk_stop",
    message0: "stop-loss %1 %2",
    args0: [
      {
        type: "field_dropdown",
        name: "MODE",
        options: [
          ["percent", "percent"],
          ["price", "price"],
          ["ATR ×", "atr"]
        ]
      },
      { type: "input_value", name: "VALUE", check: "Number" }
    ],
    previousStatement: null,
    nextStatement: null,
    colour: "#c05f5f",
    tooltip: "Attach a stop-loss to new positions."
  },
  {
    type: "risk_target",
    message0: "take-profit %1 %2",
    args0: [
      {
        type: "field_dropdown",
        name: "MODE",
        options: [
          ["percent", "percent"],
          ["price", "price"],
          ["ATR ×", "atr"]
        ]
      },
      { type: "input_value", name: "VALUE", check: "Number" }
    ],
    previousStatement: null,
    nextStatement: null,
    colour: "#c05f5f",
    tooltip: "Attach a take-profit to new positions."
  },
  {
    type: "risk_trailing",
    message0: "trailing stop %1 %2",
    args0: [
      {
        type: "field_dropdown",
        name: "MODE",
        options: [
          ["percent", "percent"],
          ["ATR ×", "atr"]
        ]
      },
      { type: "input_value", name: "VALUE", check: "Number" }
    ],
    previousStatement: null,
    nextStatement: null,
    colour: "#c05f5f",
    tooltip: "Stop that follows price: locks in profit as the trade moves."
  },
  {
    type: "position_size",
    message0: "size %1 %2",
    args0: [
      {
        type: "field_dropdown",
        name: "MODE",
        options: [
          ["% of equity", "equity_pct"],
          ["units", "units"],
          ["% risk", "risk_pct"]
        ]
      },
      { type: "input_value", name: "VALUE", check: "Number" }
    ],
    previousStatement: null,
    nextStatement: null,
    colour: "#c05f5f",
    tooltip: "Set how large each position is."
  }
];
