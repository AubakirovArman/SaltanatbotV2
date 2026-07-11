# Generated Pine compatibility matrix

> Generated from `frontend/tests/pineCorpus.json` and `frontend/tests/pineV6Corpus.json`. Do not edit by hand.

This matrix describes tested corpus features, not full Pine Script compatibility. **Approximation** and **display-only** rows require reviewing import diagnostics before using an artifact for trading.

| Level | Features |
| --- | ---: |
| exact | 125 |
| display-only | 26 |
| approximation | 22 |
| rejected | 5 |

| Feature | Level | Corpus | Covered by scripts |
| --- | --- | --- | --- |
| look-ahead offset | rejected | v6 corpus | Pivot High Look-Ahead Supply Zones (REJECT - ta.pivothigh future offset) |
| REJECT | rejected | v6 corpus | Pivot High Look-Ahead Supply Zones (REJECT - ta.pivothigh future offset) |
| Rejected program: Pivot High Look-Ahead Supply Zones | rejected | v6 corpus | Pivot High Look-Ahead Supply Zones (REJECT - ta.pivothigh future offset) |
| ta.pivothigh | rejected | v6 corpus | Pivot High Look-Ahead Supply Zones (REJECT - ta.pivothigh future offset) |
| ta.pivotlow | rejected | v6 corpus | Pivot High Look-Ahead Supply Zones (REJECT - ta.pivothigh future offset) |
| array of labels | approximation | v6 corpus | Liquidity Heatmap with Matrix/Map (opaque visual approximation) |
| array.new | approximation | v6 corpus | Order Block Detector (arrays + drawing approximation) |
| array.push | approximation | v6 corpus | Order Block Detector (arrays + drawing approximation) |
| external-series approximation | approximation | v6 corpus | Multi-Timeframe RSI (request.security approximation) |
| fill() unsupported — warn and skip | approximation | v4/v5 corpus | Bollinger Bands Overlay |
| for loop with close[i] dynamic index unsupported (repeat{count} cannot express varying offset) — may drop or approximate as agg{fn:sum, period:5}/5 | approximation | v4/v5 corpus | Kitchen Sink Mixed Support |
| hline() unsupported — warn and skip (or approximate as constant plot) | approximation | v4/v5 corpus | Old School RSI (v4) |
| map.new | approximation | v6 corpus | Liquidity Heatmap with Matrix/Map (opaque visual approximation) |
| matrix.new | approximation | v6 corpus | Liquidity Heatmap with Matrix/Map (opaque visual approximation) |
| numeric ternary (close &gt; maVal ? 1 : -1) unsupported unless converter desugars to if/setvar | approximation | v4/v5 corpus | Kitchen Sink Mixed Support |
| opaque collection approximation | approximation | v6 corpus | Liquidity Heatmap with Matrix/Map (opaque visual approximation), Order Block Detector (arrays + drawing approximation) |
| plot style_histogram rendering style dropped (only value/label/color/pane kept) | approximation | v4/v5 corpus | MACD Panel Indicator |
| position_size magnitude approximated by position_dir ctx (sign-only) | approximation | v4/v5 corpus | Pullback Counter Strategy |
| recursive nz(x[1]) | approximation | v6 corpus | Custom Recursive Smoother (RMA style) |
| recursive stop nz | approximation | v6 corpus | ATR Trailing Stop Strategy |
| recursive x := nz(x[1]) | approximation | v6 corpus | Recursive Zero-Lag Filter |
| recursive-free levels | approximation | v6 corpus | Pivot Point Standard Levels (v4) |
| request.security MTF | approximation | v6 corpus | Multi-Timeframe RSI (request.security approximation) |
| request.security unsupported — higher-timeframe data not representable | approximation | v4/v5 corpus | Kitchen Sink Mixed Support |
| strategy.exit id/from_entry linkage ignored (single-position model) | approximation | v4/v5 corpus | EMA Cross SL TP Strategy |
| syminfo.tickerid unsupported symbol reference | approximation | v4/v5 corpus | Kitchen Sink Mixed Support |
| ta.vwap unsupported (no vwap node in IR) | approximation | v4/v5 corpus | Kitchen Sink Mixed Support |
| box.new | display-only | v6 corpus | Order Block Detector (arrays + drawing approximation) |
| color by slope | display-only | v6 corpus | Hull Moving Average Trend |
| color logic | display-only | v6 corpus | EMA Ribbon Trend |
| color.from_gradient | display-only | v6 corpus | MACD Histogram Cross |
| color.new(color.blue, 90) transparency reduced to base color | display-only | v4/v5 corpus | Bollinger Bands Overlay |
| hline | display-only | v6 corpus | Simple RSI Overbought/Oversold |
| hline fill | display-only | v6 corpus | Stochastic %K %D |
| input.source treated as fixed close source (source-type input not representable as numeric input) | display-only | v4/v5 corpus | Bollinger Bands Overlay |
| label lifetime | display-only | v6 corpus | Bars Since Last Signal Counter |
| label.new | display-only | v6 corpus | Pivot High Look-Ahead Supply Zones (REJECT - ta.pivothigh future offset) |
| line.new | display-only | v6 corpus | Order Block Detector (arrays + drawing approximation) |
| multiple plots | display-only | v6 corpus | EMA Ribbon Trend |
| plot | display-only | v6 corpus | ADX Directional Trend, Bars Since Last Signal Counter, For-Loop Momentum Sum, Linear Regression Channel Slope, Simple RSI Overbought/Oversold, Single-Line Function Library Demo, Stochastic %K %D |
| plot area | display-only | v6 corpus | Cumulative Volume Delta Proxy |
| plot direction | display-only | v6 corpus | Supertrend Overlay |
| plot fill | display-only | v6 corpus | Bollinger Bands %B |
| plot histogram | display-only | v6 corpus | MACD Histogram Cross, Volume Weighted MACD (v5) |
| plot lines | display-only | v6 corpus | ValueWhen Pivot Reference |
| plot stepline | display-only | v6 corpus | Pivot Point Standard Levels (v4) |
| plotshape | display-only | v6 corpus | Hull Moving Average Trend, Keltner Channel Squeeze |
| plotshape signals | display-only | v6 corpus | Supertrend Overlay |
| plotshape style/location/text cosmetic details collapsed into marker dir+label | display-only | v4/v5 corpus | EMA Cross Alerts Indicator |
| polyline.new | display-only | v6 corpus | Liquidity Heatmap with Matrix/Map (opaque visual approximation) |
| single-line =&gt; functions | display-only | v6 corpus | Single-Line Function Library Demo |
| threshold coloring | display-only | v6 corpus | ADX Directional Trend |
| user function multi-line | display-only | v6 corpus | Bollinger Bands %B |
| [1] on the bound band maps to shift{src: extreme{...}, offset:1} | exact | v4/v5 corpus | Donchian Breakout Strategy |
| //@version=4 | exact | v6 corpus | Pivot Point Standard Levels (v4) |
| //@version=4 legacy version — best-effort conversion | exact | v4/v5 corpus | Old School RSI (v4) |
| //@version=5 | exact | v6 corpus | Volume Weighted MACD (v5) |
| % maps to arith{op:%, a: unary abs expr, b: atr} | exact | v4/v5 corpus | Range Expansion Math Strategy |
| alert{message:'Fast EMA crossed above slow EMA', when: cross{dir:above, a: ma ema fastLen, b: ma ema slowLen}} | exact | v4/v5 corpus | EMA Cross Alerts Indicator |
| alert{message:'Fast EMA crossed below slow EMA', when: cross{dir:below,...}} | exact | v4/v5 corpus | EMA Cross Alerts Indicator |
| alertcondition | exact | v6 corpus | Donchian Channel Breakout Strategy, Hull Moving Average Trend, MACD Histogram Cross |
| close[1] maps to price{field:close, offset:1} (or shift over price close) | exact | v4/v5 corpus | RSI Momentum History Indicator |
| conversion completes (does not abort) despite unsupported constructs | exact | v4/v5 corpus | Kitchen Sink Mixed Support |
| cross(r, 30) maps to cross{dir:any, a: rsi, b: num 30} | exact | v4/v5 corpus | Old School RSI (v4) |
| d maps to stoch{line:d,...} or ma{sma, period:3, source:k expr} | exact | v4/v5 corpus | Stoch WPR Combo Strategy |
| entry direction long with when = cross{dir:above, a: rsi{period:input len, source:price close}, b: input oversold (or num 30)} | exact | v4/v5 corpus | RSI Reversal Strategy |
| entry direction long, when = cross{dir:above, a: ma{kind:ema, period:fastLen, source:close}, b: ma{kind:ema, period:slowLen, source:close}} | exact | v4/v5 corpus | EMA Cross SL TP Strategy |
| entry direction short with when = cross{dir:below, a: rsi{...}, b: input overbought} | exact | v4/v5 corpus | RSI Reversal Strategy |
| entry long when compare{&gt;, price close, shift{extreme highest,1}} | exact | v4/v5 corpus | Donchian Breakout Strategy |
| entry long when logic{and, compare{&gt;, barRange expr, threshold expr}, compare{&gt;, close, open}}; entry short mirrored | exact | v4/v5 corpus | Range Expansion Math Strategy |
| entry long when logic{and, cross{dir:above, a:k, b:d}, compare{&lt;, wpr, num -80}} with -80 as num or unary{neg, num 80} | exact | v4/v5 corpus | Stoch WPR Combo Strategy |
| entry short when compare{&lt;, price close, shift{extreme lowest,1}} | exact | v4/v5 corpus | Donchian Breakout Strategy |
| entry short when logic{and, cross{dir:below, a:k, b:d}, compare{&gt;, wpr, num -20}} | exact | v4/v5 corpus | Stoch WPR Combo Strategy |
| entry when also includes compare{&gt;, price close, ma{kind:sma, period:maLen, source:close}} joined by logic and | exact | v4/v5 corpus | Pullback Counter Strategy |
| entry when includes compare{&gt;=, var downCount, input needed} | exact | v4/v5 corpus | Pullback Counter Strategy |
| exit{when: compare{&lt;, price close, ma sma}} | exact | v4/v5 corpus | Pullback Counter Strategy |
| exit{when: cross{dir:below, a: rsi{period:len}, b: num 50}} (strategy.close maps to exit) | exact | v4/v5 corpus | RSI Reversal Strategy |
| fill | exact | v6 corpus | Standard Deviation Volatility Bands, Supertrend Overlay |
| for loop | exact | v6 corpus | Trend Score Aggregator |
| for loop accumulation | exact | v6 corpus | For-Loop Weighted Average Price |
| for loop scalar accumulation | exact | v6 corpus | For-Loop Momentum Sum |
| for loop seed | exact | v6 corpus | Custom Recursive Smoother (RMA style) |
| function composition | exact | v6 corpus | Single-Line Function Library Demo |
| if converted: inputs contains len=14 (legacy input(defval, title) form) | exact | v4/v5 corpus | Old School RSI (v4) |
| if{cond: compare{&lt;, price close, price{close, offset:1}}, then:[setvar downCount = arith{+, var downCount, num 1}], else:[setvar downCount = num 0]} — += desugars to setvar with arith + | exact | v4/v5 corpus | Pullback Counter Strategy |
| immutable bindings r/longSignal/shortSignal inlined at use sites | exact | v4/v5 corpus | RSI Reversal Strategy |
| init contains setvar downCount=0 (var int declaration) | exact | v4/v5 corpus | Pullback Counter Strategy |
| input.int | exact | v6 corpus | For-Loop Momentum Sum, Simple RSI Overbought/Oversold, Stochastic %K %D |
| inputs contains atrLen=14, mult=1.5 | exact | v4/v5 corpus | Range Expansion Math Strategy |
| inputs contains chanLen=20 | exact | v4/v5 corpus | Donchian Breakout Strategy |
| inputs contains fastLen=12, slowLen=26, sigLen=9 | exact | v4/v5 corpus | MACD Panel Indicator |
| inputs contains fastLen=8, slowLen=34 | exact | v4/v5 corpus | EMA Cross Alerts Indicator |
| inputs contains fastLen=9, slowLen=21, slPerc=2.0, tpPerc=4.0 | exact | v4/v5 corpus | EMA Cross SL TP Strategy |
| inputs contains kLen=14, smoothK=3, wprLen=14 | exact | v4/v5 corpus | Stoch WPR Combo Strategy |
| inputs contains len=14 | exact | v4/v5 corpus | RSI Momentum History Indicator |
| inputs contains len=14, oversold=30, overbought=70 | exact | v4/v5 corpus | RSI Reversal Strategy |
| inputs contains len=20 | exact | v4/v5 corpus | Kitchen Sink Mixed Support |
| inputs contains length=20, mult=2.0 | exact | v4/v5 corpus | Bollinger Bands Overlay |
| k recognized as stoch{line:k, period:kLen, smooth:smoothK} (sma-over-ta.stoch pattern) OR as ma{sma, period:smoothK} wrapping a raw stoch — either is acceptable but the stoch semantics must survive | exact | v4/v5 corpus | Stoch WPR Combo Strategy |
| legacy unnamespaced builtins (rsi, cross) resolved via v4 compatibility aliases | exact | v4/v5 corpus | Old School RSI (v4) |
| lookahead risk | exact | v6 corpus | Multi-Timeframe RSI (request.security approximation) |
| math.abs maps to unary{op:abs, a: arith{-, price close, price open}} | exact | v4/v5 corpus | Range Expansion Math Strategy |
| math.max maps to minmax{op:max, a: arith{*, atr{period:atrLen}, input mult}, b: pow expr} | exact | v4/v5 corpus | Range Expansion Math Strategy |
| math.pow(atrVal, 1.1) maps to arith{op:^, a: atr{atrLen}, b: num 1.1} | exact | v4/v5 corpus | Range Expansion Math Strategy |
| mom inlined as arith{-, rsi{...}, shift{rsi{...},1}} at plot site | exact | v4/v5 corpus | RSI Momentum History Indicator |
| multiple ta calls | exact | v6 corpus | Trend Score Aggregator |
| normalization | exact | v6 corpus | For-Loop Momentum Sum |
| numeric ternary | exact | v6 corpus | ADX Directional Trend, Cumulative Volume Delta Proxy, Linear Regression Channel Slope, Recursive Zero-Lag Filter |
| numeric ternary chain | exact | v6 corpus | Trend Score Aggregator |
| nz | exact | v6 corpus | Recursive Zero-Lag Filter |
| openprofit | exact | v6 corpus | EMA Crossover Strategy with Stop |
| overlay | exact | v6 corpus | For-Loop Weighted Average Price |
| overlay=false | exact | v6 corpus | Simple RSI Overbought/Oversold |
| overlay=true | exact | v6 corpus | EMA Ribbon Trend |
| plot ids (pMid/pUp/pLo) as assignment targets do not break conversion | exact | v4/v5 corpus | Bollinger Bands Overlay |
| plot labels MACD, Signal, Histogram with mapped colors | exact | v4/v5 corpus | MACD Panel Indicator |
| plot of ma{kind:sma, period:len, source:close} label SMA pane price converts successfully | exact | v4/v5 corpus | Kitchen Sink Mixed Support |
| plot of rsi pane sub; plotshape(buy) maps to marker with when = cross any | exact | v4/v5 corpus | Old School RSI (v4) |
| plot of rsi with label RSI, pane sub (overlay=true script but rsi is oscillator; pane price is acceptable if converter keys off overlay) | exact | v4/v5 corpus | RSI Reversal Strategy |
| plot of the % expression | exact | v4/v5 corpus | Range Expansion Math Strategy |
| plotshape(bear, triangledown, abovebar) maps to marker{dir:down/short, when: cross below} | exact | v4/v5 corpus | EMA Cross Alerts Indicator |
| plotshape(bull, triangleup, belowbar) maps to marker{dir:up/long, label:'Buy' (or 'BUY'), when: cross above} | exact | v4/v5 corpus | EMA Cross Alerts Indicator |
| position_size | exact | v6 corpus | ATR Trailing Stop Strategy, RSI Divergence Strategy |
| priceChg plot value = arith{-, price close, price{close, offset:1}} | exact | v4/v5 corpus | RSI Momentum History Indicator |
| r[1] on a bound name maps to shift{src: rsi{period:len, source:close}, offset:1} | exact | v4/v5 corpus | RSI Momentum History Indicator |
| rsi(src, len) without ta. namespace maps to rsi{period:len, source:close} | exact | v4/v5 corpus | Old School RSI (v4) |
| security same-symbol | exact | v6 corpus | Pivot Point Standard Levels (v4) |
| signalLine binds to macd{line:signal, ...}; histLine binds to macd{line:histogram, ...} | exact | v4/v5 corpus | MACD Panel Indicator |
| slope math | exact | v6 corpus | Linear Regression Channel Slope |
| squeeze logic | exact | v6 corpus | Keltner Channel Squeeze |
| stop stmt: mode percent value slPerc (recognized pattern close*(1-p/100)) OR mode price with arith expr arith{*, price close, arith{-, num 1, arith{/, input slPerc, num 100}}} | exact | v4/v5 corpus | EMA Cross SL TP Strategy |
| strategy.close | exact | v6 corpus | RSI Divergence Strategy |
| strategy.entry | exact | v6 corpus | ATR Trailing Stop Strategy, Bollinger Band Breakout Strategy, Donchian Channel Breakout Strategy, EMA Crossover Strategy with Stop, RSI Divergence Strategy |
| strategy.exit | exact | v6 corpus | ATR Trailing Stop Strategy, Bollinger Band Breakout Strategy, Donchian Channel Breakout Strategy, RSI Divergence Strategy |
| strategy.exit stop/limit | exact | v6 corpus | EMA Crossover Strategy with Stop |
| strategy.position_size == 0 maps to compare{==, ctx{position_dir}, num 0} (flat-position gate) | exact | v4/v5 corpus | Pullback Counter Strategy |
| study() treated as indicator declaration | exact | v4/v5 corpus | Old School RSI (v4) |
| switch | exact | v6 corpus | Bollinger Band Breakout Strategy, Trend Score Aggregator |
| ta.atr | exact | v6 corpus | ATR Trailing Stop Strategy, Keltner Channel Squeeze |
| ta.barssince | exact | v6 corpus | Bars Since Last Signal Counter |
| ta.crossover | exact | v6 corpus | Bars Since Last Signal Counter, EMA Crossover Strategy with Stop, MACD Histogram Cross |
| ta.cum | exact | v6 corpus | Cumulative Volume Delta Proxy |
| ta.dev | exact | v6 corpus | Standard Deviation Volatility Bands |
| ta.dmi | exact | v6 corpus | ADX Directional Trend |
| ta.ema | exact | v6 corpus | EMA Crossover Strategy with Stop, EMA Ribbon Trend, Keltner Channel Squeeze, Recursive Zero-Lag Filter, Single-Line Function Library Demo, Volume Weighted MACD (v5) |
| ta.highest | exact | v6 corpus | Donchian Channel Breakout Strategy, ValueWhen Pivot Reference |
| ta.highest(chanLen) with omitted source maps to extreme{kind:highest, period:chanLen, source:price high} (default source is high) | exact | v4/v5 corpus | Donchian Breakout Strategy |
| ta.hma | exact | v6 corpus | Hull Moving Average Trend |
| ta.linreg | exact | v6 corpus | Linear Regression Channel Slope, Standard Deviation Volatility Bands |
| ta.lowest | exact | v6 corpus | Donchian Channel Breakout Strategy, ValueWhen Pivot Reference |
| ta.lowest(chanLen) maps to extreme{kind:lowest, period:chanLen, source:price low} | exact | v4/v5 corpus | Donchian Breakout Strategy |
| ta.macd | exact | v6 corpus | MACD Histogram Cross |
| ta.rma comparison | exact | v6 corpus | Custom Recursive Smoother (RMA style) |
| ta.rsi | exact | v6 corpus | RSI Divergence Strategy, Simple RSI Overbought/Oversold |
| ta.sma | exact | v6 corpus | Bollinger Band Breakout Strategy, Bollinger Bands %B, Keltner Channel Squeeze, Standard Deviation Volatility Bands, Stochastic %K %D |
| ta.stdev | exact | v6 corpus | Bollinger Band Breakout Strategy, Bollinger Bands %B, Keltner Channel Squeeze |
| ta.stoch | exact | v6 corpus | Stochastic %K %D |
| ta.stoch(close, high, low, kLen) explicit source args collapsed to canonical stoch node | exact | v4/v5 corpus | Stoch WPR Combo Strategy |
| ta.supertrend | exact | v6 corpus | Supertrend Overlay |
| ta.valuewhen | exact | v6 corpus | ValueWhen Pivot Reference |
| ta.vwma | exact | v6 corpus | Volume Weighted MACD (v5) |
| ta.wma comparison | exact | v6 corpus | For-Loop Weighted Average Price |
| ta.wpr(wprLen) maps to wpr{period:wprLen} | exact | v4/v5 corpus | Stoch WPR Combo Strategy |
| target stmt: mode percent value tpPerc OR mode price with the mirrored arith expr | exact | v4/v5 corpus | EMA Cross SL TP Strategy |
| three plot stmts pane price (overlay=true) | exact | v4/v5 corpus | Bollinger Bands Overlay |
| three plot stmts, all pane sub (overlay=false) | exact | v4/v5 corpus | MACD Panel Indicator |
| three plots pane sub, including constant plot num{0} | exact | v4/v5 corpus | RSI Momentum History Indicator |
| tuple destructuring of ta.bb: middle -&gt; bollinger{band:middle, period:length, dev:mult, source:close}, upper -&gt; bollinger{band:upper,...}, lower -&gt; bollinger{band:lower,...} | exact | v4/v5 corpus | Bollinger Bands Overlay |
| tuple destructuring: macdLine binds to macd{line:macd, fast:fastLen, slow:slowLen, signal:sigLen, source:close} | exact | v4/v5 corpus | MACD Panel Indicator |
| two plot stmts (Fast EMA, Slow EMA) pane price | exact | v4/v5 corpus | EMA Cross SL TP Strategy |
| two plot stmts pane price | exact | v4/v5 corpus | EMA Cross Alerts Indicator |
| two plots (%K, %D) pane sub (overlay=false) | exact | v4/v5 corpus | Stoch WPR Combo Strategy |
| two plots pane price of the shifted extremes | exact | v4/v5 corpus | Donchian Breakout Strategy |
| unsupported plots either skipped with warning or given placeholder values, but the SMA plot is preserved | exact | v4/v5 corpus | Kitchen Sink Mixed Support |
| user function | exact | v6 corpus | Custom Recursive Smoother (RMA style), Volume Weighted MACD (v5) |
| v4 handled gracefully: no crash, StrategyIR produced or clean version diagnostic | exact | v4/v5 corpus | Old School RSI (v4) |
| volume | exact | v6 corpus | Cumulative Volume Delta Proxy |
| weighted sum | exact | v6 corpus | For-Loop Weighted Average Price |
