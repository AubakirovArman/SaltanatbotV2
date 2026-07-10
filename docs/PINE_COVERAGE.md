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

**Indicators (`ta.*`)** — `sma, ema, rma, wma, vwma, hma, swma, rsi, atr, tr,
stdev, dev, variance, highest, lowest, change, mom, roc, cci, wpr, stoch, sum,
median, cum, barssince, bbw, macd, bb, crossover, crossunder, cross, rising,
falling`. (`tr`, `dev`, `bbw`, `hma`, `swma` are exact compositions of primitives.)

**Math (`math.*`)** — `abs, round, floor, ceil, sign, sqrt, log, log10, exp, pow,
max, min, avg, todegrees, toradians`, the constants `pi, e, phi, rphi`, and
`nz`/`na`/`na(x)` (na is modelled as NaN). Position/PnL reads map to context:
`strategy.position_size` (→ direction sign), `position_avg_price`, `openprofit`,
`equity`.

**History** — `x[n]` on price/series (static offset), `close[i]` with a dynamic
offset inside loops (scalar-only), `var[1]` previous-bar reads, and boolean history
`cond[n]` (the inlined condition, series-shifted).

**Orders & signals** — `strategy.entry/order/close/close_all`, `strategy.exit`
(`stop=`/`limit=` absolute prices), `plot`, `hline`, `plotshape`/`plotchar` (→ chart
markers), `alertcondition`, `alert`.

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
| Native-only indicators — `linreg, valuewhen, supertrend, sar, dmi/adx, mfi, cmo, tsi, kc, vwap, alma, cog, percentile/percentrank, mode` | No matching IR primitive yet; rebuild from supported blocks or request native support |
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
