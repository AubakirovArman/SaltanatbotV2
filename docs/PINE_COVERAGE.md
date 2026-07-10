# Pine Script → Strategy IR: coverage & fidelity

The importer (`frontend/src/strategy/pine/`) converts a pasted TradingView Pine
Script (v4, v5, or v6) into the app's editable Blockly/IR strategy or indicator.
The declaration in the script decides the artifact type: `indicator()`/`study()`
→ indicator, `strategy()` → strategy.

**Design guarantee.** The target IR is a per-bar, vectorized, `eval`-free dataflow
that must run **identically in the browser backtest and the live engine**. Every
construct that would break that guarantee (look-ahead, other-timeframe data,
non-determinism, unbounded collections) is rejected — never silently approximated
into something that trades differently live. The pipeline is *fail-closed*:

- **Hard error** — anything that would change trading semantics if approximated.
- **Skip + warning** — display-only constructs (`fill`, `bgcolor`, labels, colors…).
- **Convert + warning** — supported but with a documented approximation.

Every converted script is emitted as Blockly XML (the artifact's source of truth),
so it round-trips back through the compiler and stays editable as blocks.

## Supported

**Structure** — `//@version=`, `indicator()/strategy()` (title, `overlay`,
`default_qty_type/_value`), numeric & boolean `input.*` (bool as 0/1), immutable
bindings (inlined at each use), `var`/`varip` state, `:=`/`+=`/`-=`/`*=`/`/=`,
tuple destructuring, `if/else if/else`.

**Control flow** — `for … to … [by …]` (Pine direction inference), `while`,
`switch` (subject and subject-less, expression and statement position), the
ternary `?:` in *any* expression position, and legacy `iff()`.

**User functions** — single-expression (`f(x) => …`) and multi-line functions with
immutable locals and a final return expression, including tuple returns
(`f() => … [a, b]`) and default parameter values. Inlined by call-by-value
substitution. Rejected: recursion, and functions with internal mutable state /
side effects (`:=`, `if`, `plot`, orders in the body).

**Indicators (`ta.*`)** — `sma, ema, rma, wma, vwma, hma, swma, alma, rsi, atr,
tr, stdev, dev, variance, highest, lowest, highestbars, lowestbars, change, mom,
roc, cci, wpr, stoch, sum, median, cum, barssince, valuewhen, bbw, macd, bb,
supertrend, dmi (+ADX), mfi, cmo, tsi, kc, sar, vwap (session-anchored), linreg,
cog, percentrank, crossover, crossunder, cross, rising, falling` — the wave-3
natives (supertrend/dmi/kc return their Pine tuples). `bar_index` is supported
with a relativity warning (values are relative to loaded history).

**Math (`math.*`)** — `abs, round, floor, ceil, sign, sqrt, log, log10, exp, pow,
max, min, avg, todegrees, toradians`, the constants `pi, e, phi, rphi`, and
`nz`/`na`/`na(x)` (na is modelled as NaN). Position/PnL reads map to context:
`strategy.position_size` (→ direction sign), `position_avg_price`, `openprofit`,
`equity`.

**History** — `x[n]` on price/series (static offset), `close[i]` with a dynamic
offset inside loops (scalar-only), `var[1]` previous-bar reads, and boolean history
`cond[n]` (the inlined condition, series-shifted).

**Orders & signals** — `strategy.entry/order/close/close_all`, `strategy.exit`
(`stop=`/`limit=` absolute prices), `plot`, `hline`, `plotshape`/`plotchar`/`plotarrow`
(→ chart markers), `alertcondition`, `alert`.

**Chart drawings (display-only approximations, always warned)** — `bgcolor`/`barcolor`
conditional shading → full-height boxes; `label.new` → markers with text;
horizontal `line.new` → levels; `box.new` → zones over the firing bars; drawing
handles (`l = line.new(...)`, `if na(l)` guards) accepted; `set_*`/`delete`
mutations ignored. Comma-chained declarations (`var a = 0, var b = false`),
boolean equality (`flag == true`), and history on vars/flags/conditions
(`x[1]`, `flag[1]`, `cond[1]`) all convert.

## Rejected (with a clear message)

These are **structural** limits of a per-bar scalar IR, not missing polish:

| Construct | Why |
|---|---|
| `request.security` / other-timeframe / external data | Not available to a single-symbol per-bar engine |
| `ta.pivothigh/pivotlow`, look-ahead offsets | Confirm using *future* bars — impossible live |
| Arrays / matrices / maps, `for…in` collections | Unbounded state the scalar IR can't hold |
| Drawing objects (`label.*`, `line.*`, `box.*`, `table.*`, `polyline`) | Display-only, no trading effect |
| `str.*`, user types, string-typed logic | The IR is numeric/boolean only |
| `barstate.*`, `bar_index`, `timenow`, `time`, `varip` history, `math.random` | Non-deterministic or engine-internal |
| Recursion & stateful user functions | Can't inline without hoisting persistent state |
| `ta.kcw, ta.correlation, ta.mode, ta.percentile_*, ta.rci, ta.range` | No matching IR primitive yet |
| Trigonometry (`math.sin/cos/tan/…`) | No trig primitive in the engine |

## Test coverage

- `frontend/tests/pine.test.ts` — the original 12-script corpus + semantics + guardrails.
- `frontend/tests/pineV6.test.ts` — v6 features (functions, loops, switch, ternaries,
  nz/na, math/ta breadth, dynamic & boolean history) with per-feature semantic
  assertions, plus a 31-script corpus robustness sweep (every script converts and
  round-trips **or** fails cleanly; REJECT-tagged scripts must fail closed).
- `backend/tests/pineV6Schema.test.ts` — the backend deploy-time whitelist accepts
  exactly the new IR node shapes (frontend/backend parity).

Of the 31-script v6 corpus, everything computable in a per-bar scalar IR converts and
round-trips; the remainder are the genuine limitations above.
