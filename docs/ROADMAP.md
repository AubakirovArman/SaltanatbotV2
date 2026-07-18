# Roadmap

> The broad repository baseline is maintained in
> [MASTER_IMPROVEMENT_PLAN.md](./MASTER_IMPROVEMENT_PLAN.md) and
> [IMPLEMENTATION_STATUS.md](./IMPLEMENTATION_STATUS.md). Scanner-specific P0/P1/P2 integration
> remains active in [P0_P1_P2_EXECUTION_PLAN.md](./P0_P1_P2_EXECUTION_PLAN.md); this page records
> longer-horizon product work without reclassifying that ledger as complete.

The ordered implementation plan for the current public Research / Paper deployment is maintained in
[PRE_HTTPS_ROADMAP.md](./PRE_HTTPS_ROADMAP.md). It deliberately excludes HTTPS and keeps all private
exchange execution disabled until a separate security review. The current build accepts only
`RUNTIME_PROFILE=public-http-paper`; environment variables cannot activate the retained future live
policy types.

SaltanatbotV2 is a strong open-source alpha for charting, Pine import, visual strategy authoring,
reproducible research and paper trading. It contains tested future execution-foundation components,
but production routes/adapters intentionally remain deny-only and live trading is not part of this
release.

## Delivered baseline

- Strict Binance/Bybit market routing, shared feeds, persistent history and explicit unavailable/fallback states.
- Version-aware Pine compiler with typed fidelity diagnostics, corpus, compatibility matrix and fuzz tests.
- Versioned Strategy Studio, shared evaluator/backtest cores, reproducible reports, replay, optimizer and walk-forward.
- Multi-symbol portfolio backtests with one shared capital pool, correlated returns and portfolio-level exposure limits.
- Modeled portfolio TCA with reconciled commission, configured slippage, funding and per-market/exit-reason attribution.
- Checksummed and optionally ECDSA-signed local declarative plugin packages with strict permissions, device-local author identity, dual-signed bounded key rotation, explicit fingerprint trust, fail-closed local signer/chain blocking, version/signer-continuity update review, automatic dependency-aware authoring, an installed-package catalog, dependency-safe uninstall and no arbitrary JavaScript.
- Durable order/fill/position/run lifecycle plus tested future private-stream, reconciliation and
  execution-authority foundations that are unreachable from the current production runtime.
- Professional multi-chart workspaces, pane/scales, drawing management, accessible tables and responsive monitoring.
- Per-pane IANA time-zone axes with DST-safe chart labels and versioned workspace/session persistence.
- Scoped session security, encrypted keys, audit logs, verified backup/restore and fail-closed demo mode.
- EN/RU/KK coverage for core stable UI journeys and operator guides, with exact developer contracts canonical in English; public Pages, release artifacts, SBOM, checksums and attestations.
- Enforced TypeScript, Biome, docs, architecture, unit/integration, build, performance and Playwright gates.
- Blank-screen-safe startup with a localized pre-React fallback, global React recovery boundary and data-preserving stale-shell refresh.
- Attested release archives with per-file manifests and an enforced controlled-corruption/atomic-rollback drill plus EN/RU/KK incident runbooks.
- Optional offline Strategy Studio bundle with explicit install/remove controls and safe installed-app Chart/Strategy shortcuts.
- Reviewed installed-PWA file opening and file-only Share Target for exact Pine, strategy and plugin
  formats, with bounded temporary local storage and cross-browser manual fallbacks.
- Nine operator-allowlisted venues in the generic read-only continuous module, exposed through
  dynamic browser venue/source filters. dYdX Indexer books remain non-canonical sequence-observed
  research, while KuCoin and MEXC use bounded connected public protocol paths; none adds private
  execution or mainnet readiness.

## Accepted R5.1 release

The accepted R5.1 release was deployed on PostgreSQL schema 13 from
protected slot `r5a-schema13-66394fd` (commit
`66394fd38765d8da36174411cecd95a33fda1ea0`, exact-SHA CI run `29574600648`,
`6/6`). R5.1 is accepted and deployed, but it remains notification-only and is
still not proven as a 100-user service.

The release adds generic owner-scoped `price-threshold` alerts over public
Binance/Bybit last-price closed candles with durable in-app history. It is
notification-only and cannot trade, borrow, change margin, read exchange
credentials or grant trading authority. Its conservative beta bounds are 100
active and 200 non-archived rules per owner, 400 total retained rule/history
rows per owner and 480 globally active rules. The scheduler performs at most
four public reads concurrently, 16 unique reads per sweep and eight per
provider; evaluation receipts retain for 2 days and event/outbox/archive history
for 30 days.

Acceptance passed the checksum-locked upgrade/recovery gate, owner-forward
cursor and intentional at-least-once UI behavior, same-owner multi-tab
convergence, browser-storage failure handling and desktop/mobile
accessibility/visual evidence; see the recorded
[R5.1 acceptance evidence](./evidence/R5_1_OWNER_ALERTS.md). This generic
price-alert control plane is not the older account-aware arbitrage
research-alert policy/outbox: its engine-owned candidate/economics producers
remain disconnected. The R5.2.1 technical screener MVP, the R5.3a screener
alert promotion, the R5.3b-1 Telegram delivery worker, the R5.3b-2
Telegram paper commands and the chart research tools are now accepted and
deployed (see below), completing R5; the R11 integrated 100-user capacity
proof remains pending and unproven.

See [Owner-scoped server alerts](./ALERTS.md),
[Russian](./ru/ALERTS.md), [Kazakh](./kk/ALERTS.md) and the detailed
[pre-HTTPS release order](./PRE_HTTPS_ROADMAP.md).

## Accepted R5.2.1 release

The accepted R5.2.1 technical screener MVP was deployed on PostgreSQL
schema 14 from protected slot `r5b-schema14-20be5b1` (commit
`20be5b1d2fb87df38cc298953dfe7a2f414dd831`, exact-SHA CI run `29584556266`,
`6/6`). R5.2.1 is accepted and deployed, but it remains research-only and is
still not proven as a 100-user service.

The release adds an on-demand indicator screener over the public Binance spot
USDT universe: owner-scoped server presets with revisions and archive, runs
executed as bounded compute jobs, closed-candle-only evaluation with
fail-closed unavailability, deterministic bounded results and click-to-chart
indicator parity. It cannot trade, borrow, change margin, read exchange
credentials or grant trading authority. Its conservative beta bounds are 40
active presets per owner, 400 globally active presets, a universe of at most
200 symbols and the existing five-active compute-job quota per owner; they are
not R11 capacity evidence.

Acceptance passed the checksum-locked schema-14 upgrade/recovery gate and an
end-to-end screener rehearsal on the isolated replacement pair — 30/30 symbols
evaluated, 30 matched, 0 unavailable against live Binance closed candles; see
the recorded
[R5.2.1 acceptance evidence](./evidence/R5_2_1_TECHNICAL_SCREENER.md).
Saved-screen promotion into a server alert is now delivered by the accepted
R5.3a release, owner-bound Telegram delivery by the accepted R5.3b-1
release, Telegram read commands by the accepted R5.3b-2 release and the
chart research tools by the accepted release below, completing R5; the R11
integrated 100-user capacity proof remains pending and unproven.

See [On-demand technical screener](./SCREENER.md),
[Russian](./ru/SCREENER.md), [Kazakh](./kk/SCREENER.md) and the detailed
[pre-HTTPS release order](./PRE_HTTPS_ROADMAP.md).

## Accepted R5.3a release

The accepted R5.3a screener alert promotion was deployed from
protected slot `r5c-schema14-86712ba` (commit
`86712bac3293ac8d746b638218eb66995d8e5edb`, exact-SHA CI run `29590401183`,
`6/6`). The release added no migration: PostgreSQL schema 14 and trading
SQLite schema 9 were unchanged, and the runtime remains `public-http-paper`.

The release promotes a saved screen into the server alert rule kind
`screener`: the embedded screen re-runs at the timeframe-derived cadence on
closed candles and raises an on-change alert event when the matched symbol
set changes, with unknown carry-over, the 30% availability floor, cooldown
fencing and the 5-per-owner/40-global quotas. In this release delivery
stayed in-app only; `telegram` on a screener rule answered a clear `400`
until the accepted R5.3b-1 release below. It cannot trade, borrow, change
margin, read exchange credentials or grant trading authority.

Acceptance passed the exact-SHA CI gate and the paired no-migration
backup/recovery drill, and the production journal shows the dedicated
screener-alert worker lane running; see the recorded
[R5.3a acceptance evidence](./evidence/R5_3A_SCREENER_ALERTS.md). The
owner-bound Telegram binding/delivery worker is now delivered by the
accepted R5.3b-1 release, the Telegram paper commands by the accepted
R5.3b-2 release and the chart research tools by the accepted release
below, completing R5; the R11 integrated 100-user capacity proof remains
pending and unproven.

See [Owner-scoped server alerts](./ALERTS.md), [Russian](./ru/ALERTS.md),
[Kazakh](./kk/ALERTS.md) and the detailed
[pre-HTTPS release order](./PRE_HTTPS_ROADMAP.md).

## Accepted R5.3b-1 release

Production now runs the accepted R5.3b-1 Telegram delivery worker and chat
binding from protected slot `r5d-schema15-cd34ec8` (commit
`cd34ec8d11810a652bf087718f498dcece3b75fa`, exact-SHA CI run `29622330910`,
`6/6`). The release migrates PostgreSQL to schema 15
(`telegram_notification_ingress`); trading SQLite schema 9 is unchanged, the
runtime remains `public-http-paper` and the API still serves port 4180.

The release adds a third, optional supervised unit — the notification
worker — that delivers price-threshold and screener alert notifications to
a Telegram chat bound through one-consume codes, with hashed-only chat/code
storage, egress-only `getUpdates` long polling and explicit at-least-once
delivery. `telegram` is now an accepted delivery channel whenever the owner
holds an active binding. The production host provisions no bot token, so
the worker idles by design with a healthy heartbeat; provisioning the token
file later activates delivery without a new release. It cannot trade,
borrow, change margin, read exchange credentials or grant trading
authority.

Acceptance passed the exact-SHA CI gate, the checksum-locked 14→15
upgrade/recovery rehearsal — including the notification-worker idle boot
and the one-consume binding-code smoke — and the paired backup/recovery
drills; see the recorded
[R5.3b-1 acceptance evidence](./evidence/R5_3B1_TELEGRAM_DELIVERY.md). The
Telegram read commands are now delivered by the accepted R5.3b-2 release
and the chart research tools by the accepted release below, completing R5;
the R11 integrated 100-user capacity proof remains pending and unproven.

See [Owner-scoped server alerts](./ALERTS.md), [Russian](./ru/ALERTS.md),
[Kazakh](./kk/ALERTS.md), [Self-hosting](./SELF_HOSTING.md) and the
detailed [pre-HTTPS release order](./PRE_HTTPS_ROADMAP.md).

## Accepted R5.3b-2 release

Production now runs the accepted R5.3b-2 Telegram paper commands over the
fenced executor from protected slot `r5e-schema16-17e12f1` (commit
`17e12f17933de5ffb047d63358a05fad8f0211f0`, exact-SHA CI run `29625979877`,
`6/6`). The release migrates PostgreSQL to schema 16
(`telegram_command_bridge`); trading SQLite schema 9 is unchanged, the
runtime remains `public-http-paper` and the API still serves port 4180.

The release extends the bound private chat with the read commands `/help`,
`/balance`, `/daily`, `/profit`, `/performance`, `/trades` and `/alerts`
plus a two-step fenced `/pause`/`/resume`/`/stop` and `/confirm` control
flow for paper robots. Every paper answer is one durable executor command
applied by the API-process fenced executor; the notification worker opens
no HTTP listener and never opens the trading SQLite. Confirmation tokens
are hashed-only one-consume 120-second secrets and replies are explicitly
at-most-once. The production host provisions no bot token, so the worker
keeps idling by design; provisioning the token file later activates
commands together with delivery without a new release. Everything stays
paper-only research: it cannot trade live, borrow, change margin, read
exchange credentials or grant trading authority.

Acceptance passed the exact-SHA CI gate, the real-fenced-executor
PostgreSQL integration suite (the full `/pause` → `/confirm` → action →
reply round trip, one durable command per `update_id` and fail-closed
confirmation fences), the checksum-locked isolated 15→16 rehearsal with
both workers ready at schema 16, and the paired backup/recovery drills
with a retained replacement-only rollback pair; see the recorded
[R5.3b-2 acceptance evidence](./evidence/R5_3B2_TELEGRAM_COMMANDS.md). The
chart research tools are now delivered by the accepted release below,
completing R5; the R11 integrated 100-user capacity proof remains pending
and unproven.

See [Owner-scoped server alerts](./ALERTS.md), [Russian](./ru/ALERTS.md),
[Kazakh](./kk/ALERTS.md), [Self-hosting](./SELF_HOSTING.md) and the
detailed [pre-HTTPS release order](./PRE_HTTPS_ROADMAP.md).

## Accepted R5 chart research tools release — R5 complete

Production now runs the accepted chart research tools — data-anchored text
notes and the three-point parallel channel — from protected slot
`r5f-schema16-2ff6101` (commit
`2ff6101b950b42a77c378233dabecf1a5ee76ce7`, exact-SHA CI run `29629886774`,
`6/6`). The release adds no migration: PostgreSQL schema 16 and trading
SQLite schema 9 are unchanged, the runtime remains `public-http-paper` and
the API still serves port 4180. With this increment every R5 deliverable —
R5.1, R5.2.1, R5.3a, R5.3b-1, R5.3b-2 and the chart research tools — is
accepted and deployed: **R5 is complete**.

The text note anchors optional multiline text (1–500 characters) to one
data-space time/price point, records informational author-login and
creation-time metadata, and stays re-editable from the canvas, context
menu and object list through an accessible dialog editor. The parallel
channel derives its second line from a three-anchor base line plus a
signed price width, with unified body drag, width-preserving endpoint
reshaping, a dedicated width anchor, a translucent fill and a measurable
"Δ price" label. Both tools join the shared drawing catalog — now 21 tools
with EN/RU/KK labels and no reduced mobile set. A canonical geometry
contract in `packages/contracts/chartGeometry` is enforced identically by
the canvas, the drawing store, frontend workspace validation and the
additive backend workspace schema v9, which keeps v7/v8 documents
byte-for-byte valid and accepts versions 7|8|9. Everything stays
client-side research drawing: the release cannot trade, borrow, change
margin, read exchange credentials or grant trading authority.

Acceptance passed the exact-SHA CI gate, the full local and container
browser gates — including the regenerated 21-tool visual baseline and an
axe audit that exposed two real WCAG AA contrast defects, both fixed
before acceptance — and the paired no-migration backup/recovery drill; see
the recorded
[R5 chart research tools evidence](./evidence/R5_CHART_RESEARCH_TOOLS.md).
The R11 integrated 100-user capacity proof remains pending and unproven.

See the [Russian](./ru/CHART.md) and [Kazakh](./kk/CHART.md) chart guides,
the canonical [chart architecture](../frontend/src/chart/README.md) and
the detailed [pre-HTTPS release order](./PRE_HTTPS_ROADMAP.md).

## Accepted R6 release — shared paper execution contract and DCA robot

Production now runs the accepted R6 DCA paper robot on the shared paper
execution contract from protected slot `r6a-schema16-e2411ab` (commit
`e2411ab2f0b4540200089af8128304f71d3f73e0`, exact-SHA CI run `29633743310`,
`6/6`). The release adds no migration: PostgreSQL schema 16 and trading
SQLite schema 9 are unchanged, the runtime remains `public-http-paper` with
the same three project-owned units and the API still serves port 4180.

The release makes `paper-fill-model-v1` (fee 0.05% / slippage 0.02%) the
single fee/slippage parity source consumed by the live paper adapter and
the backtest defaults, and versions the paper fill behavior:
`single-position-v1` stays the default, byte-compatible with every
historical ledger — a conflicting triggered order now cancels explicitly
with reason `position-conflict:single-position-v1` instead of silently
vanishing — while `averaging-v1` merges same-side adds into one position
with a volume-weighted average entry for the new DCA robots. A DCA robot
embeds versioned `dca-params-v1` parameters (base order, up to 25 scaled
safety orders, take-profit re-placed from the volume-weighted average
entry after every fill, optional stop-loss, optional trailing take-profit,
cooldown between cycles and an optional maximum cycle duration; long and
short) driven by the versioned `dca-state-v1` machine. Every transition
carries the deterministic idempotency key `dca:<botId>:<cycle>:<ordinal>`
and persists a durable state snapshot, so restart recovery resumes
mid-cycle exactly. The worst-case capital bound is enforced server-side at
creation (`WORST_CASE_EXCEEDS_ALLOCATION`) and previewed live in the
create form from the same shared contract math. Everything stays
paper-only research: it cannot trade live, borrow, change margin, read
exchange credentials or grant trading authority.

Acceptance passed the exact-SHA CI gate and the roadmap §10 determinism
criterion: a 120-bar golden replay driven twice through the real
adapter/ledger path produced byte-identical event streams, a mid-cycle
restart reached the identical terminal state and events,
`replayPaperLedger(events)` equaled the final adapter state and committed
capital never exceeded the worst-case bound. One pre-acceptance bug —
read-model DCA metadata field names diverging from the browser contract —
was found by the test pass and fixed before acceptance, and the paired
no-migration backup/recovery drill passed; see the recorded
[R6 acceptance evidence](./evidence/R6_DCA_PAPER_ROBOT.md). The
golden-replay harness is reusable for R7, the next pending increment (the
Grid paper robot on the same ledger and state machine); the R11 integrated
100-user capacity proof remains pending and unproven.

See the [trading guide](./TRADING.md),
[canonical paper portfolios](./PAPER_PORTFOLIOS.md) and the detailed
[pre-HTTPS release order](./PRE_HTTPS_ROADMAP.md).

## Accepted R7 release — grid paper robot

Production now runs the accepted R7 grid paper robot on the shared paper
execution contract from protected slot `r7a-schema16-baf4217` (commit
`baf42178d33043fde0965d008aee9f09462df699`, exact-SHA CI run `29636312303`,
`6/6`). The release adds no migration: PostgreSQL schema 16 and trading
SQLite schema 9 are unchanged, the runtime remains `public-http-paper` with
the same three project-owned units and the API still serves port 4180.

The release adds a third additive robot kind `grid` next to strategy and
DCA robots — legacy create payloads hash identically. A grid robot embeds
versioned `grid-params-v1` parameters (an arithmetic or geometric level
ladder inside strict 2–50 bounds, neutral/long/short modes, per-level
quote size, cooldown between refills, optional stop-loss and cycle cap,
and an outside-range pause-or-stop action) driven by the pure versioned
`grid-state-v1` machine; level prices come from one shared deterministic
helper used by the machine, the server and the UI preview alike. Every
transition carries the deterministic idempotency key
`grid:<botId>:<epochCycle>:<ordinal>` (also the order clientId) and
persists a durable snapshot, so journal-deduplicated restart recovery
never re-places an existing clientId, and gap batches settle in one
consolidated placement round. Fills reuse the R6 `averaging-v1` behavior,
and realized grid PnL stays strictly separated from the evidence-aware
inventory PnL. The worst-case capital bound
`gridLevels · orderQuote · (1 + feePct/100)` is enforced server-side at
creation (`WORST_CASE_EXCEEDS_ALLOCATION`) and previewed live in the
create form together with the pre-start level-price list. Everything
stays paper-only research: it cannot trade live, borrow, change margin,
read exchange credentials or grant trading authority.

Acceptance passed the exact-SHA CI gate and the roadmap §10 criterion on
the real adapter/ledger path: a 17-bar golden replay with one bar gapping
across four grid levels settled the gap in a single consolidated
placement round with a contiguous, duplicate-free order clientId set — a
price gap never creates a cascade; a mid-cycle restart reached the
identical terminal state, events and order clientId set as the
uninterrupted run — restart never duplicates levels or reserves; a
double drive produced byte-identical event streams,
`replayPaperLedger(events)` equaled the final adapter state and committed
capital never exceeded the worst-case bound. One pre-acceptance bug — the
browser read-model parser rejecting negative (short) inventory
quantities — was found by the test pass and fixed before acceptance, and
the paired no-migration backup/recovery drill passed; see the recorded
[R7 acceptance evidence](./evidence/R7_GRID_PAPER_ROBOT.md). The next
pending increment is R8 (unified multi-leg paper execution integrating
the existing paperMultiLeg module with the common ledger, capital
reservations and market-driven fills); the R11 integrated 100-user
capacity proof remains pending and unproven.

See the [trading guide](./TRADING.md),
[canonical paper portfolios](./PAPER_PORTFOLIOS.md) and the detailed
[pre-HTTPS release order](./PRE_HTTPS_ROADMAP.md).

## Accepted R8 release — owner-scoped multi-leg paper intents

Production now runs the accepted R8 owner-scoped multi-leg paper intents
on the common capital plane from protected slot `r8a-schema16-69621f8`
(commit `69621f8107a713031f768320e9dc496010234100`, exact-SHA CI run
`29639908389`, `6/6`). Unlike R6 and R7 this is a migration release —
the first trading SQLite migration since R4: v10
`owner_scoped_paper_multi_leg` (SQL SHA-256
`34584a750937468d065d90b0af09a074a541da29ba1e7a38f2c5278cc6e9890d`) is
additive only, adding the owner-scoped `paper_multi_leg_intents` table
and the append-only `paper_multi_leg_intent_events` journal while every
v1..v9 object stays untouched. PostgreSQL schema 16 is unchanged, the
runtime remains `public-http-paper` with the same three project-owned
units and the API still serves port 4180.

The release adds two additive fenced executor command kinds,
`paper-multi-leg.submit` and `paper-multi-leg.kill-switch` — legacy
request hashes stay byte-identical. Submit builds the plan through the
existing fail-closed research builders (research-simulation only,
`executable === false` enforced, per-leg evidence mandatory), enforces
the shared freshness gate (source evidence at most 60 seconds old, plan
lifetime at most 5 minutes), the per-owner (3) and per-portfolio (2)
active-intent limits and the deterministic worst-case reservation
`Σ plannedQuantity·referencePrice·(1 + 2·feeBps/10000)` (rounded up to
six decimals) against the portfolio's available capital, then drives the
pure deterministic engine — the delivered arbitrage `paperMultiLeg`
engine reused verbatim, not forked — to its terminal state with every
transition durably journaled under `mleg:<intentId>:<sequence>`. The
combined both-legs-all-costs paper PnL reports residual exposure
explicitly instead of silently pricing it, and the guarded
running→terminal flip releases the single capital reservation exactly
once. The portfolio read model gains an additive `multiLeg` section and
subtracts running reservations from available capital; opportunity
research gains the confirmed "Run paper multi-leg" flow with a live
worst-case preview next to the portfolio-center intents section and the
owner-level kill switch, in en/ru/kk. The legacy isolated arbitrage
multi-leg journal stays byte-identical. Everything stays paper-only
research: it cannot trade live, borrow, change margin, read exchange
credentials or grant trading authority.

Acceptance passed the exact-SHA CI gate, the paired v9→v10 migration
rehearsal on a copy of the production `trading.db` and the roadmap
§12/R8.2 criterion: a partially driven run recovered on a fresh service
instance reached a journal byte-equal to the uninterrupted run —
identical terminal state, contiguous duplicate-free sequences and the
capital reservation released exactly once (re-recovery is a no-op); the
combined paper PnL includes both legs and every modeled cost, and no
opportunity is executable without depth/freshness evidence —
research-simulation only. The paired pre/post recovery generations and
the isolated drill passed; see the recorded
[R8 acceptance evidence](./evidence/R8_MULTI_LEG_PAPER_INTENTS.md). The
next pending increment is R9 (the server multi-market GA pipeline plus
the D2 ADR fixing the canonical Strategy IR/dataset/backtest contract);
the R11 integrated 100-user capacity proof remains pending and unproven.

See the [trading guide](./TRADING.md),
[canonical paper portfolios](./PAPER_PORTFOLIOS.md) and the detailed
[pre-HTTPS release order](./PRE_HTTPS_ROADMAP.md).

## Accepted R9.1 release — server multi-market evaluation and ADR 0003

Production now runs the accepted R9.1 server multi-market evaluation from
protected slot `r9a-schema16-4f5bc64` (commit
`4f5bc64e9dfb35d379a55690755a76f7594b226d`, exact-SHA CI run `29643197555`,
`6/6`). The release adds no migration: PostgreSQL schema 16 and trading
SQLite schema 10 are unchanged, the runtime remains `public-http-paper`
with the same three project-owned units and the API still serves port 4180.

Decision D2 is closed by
[ADR 0003](./adr/0003-canonical-ir-dataset-backtest-contract.md) (Accepted
2026-07-18), which fixes — before the R9.1 job API — the canonical
Strategy IR (`IR_VERSION 4`, its hand-maintained runtime/declaration pair
now guarded by a pinned SHA-256 checksum inside `npm run check`, with
`parseStrategyIR` the sole trust boundary for inbound IR), the versioned
`dataset-v1` contract (canonical serialization with a SHA-256 fingerprint
and a time-ordered train/test split with an embargo gap — never random,
never lookahead, with the survivorship/delisting limitation recorded) and
the deterministic backtest engine version `backtest-core-v1` stamped into
every server evaluation result. Server GA/generator surfaces are now
permitted; promotion and gallery surfaces remain forbidden until
R9.2/R9.3.

The release moves research-job dispatch into a generic kind registry — the
pre-existing `screener` and `backtest` kinds are re-registered with
byte-identical request, response, dedupe-key and error behavior, and
unknown kinds still hard-fail — and adds the job kind `multi-market-eval`:
the server owns candle evaluation, fetching only real closed bars from the
public provider under the 90-second screener budget discipline with
explicit fail-closed reasons (synthetic bars are never accepted), for one
to six catalog-validated markets sharing one timeframe, a 500–20 000-bar
lookback and an embargo train/out-of-sample split. Per-market train and
out-of-sample backtests run through the existing worker-thread protocol,
an out-of-sample shared capital-pool portfolio section comes from the R4
portfolio backtest allocator, and the bounded (≤256 KiB) deterministic
`multi-market-eval-v1` result is stamped with the dataset fingerprint, the
engine version and the seed. The strategy generator panel gains an
"Evaluate on server" flow feeding the pure multi-market ranker, whose
section flips from unavailable to a ranked list with a provenance line, in
en/ru/kk. Everything stays research evidence, not a performance claim: a
high rank starts nothing.

Acceptance passed the exact-SHA CI gate and the roadmap §13 criterion: the
same candle set driven twice through the full evaluation path produced
byte-identical result JSON (golden dataset fingerprint
`d076618630cf5842…`), and the tested embargo split laws prove no
lookahead/leakage. One pre-acceptance bug — a zero-loss window's infinite
profit factor is stored as JSONB null, and the client parser now maps it
to NaN so the pure ranker's finite-metrics gate fails that window closed —
was found by the test pass and fixed before acceptance, and the paired
no-migration backup/recovery generations and the isolated drill passed;
see the recorded
[R9.1 acceptance evidence](./evidence/R9_1_SERVER_EVALUATION.md). The next
pending increment is R9.2 (GA lineage, Pareto/OOS promotion and
checkpoint/resume inside R9); the R11 integrated 100-user capacity proof
remains pending and unproven.

See the [strategy and backtest guide](./STRATEGIES.md), the
[API reference](./API.md) and the detailed
[pre-HTTPS release order](./PRE_HTTPS_ROADMAP.md).

## Explicitly deferred external validation

| Item | Why deferred | Required before claim |
| --- | --- | --- |
| Continuous 7–14-day Binance/Bybit testnet soak | Requires funded accounts and protected external credentials | Reconnect, fills, protection and recovery evidence over the full window |
| Mainnet readiness | Requires the soak plus controlled real-account operational review | Signed operator evidence and removal of every Experimental warning only after approval |

These are not silently marked complete. The funded soak is excluded from the active scanner ledger,
while its remaining repository-connected work continues independently.

## P3 product opportunities

| Epic | Outcome | Relative effort |
| --- | --- | --- |
| Public venue expansion | Finish dedicated browser diagnostics for the nine registered continuous venues, accumulate repeated scheduled canary evidence and obtain a successful Kraken artifact from an eligible network, then add reviewed Crypto.com, BitMEX, Bitfinex, Gemini and Bitstamp public scopes; dYdX still needs an owned-node finality/reorg gate, while private execution remains a separate review | L–XL |
| Order-book and derivatives data | Depth, tape, funding, open interest and licensed advanced feeds | L–XL |
| Plugin capability expansion | Additional reviewed declarative extension points beyond editable indicator/strategy packages | L–XL |
| Moderated community registry | Signed indicator/strategy discovery, publisher verification, compromise revocation and supply-chain policy beyond local dual-signed rotation | XL |
| Optional encrypted sync | User-controlled cross-device strategies and workspace synchronization | XL |
| Hosted read-only demo | Public deployment of the existing non-mutating demo mode | M, infrastructure |
| More locale and RTL coverage | Formatting, long-string and bidirectional layout conformance | L |
| AI-assisted strategy drafts | Optional BYO-model natural language to validated blocks/IR | M |
| Collaboration | Opt-in review/sharing service separated from local-first core | XL |
| Live venue-quality telemetry | Compare measured latency, spread, order-book impact and execution quality across connected venues | L, external data |

## Stable-release gates beyond alpha

- Complete the funded exchange validation above.
- Maintain a current manual multi-screen-reader/browser matrix in addition to automated axe checks.
- Rehearse the delivered incident-response/rollback runbook against each real hosting platform's proxy, supervisor and persistent volumes.
- Promote release channels only through the documented alpha → beta → stable criteria.

## See also

- [Configuration and deployment](./CONFIGURATION.md)
- [Trading engine](./TRADING.md)
- [Strategies and backtesting](./STRATEGIES.md)
- [Release verification](./RELEASING.md)
