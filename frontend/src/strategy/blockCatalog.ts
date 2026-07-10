/**
 * Human-readable help for strategy blocks, surfaced in the Strategy Lab help
 * drawer when a block is selected. Keep entries short and trader-facing.
 */
export interface BlockDoc {
  category: string;
  title: string;
  body: string;
  example?: string;
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
