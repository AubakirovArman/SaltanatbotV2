/**
 * Human-readable help for strategy blocks, surfaced in the Strategy Lab help
 * drawer when a block is selected. Keep entries short and trader-facing.
 */
export interface BlockDoc {
  category: string;
  title: string;
  body: string;
  example?: string;
  inputs?: string[];
  output?: string;
  pitfalls?: string[];
}

export interface ResolvedBlockDoc extends BlockDoc {
  inputs: string[];
  output: string;
  example: string;
  pitfalls: string[];
}

export const blockCatalog: Record<string, BlockDoc> = {
  strategy_start: { category: "Core", title: "Strategy", body: "Root of the graph. 'On start (once)' runs one time when the bot starts (initialize variables); 'rules' run on every closed bar." },

  // Market & data
  market_price: { category: "Market", title: "Market price", body: "The current bar's price field: close/open/high/low/volume, or the averages hl2, hlc3, ohlc4." },
  market_price_offset: { category: "Market", title: "Price N bars ago", body: "A price field from a past bar (offset back from the current bar)." },
  market_time: { category: "Market", title: "Bar time", body: "Pine time(): bar timestamp, optionally filtered by a session string such as 0930-1600:23456." },
  market_security: { category: "Market", title: "External series", body: "Pine request.security(): value from another symbol or timeframe. Backtests/previews use attached external candles when available, otherwise chart-data fallback." },

  // Indicators
  indicator_ma: { category: "Indicators", title: "Moving average", body: "SMA / EMA / WMA / VWMA of a source over a period.", example: "EMA(21) of close" },
  indicator_rsi: { category: "Indicators", title: "RSI", body: "Relative Strength Index (0–100). Overbought > 70, oversold < 30." },
  indicator_bollinger: { category: "Indicators", title: "Bollinger band", body: "Upper / middle / lower band = SMA ± deviation × stdev." },
  indicator_macd: { category: "Indicators", title: "MACD", body: "MACD line, signal line, or histogram from fast/slow/signal EMAs." },
  indicator_atr: { category: "Indicators", title: "ATR", body: "Average True Range — volatility, for ATR-based stops/targets." },
  indicator_extreme: { category: "Indicators", title: "Highest / lowest", body: "Highest or lowest value of a source over the last N bars (Donchian-style)." },
  indicator_correlation: { category: "Indicators", title: "Correlation", body: "Rolling Pearson correlation of two series over N bars, from -1 to +1." },
  series_agg: { category: "Indicators", title: "Rolling aggregate", body: "sum / average / min / max / std-dev / median of any value over the last N bars.", example: "average of RSI(14) over 5 bars" },
  series_shift: { category: "Indicators", title: "N bars ago", body: "The value of ANY expression N bars ago — e.g. RSI 3 bars back, for slope/divergence." },
  plot_series: { category: "Indicators", title: "Plot", body: "Draw a value on the chart, on the price pane or a separate sub-pane (for oscillators)." },

  // Conditions
  cross_event: { category: "Logic", title: "Crosses", body: "True on the bar where one series crosses above/below another." },
  series_trend: { category: "Logic", title: "Rising / falling", body: "True when a series rose or fell over the last N bars." },
  value_between: { category: "Logic", title: "Between", body: "True when a value is within a low–high range (inclusive)." },
  position_is: { category: "Position & PnL", title: "Position is…", body: "True when the current position is long, short, or flat." },
  ctx_read: { category: "Position & PnL", title: "Position / PnL read", body: "The live position/PnL state: direction, entry, unrealized PnL, bars in trade, loss streak, trades today, equity. 0 when flat." },

  // Entry / exit / risk
  signal_entry: { category: "Signals", title: "Enter", body: "Open a long or short position when the condition is true (first entry per bar wins)." },
  signal_exit: { category: "Signals", title: "Exit", body: "Close the open position when the condition is true." },
  signal_marker: { category: "Signals", title: "Mark", body: "Draw an arrow on the chart when the condition fires — no trade." },
  risk_stop: { category: "Risk", title: "Stop-loss", body: "Attach a stop by percent, absolute price, or ATR multiple." },
  risk_target: { category: "Risk", title: "Take-profit", body: "Attach a take-profit by percent, price, or ATR multiple." },
  risk_trailing: { category: "Risk", title: "Trailing stop", body: "A stop that follows price to lock in profit (percent or ATR)." },
  position_size: { category: "Risk", title: "Position size", body: "How large each entry is: % of equity, fixed units, or % risk (needs a stop)." },

  // State & flow
  var_set: { category: "State", title: "Set variable", body: "Store a number in a named variable (persists across bars while the bot runs)." },
  var_change: { category: "State", title: "Change variable by", body: "Increment or decrement a variable — e.g. count a losing streak." },
  var_get: { category: "State", title: "Get variable", body: "Read a stored numeric variable (0 if never set — scalar only, not a series)." },
  varb_set: { category: "State", title: "Set flag", body: "Store a true/false flag." },
  varb_get: { category: "State", title: "Get flag", body: "Read a stored true/false flag." },
  alert_message: { category: "Alerts", title: "Alert", body: "Emit an alert (journal + Telegram). Use {a}/{b} in the text to insert values, e.g. \"RSI={a}\"." },
  flow_if: { category: "Flow", title: "If", body: "Run inner blocks only when the condition is true." },
  controls_if: { category: "Flow", title: "If / else", body: "If / else-if / else — use the gear to add branches." },
  controls_repeat_ext: { category: "Flow", title: "Repeat", body: "Run the body N times (bounded, and capped by the per-bar op budget)." },
  controls_whileUntil: { category: "Flow", title: "While / until", body: "Loop while/until a condition — hard-capped at 1000 iterations for safety." },

  // Time
  time_session: { category: "Time", title: "Session hours", body: "True during a UTC hour window (wraps past midnight)." },
  time_dayofweek: { category: "Time", title: "Day of week", body: "True on the selected UTC weekday." }
};

/** Complete inspector contract even for Blockly built-ins and newly added catalog rows. */
export function blockInspectorDoc(type: string): ResolvedBlockDoc | undefined {
  const doc = blockCatalog[type];
  if (!doc) return undefined;
  const defaults = categoryInspectorDefaults(doc.category, type);
  return {
    ...doc,
    inputs: doc.inputs ?? defaults.inputs,
    output: doc.output ?? defaults.output,
    example: doc.example ?? defaults.example,
    pitfalls: doc.pitfalls ?? defaults.pitfalls
  };
}

function categoryInspectorDefaults(category: string, type: string): Pick<ResolvedBlockDoc, "inputs" | "output" | "example" | "pitfalls"> {
  if (category === "Market") return { inputs: type === "market_security" ? ["symbol", "timeframe", "source series"] : ["field / offset where applicable"], output: "Numeric time series", example: "Use close as the source for an EMA.", pitfalls: ["Future bars are never available; offsets must reference completed history."] };
  if (category === "Indicators") return { inputs: ["source series", "period / method parameters"], output: type === "plot_series" ? "Chart plot" : "Numeric time series", example: "Feed the output into a cross or plot block.", pitfalls: ["Warm-up bars return incomplete values; choose a period supported by the loaded history."] };
  if (category === "Logic") return { inputs: ["numeric or boolean expressions"], output: "Boolean condition", example: "Connect the condition to an entry, exit or marker.", pitfalls: ["A condition is evaluated once per closed bar, not continuously inside the candle."] };
  if (category === "Signals") return { inputs: ["boolean condition", "direction / label"], output: "Signal or order intent", example: "Enter long when fast EMA crosses above slow EMA.", pitfalls: ["Multiple entries on one bar are resolved deterministically; the first accepted intent wins."] };
  if (category === "Risk") return { inputs: ["mode", "positive numeric value"], output: "Execution constraint", example: "Attach a 2% stop before risk-percent sizing.", pitfalls: ["Risk-percent size requires a valid stop; unsafe or non-positive values fail closed."] };
  if (category === "State" || category === "Position & PnL") return { inputs: ["variable / context field", "value where applicable"], output: type.includes("get") || type === "ctx_read" ? "Numeric or boolean value" : "Persistent state change", example: "Store a counter and read it on the next closed bar.", pitfalls: ["State persists across bars; reset it explicitly when the strategy lifecycle requires it."] };
  if (category === "Flow") return { inputs: ["condition / count", "nested statements"], output: "Controlled statement sequence", example: "Run an entry block only while a session condition is true.", pitfalls: ["Loops are bounded by iteration and per-bar operation budgets."] };
  if (category === "Time") return { inputs: ["UTC session or weekday"], output: "Boolean condition", example: "Limit entries to Monday–Friday session hours.", pitfalls: ["Confirm timezone and daylight-saving assumptions before live use."] };
  if (category === "Alerts") return { inputs: ["message", "condition", "optional values"], output: "Journal/notification event", example: "Alert RSI={a} when the threshold is crossed.", pitfalls: ["Alerts do not place orders and notification delivery can fail independently."] };
  return { inputs: ["connected child blocks"], output: "Strategy graph", example: "Connect rules under the Strategy root.", pitfalls: ["Exactly one Strategy root should own executable rules."] };
}
