export const positionBlocks = [
  {
    type: "ctx_read",
    message0: "position %1",
    args0: [
      {
        type: "field_dropdown",
        name: "FIELD",
        options: [
          ["direction (+1/-1/0)", "position_dir"],
          ["entry price", "entry_price"],
          ["unrealized PnL", "unrealized_pnl"],
          ["unrealized PnL %", "unrealized_pnl_pct"],
          ["bars in trade", "bars_in_position"],
          ["last trade PnL", "last_trade_pnl"],
          ["consecutive losses", "consecutive_losses"],
          ["trades today", "trades_today"],
          ["realized PnL today", "realized_today"],
          ["account equity", "equity"]
        ]
      }
    ],
    output: "Number",
    colour: "#3d9970",
    tooltip: "Read the current position / PnL state (0 when flat)."
  },
  {
    type: "position_is",
    message0: "position is %1",
    args0: [
      {
        type: "field_dropdown",
        name: "STATE",
        options: [
          ["long", "long"],
          ["short", "short"],
          ["flat", "flat"]
        ]
      }
    ],
    output: "Boolean",
    colour: "#3d9970",
    tooltip: "True when the current position matches long / short / flat."
  }
];
