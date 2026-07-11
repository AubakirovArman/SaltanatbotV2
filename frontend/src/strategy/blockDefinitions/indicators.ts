export const indicatorsBlocks = [
  {
    type: "indicator_ma",
    message0: "%1 period %2 source %3",
    args0: [
      {
        type: "field_dropdown",
        name: "KIND",
        options: [
          ["SMA", "sma"],
          ["EMA", "ema"],
          ["WMA", "wma"],
          ["VWMA", "vwma"],
          ["RMA", "rma"]
        ]
      },
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
      {
        type: "field_dropdown",
        name: "BAND",
        options: [
          ["upper", "upper"],
          ["middle", "middle"],
          ["lower", "lower"]
        ]
      },
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
      {
        type: "field_dropdown",
        name: "LINE",
        options: [
          ["line", "macd"],
          ["signal", "signal"],
          ["histogram", "histogram"]
        ]
      },
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
      {
        type: "field_dropdown",
        name: "KIND",
        options: [
          ["highest", "highest"],
          ["lowest", "lowest"]
        ]
      },
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
      {
        type: "field_dropdown",
        name: "LINE",
        options: [
          ["%K", "k"],
          ["%D", "d"]
        ]
      },
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
    type: "indicator_supertrend",
    message0: "Supertrend %1 factor %2 period %3",
    args0: [
      {
        type: "field_dropdown",
        name: "LINE",
        options: [
          ["value", "value"],
          ["direction", "dir"]
        ]
      },
      { type: "input_value", name: "FACTOR", check: "Number" },
      { type: "input_value", name: "PERIOD", check: "Number" }
    ],
    output: "Number",
    colour: "#2f9e77",
    tooltip: "Supertrend line value, or direction (+1 down-to-up / -1 up-to-down)."
  },
  {
    type: "indicator_dmi",
    message0: "DMI %1 period %2 smoothing %3",
    args0: [
      {
        type: "field_dropdown",
        name: "LINE",
        options: [
          ["+DI", "plus"],
          ["-DI", "minus"],
          ["ADX", "adx"]
        ]
      },
      { type: "input_value", name: "PERIOD", check: "Number" },
      { type: "input_value", name: "SMOOTHING", check: "Number" }
    ],
    output: "Number",
    colour: "#2f9e77",
    tooltip: "Directional Movement Index: +DI, -DI, or ADX."
  },
  {
    type: "indicator_vwap",
    message0: "VWAP",
    output: "Number",
    colour: "#2f9e77",
    tooltip: "Volume-Weighted Average Price (over the loaded history)."
  },
  {
    type: "indicator_linreg",
    message0: "linreg period %1 source %2 offset %3",
    args0: [
      { type: "input_value", name: "PERIOD", check: "Number" },
      { type: "input_value", name: "SOURCE", check: "Number" },
      { type: "field_number", name: "OFFSET", value: 0, min: 0, precision: 1 }
    ],
    output: "Number",
    colour: "#2f9e77",
    tooltip: "Linear regression curve value (ta.linreg)."
  },
  {
    type: "indicator_valuewhen",
    message0: "value of %1 when %2 occurrence %3",
    args0: [
      { type: "input_value", name: "SRC", check: "Number" },
      { type: "input_value", name: "COND", check: "Boolean" },
      { type: "field_number", name: "OCCURRENCE", value: 0, min: 0, precision: 1 }
    ],
    output: "Number",
    colour: "#2f9e77",
    tooltip: "Value of a series at the Nth most recent bar where the condition was true (ta.valuewhen)."
  },
  {
    type: "indicator_extremebars",
    message0: "bars since %1 over %2 of %3",
    args0: [
      {
        type: "field_dropdown",
        name: "KIND",
        options: [
          ["highest", "highest"],
          ["lowest", "lowest"]
        ]
      },
      { type: "input_value", name: "PERIOD", check: "Number" },
      { type: "input_value", name: "SOURCE", check: "Number" }
    ],
    output: "Number",
    colour: "#2f9e77",
    tooltip: "Bars since the highest / lowest value of the last N bars (ta.highestbars / ta.lowestbars, positive offset)."
  },
  {
    type: "indicator_mfi",
    message0: "MFI period %1",
    args0: [{ type: "input_value", name: "PERIOD", check: "Number" }],
    output: "Number",
    colour: "#2f9e77",
    tooltip: "Money Flow Index (volume-weighted RSI, 0–100)."
  },
  {
    type: "indicator_cmo",
    message0: "CMO period %1 source %2",
    args0: [
      { type: "input_value", name: "PERIOD", check: "Number" },
      { type: "input_value", name: "SOURCE", check: "Number" }
    ],
    output: "Number",
    colour: "#2f9e77",
    tooltip: "Chande Momentum Oscillator (−100…100)."
  },
  {
    type: "indicator_tsi",
    message0: "TSI short %1 long %2 source %3",
    args0: [
      { type: "input_value", name: "SHORT", check: "Number" },
      { type: "input_value", name: "LONG", check: "Number" },
      { type: "input_value", name: "SOURCE", check: "Number" }
    ],
    output: "Number",
    colour: "#2f9e77",
    tooltip: "True Strength Index (double-smoothed momentum, −1…1)."
  },
  {
    type: "indicator_alma",
    message0: "ALMA period %1 source %2 offset %3 sigma %4",
    args0: [
      { type: "input_value", name: "PERIOD", check: "Number" },
      { type: "input_value", name: "SOURCE", check: "Number" },
      { type: "field_number", name: "OFFSET", value: 0.85, min: 0, max: 1 },
      { type: "field_number", name: "SIGMA", value: 6, min: 0.1 }
    ],
    output: "Number",
    colour: "#2f9e77",
    tooltip: "Arnaud Legoux Moving Average (Gaussian-weighted)."
  },
  {
    type: "indicator_cog",
    message0: "COG period %1 source %2",
    args0: [
      { type: "input_value", name: "PERIOD", check: "Number" },
      { type: "input_value", name: "SOURCE", check: "Number" }
    ],
    output: "Number",
    colour: "#2f9e77",
    tooltip: "Center of Gravity oscillator (ta.cog)."
  },
  {
    type: "indicator_percentrank",
    message0: "percentrank period %1 source %2",
    args0: [
      { type: "input_value", name: "PERIOD", check: "Number" },
      { type: "input_value", name: "SOURCE", check: "Number" }
    ],
    output: "Number",
    colour: "#2f9e77",
    tooltip: "Percent of the last N values that are ≤ the current value (0–100)."
  },
  {
    type: "indicator_sar",
    message0: "SAR start %1 increment %2 max %3",
    args0: [
      { type: "input_value", name: "START", check: "Number" },
      { type: "input_value", name: "INC", check: "Number" },
      { type: "input_value", name: "MAX", check: "Number" }
    ],
    output: "Number",
    colour: "#2f9e77",
    tooltip: "Parabolic SAR (stop and reverse) level."
  },
  {
    type: "indicator_kc",
    message0: "Keltner %1 period %2 mult %3",
    args0: [
      {
        type: "field_dropdown",
        name: "BAND",
        options: [
          ["upper", "upper"],
          ["middle", "middle"],
          ["lower", "lower"]
        ]
      },
      { type: "input_value", name: "PERIOD", check: "Number" },
      { type: "input_value", name: "MULT", check: "Number" }
    ],
    output: "Number",
    colour: "#2f9e77",
    tooltip: "Keltner Channel band (EMA ± mult × ATR)."
  },
  {
    type: "indicator_correlation",
    message0: "correlation of %1 and %2 over %3 bars",
    args0: [
      { type: "input_value", name: "A", check: "Number" },
      { type: "input_value", name: "B", check: "Number" },
      { type: "input_value", name: "PERIOD", check: "Number" }
    ],
    output: "Number",
    colour: "#2f9e77",
    tooltip: "Rolling Pearson correlation coefficient (-1 to +1)."
  },
  {
    type: "series_agg",
    message0: "%1 of %2 over %3 bars",
    args0: [
      {
        type: "field_dropdown",
        name: "FN",
        options: [
          ["sum", "sum"],
          ["average", "avg"],
          ["min", "min"],
          ["max", "max"],
          ["std dev", "stdev"],
          ["median", "median"]
        ]
      },
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
    message0: "plot %1 as %2 color %3 on %4",
    args0: [
      { type: "input_value", name: "VALUE", check: "Number" },
      { type: "field_input", name: "LABEL", text: "signal" },
      { type: "field_input", name: "COLOR", text: "#4db6ff" },
      {
        type: "field_dropdown",
        name: "PANE",
        options: [
          ["price pane", "price"],
          ["separate pane", "sub"]
        ]
      }
    ],
    previousStatement: null,
    nextStatement: null,
    colour: "#2f9e77",
    tooltip: "Plot a custom series on the chart."
  },
  {
    type: "draw_box",
    message0: "box from %1 to %2 while %3 label %4 color %5",
    args0: [
      { type: "input_value", name: "TOP", check: "Number" },
      { type: "input_value", name: "BOTTOM", check: "Number" },
      { type: "input_value", name: "WHEN", check: "Boolean" },
      { type: "field_input", name: "LABEL", text: "zone" },
      { type: "field_input", name: "COLOR", text: "#26a69a" }
    ],
    previousStatement: null,
    nextStatement: null,
    colour: "#2f9e77",
    tooltip: "Shade a box over every run of bars where the condition holds (e.g. a session/killzone: high..low while in-session)."
  },
  {
    type: "draw_vline",
    message0: "vertical line when %1 label %2 color %3",
    args0: [
      { type: "input_value", name: "WHEN", check: "Boolean" },
      { type: "field_input", name: "LABEL", text: "" },
      { type: "field_input", name: "COLOR", text: "#8f9bb3" }
    ],
    previousStatement: null,
    nextStatement: null,
    colour: "#2f9e77",
    tooltip: "Draw a vertical line on each bar where the condition fires."
  },
  {
    type: "draw_projection",
    message0: "projection time %1 to %2 price %3 to %4 while %5 label %6 color %7",
    args0: [
      { type: "input_value", name: "LEFT", check: "Number" },
      { type: "input_value", name: "RIGHT", check: "Number" },
      { type: "input_value", name: "TOP", check: "Number" },
      { type: "input_value", name: "BOTTOM", check: "Number" },
      { type: "input_value", name: "WHEN", check: "Boolean" },
      { type: "field_input", name: "LABEL", text: "projection" },
      { type: "field_input", name: "COLOR", text: "#4db6ff" }
    ],
    previousStatement: null,
    nextStatement: null,
    colour: "#2f9e77",
    tooltip: "Draw an explicit time/price zone, including future projections."
  },
  {
    type: "table_metric",
    message0: "table %1 row %2 column %3 value %4 while %5",
    args0: [
      { type: "field_input", name: "TABLE", text: "Statistics" },
      { type: "field_input", name: "LABEL", text: "Average" },
      { type: "field_input", name: "COLUMN", text: "Value" },
      { type: "input_value", name: "VALUE", check: "Number" },
      { type: "input_value", name: "WHEN", check: "Boolean" }
    ],
    previousStatement: null,
    nextStatement: null,
    colour: "#2f9e77",
    tooltip: "Expose the latest numeric value in an accessible chart table."
  },
  {
    type: "draw_ray",
    message0: "level %1 when %2 label %3 color %4",
    args0: [
      { type: "input_value", name: "PRICE", check: "Number" },
      { type: "input_value", name: "WHEN", check: "Boolean" },
      { type: "field_input", name: "LABEL", text: "level" },
      { type: "field_input", name: "COLOR", text: "#f7c948" }
    ],
    previousStatement: null,
    nextStatement: null,
    colour: "#2f9e77",
    tooltip: "Draw a horizontal level starting where the condition fires, extending right (support/resistance)."
  },
  {
    type: "series_trend",
    message0: "%1 over %2 bars %3",
    args0: [
      {
        type: "field_dropdown",
        name: "DIR",
        options: [
          ["rising", "rising"],
          ["falling", "falling"]
        ]
      },
      { type: "input_value", name: "PERIOD", check: "Number" },
      { type: "input_value", name: "SOURCE", check: "Number" }
    ],
    output: "Boolean",
    colour: "#b28f36",
    tooltip: "True when a series rose/fell over N bars."
  },
  {
    type: "series_cum",
    message0: "cumulative sum of %1",
    args0: [{ type: "input_value", name: "SOURCE", check: "Number" }],
    output: "Number",
    colour: "#2f9e77",
    tooltip: "Running total of a series from the first bar (ta.cum)."
  },
  {
    type: "series_barssince",
    message0: "bars since %1",
    args0: [{ type: "input_value", name: "COND", check: "Boolean" }],
    output: "Number",
    colour: "#2f9e77",
    tooltip: "Number of bars since the condition was last true (ta.barssince)."
  }
];
