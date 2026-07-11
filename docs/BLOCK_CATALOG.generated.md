# Generated strategy block catalog

> Generated from `frontend/src/strategy/blockCatalog.ts`. Do not edit by hand.

The stable block type is the serialization/compiler identifier and is intentionally not localized. Trader-facing titles and descriptions below are the canonical English source copy.

## Category summary

| Category | Blocks |
| --- | ---: |
| Alerts | 1 |
| Core | 1 |
| Flow | 4 |
| Indicators | 10 |
| Logic | 3 |
| Market | 4 |
| Position & PnL | 2 |
| Risk | 4 |
| Signals | 3 |
| State | 5 |
| Time | 2 |

## Blocks

| Type | Category | Title | Description | Example |
| --- | --- | --- | --- | --- |
| `alert_message` | Alerts | Alert | Emit an alert (journal + Telegram). Use {a}/{b} in the text to insert values, e.g. "RSI={a}". | — |
| `strategy_start` | Core | Strategy | Root of the graph. 'On start (once)' runs one time when the bot starts (initialize variables); 'rules' run on every closed bar. | — |
| `controls_if` | Flow | If / else | If / else-if / else — use the gear to add branches. | — |
| `controls_repeat_ext` | Flow | Repeat | Run the body N times (bounded, and capped by the per-bar op budget). | — |
| `controls_whileUntil` | Flow | While / until | Loop while/until a condition — hard-capped at 1000 iterations for safety. | — |
| `flow_if` | Flow | If | Run inner blocks only when the condition is true. | — |
| `indicator_atr` | Indicators | ATR | Average True Range — volatility, for ATR-based stops/targets. | — |
| `indicator_bollinger` | Indicators | Bollinger band | Upper / middle / lower band = SMA ± deviation × stdev. | — |
| `indicator_correlation` | Indicators | Correlation | Rolling Pearson correlation of two series over N bars, from -1 to +1. | — |
| `indicator_extreme` | Indicators | Highest / lowest | Highest or lowest value of a source over the last N bars (Donchian-style). | — |
| `indicator_ma` | Indicators | Moving average | SMA / EMA / WMA / VWMA of a source over a period. | EMA(21) of close |
| `indicator_macd` | Indicators | MACD | MACD line, signal line, or histogram from fast/slow/signal EMAs. | — |
| `indicator_rsi` | Indicators | RSI | Relative Strength Index (0–100). Overbought &gt; 70, oversold &lt; 30. | — |
| `plot_series` | Indicators | Plot | Draw a value on the chart, on the price pane or a separate sub-pane (for oscillators). | — |
| `series_agg` | Indicators | Rolling aggregate | sum / average / min / max / std-dev / median of any value over the last N bars. | average of RSI(14) over 5 bars |
| `series_shift` | Indicators | N bars ago | The value of ANY expression N bars ago — e.g. RSI 3 bars back, for slope/divergence. | — |
| `cross_event` | Logic | Crosses | True on the bar where one series crosses above/below another. | — |
| `series_trend` | Logic | Rising / falling | True when a series rose or fell over the last N bars. | — |
| `value_between` | Logic | Between | True when a value is within a low–high range (inclusive). | — |
| `market_price` | Market | Market price | The current bar's price field: close/open/high/low/volume, or the averages hl2, hlc3, ohlc4. | — |
| `market_price_offset` | Market | Price N bars ago | A price field from a past bar (offset back from the current bar). | — |
| `market_security` | Market | External series | Pine request.security(): value from another symbol or timeframe. Backtests/previews use attached external candles when available, otherwise chart-data fallback. | — |
| `market_time` | Market | Bar time | Pine time(): bar timestamp, optionally filtered by a session string such as 0930-1600:23456. | — |
| `ctx_read` | Position & PnL | Position / PnL read | The live position/PnL state: direction, entry, unrealized PnL, bars in trade, loss streak, trades today, equity. 0 when flat. | — |
| `position_is` | Position & PnL | Position is… | True when the current position is long, short, or flat. | — |
| `position_size` | Risk | Position size | How large each entry is: % of equity, fixed units, or % risk (needs a stop). | — |
| `risk_stop` | Risk | Stop-loss | Attach a stop by percent, absolute price, or ATR multiple. | — |
| `risk_target` | Risk | Take-profit | Attach a take-profit by percent, price, or ATR multiple. | — |
| `risk_trailing` | Risk | Trailing stop | A stop that follows price to lock in profit (percent or ATR). | — |
| `signal_entry` | Signals | Enter | Open a long or short position when the condition is true (first entry per bar wins). | — |
| `signal_exit` | Signals | Exit | Close the open position when the condition is true. | — |
| `signal_marker` | Signals | Mark | Draw an arrow on the chart when the condition fires — no trade. | — |
| `var_change` | State | Change variable by | Increment or decrement a variable — e.g. count a losing streak. | — |
| `var_get` | State | Get variable | Read a stored numeric variable (0 if never set — scalar only, not a series). | — |
| `var_set` | State | Set variable | Store a number in a named variable (persists across bars while the bot runs). | — |
| `varb_get` | State | Get flag | Read a stored true/false flag. | — |
| `varb_set` | State | Set flag | Store a true/false flag. | — |
| `time_dayofweek` | Time | Day of week | True on the selected UTC weekday. | — |
| `time_session` | Time | Session hours | True during a UTC hour window (wraps past midnight). | — |

Generated total: **39 documented block types**.
