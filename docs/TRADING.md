# Paper trading & the Antares-style command language

> **Current release boundary — `public-http-paper`:** only research, backtests and paper execution are
> supported. Do not enter exchange API keys, select Binance/Bybit execution, enable live feature flags
> or attempt any real-money workflow. The adapter and key-storage sections below are retained only as
> a dormant legacy/private-live engineering reference for a separate future HTTPS/live release.

The Trade tab drives SaltanatbotV2 paper bots through a single, exchange-agnostic instruction
pipeline: an **Antares-style command string** is parsed into structured steps, each step is
normalised into an `ExecOrder`, and the simulated **paper** adapter executes it. This document
describes the command language exactly as implemented in `backend/src/trading/commands.ts`, the
current paper workflow, notifications, and the dormant live-adapter code boundary. Backtests and
paper results do not guarantee future performance and never represent real exchange fills.

---

## Workspace, robots center and account metadata

The top-level browser navigation treats chart-based observation as **Monitoring**, strategy/bot work
as **Automation**, and market discovery as the read-only **Screener**. Automation is split into
**Strategies** and **Robots**. The global **Running** control reports the authenticated running-bot
count and opens the robots/portfolio center without requiring the operator to find a particular bot
first.

The accepted/deployed R4 release replaces the ad hoc combined view with canonical owner-scoped
paper portfolios. Final SHA `bb455facdfe5a1b3cabe15490c86c299ea684ee7` passed CI run
`29560112312` (`6/6`) and was deployed in slot `r4c-schema12-bb455fa`.
It shows only state the executor-owned ledger and durable valuation evidence can prove:
balance/equity, realized/unrealized P&L, capital reservations, positions, open orders and associated
robot revisions. It has literal empty/loading/error states. Missing or stale values remain typed as
such; real exchange margin, borrowing and account telemetry are unavailable in
`public-http-paper`. The production cutover is limited to this paper-only portfolio workflow; it
does not enable HTTPS, private exchange access, live execution, real borrowing or real margin
telemetry.

Legacy Binance/Bybit registry and credential code is not an operator workflow in this release.
Existing installations may retain dormant metadata for compatibility, but users and administrators
must not add keys or treat those rows as executable accounts before the separate HTTPS/live release.

## Current paper workflow

1. Sign in with an activated account and open **Trading** or **Automation → Robots**.
2. Save and validate a strategy in Strategy Studio.
3. Create or select an active paper portfolio.
4. Create a bot, explicitly select **Paper (simulation)**, and reserve a positive allocation from
   that portfolio.
5. Choose the symbol, timeframe, virtual position size and simulated leverage.
6. Start the bot, then monitor its isolated virtual balance, positions, open orders, fills and logs.
7. Stop the bot or use the paper-only controls when the experiment is complete.

Paper bots require no exchange credentials and cannot withdraw funds or submit exchange requests.
If a screen or imported legacy configuration names Binance, Bybit, API keys, borrowing or live
execution, leave it unused in the current release.

### R4 canonical portfolio lifecycle

Production visual acceptance used Chromium 149 at 1440×900, 390×844 and 320×700 and retained eight
accepted PNG captures. Axe reported zero violations, touch-target and document-overflow checks
reported zero findings, and opener-focus restoration plus robot-drawer scrolling passed. This is
automated browser evidence, not a manual Opera/real-Android-device or VoiceOver/NVDA/TalkBack claim.

Create, rename, choose-default, archive and reset are owner-scoped durable commands. A reset is not
a delete: it closes one ledger epoch, preserves its events/revision evidence and creates the next
epoch. Previously bound robots require an explicit rebind to new capital. Archive requires all
active allocations to be released.

The create-robot form reads exact available capital and sends a fixed six-decimal USDT allocation.
Once bound, a paper robot's portfolio, epoch, allocation and revision evidence are immutable. Its
start/pause/resume/stop controls require confirmation and pass through the same fenced idempotent
command queue. A timeout is retried with the same idempotency key, not by creating a new action.
Each paper order stores a SHA-256 identity of its complete canonical JSON-safe intent before
execution. Crash-left non-terminal intents may resume only with that exact identity; terminal
orders are never resubmitted. Known paper rejections, including a missing executable price, also
receive a durable `command_completed` ledger receipt.

See [Canonical paper portfolios](./PAPER_PORTFOLIOS.md) for storage authority, API behavior,
migration, backup and rollback. HTTPS, exchange credentials and live/private execution remain out
of scope.

### DCA robot type (R6, accepted)

R6 — **accepted and deployed**; see the recorded
[R6 acceptance evidence](./evidence/R6_DCA_PAPER_ROBOT.md) — adds a second paper robot type
next to strategy robots. The create form gains a robot-type toggle (**Strategy | DCA**); the DCA
panel replaces the strategy picker with direction and the `dca-params-v1` inputs (base and safety
order sizes, safety-order count, price deviation, step/volume scales, take-profit, optional
stop-loss/trailing/cycle-duration limits and cooldown), each validated inline. The form shows a
live worst-case capital preview computed by the exact shared contract math against the
portfolio's available capital and blocks submission when the reserved allocation cannot cover it;
the server enforces the same limit. The robot detail drawer adds a DCA section with the cycle
phase, safety orders filled/total, average entry, next safety price, take-profit target and
cooldown, plus the parameters and worst case in a disclosure. DCA robots are research-only paper
simulation like every other robot here. Exact parameters, formulas, the cycle state machine,
averaging fill model, determinism and restart semantics:
[Canonical paper portfolios](./PAPER_PORTFOLIOS.md).

## 1. The command language

Manual commands are entered on the Trade tab and executed against a running bot via `TradingEngine.manualCommand()`, which calls `parseMessageSet()` and runs the resulting steps in order.

### 1.1 Three-level grammar

```
messageset := command ( "::" command )*      // "::" chains commands
command    := param ( ";" param )*           // ";" separates params
param      := key=value | flag! | flag^ | pause=ms | randpause=a-b
```

| Separator | Meaning |
| --- | --- |
| `;` (or a newline) | Separates parameters **within** one command. |
| `::` | Chains commands. Each chained command runs strictly in sequence. |

Parsing is done by `parseMessageSet()`, which splits on `::`, trims, drops empty parts, and parses each segment into a `CommandStep { command?, delayMs }`.

### 1.2 `param=value` syntax and the default action

Each parameter is a `key=value` pair. Keys and enum values are lower-cased before matching, so the parser is case-insensitive. If no `action` is given, the action defaults to **`neworder`**. These two are equivalent:

```text
mktype=spot;symbol=XRPUSDT;side=buy;type=market;qty=20
action=neworder;mktype=spot;symbol=XRPUSDT;side=buy;type=market;qty=20
```

Legacy key synonyms are normalised automatically (`normalizeKey`):

| Legacy key | Canonical |
| --- | --- |
| `leverage` | `lev` |
| `ququantity` | `quqty` |
| `openquantityproc` | `openpro` |
| `closequantityproc` | `closepro` |
| `priceproc` | `pricepro` |
| `stoppriceproc` | `trgpricepro` |
| `stopprice` | `trgprice` |
| `clientorderid` | `clientid` |
| `reduce` | `reduceonly` |
| `market` | `mktype` |

### 1.3 The `!` and `^` boolean flags

A trailing `!` means **true**, a trailing `^` means **false**. This works both as a bare flag and appended to a value:

```text
reduceonly!        →  reduceonly=true
dualside^          →  dualside=false
```

These map to the truthy/falsy fields in `ExecOrder`. A value is treated as truthy (`truthy()`) when it equals `true`, `1`, or `yes`. Flags recognised by `commandToExec()` include: `levforqty`, `reduceonly` (and `closeposition`, which also forces `reduceOnly`), `dualside`, `isisolated`, `ignoreside`, `upsert`, `forcereplace`, `includelimit`, and `clearstage`.

### 1.4 `pause` and `randpause`

Delay directives are handled per step by `parseStep()`. They set the step's `delayMs`, which the engine applies **after** the step's command runs:

| Directive | Effect |
| --- | --- |
| `pause=1000` | Fixed 1000 ms delay. |
| `randpause=300-900` | Random delay drawn uniformly from `[a, b]` inclusive (the upper bound is clamped to be ≥ the lower bound). |

The engine caps any single delay at **10 000 ms** (`Math.min(step.delayMs, 10_000)`). A typical manual reversal uses a pause to let margin free up between closing and re-opening:

```text
mktype=futures;symbol=ETHUSDT;side=buy;type=market;closepro=100;reduceonly!::pause=500;mktype=futures;symbol=ETHUSDT;side=sell;type=market;qty=0.05;lev=2
```

### 1.5 Action aliases and shorthands

`action=` selects the operation, but several friendly aliases resolve to the same action (`ACTION_ALIASES`), e.g. `order → neworder`, `entry → openposition`, `exit`/`exitposition`/`closepos → closeposition`, `exitall`/`closeall`/`closeallpositions → exitallpositions`, `reverse → turnover`, `cancelallorders → cancelall`, `setvalue → set`.

Some actions accept a shorthand where the action keyword itself carries a value (`parseOne()`):

| Shorthand | Expands to |
| --- | --- |
| `closepos=XRPUSDT` | `action=closeposition;symbol=XRPUSDT` |
| `get=BALANCE` | `action=get;value=BALANCE` |
| `set=LEVERAGE` | `action=set;value=LEVERAGE` |
| `cancelorder=symbol` | `action=cancelorder;by=symbol` |

For most actions, a bare `action=SYMBOL` form sets `symbol` (upper-cased) unless the value is literally `symbol`.

---

## 2. Supported actions

`CommandAction` covers the fourteen Antares actions. Each is mapped to an internal `ExecAction` by `mapAction()` and interpreted by the adapter. The table below reflects the behaviour implemented in the **paper** adapter (`exchange/paper.ts`), which is the reference implementation; the live adapters implement a subset (see §4).

| Action (aliases) | Internal | What it does |
| --- | --- | --- |
| `neworder` (`order`) | `neworder` | Create an order. A `type=market` order fills immediately; if `reduceonly` or `closepro` is set it is routed to `close`. Any other `type` rests in the book until triggered. |
| `openposition` (`entry`) | `open` | Market-open a position and attach reduce-only protection (`stop`, `tp`). Fails if already in a position on the symbol unless `clearstage` is set. |
| `closeposition` (`exit`, `exitposition`, `closepos`) | `close` | Close a position fully or partially. Size = `qty`, else `closepro` %, else 100 %. Side is derived from the open position. |
| `exitallpositions` (`exitall`, `closeall`, `closeallpositions`) | `flatten` | Market-close the position and clear the entire order book. |
| `openorders` | `openorders` | Place a resting **limit** entry plus reduce-only protective stop/TP that act once it fills. `type` is forced to `limit`. |
| `spreadentry` | `spreadentry` | Open one market slice immediately, then place `spreadcount - 1` limit orders spread across `spreadperc` % of a base price. |
| `chporders` | `chporders` | Replace SL/TP of an **existing** position without closing it. Changing the stop clears existing stop orders; changing TP clears existing TP orders. |
| `turnover` (`reverse`) | `turnover` | Paper/reference action that reverses the position: close the current side and open the opposite. Live execution is disabled until both child actions have independent durable lifecycles. |
| `cancelorder` | `cancel` | Cancel resting orders by selector `by` ∈ {`symbol`, `side`, `type`, `id`, `all`}. Defaults to `id` when an id is supplied, else `symbol`. |
| `cancelall` (`cancelallorders`) | `cancelall` | Cancel all resting orders (for `symbol` if given, otherwise the whole book). Positions are untouched. |
| `cancelorphans` | `cancelorphans` | Cancel protective SL/TP orders left with no open position. `includelimit!` also cancels resting `limit` orders. No-op while a position is open. |
| `replaceorder` | `replace` | Paper/reference action that modifies a resting order matched by `orderid` or `clientid` (side/price/qty/trgprice). With `upsert!`, creates the order if not found. Live execution is disabled until cancel/new child actions have independent durable lifecycles. |
| `get` | `get` | Read data: `PRICE`/`SYMPRICE`, `OPENPOS`/`POSITIONS`, `ORDERS`, `DUALSIDE`/`POSITIONMODE`, else account balance/equity (`BALANCE`). |
| `set` | `set` | Set an account/position parameter: `LEVERAGE`, `DUALSIDE` (hedge mode), `ISOLATEDMARGIN`. |

### 2.1 Order-parameter reference

These parameters populate `ExecOrder` via `commandToExec()`:

| Param | Field | Meaning |
| --- | --- | --- |
| `mktype` | `market` | `spot` or `futures` (default `futures`; anything other than `spot` is treated as futures). |
| `symbol` | `symbol` | Trading pair, upper-cased. Falls back to the bot's symbol if omitted. |
| `side` | `side` | `buy`/`long` → `buy`; `sell`/`short` → `sell`. |
| `type` | `type` | `market`, `limit`, `stop_market`, `stop_limit`, `tp_market`, `tp_limit` (default `market`). |
| `qty` | `qty` | Absolute base quantity. |
| `quqty` | `quoteQty` | Quote-denominated size (converted to base by the adapter). |
| `openpro` | `openPct` | % of free balance to open with. |
| `closepro` | `closePct` | % of position to close. |
| `depopro` | `depoPct` | % of total deposit to open with. |
| `lev` | `leverage` | Leverage. |
| `levforqty` | `levForQty` | Multiply the computed quantity by leverage. |
| `reduceonly` | `reduceOnly` | Reduce-only (no reversal). Also set when `closeposition` is truthy. |
| `price` | `price` | Limit price. |
| `trgprice` | `trgPrice` | Trigger price for stop/TP. |
| `pricepro` | `pricePro` | Limit price as ± % of mark. |
| `trgpricepro` | `trgPricePro` | Trigger as ± % of mark. |
| `tif` | `tif` | `GTC`, `IOC`, or `FOK`. |
| `clientid` | `clientId` | Client order id. |
| `orderid` | `orderId` | Exchange order id (for replace/cancel). |
| `by` | `by` | Cancel selector (`order` is normalised to `id`). |
| `stop` | `stop` | Stop level: `stop=5%` (percent basis) or `stop=29000` (absolute price). |
| `tp` | `takeProfits` | One or more TP levels — see §2.2. |
| `spreadperc` | `spreadPerc` | Spread width % for `spreadentry`. |
| `spreadcount` | `spreadCount` | Number of orders (incl. the market slice) for `spreadentry`. |
| `value` | `getValue`/`setValue` | Target of `get`/`set` (upper-cased). |

### 2.2 Take-profit levels

TP levels are parsed by `parseTpLevels()` from bracket groups, accepted both back-to-back and comma-separated: `tp=[10%,40%][25000,0.001]` or `tp=[10%,40%],[25000,0.001]`. Each group is `[price,qty]` with an optional third element `[price,qty,limit]`:

- A `%` on the price makes it a **percent** basis (offset from the entry price); otherwise it is an absolute price.
- A `%` on the qty makes it a **percent** of the position; otherwise it is an absolute base amount. Omitting the qty defaults to 100 %.
- Supplying the third `limit` element makes the level a **TP_LIMIT**; otherwise it is **TP_MARKET**.

Stop basis works the same way in `parseStop()`: a trailing `%` selects percent basis, otherwise the value is an absolute price.

---

## 3. The paper engine (default execution mode)

When a bot's `exchange` is `paper`, `TradingEngine.buildAdapter()` constructs a `PaperAdapter` — a fully simulated exchange with a real order book. It is the default and requires no API keys. Its parameters:

| Setting | Value |
| --- | --- |
| Start balance | `10 000` USDT (or `max(sizeValue * 10, 10 000)` when sizing by quote). |
| Fee | `0.05 %` per fill (`feePct`). |
| Slippage | `0.02 %`, applied against you on entry/exit (`slipPct`). |
| Currency | `USDT`. |

### 3.1 Resting orders and tick-based fills

`neworder` with any non-market type places a `PendingOrder` in the book. On every price tick the engine calls `onPrice()`, which fills any resting order whose trigger/limit condition is crossed (`triggered()`):

| Type | Fills when |
| --- | --- |
| `limit` | buy: price ≤ limit; sell: price ≥ limit. |
| `stop_market` / `stop_limit` | sell-stop: price ≤ trigger; buy-stop: price ≥ trigger. |
| `tp_market` / `tp_limit` | sell-TP: price ≥ trigger; buy-TP: price ≤ trigger. |

Without an executable-depth source, limit and `*_limit` orders use their stored `price`; market and
`*_market` conditionals use the tick plus the configured adverse slippage. When a verified executable
quote is supplied, both entries and exits require enough reported quantity and use that quote's price;
invalid or insufficient liquidity leaves the order unfilled. The engine holds a **single one-way
position per symbol**: an opposing fill reduces or closes it (realising PnL net of fees), and once a
position is fully closed, any remaining reduce-only protective orders are dropped from the book.

### 3.2 Durable event ledger and funding

Paper state is reconstructed from the per-bot, append-only `paper_events` ledger. It records account
initialization, order upserts/cancellations, fills, fees, realized-PnL cash movements, position changes,
funding settlements and account settings. Sequence gaps, conflicting event IDs/sequences/idempotency
keys, unknown event types and unverified funding fail closed. Exact redelivery of the same event is a
no-op. The durable append happens before the in-memory transition becomes authoritative; a storage
failure rolls the simulated command back.

Funding changes paper cash only through `applyFundingSettlement()` with a verified settlement ID,
symbol, rate, mark price, timestamp and source. Replaying the same settlement ID is idempotent. The
simulator does **not** infer funding from a current rate, elapsed time or missing venue data, so it
cannot invent a credit. Positive funding is paid by longs and received by shorts; a negative rate
reverses that direction.

For backward compatibility, a bot with no ledger imports its old `paper:<botId>` snapshot once. As
soon as events exist, recovery always uses the ledger; the compatibility snapshot is not an alternate
source of truth.

### 3.3 Multi-leg paper recovery journal

Operators with the `paper-trade` role can open **Multi-leg paper journal** in the Trade sidebar.
Paste the exact, unexpired `paper-multi-leg-plan-v1` JSON produced by an N-leg or route-family
research engine and keep the generated idempotency key for retries of that same plan. The panel
shows restart-recovery state, recent runs, terminal status and every append-only original fill,
compensation decision, reverse fill and terminal event. It is available in English, Russian and
Kazakh and pauses its ten-second refresh loop while the browser tab is hidden.

This workflow is separate from bot paper trading. It accepts no exchange keys, sends no private
request and can never place a live order. A `manual-review-required` result means the deterministic
compensation scenario left an exact unresolved paper quantity; it is not an instruction to send a
real order.

Supported Screener rows now have a one-click **research handoff** to Automation. It transfers a
strict, short-lived `market-opportunity-v1` envelope and opens a card with legs, economics, source
evidence and explicit blockers. The envelope always blocks live execution and is **not** the exact
`paper-multi-leg-plan-v1` required by this journal. A research card may open the journal only when its
paper boundary says a verified plan is possible; the operator must still supply the separate exact,
unexpired plan JSON before a simulation can start. Clicking the Screener action alone therefore
cannot submit a paper or live order.

### 3.4 Quantity resolution

`resolveQty()` picks the first source present, in priority order: `qty` → `quqty` (÷ price, × leverage if `levforqty`) → `openpro`/`depopro` (% of balance × leverage ÷ price) → `closepro` (% of the open position).

That priority describes paper/general command resolution. Every **risk-increasing live** order must
already contain an explicit positive base `qty` before preflight; `quqty`, `openpro` and `depopro`
cannot be used to create live exposure. Live exits and cancellation are subject to the narrower
action allowlist below; a risk limit never converts an unsupported compound command into a safe one.

---

## 4. Dormant legacy/private-live reference — Binance & Bybit

> **Not available in `public-http-paper`.** This section documents dormant implementation details for
> maintainers; it is not a setup guide. Do not store exchange credentials, change `DEMO_MODE`, enable
> `ENABLE_LIVE_SPOT`, arm live trading or create a Binance/Bybit execution bot. A future release must
> introduce HTTPS, isolated per-user credentials, reviewed deployment controls and a separately
> verified live rollout before any of these paths may become operator-accessible.

The repository retains Binance and Bybit adapter code and legacy setting names
(`keys:binance` / `keys:bybit`) for compatibility and future hardening. In the current release,
non-paper execution remains outside the supported runtime contract.

Live bots are fail-closed unless `maxPositionQuote`, `maxOrderQuote`, `maxDailyLossQuote` and
`maxOpenOrders` are all positive; leverage is the bot's maximum permitted leverage. The server
validates these values on save and again at every start/resume. Immediately before a live adapter
receives a risk-increasing order, it checks daily realized loss, order notional, projected position,
leverage and the resulting open-order count. The decision is bound to the bot's exact symbol/market
and a just-received venue price; a command-supplied market price cannot reduce measured risk. Existing
non-reduce resting orders reserve position capacity, and concurrent strategy/manual submissions are
serialized through the exact exchange+market+symbol execution lock. Live starts use a separate
exchange+symbol lock, so two concurrent start requests cannot pass collision/reconciliation checks
together even when they request different markets. Futures leverage must be acknowledged or
reconciled before entry; an ambiguous or mismatched result fails closed. Every risk-increasing live
order requires an explicit positive base `qty`; an unmeasurable quantity and unsupported live action
are rejected.
Only venue-enforced futures reduce-only orders bypass entry caps.

The manual live-action allowlist is intentionally narrower than the paper command language. Exact
`neworder`/`open` submissions pass the full risk and durable-lifecycle checks; `close`, `cancelall` and
the read-only `get` action are also allowed. `get` executes as a read and deliberately creates no
durable order-journal row. Live `replace`, `turnover`, `openorders`, `spreadentry`, single-order
`cancel`, `cancelorphans`, account-wide `flatten`, `set` and `chporders` fail closed until their venue
semantics and every child mutation have an independently reconcilable lifecycle. Account-wide cancel
and flatten remain available only through the dedicated audited emergency-stop workflow described
below, not by disguising them as a manual bot command.

Spot exposure uses only this bot's confirmed attributed inventory plus durable journal reservations.
Reservations remain active for accepted, partially filled and even venue-filled orders until their
executions have been committed to local accounting. Cancelled/expired rows retain only an unaccounted
partial fill, while legacy `replaced` rows conservatively retain their entry quantity until accounting
proves it. Pending spot buys reserve exposure, while pending spot sells reserve attributed quantity so
concurrent closes cannot sell the same inventory twice.

Futures exposure sums every exact-symbol position leg, including hedge mode, and compares that venue
total with the durable gross quantity committed by confirmed fills. Preflight uses the larger value,
so a lagging `positions()` response cannot erase newly accounted exposure. If one venue order matches
one journal reservation, quantity and price are merged by conservative maximum rather than added or
trusted independently. Multiple identity matches, duplicate matches, a side mismatch or a
risk-increasing/reduce-only conflict fail closed.

Only one live bot may own an exchange+symbol at a time, even when the bots select different spot and
futures markets. The `override` start field cannot bypass a live collision; the existing bot must be
stopped and its state reconciled first.

If a venue has already accepted an entry but rejects or fails to acknowledge the requested SL/TP,
the accepted entry is not rewritten as a rejected order. The bot keeps managed-position state,
pauses, and retains the durable entry reservation. A best-effort reduce-only emergency close uses a
distinct `…-safety` client identity and must return its own venue order ID. Its acceptance is reported
separately and both entry/close executions must still reach authenticated accounting; a missing ID or
failed close is surfaced explicitly as a possible unprotected-position incident.

The retained live code includes a transport gate for exchange-key storage and risk-increasing
mutations. Passing that gate through HTTPS or localhost would still **not** enable live execution in
`public-http-paper`; transport security alone is not authorization for a dormant feature.
`X-Forwarded-Proto` is honoured only when the operator configured `TRUST_PROXY`.

### Dormant account-level emergency-stop design

`POST /api/trade/kill` is a durable, idempotent workflow rather than a UI-only bot stop. It first
disarms live trading and atomically changes the execution gate to `stopping`, so strategies and
manual commands cannot submit another live order. It then stops all bot runtimes, enumerates every
open order on each configured/running Binance and Bybit spot/futures account, cancels by symbol, and
polls the account again. Success is returned only when reconciliation proves that no open order
remains. `GET /api/trade/kill` exposes the persisted operation and per-account result.

The default button deliberately **leaves positions open**. The separate flatten action requires both
an explicit UI confirmation and `confirmFlatten=FLATTEN_ALL_LIVE_POSITIONS`; it enumerates futures
positions, submits 100% reduce-only market closes, and verifies that every position is flat. It never
sells spot holdings. Each request should carry a UUID `operationId`: retrying the same UUID returns
the same persisted result without repeating exchange actions. An interrupted `stopping` operation is
restored as `partial_failure`; unresolved orders, positions, adapter errors, or bot-stop failures also
produce `partial_failure` (HTTP 207), never a false success. Live trading cannot be re-armed until a
new retry reaches `terminal` with `ok=true`.

The dormant Bybit live-spot path is fail-closed by default and contains an
`ENABLE_LIVE_SPOT` override in legacy code. The
engine tracks bot-attributed quantity, weighted average, base/quote fee assets and remaining quantity
from deduplicated confirmed v5 executions. Automated and manual bot closes use only that attributed
quantity, never the account-wide base balance. A restart restores inventory but pauses the bot until
the operator verifies the exchange balance and confirms resume. Binance live spot remains disabled
until authenticated spot execution accounting exists.
A future live rollout would require paper and funded testnet validation before any mainnet review;
the retained Bybit live-spot path remains experimental.

No live path is presented as mainnet-ready. The continuous funded 7–14-day Binance/Bybit exchange
soak is explicitly excluded from the current verified scope.

Every mutating live request is journaled before network I/O. A definitive HTTP/API rejection becomes `rejected`; a network/HTTP 5xx failure, or an unreadable, truncated, malformed or identity-free HTTP 2xx response during POST/DELETE, is ambiguous and becomes `unknown`, because the venue may have accepted the request. The engine preserves the reservation and never blindly resubmits that mutation. Authenticated Binance USDⓈ-M and Bybit v5 private streams are the primary order-state source; the Bybit `order` + `execution` topics cover enabled spot and linear trading. Bounded signed REST polling runs every 30 seconds only while the stream is unavailable. Disconnect and reconnect edges force an immediate REST gap reconciliation. Poll and stream snapshots enter through one identity-aware ingest boundary: reconnect replays are idempotent, crossed or conflicting client/venue IDs are rejected without rebinding, cumulative filled quantity cannot decrease, and accepted/partial/terminal state cannot regress. A venue terminal status does not release reserved risk until the corresponding execution has been committed to accounting; if REST polling or reconnect reconciliation reaches a terminal state without that execution evidence, the bot is paused for operator reconciliation.

While a bot is running, its in-memory configuration is the authorization identity for update, start,
stop, resume and command routes. `POST /bots` rejects an update to that ID with `409`, so persisted
paper configuration cannot replace a live runtime identity. Safe stop/delete first blocks new order
producers, closes feeds and drains command, market-event and order critical sections. A later manual
live start performs signed order reconciliation when durable state or journal evidence already exists.

An accepted live close is handled by the same proof boundary: HTTP/order acknowledgement alone does
not clear the bot's managed position. Managed state stays intact and the bot is paused until an
authenticated execution is committed; only then can local state become flat.

Trading schema v2 durably stores orders, order events, confirmed fills, the latest position/manual-action
snapshot and logical strategy runs. Protected entries additionally record the execution lifecycle from
`entry_submitted` through `open_protected` or `open_unprotected/error`. Binance supplies entry/SL/TP
order IDs. Bybit supplies the entry ID and a typed `exchange_ack` for its position-level
`trading-stop` endpoint, which does not return individual protective-order IDs.

Before a protected futures entry performs exchange I/O, the journal also receives separate,
deterministically named reduce-only child intents for the stop (`…-sl`), every take-profit
(`…-tp1`, `…-tp2`, …) and a possible emergency close (`…-safety`). These rows are operator-visible
close lifecycles, not duplicate entries. When no emergency close is needed, its pre-written safety row
ends as rejected with an explicit “not required” result. Binance child rows can retain their venue
order IDs. Bybit position-level `trading-stop` can be confirmed without any correlatable child order
ID, so the local SL/TP rows remain accepted with that limitation stated in their message; the local
deterministic ID must not be mistaken for a venue order ID. Missing or unmatched protection/execution
evidence remains fail-closed and requires operator reconciliation.

Trade executions additionally persist the venue execution ID, incremental
quantity/price, actual commission amount and asset, and venue realized PnL.
Duplicate execution IDs after reconnect do not create a second fill. The fill
journal displays both fee amount and asset.

Binance USDⓈ-M renews its 60-minute listenKey every 50 minutes and rotates it after expiry. It is
not spot execution accounting. Bybit authenticates with HMAC-SHA256, subscribes to both `order` and
`execution` for enabled spot/linear bots, and sends a heartbeat every 20 seconds. Both transports use
capped reconnect backoff and are closed during bot stop or server shutdown. Bybit live spot remains
explicitly armed and inventory-constrained; a missing confirmed execution prevents automated close
rather than falling back to an unrelated account balance.

Before a live bot resumes after process restart, the engine sequentially queries signed order status for every `intent`, `unknown`, `accepted`, and `partially_filled` journal row. A matching open order is only a fallback proof for ordinary order placement; it cannot prove that an interrupted cancel or legacy replace command completed. Missing, conflicting, regressing, or action-ambiguous evidence leaves the existing durable state intact, records crash-left intent as `unknown`, and pauses trading for operator review. Already-terminal journal rows are not blindly queried or rewritten, but any unaccounted terminal execution remains reserved and blocks or pauses automation.

### 4.1 Dormant Binance adapter (`exchange/binance.ts`)

- **Markets:** signed REST code exists for Spot (`api.binance.com`) and USDⓈ-M Futures
  (`fapi.binance.com`), but live Spot submission is disabled until authenticated spot execution
  accounting exists. Only USDⓈ-M is available as an experimental live path.
- **Signing:** every private call goes through `signed()`, which builds a query string with `timestamp` and `recvWindow=5000`, computes an **HMAC-SHA256** signature with the API secret, appends it as `signature`, and sends the API key in the `X-MBX-APIKEY` header.
- **Orders:** market by default; `limit` sends price + TIF; conditional types send `stopPrice`. On
  futures, `openposition`/entry can also attach a `STOP_MARKET` (`closePosition`) and
  `TAKE_PROFIT_MARKET` reduce-only orders. The adapter can resolve `close`/`flatten` from the live
  position, but the common manual live preflight permits exact `close` and blocks `flatten`; account
  flatten uses the emergency-stop workflow. The presence of Spot REST methods does not enable live
  Spot trading.
- **Set:** adapter methods exist for futures `LEVERAGE`, `ISOLATEDMARGIN` (`marginType`) and
  `DUALSIDE` (`positionSide/dual`), but the common manual live preflight currently blocks `set`.

### 4.2 Dormant Bybit adapter (`exchange/bybit.ts`)

- **Markets:** v5 unified API. `linear` category for USDT futures, `spot` for spot.
- **Signing:** execution and account operations share `exchange/bybitClient.ts`; it builds an **HMAC-SHA256** signature over `timestamp + apiKey + recvWindow + payload` (query string for GET, JSON body for POST) and sends `X-BAPI-API-KEY`, `X-BAPI-TIMESTAMP`, `X-BAPI-RECV-WINDOW`, and `X-BAPI-SIGN` headers with `recvWindow=5000`. A non-zero `retCode` is raised as an error.
- **Orders:** `Market`/`Limit`, with `triggerPrice` + `triggerDirection` for conditionals. Futures
  adapter code can resolve `close`/`flatten` from the live position, but manual live preflight permits
  exact `close`, blocks `flatten`, `replace` and `turnover`, and permits only `cancelall` from the
  cancel family. Account flatten uses the emergency-stop workflow.
- **Set:** adapter methods exist for futures `LEVERAGE` (`set-leverage`), `ISOLATEDMARGIN`
  (`switch-isolated`) and `DUALSIDE` (`switch-mode`), but the common manual live preflight currently
  blocks `set`.

### 4.3 Dormant Bybit UTA cross-collateral and debt design

This code is not exposed as a supported workflow in `public-http-paper`. Its retained design reads
Bybit Unified Trading Account margin and debt without flattening the account into one balance. It
models account IMR/MMR, initial and maintenance margin, per-coin wallet/equity/USD value, spot versus
derivatives liability, accrued interest, hourly variable rate, borrowing quota/usage, collateral
switches and platform collateral restrictions.

The dormant mutation design separates:

- `POST /bybit/uta/borrow` creates only a manually confirmed variable-rate loan. Live trading must be armed; the server rejects isolated margin, missing funded collateral, unavailable coins, account MMR at or above 50%, and projected borrowing usage above 80%.
- `POST /bybit/uta/repay` uses Bybit's no-conversion repayment by default. Allowing Bybit to convert collateral requires a separate second confirmation because it can sell collateral and charge a conversion fee.
- `POST /bybit/uta/collateral` explicitly changes a supported coin's collateral switch. USDT/USDC are exchange-managed and cannot be toggled here.

The future live release would have to keep borrowing and repayment operator-only, CSRF-protected and
audit logged. The current release disables this surface completely; do not enter keys, borrow funds,
toggle collateral or try to work around the public-HTTP boundary.

### 4.4 The strategy-driven path

Beyond manual commands, a running strategy emits entry/exit intents on each closed bar
(`onClosedBar()`). In the current release those intents are handled only by the paper engine, which
keeps stop/target management inside `onTick()`. The remaining live-protection behavior in this
section is dormant reference code and must not be treated as an available execution mode. Position
sizing follows the bot's `sizeMode` when the strategy does not specify a size.

---

## 5. Notifications (Telegram + VK)

`notifications.ts` fires messages to any enabled channel on lifecycle events. The engine calls `notify()` on start, stop, position open, position close (including resting-order fills), and signals/alerts (when `notifyMarkers` is on). Each event has an icon:

| Event | Icon | Fired when |
| --- | --- | --- |
| `start` | ▶️ | Bot started. |
| `stop` | ⏹️ | Bot stopped. |
| `open` | 🟢 | Position opened. |
| `close` | 🔵 | Position closed / reduce-only fill. |
| `error` | ⚠️ | Error condition. |
| `signal` | 🔔 | Marker / alert signal. |

- **Telegram:** POSTs to `api.telegram.org/bot<token>/sendMessage` with the configured `chatId`, `parse_mode: HTML`, and web-page preview disabled. HTML is escaped.
- **VK:** POSTs to `api.vk.com/method/messages.send` with `access_token`, `peerId`, API version `5.199`, and a `random_id`. HTML tags are stripped before sending.

A channel is only used when it is `enabled` **and** its token and destination id are non-empty. Failures are swallowed (`Promise.allSettled`). `testNotify()` sends a test message to verify configuration. The config lives in the `notify` setting; both channels default to disabled.

---

## 6. Dormant API-key storage reference

> `public-http-paper` does not require exchange credentials. Do not enter or provision API keys for
> the current release. The details below describe retained legacy storage code for migration and
> security review before the separate HTTPS/live release.

Legacy secrets are stored via the `store.ts` settings table in a local SQLite database
(`data/trading.db`), with an `encrypted` flag per row. Retained exchange-key rows are encrypted and
are not returned to the browser.

**Key derivation.** Only a first run with no `trading.db` may atomically create `data/.secret` from
32 random bytes with `0o600` permissions. Existing databases require their existing owner-only,
regular key file. The loader derives the same 32-byte scrypt key from the exact legacy file value
(including one historical trailing LF/CRLF), then authenticates every existing encrypted row over a
read-only SQLite/WAL view before migrations or database writes. It never replaces a missing key or
repairs suspicious permissions. An owner-only SQLite coordination database holds an exclusive lock
for the whole backend lifetime, so a second initializer/executor fails before touching `trading.db`;
the OS releases that lock after either graceful shutdown or a crash.

**Cipher.** `encrypt()` uses **AES-256-GCM**: a fresh random 12-byte IV per value, the derived key, and the GCM auth tag. The stored value is `base64(iv).base64(tag).base64(ciphertext)`. `decrypt()` reverses this and verifies the auth tag, so tampered ciphertext fails to decrypt.

```text
data/.secret          → 32 random bytes, mode 0600, scrypt → 256-bit key
settings.value        → "<iv>.<tag>.<ciphertext>"  (AES-256-GCM, per-row IV)
```

> **Current security summary:** paper mode needs no exchange credentials and is the only supported
> execution mode. Encryption-at-rest does not make public HTTP suitable for credentials or live
> trading. Key entry and all live workflows remain unavailable until the separate HTTPS/live release.

---

## 7. Worked examples

All commands in this section are for a bot explicitly configured with `exchange=paper`. Do not run
them against an exchange adapter or reinterpret simulated fills as executable venue instructions.

**Simple spot market buy (default `neworder`):**

```text
mktype=spot;symbol=XRPUSDT;side=buy;type=market;qty=20
```

**Open a futures long with attached stop and two take-profits, one command:**

```text
action=openposition;mktype=futures;symbol=ETHUSDT;side=BUY;qty=0.05;lev=5;stop=3%;tp=[3200,50%][3400,50%]
```

**Resting conditional take-profit (reduce-only), fills on a future tick:**

```text
mktype=futures;symbol=BTCUSDT;side=sell;type=tp_market;closepro=100;trgpricepro=5;reduceonly!
```

**Distributed (spread) entry — one market slice + three limits across 1.5 %:**

```text
action=spreadentry;mktype=futures;symbol=ETHUSDT;side=BUY;qty=50;price=3000;spreadperc=1.5;spreadcount=3;stop=2%;tp=[3150,100%]
```

**Update protection on an open position without closing it:**

```text
action=chporders;mktype=futures;symbol=ADAUSDT;stop=0.48;tp=[0.55,50%][0.60,50%]
```

**Manual reversal with a chained pause (close → wait 500 ms → open opposite):**

```text
mktype=futures;symbol=ETHUSDT;side=buy;type=market;closepro=100;reduceonly!::pause=500;mktype=futures;symbol=ETHUSDT;side=sell;type=market;qty=0.05;lev=2
```

**Read balance on spot, then price on futures, in one message set:**

```text
mktype=spot;get=BALANCE::mktype=futures;get=PRICE;symbol=BTCUSDT
```

**Set leverage, then cancel every resting order on a symbol:**

```text
set=LEVERAGE;symbol=BTCUSDT;lev=10;mktype=futures::action=cancelall;symbol=BTCUSDT;mktype=futures
```

---

## 8. Dormant live-adapter rate-limit and host-clock reference

Signed Binance and Bybit calls share one in-process circuit per exchange. HTTP `429` and Binance
`418` open the circuit for `Retry-After` (with bounded safe defaults), so other bots cannot continue
hammering the same venue. Signed mutating requests are not automatically replayed.

Before sending, the same guard reserves request weight in a bounded local window
and retains headroom for protection/reconciliation. Binance
`X-MBX-USED-WEIGHT-1M` and Bybit `X-Bapi-Limit*` headers reconcile local usage;
exhaustion opens the circuit until reset instead of waiting for HTTP 429.

Binance error `-1021` and Bybit error `10002` are treated as explicit host clock-skew failures in the
dormant adapter code. A future live release must require a synchronized operating-system clock
(for example through NTP/chrony); increasing `recvWindow` is not a substitute for a reliable host
clock.

## See also

- [Project README](../README.md)
- [Architecture](./ARCHITECTURE.md)
- [HTTP & WebSocket API](./API.md)
- [Strategies](./STRATEGIES.md)
- [Configuration](./CONFIGURATION.md)
- [Exchange capability matrix and operator checklist](./EXCHANGE_CAPABILITIES.md)
