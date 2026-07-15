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

export const marketBlocks = [
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
  {
    type: "market_hist_dyn",
    message0: "market %1 %2 bars ago (dynamic)",
    args0: [
      { type: "field_dropdown", name: "FIELD", options: PRICE_FIELDS },
      { type: "input_value", name: "OFFSET", check: "Number" }
    ],
    output: "Number",
    colour: "#4285b4",
    tooltip: "Read a price field N bars back where N can be a variable (e.g. a loop counter)."
  },
  {
    type: "market_time",
    message0: "bar time session %1 timezone %2",
    args0: [
      { type: "field_input", name: "SESSION", text: "" },
      { type: "field_input", name: "TIMEZONE", text: "" }
    ],
    output: "Number",
    colour: "#4285b4",
    tooltip: "Pine time(): returns the bar timestamp, or na outside the optional session."
  },
  {
    type: "market_security",
    message0: "external %1 timeframe %2 value %3",
    args0: [
      { type: "field_input", name: "SYMBOL", text: "current" },
      { type: "field_input", name: "TIMEFRAME", text: "chart" },
      { type: "input_value", name: "SOURCE", check: "Number" }
    ],
    output: "Number",
    colour: "#4285b4",
    tooltip: "Pine request.security(): external symbol/timeframe series. Research/live runs fail closed when candles are unresolved; chart fallback requires an explicit preview option."
  },
  {
    type: "market_barindex",
    message0: "bar index",
    output: "Number",
    colour: "#4285b4",
    tooltip: "Index of the current bar (relative to loaded history; 0 = first bar)."
  }
];
