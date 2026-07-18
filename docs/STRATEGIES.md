# Visual strategy builder & backtesting

SaltanatbotV2 ships a no-code strategy builder: you assemble trading logic from drag-and-drop [Blockly](https://developers.google.com/blockly) blocks, the workspace compiles into a small, safe **JSON intermediate representation (IR)** — never into an executable code string — and that same IR is interpreted by a shared evaluator. The frontend runs the IR through a vectorized backtester and a chart preview, while the backend engine runs the *identical* per-bar evaluator on live candles, so a running bot's signals match its backtest bar-for-bar.

The generated [strategy block catalog](./BLOCK_CATALOG.generated.md) lists stable block type identifiers and canonical help text directly from the source catalog.

## Contents

- [From blocks to IR](#from-blocks-to-ir)
- [Studio workflow and artifacts](#studio-workflow-and-artifacts)
- [Block taxonomy](#block-taxonomy)
- [The IR shape](#the-ir-shape)
- [Backtesting: `runBacktest`](#backtesting-runbacktest)
- [Parameter optimization and structural generation](#parameter-optimization-and-structural-generation)
- [Metrics produced](#metrics-produced)
- [Chart preview: `previewStrategy`](#chart-preview-previewstrategy)
- [Sharing a strategy via URL hash](#sharing-a-strategy-via-url-hash)
- [The same evaluator on the backend](#the-same-evaluator-on-the-backend)
- [See also](#see-also)

## From blocks to IR

Every strategy starts from a single `strategy_start` block that carries a `NAME` field and a `RULES` statement slot. `compileWorkspace()` (in `frontend/src/strategy/compile.ts`) walks the workspace, finds the top `strategy_start` block, and compiles the chain of statement blocks in `RULES` into a `StrategyIR`.

```ts
import { compileWorkspace } from "./strategy/compile";

const { ir, errors } = compileWorkspace(workspace);
// ir: { name, inputs, body }  — errors: string[]
```

Key properties of the compiler:

- **No `eval`, no code strings.** Compilation produces a plain JSON object (`StrategyIR`) made of tagged union nodes (each node has a `k` discriminator). Nothing is ever turned into JavaScript source and executed. The header comment states the intent directly: *"Compile a Blockly workspace into a safe JSON-IR (no eval, no code strings)."*
- **Disabled blocks are skipped.** `compileStatements` only compiles a block when `block.isEnabled()` is true.
- **Validation.** If there is no `strategy_start` block, compilation returns `{ errors: ["Add a Strategy block to define entry rules."] }` with no IR. If the body contains no `entry` and no `marker` statement, an error is pushed: *"Strategy has no entry rule — add a Buy/Sell, Entry, or Mark signal."* Unrecognized statement blocks push `Unsupported action block: <type>`; unrecognized value/condition blocks push `Unsupported value block:` / `Expected a condition but found:`.
- **Inputs are collected as a side effect.** A `param_number` block registers a named tunable input the first time it is seen (via `ctx.inputs`). Each schema carries `name`, `value`/`defaultValue`, `min`, `max`, `step` and `optimizationEligible`; invalid ranges are linked to the exact block as compile diagnostics.
- **Variables** declared with `var_set` are tracked in `ctx.vars` and read back with `var_get`.
- **Blockly functions are compile-time subgraphs.** Numeric arguments are substituted into reusable return/body graphs. Recursion, unknown functions and nesting beyond the fixed depth budget fail closed; no executable code is generated.

The reverse direction — generating Blockly XML for built-in indicators and templates — lives in `frontend/src/strategy/library.ts`. For example, `strategyXml()` emits a `strategy_start` block whose `RULES` statement chains `plot_series` blocks, and helpers like `maValue()` / `rsiValue()` / `bollingerValue()` / `macdValue()` build the corresponding indicator value blocks. This is how each chart indicator becomes an editable `StrategyArtifact` in the default library.

## Studio workflow and artifacts

The right-hand Studio is split into seven explicit stages: **Build**, **Validate**, **Preview**,
**Backtest**, **Optimize**, **Run** and **Learn**. Validation diagnostics select and center the
originating block. Learn shows the selected block's description, input/output contract, example and
pitfalls. The three-step wizard creates an EMA-cross, RSI-threshold or price-breakout strategy as
ordinary Blockly XML, so the result is fully editable and has no wizard-only runtime.

Artifacts use schema v2 and local semantic versions. Every meaningful save records the IR/XML hash,
parameter schema, indicator dependencies and immutable prior revision. The version panel can compare
line/metadata changes and roll back by creating a new current revision; history is never rewritten.
Dependency edges are validated for missing indicators and cycles.

Portable `.strategy` files include schema/semantic versions, SHA-256 content and IR hashes,
parameters, dependencies and provenance. Import verifies the checksum before accepting the payload;
legacy schema-v1 files use an explicit migration path. These files are the integrity-checked sharing
format. URL hashes remain a convenience for local collaboration and must not be treated as signed or
trusted packages.

## Block taxonomy

Blocks are registered by `registerStrategyBlocks()` and grouped into toolbox categories by `strategyToolbox` (both in `frontend/src/strategy/blocks.ts`). At a high level:

| Category | Blocks | Role |
| --- | --- | --- |
| **Market** | `market_price`, `market_price_offset` | Read a price field (`open`, `high`, `low`, `close`, `volume`, `hl2`, `hlc3`, `ohlc4`) from the current or an N-bars-ago bar. |
| **Indicators** | `indicator_ma` (SMA/EMA/WMA/VWMA), `indicator_rsi`, `indicator_bollinger`, `indicator_macd`, `indicator_atr`, `indicator_stdev`, `indicator_extreme` (highest/lowest), `indicator_change`, `indicator_stoch`, `indicator_wpr`, `indicator_cci`, `indicator_roc`, `plot_series` | Numeric indicator values, plus `plot_series` which draws a custom line on the chart. |
| **Math** | `param_number`, `math_number`, `math_arithmetic`, `math_round`, `math_minmax` | Constants, tunable inputs, arithmetic (`+ - * /`), rounding, and min/max. |
| **Logic** | `cross_event`, `series_trend`, `value_between`, `logic_compare`, `logic_operation`, `logic_negate`, `logic_boolean` | Boolean conditions: crosses, rising/falling trends, range checks, comparisons, and/or/not. |
| **Time** | `time_session`, `time_dayofweek` | UTC session-window and day-of-week gates. |
| **Signals** | `signal_entry`, `signal_exit`, `signal_marker`, `flow_if` | Open/close positions, draw a no-trade arrow, and conditionally run inner blocks. A legacy `trade_action` block (buy/sell/exit/alert) also compiles. |
| **Risk & Size** | `risk_stop`, `risk_target`, `risk_trailing`, `position_size` | Stop-loss, take-profit, trailing stop, and position sizing. |
| **State & Alerts** | `var_set`, `var_get`, `alert_message` | Per-bar variables and alert emission. |

Blocks are typed: value blocks declare `output: "Number"` or `"Boolean"`, and inputs declare a `check`, so Blockly only lets a numeric block plug into a numeric slot and a boolean block into a condition slot.

## The IR shape

The canonical IR type (`packages/strategy-core/index.d.ts`, re-exported by frontend/backend facades) has three node families:

- **`NumExpr`** — evaluates to a number on every bar. Examples: `{ k: "num", v }`, `{ k: "input", name }`, `{ k: "var", name }`, `{ k: "price", field, offset? }`, `{ k: "ma", kind, period, source }`, `{ k: "rsi", ... }`, `{ k: "bollinger", ... }`, `{ k: "macd", ... }`, `{ k: "atr", ... }`, `{ k: "arith", op, a, b }`, `{ k: "unary", op, a }`, and others.
- **`BoolExpr`** — evaluates to true/false. Examples: `{ k: "compare", op, a, b }`, `{ k: "logic", op, a, b }`, `{ k: "not", a }`, `{ k: "cross", dir, a, b }`, `{ k: "trend", dir, period, source }`, `{ k: "between", value, low, high }`, `{ k: "session", start, end }`, `{ k: "dayofweek", day }`.
- **`Stmt`** — an action on a bar: `entry`, `exit`, `stop`, `target`, `trail`, `size`, `setvar`, `alert`, `plot`, `marker`, and `if` (with a nested `then: Stmt[]`).

A `StrategyIR` is simply:

```ts
interface StrategyIR {
  name: string;
  inputs: {
    name: string;
    value: number;
    defaultValue?: number;
    min?: number;
    max?: number;
    step?: number;
    optimizationEligible?: boolean;
  }[];
  body: Stmt[];
}
```

Here is a compiled IR for the built-in *Price Cross EMA* strategy (buy when close crosses above EMA-21, plotting the EMA):

```json
{
  "name": "Price Cross EMA",
  "inputs": [],
  "body": [
    { "k": "plot", "label": "EMA 21", "color": "#4db6ff",
      "value": { "k": "ma", "kind": "ema",
                 "period": { "k": "num", "v": 21 },
                 "source": { "k": "price", "field": "close" } } },
    { "k": "entry", "direction": "long",
      "when": { "k": "cross", "dir": "above",
                "a": { "k": "price", "field": "close" },
                "b": { "k": "ma", "kind": "ema",
                       "period": { "k": "num", "v": 21 },
                       "source": { "k": "price", "field": "close" } } } }
  ]
}
```

## Backtesting: `runBacktest`

`runBacktest(ir, candles, config?)` (in `frontend/src/strategy/backtest.ts`) simulates the strategy bar-by-bar over historical candles and returns a `BacktestResult`.

```ts
import { runBacktest, DEFAULT_CONFIG } from "./strategy/backtest";

const result = runBacktest(ir, candles); // uses DEFAULT_CONFIG
```

### Configuration

`BacktestConfig` and its default:

| Field | Type | `DEFAULT_CONFIG` | Meaning |
| --- | --- | --- | --- |
| `initialCapital` | number | `10_000` | Starting equity. |
| `commissionPct` | number | `0.05` | Commission per side, in percent, charged on entry + exit notional. |
| `slippagePct` | number | `0.02` | Slippage applied to the fill price, in percent. |
| `allowShort` | boolean | `true` | When false, `short` entries are skipped. |
| `fillTiming` | `next_open \| same_close` | `next_open` | Default fills a signal at the following bar's open; `same_close` is legacy behavior. |
| `maxLeverage` | number | `5` | Maximum position notional as a multiple of equity. |
| `qtyStep` | number | `0` | Optional quantity step; zero disables quantity rounding. |
| `fundingRatePctPer8h` | number | `0` | Funding/borrow cost per eight hours, prorated by bar duration. |

### Bar loop semantics

For each candle, in order:

1. **Fill pending signals.** With the default `next_open` timing, an entry or exit produced by the previous closed bar fills at this bar's open. `same_close` retains the legacy same-bar close behavior.
2. **Intrabar exits.** The engine checks the stop as it stood at bar open before the target. Gap-through stops use the worse open; favourable gaps through a limit target use the better open. A trailing stop is ratcheted from this bar's extreme only for use on the next bar, avoiding look-ahead.
3. **Excursion and liquidation.** MAE/MFE are updated from intrabar extremes. If equity plus worst-case unrealized PnL reaches zero, the position is liquidated and the run stops trading.
4. **Evaluate the IR.** `execStatements(ir.body, i, rt, intents)` gathers entry, exit, risk, sizing, alert and marker intents. A per-bar operation budget bounds loops.
5. **Schedule or execute signals.** Under `next_open`, actionable intents are carried to the next bar. Under `same_close`, they execute on the current close.
6. **Account for holding costs.** Funding/borrow cost is prorated to the inferred bar duration and deducted while a position is open.

Fills use `applySlippage()`; long entries and short exits fill *higher*, the opposite fill *lower*, by `slippagePct`. Commission is `qty * (entryPrice + exitPrice) * commissionPct/100`, deducted from realized PnL.

**Sizing** (`resolveSize`) supports three modes: `units` (fixed quantity), `equity_pct` (percent of equity as notional / price), and `risk_pct` (equity × risk% divided by the per-unit distance to the stop). Risk-percent sizing without a valid stop fails closed and skips the entry. The default sizing before any `size` statement runs is `{ mode: "equity_pct", value: 100 }`.

**Stops and targets** (`resolveStop` / `resolveTarget`) each support `price` (absolute), `percent` (relative to entry), and `atr` (a multiple of ATR-14 distance). A `stopHit` is `low ≤ stop` for longs / `high ≥ stop` for shorts; a `targetHit` is `high ≥ target` for longs / `low ≤ target` for shorts.

Any position still open on the last bar is closed at that bar's close with reason `"close"` for reporting.

### Multi-symbol portfolio backtest

Strategy Studio can run the same compiled strategy on two to six markets and pass their candidate
fills through `simulatePortfolioBacktest()` from `@saltanatbotv2/backtest-core`. The allocator uses
one mark-to-market capital pool and processes funding and exits before new entries at the same
timestamp. It can cap concurrent positions, gross exposure, per-position exposure and reject a
partial allocation below a configured minimum. Only the candle range shared by every selected
market contributes to the result.

The portfolio report includes its equity curve, drawdown, peak exposure, accepted and rejected
entries, funding, per-market contribution and a synchronized-return correlation matrix. Its JSON
export uses a versioned `saltanat-portfolio-backtest-report` envelope.

The embedded risk lab measures historical 95%/99% Value at Risk and expected shortfall from
shared-equity period returns, the worst period, Ulcer Index, longest underwater recovery and
allocation concentration by accepted notional. It also runs 1,000 deterministic moving-block
bootstrap paths. Resampling contiguous return blocks retains short volatility clusters better than
independently shuffling trades; histories above the bounded observation budget are compounded into
adjacent buckets before simulation. The report exposes P5/P50/P95 profit and drawdown, probability
of loss, 50% capital loss and ruin. These are robustness estimates, not forecasts or guaranteed loss
limits.

The execution stress matrix adds four explicit counterfactual cost overlays to accepted trades:
5 bps on both entry and exit fills, 25 bps on every exit, doubled observed funding and a combined
scenario. Each extra cost is charged to the shared equity curve at the trade's exit time, producing
stressed net profit and maximum drawdown. The report also shows the additional per-fill basis-point
cost that would consume a positive baseline net profit. This is an execution-cost sensitivity test;
it does not simulate order-book capacity, changed signals or a different future market path.

The execution-quality panel performs deterministic transaction-cost attribution for the accepted
portfolio fills. It reconciles commission from recorded gross and net trade PnL, reads funding from
the execution trace and reverses the configured adverse slippage adjustment only for fill paths
where the simulator applies it. The report shows reference gross PnL, total cost drag, all-in basis
points and per-market/exit-reason breakdowns. This is modeled TCA for comparing research settings;
it is not measured order-book impact, latency or venue-quality telemetry.

This first version deliberately replays fills produced by canonical single-market backtests and
re-sizes their quantities without changing fill prices or exit reasons. A signal that reads strategy
equity therefore reads its market-local backtest equity, not the shared portfolio equity. The UI and
exported assumptions state this boundary; the result must not be described as a globally
equity-dependent signal simulation.

### Result

```ts
interface BacktestResult {
  name: string;
  trades: Trade[];           // direction, entry/exit index+time+price, qty, pnl, pnlPct, reason
  equityCurve: EquityPoint[]; // { time, equity } including unrealized PnL each bar
  markers: TradeMarker[];    // flat entry/exit markers
  signals: TradeMarker[];    // arrows from signal_marker blocks (no trade)
  alerts: { time: number; message: string }[];
  metrics: BacktestMetrics;
}
```

A `Trade.reason` is one of `"signal" | "stop" | "target" | "close" | "liquidation"`.

## Parameter optimization and structural generation

The backtest optimizer has two distinct search modes. **Grid** evaluates the Cartesian product of up
to three selected parameter axes. **Genetic** searches up to 12 selected axes in the browser UI with
a seeded, bounded population and generation count. It uses tournament selection, uniform crossover,
local mutation, elitism, canonical parameter deduplication and cached evaluations inside the
optimizer Web Worker. The same seed and inputs produce the same ranking. Genetic search is
worker-only (there is no blocking main-thread fallback), has an explicit Cancel action and reports a
separate final-holdout phase, so progress cannot reach 100% before the audit completes. Each
independent split must contain more candles than the strategy's estimated indicator warm-up; the
search fails closed with an actionable history/lookback error otherwise.

Genetic fitness combines **train + validation** net return, Sharpe, profit factor, return versus
drawdown, win rate and explicit penalties for drawdown, too few trades, liquidation, validation loss
and the train/validation generalization gap. The final temporal **test tail is never used for
selection, crossover, mutation or fitness ranking**: after the train/validation ranking is frozen,
only its preselected candidate #1 is tested once. A failed gate does not advance candidate #2, and
untested rows cannot be applied. Changing only the tail therefore cannot change the evolved genomes,
their fitness order or which genome is selected for the gate. Applying a passing result writes its
values into the matching Blockly input fields, so subsequent compile, save, export, backtest and bot
paths see the same parameters. Application is refused if the strategy, market, timeframe, bar count
or execution-cost config changed since the search. This is still a single historical split, not a
probability, forecast or permission to run the result live; walk-forward and paper validation remain
independent gates.

The **Strategy generator** in the artifact library is a separate structural tool. Its closed grammar
produces long and short trend, mean-reversion, breakout and momentum `StrategyIR` candidates, then
applies seeded structural crossover/mutation, fingerprint deduplication, node/input budgets and a
narrow validation whitelist. The result table exposes family, direction, generation, origin,
fingerprint, parent/mutation provenance and validation evidence. Import converts only a selected
valid candidate into a normal, editable portable strategy artifact; generation never starts a
backtest or bot.

Do not confuse generator evolution with optimized fitness. The browser generator itself creates
structural diversity but never fetches candles, runs backtests or scores candidates — that purity
is deliberate and preserved. Its core keeps a pure multi-market ranker for caller-supplied,
disjoint train/OOS metrics, including median/worst market, drawdown, trade-count, liquidation,
generalization and dispersion penalties. The ranker's inputs come from the server evaluation
described below; until at least one server evaluation completes, the ranking section honestly
reports itself as unavailable, and imported candidates always still require ordinary backtest,
walk-forward and paper review.

### Server multi-market evaluation (R9.1, accepted)

R9.1 is **accepted and deployed** with no migration; see the recorded
[R9.1 acceptance evidence](evidence/R9_1_SERVER_EVALUATION.md). Once the generator holds valid
candidates, its **Server evaluation (multi-market)** section submits one
`kind: "multi-market-eval"` research job per candidate to `POST /api/jobs`. The
contract is governed by [ADR 0003](adr/0003-canonical-ir-dataset-backtest-contract.md) and
documented in the [API reference](API.md): one to six unique catalog markets sharing a single
timeframe, a lookback of 500–20000 bars (default 3000) and a leakage-safe split (`trainFraction`
0.5–0.9, default 0.7; `embargoBars` 0–500, default 8); the generator seed is recorded into the
result for provenance. The server re-validates the IR through its `parseStrategyIR` trust
boundary, fetches only real closed exchange bars in-process (synthetic fills are forbidden — a
market without enough real history fails the job with an explicit reason), pins the data identity
as a `dataset-v1` SHA-256 fingerprint, splits each market so the out-of-sample window starts
strictly after training plus the embargo gap, runs train and out-of-sample backtests per market in
the backtest worker thread and finishes with one shared capital-pool portfolio run over the
out-of-sample windows. The bounded result is deterministic and stamped with the backtest engine
version: identical (IR, dataset fingerprint, config, engine version) inputs reproduce it exactly.

Completed evaluations feed the pure ranker, and the ranking section flips from unavailable to a
ranked list with its per-policy penalty breakdown; the provenance line shows the dataset
fingerprint and engine version, and results are cached per candidate + dataset fingerprint. Job
states are explicit (queued, running, failed with the server reason, cancelled) and the per-owner
quota of five active research jobs applies. The evaluation universe is the currently listed public
catalog only, so results carry survivorship bias. This is research evidence, not a performance
claim or a promotion path: a high rank starts nothing — import, backtest, walk-forward and paper
review remain the only way forward.

### Server GA evolution with lineage and promotion (R9.2, accepted)

R9.2 is **accepted and deployed** with the additive PostgreSQL 16→17 migration
`ga_evolution_lineage`; see the recorded
[R9.2 acceptance evidence](evidence/R9_2_GA_EVOLUTION.md). Everything here is research-only, and
the public strategy gallery stays out of scope until R9.3.

The pure generator primitives now live in the workspace package
`@saltanatbotv2/strategy-generator` (`frontend/src/strategy/generator` re-exports it unchanged,
so existing imports and suites are untouched). The package keeps zero IO — it never fetches
candles, runs backtests or scores candidates. The generator panel's **Server evolution (GA)**
section drives the server half: configure one to four catalog markets on a shared timeframe, the
lookback and embargo split, a seed, a population of 8–64 and 1–16 generations, then start a
`kind: "ga-evolution"` research job (documented in the [API reference](API.md)). The server
fetches real closed bars once under the R9.1 discipline, pins them with a `dataset-v1`
fingerprint and breeds each generation with the seeded package PRNG. Candidates are
fingerprint-deduplicated and never re-evaluated; every new candidate gets per-market
train/out-of-sample backtests plus a shared-capital OOS portfolio run, an objective vector (by
default net profit maximized, max drawdown minimized, Sharpe maximized, structural complexity
minimized), its lineage (parents and mutation log) and an out-of-sample report with the
direction-adjusted train-vs-OOS gap per objective, OOS loss share, cross-market dispersion and
explicit overfit/unstable flags. Pareto ranks are recomputed cumulatively; rank 0 is the
non-dominated frontier shown in the run's frontier table.

Each generation commits atomically together with a resume checkpoint (population genomes plus RNG
state), so **Cancel** ends the run as `checkpointed` rather than failed, and **Resume** continues
it exactly: the same seed and dataset produce identical candidates, objectives and lineage whether
or not the run was interrupted — the R9.2 release criterion. Resume refetches and re-fingerprints
the market data and fails explicitly with `ga_dataset_drift` when history no longer reproduces the
pinned fingerprint; determinism is never silently violated. At most one GA run per owner may be
active at a time.

**Promote** copies a frontier candidate into your **own** strategy library through the normal
portable-artifact flow, with provenance recorded: run, fingerprint, generation, seed, dataset
fingerprint, engine and generator versions, lineage chain and the OOS report. The server refuses
promotion when a candidate has no out-of-sample report or is flagged overfit
(`ga_promotion_requires_oos` / `ga_promotion_overfit`), and the UI disables the action with the
same reason. A promoted artifact is an ordinary editable strategy: it starts nothing, and
backtest, walk-forward and paper review remain the only way forward. The evaluation universe is
still the currently listed public catalog, so results carry survivorship bias.

## Metrics produced

`computeMetrics()` derives `BacktestMetrics` from the trades and equity curve:

| Metric | Definition |
| --- | --- |
| `netProfit` | `finalEquity - initialCapital`. |
| `netProfitPct` | `netProfit / initialCapital * 100`. |
| `totalTrades` | Number of closed trades. |
| `wins` / `losses` | Trades with `pnl > 0` / `pnl <= 0`. |
| `winRate` | `wins / totalTrades * 100`. |
| `profitFactor` | Gross profit / gross loss (`Infinity` if there are wins but no losses, `0` if none). |
| `maxDrawdown` / `maxDrawdownPct` | Largest peak-to-trough drop in equity, absolute and percent of peak. |
| `sharpe` | Mean bar return / std of bar returns, annualized by `sqrt(barsPerYear)`, where `barsPerYear` is derived from the median candle spacing. |
| `avgTrade` | `netProfit / totalTrades`. |
| `expectancy` | Mean PnL per trade. |
| `timeInMarketPct` | `barsInMarket / totalBars * 100`. |
| `finalEquity` | Last equity-curve value. |

## Chart preview: `previewStrategy`

`previewStrategy(ir, candles)` answers the question *"what would this strategy draw and where would it fire?"* — it deliberately runs **without position gating**, so it reports every plot line and every bar where an entry/exit/marker condition is true, independent of whether a position is open.

```ts
const { plots, signals } = previewStrategy(ir, candles);
```

- **`plots: PlotSeries[]`** — one entry per `plot` statement, each `{ label, color, points: { time, value }[] }`. Non-finite values (indicator warm-up `NaN`s) are filtered out, so lines start where the indicator becomes valid.
- **`signals: TradeMarker[]`** — a marker for every bar (from index 1 onward) whose condition fires:
  - `entry` → `buy` arrow at the bar low (long) or `sell` arrow at the bar high (short);
  - `exit` → `exit` marker at the bar high;
  - `marker` → arrow at the bar low (up) / high (down) with the block's label.

`if` statements are walked recursively so nested plots and signals are collected too. This is what the "add strategy to chart" overlay uses: the indicator lines it draws and all the points where it would have triggered.

## Sharing a strategy via URL hash

`frontend/src/strategy/share.ts` encodes a strategy into the URL hash so it can be shared by link — no server round-trip.

A `SharePayload` is `{ name, xml }` (the Blockly workspace XML). `encodeShare()` JSON-stringifies it, UTF-8 encodes it, base64-encodes it, and makes it URL-safe (`+`→`-`, `/`→`_`, trailing `=` stripped). `buildShareUrl()` produces:

```
https://<host><path>#s=<url-safe-base64>
```

On load, `readSharedFromHash()` checks for a `#s=` hash and calls `decodeShare()`, which reverses the encoding and validates the payload — it only accepts JSON whose `xml` is a string containing `strategy_start`, otherwise it returns `null` (and any decode error is swallowed to `null`). `clearShareHash()` removes the hash from the address bar via `history.replaceState` once the shared strategy has been imported.

```ts
import { buildShareUrl, readSharedFromHash } from "./strategy/share";

const url = buildShareUrl({ name, xml });      // share this link
const shared = readSharedFromHash();           // { name, xml } | null on load
```

## The same evaluator on the backend

The backtester and live bot engine use the same stateful evaluator from `packages/strategy-core`. The frontend adds historical fills, portfolio accounting and display collection around a reusable runtime; the backend uses the live convenience facade. A stateful cross-runtime parity test compares preview signals with core evaluator intents bar-for-bar.

```ts
export function evaluateBar(ir: StrategyIR, candles: Candle[], index: number): BarIntents
export function evaluateStrategyBar(ir: StrategyIR, index: number, runtime: StrategyRuntime): BarIntents
export function atrValue(candles: Candle[], period: number, index: number): number
```

`evaluateBar` builds a fresh runtime around the caller's persistent variable map, executes `ir.body` at `index`, and returns `BarIntents` (entry, exit, stop, target, trail, size, alerts, markers and budget status). Backtest/preview use `createStrategyRuntime()` plus `evaluateStrategyBar()` so pure series stay memoized across a fixed history. The live engine imports `evaluateBar` and `atrValue` through its compatibility facade as its candle buffer grows.

Every backtest is a self-contained schema-v1 research report. Immutable metadata
records strategy hash, symbol, timeframe, exchange, market/price type, complete
data range, normalized costs/execution settings, provenance fingerprint and all
fill assumptions. Data quality records requested/loaded bars and bounded gap
details. The UI exports `.saltanat-report.json`; comparison is permitted only
when `compareBacktestReports()` confirms matching settings, data and provenance.

`createBacktestReplay()` turns the versioned evaluator and execution traces into
a deterministic random-access frame per bar. Each frame joins signals,
expression explanations, variable changes, scheduled/actual fills, position
events, equity and trade boundaries. The report exposes native previous/next
buttons and a range input for keyboard-accessible stepping.

Research supports a fixed in-sample/out-of-sample split plus two deterministic
walk-forward modes. Rolling uses independent train/test windows; anchored keeps
the first bar fixed and expands training before each disjoint OOS segment. The
result view stitches OOS equity and reports the winning value range and
normalized stability of every swept parameter.

Two properties keep frontend and backend in lockstep:

- **One expression/statement evaluator.** Numeric/boolean evaluation, control flow, state mutation, alert rendering, operation budgets and intent collection live in `packages/strategy-core/evaluator.ts`. Indicators come from the adjacent canonical `ta.ts` implementation.
- **Determinism.** Series are computed by folding indicator periods to constants (`constNum`) and vectorizing pure numeric expressions once per bar-index-independent key (`getSeries` memoizes on `JSON.stringify(expr)`). Comparisons short-circuit to `false` on `NaN`, and crosses/trends require a valid prior bar, so warm-up bars behave identically in backtest and live.

Because the IR is transported as plain JSON, a strategy authored and backtested in the browser can be sent verbatim to the backend as `bot.config.ir` and produce the same intents on the same candles.

## See also

- [Project overview](../README.md)
- [Architecture](./ARCHITECTURE.md)
- [API reference](./API.md)
- [Trading engine](./TRADING.md)
- [Configuration](./CONFIGURATION.md)
