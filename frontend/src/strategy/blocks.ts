import * as Blockly from "blockly/core";
import "blockly/blocks";

let blocksRegistered = false;

const PRICE_FIELDS: [string, string][] = [
  ["close", "close"],
  ["open", "open"],
  ["high", "high"],
  ["low", "low"],
  ["volume", "volume"],
  ["hl2", "hl2"],
  ["hlc3", "hlc3"],
  ["ohlc4", "ohlc4"]
];

export function registerStrategyBlocks() {
  if (blocksRegistered) return;
  Blockly.defineBlocksWithJsonArray([
    {
      type: "strategy_start",
      message0: "strategy %1 on start (once) %2 rules %3",
      args0: [
        { type: "field_input", name: "NAME", text: "Momentum Breakout" },
        { type: "input_statement", name: "INIT" },
        { type: "input_statement", name: "RULES" }
      ],
      colour: "#5f7285",
      tooltip: "Entry point. 'On start' runs once at bot start (set initial variables); 'rules' run every bar."
    },
    // ---- Market ----
    {
      type: "market_price",
      message0: "market %1",
      args0: [{ type: "field_dropdown", name: "FIELD", options: PRICE_FIELDS }],
      output: "Number",
      colour: "#4285b4",
      tooltip: "Read a price field from the current bar."
    },
    {
      type: "market_price_offset",
      message0: "market %1 %2 bars ago",
      args0: [
        { type: "field_dropdown", name: "FIELD", options: PRICE_FIELDS },
        { type: "field_number", name: "BARS", value: 1, min: 0, precision: 1 }
      ],
      output: "Number",
      colour: "#4285b4",
      tooltip: "Read a price field from a past bar (offset)."
    },
    // ---- Indicators ----
    {
      type: "indicator_ma",
      message0: "%1 period %2 source %3",
      args0: [
        { type: "field_dropdown", name: "KIND", options: [["SMA", "sma"], ["EMA", "ema"], ["WMA", "wma"], ["VWMA", "vwma"]] },
        { type: "input_value", name: "PERIOD", check: "Number" },
        { type: "input_value", name: "SOURCE", check: "Number" }
      ],
      output: "Number",
      colour: "#2f9e77",
      tooltip: "Moving average."
    },
    {
      type: "indicator_rsi",
      message0: "RSI period %1 source %2",
      args0: [
        { type: "input_value", name: "PERIOD", check: "Number" },
        { type: "input_value", name: "SOURCE", check: "Number" }
      ],
      output: "Number",
      colour: "#2f9e77",
      tooltip: "Relative Strength Index."
    },
    {
      type: "indicator_bollinger",
      message0: "Bollinger %1 period %2 dev %3 source %4",
      args0: [
        { type: "field_dropdown", name: "BAND", options: [["upper", "upper"], ["middle", "middle"], ["lower", "lower"]] },
        { type: "input_value", name: "PERIOD", check: "Number" },
        { type: "input_value", name: "DEV", check: "Number" },
        { type: "input_value", name: "SOURCE", check: "Number" }
      ],
      output: "Number",
      colour: "#2f9e77",
      tooltip: "Bollinger band value."
    },
    {
      type: "indicator_macd",
      message0: "MACD %1 fast %2 slow %3 signal %4 source %5",
      args0: [
        { type: "field_dropdown", name: "LINE", options: [["line", "macd"], ["signal", "signal"], ["histogram", "histogram"]] },
        { type: "input_value", name: "FAST", check: "Number" },
        { type: "input_value", name: "SLOW", check: "Number" },
        { type: "input_value", name: "SIGNAL", check: "Number" },
        { type: "input_value", name: "SOURCE", check: "Number" }
      ],
      output: "Number",
      colour: "#2f9e77",
      tooltip: "MACD line, signal, or histogram."
    },
    {
      type: "indicator_atr",
      message0: "ATR period %1",
      args0: [{ type: "input_value", name: "PERIOD", check: "Number" }],
      output: "Number",
      colour: "#2f9e77",
      tooltip: "Average True Range (volatility)."
    },
    {
      type: "indicator_stdev",
      message0: "StdDev period %1 source %2",
      args0: [
        { type: "input_value", name: "PERIOD", check: "Number" },
        { type: "input_value", name: "SOURCE", check: "Number" }
      ],
      output: "Number",
      colour: "#2f9e77",
      tooltip: "Rolling standard deviation."
    },
    {
      type: "indicator_extreme",
      message0: "%1 period %2 source %3",
      args0: [
        { type: "field_dropdown", name: "KIND", options: [["highest", "highest"], ["lowest", "lowest"]] },
        { type: "input_value", name: "PERIOD", check: "Number" },
        { type: "input_value", name: "SOURCE", check: "Number" }
      ],
      output: "Number",
      colour: "#2f9e77",
      tooltip: "Highest / lowest value over N bars."
    },
    {
      type: "indicator_change",
      message0: "change over %1 bars of %2",
      args0: [
        { type: "input_value", name: "PERIOD", check: "Number" },
        { type: "input_value", name: "SOURCE", check: "Number" }
      ],
      output: "Number",
      colour: "#2f9e77",
      tooltip: "Difference between now and N bars ago."
    },
    {
      type: "indicator_stoch",
      message0: "Stoch %1 period %2 smooth %3",
      args0: [
        { type: "field_dropdown", name: "LINE", options: [["%K", "k"], ["%D", "d"]] },
        { type: "input_value", name: "PERIOD", check: "Number" },
        { type: "field_number", name: "SMOOTH", value: 3, min: 1, precision: 1 }
      ],
      output: "Number",
      colour: "#2f9e77",
      tooltip: "Stochastic oscillator (0–100)."
    },
    {
      type: "indicator_wpr",
      message0: "Williams %%R period %1",
      args0: [{ type: "input_value", name: "PERIOD", check: "Number" }],
      output: "Number",
      colour: "#2f9e77",
      tooltip: "Williams %R (−100…0)."
    },
    {
      type: "indicator_cci",
      message0: "CCI period %1",
      args0: [{ type: "input_value", name: "PERIOD", check: "Number" }],
      output: "Number",
      colour: "#2f9e77",
      tooltip: "Commodity Channel Index."
    },
    {
      type: "indicator_roc",
      message0: "ROC %% over %1 bars of %2",
      args0: [
        { type: "input_value", name: "PERIOD", check: "Number" },
        { type: "input_value", name: "SOURCE", check: "Number" }
      ],
      output: "Number",
      colour: "#2f9e77",
      tooltip: "Rate of change in percent."
    },
    {
      type: "series_agg",
      message0: "%1 of %2 over %3 bars",
      args0: [
        { type: "field_dropdown", name: "FN", options: [["sum", "sum"], ["average", "avg"], ["min", "min"], ["max", "max"], ["std dev", "stdev"], ["median", "median"]] },
        { type: "input_value", name: "SOURCE", check: "Number" },
        { type: "input_value", name: "PERIOD", check: "Number" }
      ],
      output: "Number",
      colour: "#2f9e77",
      tooltip: "Rolling aggregate of any value over the last N bars."
    },
    {
      type: "series_shift",
      message0: "%1 from %2 bars ago",
      args0: [
        { type: "input_value", name: "SOURCE", check: "Number" },
        { type: "field_number", name: "OFFSET", value: 1, min: 0, precision: 1 }
      ],
      output: "Number",
      colour: "#2f9e77",
      tooltip: "The value of any expression N bars ago (e.g. RSI 3 bars ago)."
    },
    {
      type: "plot_series",
      message0: "plot %1 as %2 color %3",
      args0: [
        { type: "input_value", name: "VALUE", check: "Number" },
        { type: "field_input", name: "LABEL", text: "signal" },
        { type: "field_input", name: "COLOR", text: "#4db6ff" }
      ],
      previousStatement: null,
      nextStatement: null,
      colour: "#2f9e77",
      tooltip: "Plot a custom series on the chart."
    },
    // ---- Params ----
    {
      type: "param_number",
      message0: "input %1 = %2",
      args0: [
        { type: "field_input", name: "NAME", text: "length" },
        { type: "field_number", name: "VALUE", value: 14 }
      ],
      output: "Number",
      colour: "#6d72c9",
      tooltip: "A named numeric parameter you can tune before a backtest."
    },
    {
      type: "math_minmax",
      message0: "%1 of %2 and %3",
      args0: [
        { type: "field_dropdown", name: "OP", options: [["max", "max"], ["min", "min"]] },
        { type: "input_value", name: "A", check: "Number" },
        { type: "input_value", name: "B", check: "Number" }
      ],
      output: "Number",
      colour: "#6d72c9",
      tooltip: "Take the larger or smaller of two values."
    },
    // ---- Position & PnL ----
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
      args0: [{ type: "field_dropdown", name: "STATE", options: [["long", "long"], ["short", "short"], ["flat", "flat"]] }],
      output: "Boolean",
      colour: "#3d9970",
      tooltip: "True when the current position matches long / short / flat."
    },
    // ---- Logic ----
    {
      type: "cross_event",
      message0: "%1 crosses %2 %3",
      args0: [
        { type: "input_value", name: "A", check: "Number" },
        { type: "field_dropdown", name: "DIRECTION", options: [["above", "above"], ["below", "below"]] },
        { type: "input_value", name: "B", check: "Number" }
      ],
      output: "Boolean",
      colour: "#b28f36",
      tooltip: "Detect a cross between two series."
    },
    {
      type: "series_trend",
      message0: "%1 over %2 bars %3",
      args0: [
        { type: "field_dropdown", name: "DIR", options: [["rising", "rising"], ["falling", "falling"]] },
        { type: "input_value", name: "PERIOD", check: "Number" },
        { type: "input_value", name: "SOURCE", check: "Number" }
      ],
      output: "Boolean",
      colour: "#b28f36",
      tooltip: "True when a series rose/fell over N bars."
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
    // ---- Time ----
    {
      type: "time_session",
      message0: "within UTC hours %1 to %2",
      args0: [
        { type: "field_number", name: "START", value: 13, min: 0, max: 23, precision: 1 },
        { type: "field_number", name: "END", value: 21, min: 0, max: 23, precision: 1 }
      ],
      output: "Boolean",
      colour: "#b0763b",
      tooltip: "True during a trading session window (UTC hours)."
    },
    {
      type: "time_dayofweek",
      message0: "day is %1",
      args0: [
        {
          type: "field_dropdown",
          name: "DAY",
          options: [
            ["Monday", "1"], ["Tuesday", "2"], ["Wednesday", "3"], ["Thursday", "4"],
            ["Friday", "5"], ["Saturday", "6"], ["Sunday", "0"]
          ]
        }
      ],
      output: "Boolean",
      colour: "#b0763b",
      tooltip: "True on the selected day of week (UTC)."
    },
    // ---- Signals / orders ----
    {
      type: "signal_marker",
      message0: "mark %1 %2 when %3",
      args0: [
        { type: "field_dropdown", name: "DIR", options: [["▲ up", "up"], ["▼ down", "down"]] },
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
        { type: "field_dropdown", name: "DIRECTION", options: [["long", "long"], ["short", "short"]] },
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
        { type: "field_dropdown", name: "ACTION", options: [["buy", "buy"], ["sell", "sell"], ["exit", "exit"], ["alert", "alert"]] },
        { type: "input_value", name: "WHEN", check: "Boolean" }
      ],
      previousStatement: null,
      nextStatement: null,
      colour: "#bd58a4",
      tooltip: "Legacy action block (buy/sell/exit/alert)."
    },
    // ---- Risk ----
    {
      type: "risk_stop",
      message0: "stop-loss %1 %2",
      args0: [
        { type: "field_dropdown", name: "MODE", options: [["percent", "percent"], ["price", "price"], ["ATR ×", "atr"]] },
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
        { type: "field_dropdown", name: "MODE", options: [["percent", "percent"], ["price", "price"], ["ATR ×", "atr"]] },
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
        { type: "field_dropdown", name: "MODE", options: [["percent", "percent"], ["ATR ×", "atr"]] },
        { type: "input_value", name: "VALUE", check: "Number" }
      ],
      previousStatement: null,
      nextStatement: null,
      colour: "#c05f5f",
      tooltip: "Stop that follows price: locks in profit as the trade moves."
    },
    // ---- Position sizing ----
    {
      type: "position_size",
      message0: "size %1 %2",
      args0: [
        { type: "field_dropdown", name: "MODE", options: [["% of equity", "equity_pct"], ["units", "units"], ["% risk", "risk_pct"]] },
        { type: "input_value", name: "VALUE", check: "Number" }
      ],
      previousStatement: null,
      nextStatement: null,
      colour: "#c05f5f",
      tooltip: "Set how large each position is."
    },
    // ---- State ----
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
    // ---- Events ----
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
      tooltip: "Emit an alert when a condition fires. Use {a}/{b} in the text to insert the values (e.g. \"RSI={a}\")."
    },
    // ---- Flow ----
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
    }
  ]);
  blocksRegistered = true;
}

export const strategyToolbox = {
  kind: "categoryToolbox",
  contents: [
    {
      kind: "category",
      name: "Market",
      colour: "#4285b4",
      contents: [
        { kind: "block", type: "market_price" },
        { kind: "block", type: "market_price_offset" }
      ]
    },
    {
      kind: "category",
      name: "Indicators",
      colour: "#2f9e77",
      contents: [
        { kind: "block", type: "indicator_ma" },
        { kind: "block", type: "indicator_rsi" },
        { kind: "block", type: "indicator_bollinger" },
        { kind: "block", type: "indicator_macd" },
        { kind: "block", type: "indicator_atr" },
        { kind: "block", type: "indicator_stdev" },
        { kind: "block", type: "indicator_extreme" },
        { kind: "block", type: "indicator_change" },
        { kind: "block", type: "indicator_stoch" },
        { kind: "block", type: "indicator_wpr" },
        { kind: "block", type: "indicator_cci" },
        { kind: "block", type: "indicator_roc" },
        { kind: "block", type: "series_agg" },
        { kind: "block", type: "series_shift" },
        { kind: "block", type: "plot_series" }
      ]
    },
    {
      kind: "category",
      name: "Math",
      colour: "#6d72c9",
      contents: [
        { kind: "block", type: "param_number" },
        { kind: "block", type: "math_number" },
        { kind: "block", type: "math_arithmetic" },
        { kind: "block", type: "math_round" },
        { kind: "block", type: "math_minmax" }
      ]
    },
    {
      kind: "category",
      name: "Position & PnL",
      colour: "#3d9970",
      contents: [
        { kind: "block", type: "ctx_read" },
        { kind: "block", type: "position_is" }
      ]
    },
    {
      kind: "category",
      name: "Logic",
      colour: "#b28f36",
      contents: [
        { kind: "block", type: "cross_event" },
        { kind: "block", type: "series_trend" },
        { kind: "block", type: "value_between" },
        { kind: "block", type: "logic_compare" },
        { kind: "block", type: "logic_operation" },
        { kind: "block", type: "logic_negate" },
        { kind: "block", type: "logic_boolean" }
      ]
    },
    {
      kind: "category",
      name: "Time",
      colour: "#b0763b",
      contents: [
        { kind: "block", type: "time_session" },
        { kind: "block", type: "time_dayofweek" }
      ]
    },
    {
      kind: "category",
      name: "Signals",
      colour: "#bd58a4",
      contents: [
        { kind: "block", type: "signal_entry" },
        { kind: "block", type: "signal_exit" },
        { kind: "block", type: "signal_marker" }
      ]
    },
    {
      kind: "category",
      name: "Flow",
      colour: "#bd58a4",
      contents: [
        { kind: "block", type: "flow_if" },
        { kind: "block", type: "controls_if" },
        { kind: "block", type: "controls_repeat_ext" },
        { kind: "block", type: "controls_whileUntil" }
      ]
    },
    {
      // Blockly's dynamic Functions category (define + call). Parameterless functions
      // are inlined at compile time; parameters/recursion are rejected by the compiler.
      kind: "category",
      name: "Functions",
      colour: "#745ba5",
      custom: "PROCEDURE"
    },
    {
      kind: "category",
      name: "Risk & Size",
      colour: "#c05f5f",
      contents: [
        { kind: "block", type: "risk_stop" },
        { kind: "block", type: "risk_target" },
        { kind: "block", type: "risk_trailing" },
        { kind: "block", type: "position_size" }
      ]
    },
    {
      kind: "category",
      name: "State & Alerts",
      colour: "#9469c9",
      contents: [
        { kind: "block", type: "var_set" },
        { kind: "block", type: "var_change" },
        { kind: "block", type: "var_get" },
        { kind: "block", type: "varb_set" },
        { kind: "block", type: "varb_get" },
        { kind: "block", type: "alert_message" }
      ]
    }
  ]
};
