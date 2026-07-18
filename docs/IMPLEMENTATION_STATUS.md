# Improvement implementation status

Updated: 2026-07-18

Active branch: `main`

Source plan: [MASTER_IMPROVEMENT_PLAN.md](./MASTER_IMPROVEMENT_PLAN.md)

This is the execution ledger. It records what is proven complete, what is active, and what remains. A
checked item proves only the named slice and its listed evidence; it does **not** mean every P0, P1
or P2 epic is complete. The canonical thirty-row completion contract remains
[P0/P1/P2 execution ledger](P0_P1_P2_EXECUTION_PLAN.md).

Evidence levels are not interchangeable: an **engine** is pure code; **runtime-connected** means the
server can mount it when configured; **browser-delivered** means an EN/RU/KK workflow exists;
**deterministic** means fixtures/tests pass; a **public canary** is one credential-free live
observation; **private evidence** requires authenticated account/order/fill observations; and
**production-ready** additionally requires sustained runtime, operational, legal and applicable
private gates. No earlier level implies a later one.

## R4 accepted and deployed — 2026-07-17

Production ran PostgreSQL schema 12 and trading SQLite schema 9 from protected
slot `r4c-schema12-bb455fa` at commit
`bb455facdfe5a1b3cabe15490c86c299ea684ee7`. Exact-SHA GitHub Actions run
`29560112312` passed all 6/6 jobs. The delivered contract includes the durable
executor-command queue, canonical owner-scoped paper portfolios, epochs,
reservations and receipts, evidence-aware projections, bounded robot journals,
the corresponding browser center and fenced PostgreSQL-to-SQLite executor.

Golden-ledger, restart, two-owner/browser, isolated paired
restore/migration/rollback and protected production-smoke gates are recorded in
[R4 canonical paper portfolios evidence](./evidence/R4_PAPER_PORTFOLIOS.md).
R5.1 is now accepted, committed and deployed: the schema-13
backup/restore/rollback, exact-CI, browser-closed and visual gates passed, and
production cut over to protected slot `r5a-schema13-66394fd` (PostgreSQL schema
13) at commit `66394fd38765d8da36174411cecd95a33fda1ea0`, still on port 4180
([R5.1 owner-scoped alerts evidence](./evidence/R5_1_OWNER_ALERTS.md)). The
runtime remains `public-http-paper`: HTTPS, exchange credential use, private
streams, signed requests and live orders remain outside this release.

## R5.1 owner alerts accepted and deployed — 2026-07-17

- [x] Define strict research-only price-rule, event, outbox and public projection
  contracts shared by the browser and backend.
- [x] Implement owner-scoped PostgreSQL rule/revision/state/receipt/event/outbox
  persistence with authorization revision, CSRF, lease and state-revision
  fences.
- [x] Evaluate exact Binance/Bybit public closed candles, one durable bar at a
  time, including historical first-bar recovery and exact decimal comparison.
- [x] Add transactional per-owner event ordering, forward cursor pages,
  at-least-once browser checkpoints, multi-tab fences and deletion tombstones.
- [x] Add beta quotas, provider-fair admission, structured metrics and bounded
  2-day/30-day retention.
- [x] Finish full unit/integration/build/browser/visual/soak gates and the exact
  unprivileged PostgreSQL schema-13 recovery rehearsal.
- [x] Commit/push the exact candidate, pass all six GitHub CI jobs, create a
  protected release slot and cut over schema 13 without changing port 4180.

Gate, rehearsal and cutover evidence, including exact-SHA GitHub Actions run
`29574600648` (6/6 jobs), is recorded in
[R5.1 owner-scoped alerts evidence](./evidence/R5_1_OWNER_ALERTS.md). Canonical
behavior and current limits are documented in
[Owner-scoped server alerts](./ALERTS.md).

## R5.2.1 technical screener accepted and deployed — 2026-07-17

- [x] Strict `screener-definition/run-request/run-result/preset` v1 contracts
  shared by the browser and backend.
- [x] Owner-scoped PostgreSQL preset persistence (schema 14) with client-ID
  idempotency, revision fences, archive and 40-per-owner/400-global beta
  quotas.
- [x] On-demand runs through the existing compute-job queue (`kind: screener`)
  with a pure closed-candle indicator engine, fail-closed unavailability and
  deterministic bounded results.
- [x] EN/RU/KK technical scanner mode with presets, honest run states and
  click-to-chart carrying symbol, timeframe and indicator context.
- [x] Unit/route/integration/worker/browser/E2E test gates and documentation.

Production now runs PostgreSQL schema 14 (additive migration 14
`owner_screener_presets`) and the unchanged trading SQLite schema 9 from
protected slot `r5b-schema14-20be5b1` at commit
`20be5b1d2fb87df38cc298953dfe7a2f414dd831` (a test fix on top of feature
commit `d42210022dd38e17aa002d140e489acd0fbc30a5`), still on port 4180 in the
`public-http-paper` runtime. Exact-SHA GitHub Actions run `29584556266` passed
all 6/6 jobs; an earlier revision `d422100` failed CI run `29583889332` on
migration-chain assertions and was fixed forward before any production change.
The recovery rehearsal included an end-to-end screener proof on the isolated
replacement pair: a preset was created and a run executed via a compute job
against live Binance closed candles with 30/30 symbols evaluated, 30 matched
and 0 unavailable. Gate, rehearsal and cutover evidence is recorded in
[R5.2.1 technical screener evidence](./evidence/R5_2_1_TECHNICAL_SCREENER.md).

Scheduled screens, screen-to-alert promotion (reserved rule kind `screener`)
and a Bybit-primary universe remain explicitly outside this increment.
Canonical behavior is documented in
[On-demand technical screener](./SCREENER.md).

## R5.3a screener alert promotion accepted and deployed — 2026-07-17

R5.3a promotes a saved technical screen into a durable server alert rule of
kind `screener` with repeat-on-change semantics. The increment adds no
migration: PostgreSQL schema 14 and the trading SQLite schema 9 are
unchanged.

- [x] Widen the shared alert contracts with the `screener` rule kind and
  `ScreenerAlertDefinitionV1`, embedding a full `screener-definition-v1` by
  value with `repeat: "on-change"`.
- [x] Add the pure transition evaluator: baseline initialization without
  triggering, unknown carry-over for unavailable symbols, the 30% availability
  deferral floor, cooldown deferral without state advance and deterministic
  state/fingerprint/transition keys.
- [x] Add the repository claim/completion lane: `screener-alert-worker`
  receipts with duplicate-receipt replay, transition re-verification against
  durable prior state, one-transaction event/outbox/pre-delivered in-app
  delivery, cooldown fencing and rules that stay active after a trigger while
  rearm stays price-only (`409 alert_rearm_unsupported`).
- [x] Admit at most one screener-alert evaluation per research-worker sweep
  under a 300-second lease and a 90-second market-evidence budget with a
  dedicated lane metrics block.
- [x] Enforce screener-kind quotas (5 enabled per owner, 40 globally active,
  inside the shared caps) with typed `429` errors, and keep delivery in-app
  only until R5.3b.
- [x] Deliver the browser "Create alert from this screen" promotion, screener
  rule listing/toggle/archive, envelope-titled toasts and EN/RU/KK strings.
- [x] Pass exact-commit GitHub CI, create a protected release slot, run the
  backup/restore rehearsal, cut production over and record acceptance
  evidence per [RELEASING.md](./RELEASING.md).

Production now runs protected slot `r5c-schema14-86712ba` at commit
`86712bac3293ac8d746b638218eb66995d8e5edb`, still on port 4180 in the
`public-http-paper` runtime. Exact-SHA GitHub Actions run `29590401183`
passed all 6/6 jobs. The production worker journal shows the
`screenerAlertLane` running (`evaluationsPerSweep` 1, 0 failures), and
paired recovery generations `dd5c0827` (pre-cutover) and `3632bd9f`
(post-cutover, isolated drill passed) were verified. Gate, rehearsal and
cutover evidence is recorded in
[R5.3a screener alerts evidence](./evidence/R5_3A_SCREENER_ALERTS.md).

The chart research tools (text notes and the parallel channel) are now
accepted and deployed (section below). The R5.3b-1 notification worker with
owner-bound Telegram binding/delivery is now accepted and deployed (section
below). Canonical behavior is documented in
[Screener alerts (R5.3a)](./ALERTS.md) and the promotion paragraph in
[SCREENER.md](./SCREENER.md).

## R5.3b-1 Telegram delivery and binding accepted and deployed — 2026-07-18

R5.3b-1 adds the separate notification worker, Telegram delivery of alert
notifications and the owner-bound chat binding lifecycle. The slice passed
the full [RELEASING.md](./RELEASING.md) gate — exact-commit CI, the
additive schema-15 migration with its paired backup/isolated-restore
rehearsal, a protected slot and the production unit created at cutover —
and was accepted and deployed on 2026-07-18.

- [x] Additive PostgreSQL migration 15 `telegram_notification_ingress`:
  `notification_bindings.recipient_chat_id`, hashed one-consume
  `notification_binding_codes`, fenced `telegram_ingress_consumers`
  lease/cursor and the normalized `telegram_updates` dedup journal.
- [x] Separate `notification-worker` process: no HTTP listener, no trading
  SQLite, never runs migrations (idles on schema mismatch), owner-only
  token-file validation, idle-with-heartbeat when the token is absent, and
  optional readiness coupling via `OPERATIONS_REQUIRE_NOTIFICATION_WORKER`.
- [x] Telegram delivery lane over the existing `notification_deliveries`
  lease fence: binding re-proof before each send, plain-text sendMessage
  with footer, delivered/retrying/dead-letter/cancelled outcomes, bounded
  backoff, global/per-chat/per-owner send buckets and documented
  at-least-once external delivery.
- [x] Binding lifecycle: one-consume hashed codes (10-minute TTL, 3
  outstanding, per-owner rate limit) via `/api/alerts/bindings` routes;
  worker-side `/start`/`/bind` consumption with per-chat limits,
  single-active-binding replacement and revoke that cancels pending
  deliveries; `telegram` accepted as a delivery channel for price-threshold
  and screener kinds when a binding is active.
- [x] Egress-only `getUpdates` ingress with a fenced single-consumer lease,
  transactional `(bot, update_id)` dedup + cursor advance, and normalized
  hashed-only journal rows.
- [x] Browser Telegram bindings panel (create code shown once, list with
  hashed handles, confirm-revoke) and channel-picker gating with EN/RU/KK
  strings; deployment examples (third systemd unit, Compose `telegram`
  profile) and documentation.
- [x] Exact-commit GitHub CI, protected release slot, schema-15
  backup/restore rehearsal, production cutover and recorded acceptance
  evidence per [RELEASING.md](./RELEASING.md).

Production now runs PostgreSQL schema 15 (additive migration 15
`telegram_notification_ingress`) and the unchanged trading SQLite schema 9
from protected slot `r5d-schema15-cd34ec8` at commit
`cd34ec8d11810a652bf087718f498dcece3b75fa`, still on port 4180 in the
`public-http-paper` runtime. Exact-SHA GitHub Actions run `29622330910`
passed all 6/6 jobs. Production now runs three project-owned units — the
API, the research worker and the new
`saltanatbotv2-notification-worker.service`. No bot token is provisioned on
this host, so the worker idles by design (`notification_worker_idle`,
reason `token_absent`) with a healthy heartbeat; readiness keeps the worker
optional unless `OPERATIONS_REQUIRE_NOTIFICATION_WORKER` is set, and
provisioning the token file later activates delivery without a new release.
Gate, rehearsal and cutover evidence is recorded in
[R5.3b-1 Telegram delivery evidence](./evidence/R5_3B1_TELEGRAM_DELIVERY.md).

R5.3b-2 — the Telegram paper commands — is now accepted and deployed
(section below), completing R5.3. The chart research tools (text notes and
the parallel channel) — the last open R5 item — are now also accepted and
deployed (section below), completing R5.

## R5.3b-2 Telegram paper commands accepted and deployed — 2026-07-18

R5.3b-2 extends the bound Telegram chat with the read commands (`/help`,
`/balance`, `/daily`, `/profit`, `/performance`, `/trades`, `/alerts`) and
the two-step `/pause`/`/resume`/`/stop` + `/confirm` paper control flow
through the existing API-process fenced executor. The slice passed the full
[RELEASING.md](./RELEASING.md) gate — exact-commit CI, the additive
schema-16 migration with its paired backup/isolated-restore rehearsal, a
protected slot and the production cutover — and was accepted and deployed
on 2026-07-18.

- [x] Additive PostgreSQL migration 16 `telegram_command_bridge`:
  `telegram_command_replies` (one pending reply per durable executor
  command, `replied_at` fence) and `telegram_confirmations` (hashed
  one-consume control tokens) with owner/binding composite foreign keys and
  retention indexes.
- [x] Pure command parser and Phase A command bridge: the ingress batch
  transaction resolves the active binding by hashed chat fingerprint,
  re-checks owner status and the current authorization revision, and
  enqueues exactly one durable executor command per update
  (`telegram:<botFingerprint>:<updateId>` idempotency key, payload `origin`
  marker, no `executor_commands` DDL); `/alerts` answers directly from
  PostgreSQL (≤10 rules, ≤5 events).
- [x] Read-only executor kinds `paper-portfolio.snapshot` (one bounded
  result feeds `/balance`, `/daily`, `/profit` and `/performance`;
  unavailable evidence stays unavailable, never zero; ≤20 robots with a
  truncation flag) and `paper-robot.trades` (≤10 fills), applied through
  the existing lease/fence executor path.
- [x] Two-step fenced control: confirm-target snapshot, 8-character handle
  resolution (0/1/many), 16-character base32 one-consume tokens stored as
  SHA-256 (120-second TTL, ≤3 outstanding per owner), `FOR UPDATE`
  consumption that re-proves chat/owner/binding/authorization and pins the
  portfolio/ledger/robot revisions into the `paper-robot.action` command.
- [x] Bounded replies lane beside the delivery lane
  (`NOTIFICATION_REPLIES_POLL_INTERVAL_MS`): binding re-proof before every
  send, `replied_at` settled before the external send (at-most-once
  replies), 10-minute non-terminal timeout reply, shared send rate limits,
  and retention stages for confirmations (2 days) and replied rows
  (7 days).
- [x] Full unit and env-gated PostgreSQL integration coverage of the
  command round trip (one update ⇒ one durable command across a crash,
  cross-owner/revoked/expired fail-closed, confirmation quota) wired into
  CI.
- [x] Full release gate per [RELEASING.md](./RELEASING.md): exact-commit
  CI, schema-16 backup/isolated-restore rehearsal, protected slot,
  production cutover and recorded acceptance evidence.

Production now runs PostgreSQL schema 16 (additive migration 16
`telegram_command_bridge`) and the unchanged trading SQLite schema 9 from
protected slot `r5e-schema16-17e12f1` at commit
`17e12f17933de5ffb047d63358a05fad8f0211f0`, still on port 4180 in the
`public-http-paper` runtime. Exact-SHA GitHub Actions run `29625979877`
passed all 6/6 jobs. The same three project-owned units keep running; no
bot token is provisioned on this host, so the notification worker still
idles by design, and provisioning the token file later activates the
command lane together with delivery without a new release. Because
production has no token, the end-to-end command proof is the
real-fenced-executor PostgreSQL integration suite (the full `/pause` →
`/confirm` → action → reply round trip, one durable command per
`update_id`, fail-closed fences). Gate, rehearsal and cutover evidence is
recorded in
[R5.3b-2 Telegram commands evidence](./evidence/R5_3B2_TELEGRAM_COMMANDS.md).

Canonical behavior is documented in
[Telegram paper commands (R5.3b-2)](./ALERTS.md) (EN/RU/KK) and the threat
analysis in [THREAT_MODEL.md](./THREAT_MODEL.md).

## R5 chart research tools accepted and deployed — 2026-07-18

This slice — the last open R5 item (roadmap section 9, research chart
tools) — adds the **text note** and **parallel channel** drawing tools. The
slice is browser/workspace-only and required **no runtime migration**;
existing v7/v8 workspace documents stay valid unchanged. It passed the full
[RELEASING.md](./RELEASING.md) gate — exact-commit CI, a protected release
slot, the paired backup/isolated-restore rehearsal and the production
cutover — and was accepted and deployed on 2026-07-18.

- [x] Canonical chart geometry contract
  (`packages/contracts/chartGeometry`): horizontal/trend/channel shapes
  with exact-key parsers shared by the canvas, the drawing store, workspace
  export/import validation and the backend v9 document contract.
- [x] Text note tool: one data-space anchor, up to 500 characters of
  multiline text, inline editor (save/cancel, keyboard accessible),
  informational author-login and creation-time metadata stored in the
  owner-scoped client workspace document (not a server-verified signature).
- [x] Parallel channel tool: three anchors (base line plus signed width
  offset), unified body movement, endpoint reshape preserving width, a
  width-only anchor, translucent fill and a Δ width label in price units.
- [x] Additive workspace schema v9 (frontend and backend document
  contract): both tools plus their optional fields validated on both
  sides; v9 is additive over the untouched v8 shape, v7/v8 documents stay
  byte-for-byte valid and load unchanged, the backend accepts versions 7,
  8 and 9, and versions above 9 stay rejected.
- [x] Shared drawing tool catalog entries (desktop rail and the mobile
  bottom sheet, no reduced set; the catalog grew from 19 to 21 tools and
  the visual drawing-tools baseline was deliberately regenerated) with
  EN/RU/KK labels and editor strings.
- [x] Frontend, backend, contracts and e2e coverage for the new tools,
  and user documentation in the RU/KK chart guides plus the EN/RU/KK site
  feature cards. The new journey's axe audit exposed two real WCAG AA
  contrast defects, both fixed before acceptance.

Production now runs protected slot `r5f-schema16-2ff6101` at commit
`2ff6101b950b42a77c378233dabecf1a5ee76ce7`, still on port 4180 in the
`public-http-paper` runtime with the same three project-owned units.
Exact-SHA GitHub Actions run `29629886774` passed all 6/6 jobs. The
release carries no migration: PostgreSQL schema 16 and the trading SQLite
schema 9 are unchanged. Paired recovery generations `7a734401`
(pre-cutover) and `83c4b37e` (post-cutover, isolated drill passed) were
verified. Gate, rehearsal and cutover evidence is recorded in
[R5 chart research tools evidence](./evidence/R5_CHART_RESEARCH_TOOLS.md).

With this acceptance every R5 deliverable — R5.1, R5.2.1, R5.3a, R5.3b-1,
R5.3b-2 and the chart research tools — is accepted and deployed: **R5 is
complete**. R6 (the shared paper execution contract and the DCA robot) is
now also accepted and deployed; see the next section.

## R6 shared paper execution contract and DCA robot accepted and deployed — 2026-07-18

This slice (roadmap R6) delivers the shared versioned paper execution
contract and the DCA robot on top of it. It passed the full
[RELEASING.md](./RELEASING.md) gate — exact-commit CI, a protected release
slot, the paired backup/isolated-restore rehearsal and the production
cutover — and was accepted and deployed on 2026-07-18. The increment
changes no PostgreSQL or SQLite schema — DCA robots ride the existing
paper event types and settings snapshots, and the cutover verified that
every pre-R6 ledger replays byte-identically.

- [x] Shared versioned paper fill model `paper-fill-model-v1`
  (`packages/execution-core/fillModel.ts`, feePct 0.05 / slipPct 0.02) as
  the single fee/slippage parity source for the paper engine adapter, the
  backtest defaults and the DCA worst-case math.
- [x] Shared `dca-params-v1` contract (`packages/contracts/dca.ts`):
  exact fail-closed parser with the research-only safety envelope and the
  conservative ceil-to-six-decimals `worstCaseDcaCapitalQuote` used by both
  the server (`WORST_CASE_EXCEEDS_ALLOCATION` on create) and the browser
  preview.
- [x] Versioned adapter fill behavior: `single-position-v1` (default,
  byte-compatible with every historical ledger; a triggered same-side
  resting order now cancels explicitly instead of vanishing) and
  `averaging-v1` (DCA-only volume-weighted same-side merges) with the
  fail-closed ledger reducer extended additively.
- [x] Pure versioned `dca-state-v1` cycle machine plus engine dispatch:
  base/safety/take-profit ladder, optional stop-loss, trailing and
  cycle-duration exits, cooldown, mirrored shorts, deterministic
  `dca:<botId>:<cycle>:<ordinal>` transition keys doubling as durable order
  client ids, and settings-path snapshots for fail-closed restart recovery.
- [x] Golden-replay harness (`backend/src/trading/goldenReplay.ts`)
  driving the real adapter/lifecycle/ledger path deterministically over
  in-memory stores.
- [x] HTTP + browser slice: `kind: "strategy" | "dca"` config
  discriminator (absent = strategy, full back-compat), robot-type toggle
  and DCA create panel with live worst-case preview and inline validation,
  detail-drawer DCA cycle section from additive runtime metadata, EN/RU/KK
  catalogs.
- [x] EN/RU/KK user documentation: DCA sections in
  [PAPER_PORTFOLIOS.md](./PAPER_PORTFOLIOS.md),
  [ru/PAPER_PORTFOLIOS.md](./ru/PAPER_PORTFOLIOS.md) and the
  [TRADING.md](./TRADING.md) / [ru](./ru/TRADING.md) / [kk](./kk/TRADING.md)
  guides.
- [x] Full R6 verification matrix (machine/golden-replay/restart suites,
  command-handler and e2e journeys) consolidated and green in exact-commit
  CI. The roadmap §10 determinism criterion passed: the golden replay
  produced byte-identical event streams twice, a mid-cycle restart reached
  the identical terminal state, ledger replay equals the final adapter
  state, and committed capital never exceeded the worst-case bound. One
  pre-acceptance bug (read-model DCA metadata field names diverging from
  the browser contract) was found by the test pass and fixed before
  acceptance.
- [x] Release gate: exact-commit CI evidence, protected slot, paired
  backup/isolated-restore rehearsal, production cutover and acceptance
  record.

Production now runs protected slot `r6a-schema16-e2411ab` at commit
`e2411ab2f0b4540200089af8128304f71d3f73e0`, still on port 4180 in the
`public-http-paper` runtime with the same three project-owned units.
Exact-SHA GitHub Actions run `29633743310` passed all 6/6 jobs. The
release carries no migration: PostgreSQL schema 16 and the trading SQLite
schema 9 are unchanged. Paired recovery generations `440523a6`
(pre-cutover) and `65bb4359` (post-cutover, isolated drill passed) were
verified. Gate, rehearsal and cutover evidence is recorded in
[R6 DCA paper robot evidence](./evidence/R6_DCA_PAPER_ROBOT.md).

R7 (the Grid paper robot on the same ledger and golden-replay harness) is
now also accepted and deployed; see the next section.

## R7 grid paper robot accepted and deployed — 2026-07-18

This slice (roadmap R7) puts a Grid robot on the shared paper execution
contract delivered by R6, reusing that foundation verbatim: the robot-kind
discriminator, the `averaging-v1` fill behavior, settings-table machine
snapshots, per-transition idempotency keys, the golden-replay harness, the
worst-case preview pattern, engine kind dispatch and additive read-model
runtime metadata. It passed the full [RELEASING.md](./RELEASING.md) gate —
exact-commit CI, a protected release slot, the paired
backup/isolated-restore rehearsal and the production cutover — and was
accepted and deployed on 2026-07-18. The increment changes no PostgreSQL
or SQLite schema, and legacy strategy/DCA create payloads hash
identically.

- [x] Shared `grid-params-v1` contract (`packages/contracts/grid.ts`):
  exact fail-closed parser with the research-only safety envelope, the
  deterministic six-decimal `gridLevelPrices` ladder shared by the browser
  preview and the machine, and the conservative ceil-to-six-decimals
  `worstCaseGridCapitalQuote` behind the same
  `WORST_CASE_EXCEEDS_ALLOCATION` create gate as DCA.
- [x] Pure `grid-state-v1` ladder machine
  (`backend/src/trading/grid/machine.ts`): anchor placement rule (strictly
  below the anchor close arms buys, strictly above arms sells, exact-at
  never arms; long/short arm one ladder), paired close limits at adjacent
  level prices, realized round-trip accounting net of the fee model,
  cooldown re-arm, one consolidated placement round per gap batch,
  outside-range pause/stop, stop-loss flatten, `maxCycles`, and
  deterministic `grid:<botId>:<epochCycle>:<ordinal>` transition keys
  doubling as durable order client ids.
- [x] Runtime and engine dispatch
  (`backend/src/trading/grid/{runtime,engineBridge}.ts`): bounded step
  loop, per-transition `gridState:<botId>` snapshots, order-journal
  reconciliation so a restart never duplicates level orders or reserves,
  ledger-epoch guard and fail-closed pause on execution errors.
- [x] Additive read-model `grid` runtime metadata with browser-shaped
  field names, plus the browser slice: **Strategy | DCA | Grid** create
  toggle, grid fieldset with inline validation, live worst-case preview
  and the pre-start level-price preview list, detail-drawer grid section
  separating realized grid PnL from evidence-aware inventory PnL, and
  EN/RU/KK catalogs.
- [x] EN/RU/KK user documentation: grid sections in
  [PAPER_PORTFOLIOS.md](./PAPER_PORTFOLIOS.md),
  [ru/PAPER_PORTFOLIOS.md](./ru/PAPER_PORTFOLIOS.md) and the
  [TRADING.md](./TRADING.md) / [ru](./ru/TRADING.md) /
  [kk](./kk/TRADING.md) guides.
- [x] Full R7 verification matrix consolidated green in exact-commit CI:
  contract goldens, machine suite (gap batches, pause/resume/stop
  variants, stop-loss, `maxCycles`, long/short, snapshot round-trip),
  golden replay driven twice byte-identically with a duplicate-free
  mid-cycle restart, command-handler round trip, frontend and e2e
  journeys. The roadmap §10 determinism criterion passed: the golden
  replay produced byte-identical event streams twice, the four-level gap
  bar settled in a single consolidated placement round with a contiguous
  duplicate-free order clientId set (a price gap never creates a
  cascade), a mid-cycle restart reached the identical terminal state with
  the identical order clientId set as the uninterrupted run (restart
  never duplicates levels or reserves), ledger replay equals the final
  adapter state, and committed capital never exceeded the worst-case
  bound, which is previewed in the create form before confirmation. One
  pre-acceptance bug (the browser read-model parser rejected negative
  short-grid inventory quantities) was found by the test pass and fixed
  before acceptance.
- [x] Release gate: exact-commit CI evidence, protected slot, paired
  backup/isolated-restore rehearsal, production cutover and acceptance
  record.

Production now runs protected slot `r7a-schema16-baf4217` at commit
`baf42178d33043fde0965d008aee9f09462df699`, still on port 4180 in the
`public-http-paper` runtime with the same three project-owned units.
Exact-SHA GitHub Actions run `29636312303` passed all 6/6 jobs. The
release carries no migration: PostgreSQL schema 16 and the trading SQLite
schema 9 are unchanged. Paired recovery generations `0ee96dbe`
(pre-cutover) and `cb3702ac` (post-cutover, isolated drill passed) were
verified. Gate, rehearsal and cutover evidence is recorded in
[R7 grid paper robot evidence](./evidence/R7_GRID_PAPER_ROBOT.md).

R8 (owner-scoped multi-leg paper intents on the common capital plane) is
now also accepted and deployed; see the next section.

## R8 owner-scoped multi-leg paper intents accepted and deployed — 2026-07-18

This slice (roadmap R8) integrates the delivered, isolated
`backend/src/arbitrage/paperMultiLeg` research run machine with the
canonical owner-scoped portfolio boundary: durable multi-leg intents
inside the versioned trading store, a common worst-case capital
reservation, a combined both-legs-all-costs research PnL and an
opportunity-to-intent browser handoff. The pure engine, plan builders,
freshness validation and canonical hashing are reused verbatim — the
state machine is not forked — and the legacy admin-gated multi-leg
journal stays byte-identical. It passed the full
[RELEASING.md](./RELEASING.md) gate — exact-commit CI, a protected
release slot, the paired backup/isolated-restore rehearsal including the
copy-only SQLite 9→10 migration rehearsal, and the production cutover —
and was accepted and deployed on 2026-07-18. Unlike R6/R7 this increment
carries a migration: the trading SQLite moved to schema 10 (additive
only, the first SQLite migration since R4) while PostgreSQL stays at
schema 16, and legacy executor request hashes stay byte-identical.

- [x] Trading SQLite migration v10 `owner_scoped_paper_multi_leg`
  (`backend/src/trading/multiLeg/migration.ts`): additive-only
  `paper_multi_leg_intents` plus append-only
  `paper_multi_leg_intent_events` with contiguous sequences, a unique
  event idempotency key and update/delete-rejecting triggers;
  `TRADING_SCHEMA_VERSION` 10 with the pinned migration-chain tests
  extended and v1..v9 SQL byte-identical.
- [x] Server contract (`backend/src/trading/multiLeg/contract.ts`):
  ceil-to-six-decimals `worstCaseMultiLegCapitalQuote` (every leg
  notional plus modeled fees for both the original and the compensation
  direction), `combinedMultiLegPnl` over all recorded original and
  compensation fills with explicit residual-exposure lines, exact micro
  conversion, the `MULTI_LEG_*` error codes and the 3-per-owner /
  2-per-portfolio active-intent limits.
- [x] Additive executor payload kinds `paper-multi-leg.submit` and
  `paper-multi-leg.kill-switch` with legacy request hashes asserted
  byte-identical, plus the fenced apply pipeline
  (`backend/src/trading/multiLeg/{intentStore,intentService}.ts`):
  kill-switch check, fail-closed plan build/validation, limits,
  worst-case reservation against epoch cash minus running reservations,
  every engine transition durably journaled under
  `mleg:<intentId>:<sequence>`, terminal stamp and receipt in one
  transaction, redelivery resuming the same intent and startup
  `recoverIncompletePaperMultiLegIntents` reaching the identical
  terminal state with a single guarded reservation release.
- [x] Read model: `availableCapital` subtracting running multi-leg
  reservations and the additive `multiLeg` detail section (kill-switch
  state, recent intents with outcome, source, reserved capital, signed
  net PnL, fees, per-leg fill/compensation rows and residual exposure)
  with browser-exact field names.
- [x] Browser slice: the **Run paper multi-leg** action on eligible
  (`paperPlan: ready`) opportunity research cards with a confirm dialog
  (portfolio selector, client worst-case mirror with honest degraded
  states, stable idempotency key, exact rejection-code surfacing), the
  portfolio-center multi-leg intents section with outcome badges, legs
  disclosure, the explicit combined-PnL note, residual-exposure lines
  and the confirmed owner kill-switch toggle, plus EN/RU/KK catalogs.
- [x] Migration rehearsal script
  `scripts/rehearse-trading-migration.mjs` (copy-only 0→10/9→10 runs
  verified, rerun no-op) for the release-time paired rehearsal.
- [x] EN/RU/KK user documentation:
  [PAPER_PORTFOLIOS.md](./PAPER_PORTFOLIOS.md) /
  [ru](./ru/PAPER_PORTFOLIOS.md) multi-leg intents section,
  [TRADING.md](./TRADING.md) / [ru](./ru/TRADING.md) /
  [kk](./kk/TRADING.md) opportunity-research user flow, the
  [ARBITRAGE_SCREENER.md](./ARBITRAGE_SCREENER.md) handoff notes and
  the [MIGRATIONS.md](./MIGRATIONS.md) accepted schema-10 record.
- [x] E2E journey, full-matrix consolidation and the complete
  [RELEASING.md](./RELEASING.md) release gate: exact-commit CI, a
  protected slot, the paired backup/isolated-restore rehearsal
  including the SQLite 9→10 rehearsal, production cutover and the
  recorded acceptance evidence. The roadmap §12/R8.2 release criterion
  passed: a partially driven run truncated mid-flight recovered on a
  fresh service instance to a journal byte-equal to the uninterrupted
  run — identical terminal state, contiguous sequences with no
  duplicates and the capital reservation released exactly once
  (re-recovery is a no-op, and a redelivered submit resumes its own
  crashed intent replaying the exact durable receipt); the combined
  paper PnL includes both legs and every modeled cost with residual
  exposure listed explicitly instead of silently priced; and no
  opportunity is executable without depth/freshness evidence —
  research simulation only. Chromium e2e passed 95/95 including the
  new R8 journey, Firefox smoke 19/19 and visual regression 6/6.

Production now runs protected slot `r8a-schema16-69621f8` at commit
`69621f8107a713031f768320e9dc496010234100`, still on port 4180 in the
`public-http-paper` runtime with the same three project-owned units.
Exact-SHA GitHub Actions run `29639908389` passed all 6/6 jobs. Unlike
R6/R7 this release carries a migration: the trading SQLite migrated
9 → 10 with the additive-only `owner_scoped_paper_multi_leg` migration
(SQL SHA-256
`34584a750937468d065d90b0af09a074a541da29ba1e7a38f2c5278cc6e9890d`) —
the first SQLite migration since R4 — while PostgreSQL schema 16 is
unchanged. Before the cutover, `scripts/rehearse-trading-migration.mjs`
migrated a copy of the pre-cutover generation's production `trading.db`
from version 9 to 10, applying exactly `owner_scoped_paper_multi_leg`;
the rehearsal copies were removed and the generation re-verified.
Paired recovery generations `ddf80eba` (pre-cutover, verified at
SQLite 9 and retained as the replacement-only rollback source) and
`7ac9a851` (post-cutover at SQLite 10, isolated drill passed) were
verified. Gate, rehearsal and cutover evidence is recorded in
[R8 multi-leg paper intents evidence](./evidence/R8_MULTI_LEG_PAPER_INTENTS.md).

The next increment is R9 (the server multi-market GA pipeline plus the
D2 ADR for the canonical Strategy IR/dataset/backtest contract); its
first slice R9.1 is now also accepted and deployed — see the next
section.

## R9.1 server multi-market evaluation accepted and deployed — 2026-07-18

This slice (roadmap R9.1 plus decision D2) closed decision D2 with
[ADR 0003](./adr/0003-canonical-ir-dataset-backtest-contract.md) and
delivered the generic research-job registry, the server-owned
`multi-market-eval` job kind and the generator panel's server
evaluation flow. It passed the full [RELEASING.md](./RELEASING.md)
gate — exact-commit CI, a protected release slot, the paired
backup/isolated-restore rehearsal and the production cutover — and was
accepted and deployed on 2026-07-18. Like R6/R7 — and unlike R8 — it
carries no PostgreSQL or trading-SQLite schema change (the durable
compute-job queue already accepts kind-discriminated jobs), keeps the
existing `backtest`/`screener` job APIs byte-identical and stays
research-only: promotion and gallery surfaces remain forbidden until
R9.2/R9.3.

- [x] [ADR 0003 canonical IR, dataset and backtest contract](./adr/0003-canonical-ir-dataset-backtest-contract.md)
  recorded with Status: Accepted, closing decision D2 before the job API:
  canonical Strategy IR = `IR_VERSION 4` in `packages/strategy-core` with
  `parseStrategyIR` as the only inbound trust boundary, the versioned
  `dataset-v1` contract with embargo split and survivorship policy, and
  the deterministic engine identity `BACKTEST_ENGINE_VERSION`. The
  roadmap D2 decision-table row is now flipped open → closed with the
  ADR link as part of this acceptance.
- [x] IR drift guard `scripts/check-strategy-core-ir.mjs`: pinned SHA-256
  digests of the hand-maintained `packages/strategy-core`
  `index.js`/`index.d.ts` pair plus an `IR_VERSION 4` assertion, wired
  into the strategy-core `check` chain so silent IR edits fail
  `npm run check`.
- [x] Pure `packages/backtest-core/dataset.ts`: `DatasetDescriptorV1`,
  the canonical fingerprint serialization with `String(Number)` bar
  formatting, `splitDatasetBars` with time-ordered train/test windows and
  embargo gap (fails closed on empty windows or unordered bars), bounds
  constants and the exported `BACKTEST_ENGINE_VERSION`.
- [x] Generic research-job registry (`backend/src/jobs/registry.ts`):
  strict per-kind payload schemas and dispatch for the existing
  `backtest` (worker-thread) and `screener` (in-process) kinds moved
  behind definitions with byte-identical behavior; unknown kinds keep the
  hard-fail error.
- [x] Job kind `multi-market-eval`
  (`backend/src/workers/multiMarketEvalTask.ts` plus the bounded
  `backtestThreadRunner.ts` adapter): 1..6 unique catalog markets on one
  timeframe, real closed provider bars only under a shared 90-second
  budget (explicit `multi_market_eval_*` failure codes, never synthetic
  fills), `dataset-v1` fingerprint, embargo split, per-market train and
  out-of-sample backtests through the existing backtest worker thread,
  a shared capital-pool out-of-sample portfolio run and a deterministic
  `multi-market-eval-v1` result bounded at 256 KiB with cancellation and
  phase-scaled heartbeats.
- [x] Browser slice: `frontend/src/strategy/evaluationClient.ts`
  (submit/poll/cancel with client-side bounds and fail-closed result
  parsing) and the generator panel **Server evaluation (multi-market)**
  section — market/timeframe/lookback/split controls with spec defaults,
  per-owner quota surfacing, explicit queued/running/failed/cancelled
  states, results cached per candidate + dataset fingerprint and fed to
  the pure `rankMultiMarketEvaluations` ranker, which flips the ranking
  section from unavailable to a ranked list with the dataset fingerprint
  and engine version provenance line; EN/RU/KK catalogs.
- [x] Dataset contract suite
  (`backend/tests/backtestDatasetContract.test.ts`) covering fingerprint
  goldens, canonical formatting, split determinism, the embargo gap and
  no-lookahead ordering.
- [x] The registry/multi-market-eval/route parity suites, frontend
  client and generator-flow suites, the `r9-generator-eval` E2E
  journey, and the full [RELEASING.md](./RELEASING.md) gate
  (exact-commit CI, protected slot, paired backup/isolated-restore
  rehearsal, production cutover and recorded evidence). The roadmap
  §13 release criterion passed: the same candle set driven twice
  through the full evaluation path produced **byte-identical result
  JSON** (golden dataset fingerprint `d076618630cf5842…`, golden
  train/OOS metrics), and the tested embargo split laws prove no
  lookahead or leakage. One integration bug was found and fixed
  pre-acceptance: a zero-loss window's infinite profit factor is
  stored as JSONB null, and the client parser now maps it to NaN so
  the pure ranker's finite-metrics gate fails that window closed
  instead of rejecting the whole completed job. Vitest passed 3263
  with 130 skipped; Chromium e2e passed 96/96 including the new R9.1
  generator-evaluation journey, Firefox smoke 19/19 and visual
  regression 6/6.

Canonical behavior for the delivered contracts is documented in the
[API reference](./API.md) research-jobs section and the
[strategy reference](./STRATEGIES.md) server multi-market evaluation
section.

Production now runs protected slot `r9a-schema16-4f5bc64` at commit
`4f5bc64e9dfb35d379a55690755a76f7594b226d`, still on port 4180 in the
`public-http-paper` runtime with the same three project-owned units.
Exact-SHA GitHub Actions run `29643197555` passed all 6/6 jobs. Like
R6/R7 — and unlike R8 — this release carries no migration: PostgreSQL
schema 16 and the trading SQLite schema 10 are unchanged. Paired
recovery generations `92026f70` (pre-cutover, verified and retained as
the replacement-only rollback source) and `e894eede` (post-cutover,
isolated drill passed) were verified. Gate and cutover evidence is
recorded in
[R9.1 server evaluation evidence](./evidence/R9_1_SERVER_EVALUATION.md).

R9 overall is not finished: R9.2 (GA lineage, Pareto/OOS promotion and
checkpoint/resume) is implemented on `main` but **not accepted** — see
the next section — and R9.3 (the strategy gallery) has not started.

## R9.2 server GA evolution with lineage and promotion — in progress, NOT accepted

This slice is **implemented but not accepted or deployed**. Production
still runs the accepted R9.1 slot `r9a-schema16-4f5bc64` on PostgreSQL
schema 16 and trading SQLite schema 10; the new schema-17 migration has
not been applied to any production database, and no protected release
slot, exact-SHA CI acceptance run, paired backup/rehearsal or cutover
evidence exists yet. Everything below is code-and-test evidence only.
The slice stays research-only: promotion targets the owner's own
strategy library, and the public gallery remains out of scope until
R9.3.

- [x] Pure package extraction: the browser generator primitives moved
  byte-identically into the workspace package
  `packages/strategy-generator` (zero IO preserved, checked-in
  generated artifacts with the
  `scripts/check-strategy-generator-generated.mjs` staleness guard,
  `frontend/src/strategy/generator` reduced to a re-export shim; the
  existing generator suites run unchanged from the new location).
- [x] Additive PostgreSQL migration 17 `ga_evolution_lineage`
  (checksum
  `4169ec0148c63415abe913195d34b03fa603039d0fe7defabfe76a89f7a61a73`):
  bounded `ga_runs` (size-checked config/checkpoint/pareto JSONB and
  at most one running row per owner) plus `ga_candidates` lineage rows
  keyed `(run_id, fingerprint)`; migrations v1–v16 stay byte-identical
  and the migration-chain suites received the established v15/v16
  bump treatment.
- [x] Job kind `ga-evolution` in the research-job registry
  (in-process lane, `backend/src/workers/gaEvolutionTask.ts` +
  `backend/src/ga/`): strict start/resume payloads (1..4 markets on
  one timeframe, lookback 500..20000, `dataset-v1` split, seed,
  population 8..64, generations 1..16, canonical objective vector),
  the dataset fetched once through the reused R9.1 fetch/evaluate
  discipline and pinned by fingerprint, fingerprint dedup (no
  candidate is ever re-evaluated), per-generation atomic lineage +
  cumulative Pareto ranks + resume checkpoint, cancel → resumable
  `checkpointed` result, resume that refetches and verifies the
  fingerprint (`ga_dataset_drift` on divergence) and a bounded
  `ga-evolution-v1` result ≤ 256 KiB. Existing job kinds stay
  byte-identical; at most one active GA run per owner.
- [x] Owner-scoped `/api/ga` read surface (runs, run detail with the
  frontier and a bounded candidate page, candidate detail with the
  lineage chain) plus `POST /api/ga/promote`, which stamps
  `promoted_at` idempotently and returns the full IR + provenance
  bundle; the server refuses promotion without a clean out-of-sample
  report (`ga_promotion_requires_oos` / `ga_promotion_overfit`).
- [x] Browser slice: the generator panel **Server evolution (GA)**
  section (bounded config with an explicit seed field, run list with
  explicit running/checkpointed/completed/failed/cancelled states and
  generation progress, cancel-to-checkpoint and resume, the Pareto
  frontier table with OOS-gap badges and explicit overfit flags, the
  candidate drawer with lineage chain, mutation log and per-market
  train/OOS metrics, and promotion disabled with its reason when the
  OOS report is missing or flags overfit), saving promoted candidates
  into the existing portable-artifact library flow with provenance;
  EN/RU/KK catalogs.
- [ ] The dedicated R9.2 verification program from the increment spec:
  the seeded-reproducibility suite (same seed + dataset ⇒ identical
  results and lineage, checkpoint/resume equal to an uninterrupted
  run, dataset drift, dedup evaluation counts, Pareto golden sets,
  promotion refusals, single-active-run limit, result bounds), the
  GA route suites, the frontend server-evolution suites, the
  PG-gated migration-17 integration coverage and the
  `r9b-ga-evolution` E2E journey.
- [ ] The [RELEASING.md](./RELEASING.md) acceptance gate: exact-commit
  CI, a protected slot, the schema-16→17 paired
  backup/isolated-restore rehearsal, the production cutover and
  recorded evidence. Until this box is checked, R9.2 is not accepted
  and this section must not be read as a release record.

Contract documentation for the in-progress surfaces lives in the
[API reference](./API.md) server-GA-evolution section, the
[strategy reference](./STRATEGIES.md) R9.2 section and the
[migration notes](./MIGRATIONS.md) in-progress schema-17 note.

## Delivered slices (not full roadmap completion)

### Product workspaces, strategy research and market evidence — 2026-07-15

- [x] Separate the primary browser information architecture into **Monitoring**, **Automation** and
  read-only **Screener**. Automation retains explicit **Strategies** and **Robots** sub-sections.
- [x] Add the pre-R4 global running-robot count and browser robots/portfolio center that groups available
  live exchange-account and isolated paper-bot state. It shows available balance/equity, realized
  P&L, positions and open orders, labels own versus managed account metadata, and has explicit
  loading, error and empty states. Margin and borrowing remain unavailable when the portfolio API
  does not supply them; the UI does not synthesize values.
- [x] Add owner-scoped CRUD for Binance/Bybit trading accounts with enabled and own/managed fields,
  secure-origin mutation checks and in-use deletion/disable guards. Every account may hold its own
  AES-256-GCM credentials authenticated against owner/account/exchange. Bots, journals, portfolio,
  emergency state, audit and private WebSocket events are owner-filtered; application admins grant
  roles but do not bypass another user's trading boundary. Schema v6 transactionally assigns
  legacy rows/keys to one selected administrator and disarms live trading during migration.
- [x] Let visible-range horizontal Volume Profile use chart candles or an independently selected
  `1m`, `5m`, `15m`, `1h`, `4h` or `1d` source. Bounded paging is cancellable and persisted; an
  incomplete, fallback/synthetic, unavailable or over-budget source fails closed instead of mixing
  fabricated volume into the profile. Candle-volume display remains a separate control.
- [x] Add deterministic, bounded genetic parameter optimization in the existing Web Worker with up
  to 12 axes, seeded population, tournament selection, crossover, mutation, elitism, deduplication,
  explicit cancel/phase progress, train/validation composite fitness and one final untouched test of
  the preselected winner only. Applying a passing winner updates Blockly and is bound to the exact
  strategy/market/timeframe/history/config evidence; undersized warm-up windows fail closed. The
  score is comparative backtest research, not a profitability forecast.
- [x] Add a separate deterministic structural strategy generator for long/short trend,
  mean-reversion, breakout and momentum IR. It provides bounded seeded crossover/mutation,
  fingerprints, deduplication, provenance, canonical validation and reviewed import into Strategy
  Studio. The browser generator currently produces diversity only: it does not fetch candles, run
  backtests or rank candidates. A pure multi-market ranker accepts caller-supplied train/OOS metrics,
  but no browser multi-market fitness pipeline is connected.
- [x] Publish the strict `market-opportunity-v1` research envelope and a short-lived bounded browser
  handoff from supported Screener rows to an Automation research card. The card exposes economics,
  legs, evidence and blockers; it never authorizes live execution. It is not the exact
  `paper-multi-leg-plan-v1` consumed by the paper journal, so opening the card cannot place an order.
- [x] Add an admin-only Order-book ML research foundation and Screener workflow for uploaded,
  reconstructed, sequence-verified aggregate L2 snapshots. It includes fail-closed quality checks,
  past-only features, future-label provenance, purged chronological train/validation/test splits,
  a train-only-scaled ridge baseline and exact-scope inference. The bounded API holds at most four
  30-minute in-memory sessions, 2,000 snapshots and three models per session; there is no online
  collector or durable model registry. Anonymous aggregate liquidity cannot establish participant
  identity, the score is not a calibrated probability, and neither the UI nor API can place paper
  or live orders.

### Arbitrage P0 correctness and basis workspace — 2026-07-14

- [x] Aggregate public Binance/Bybit spot and perpetual best bid/ask data without credentials.
- [x] Compare buy-spot ask with same- and other-venue perpetual bid in all four Binance/Bybit directions.
- [x] Report configurable cost-adjusted edge, top-book capacity and funding separately.
- [x] Exclude delivery/non-executable rows and expose partial/stale source status explicitly.
- [x] Bootstrap discovery with bounded REST and maintain shared direct public WebSockets for all four venue/market sources.
- [x] Mark a socket healthy only after valid market data, terminate silent feeds and reconnect with bounded jittered exponential backoff.
- [x] Add on-demand two-book depth with one matched base quantity, common-step rounding, residual-delta reporting and fail-closed paper entry.
- [x] Normalize Binance/Bybit asset/instrument IDs, lot/tick/minimum filters and funding intervals in a cached registry, use verified execution filters for depth, require strict venue-native identity for same-venue routes and reviewed economic identity (currently BTC/ETH) before cross-venue matching.
- [x] Preserve per-leg exchange/receive timestamps, visibly classify degraded discovery rows and suppress them from alerts, history and paper/live gates outside bounded quote-age or cross-leg-skew limits.
- [x] Count only discrete registry-verified funding settlements; unknown schedules receive no speculative funding credit.
- [x] Filter server-side before truncation, rank expected executable dollars by default and expose total/truncated metadata.
- [x] Persist a sampled seven-day SQLite opportunity history and expose a bounded history endpoint/chart.
- [x] Persist authenticated alert rules and a durable at-least-once outbox with per-rule/route crossing, retry/restart/cancellation and visible delivery state.
- [x] Add an append-only browser paper ledger with matched entry/exit fills, explicit manually confirmed funding events, deterministic replay, migration and restart recovery.
- [x] Add route-specific cost waterfall, required capital/margin buffer, convergence scenarios and ranking by net dollars, ROI, edge, capacity or quality.
- [x] Add lazy EN/RU/KK workspace, accessible table, responsive filters, canonical docs and unit/API/E2E tests.
- [x] Keep the entire feature read-only; no order placement or guaranteed-profit claim.

### Arbitrage P1 strategy engines and venue products — 2026-07-14

- [x] Publish three-leg Binance/Bybit spot-cycle research from directional REST top-book snapshots with fee/step rounding after every leg, residual dust and fail-closed partial cycles; it does not claim full-depth execution.
- [x] Publish read-only Bybit `FundingRateArb`, `CarryTrade`, `FutureSpread` and `PerpBasis` native combination books.
- [x] Add a pure pairwise evaluator for prefunded spot-spot, perpetual-perpetual, reverse carry and dated/calendar spreads with explicit assumptions and `executable: false`.
- [x] Add deterministic research-only discovery/evaluation for cross-venue spot-spot, reverse carry, perpetual-perpetual funding, spot-dated-future, calendar and perpetual-future routes with exact assumption scopes and bounded HTTP input.
- [x] Add a bounded four-to-eight-leg spot-cycle generator/simulator with exact accounting units,
  sequence-verified depth, fee/dust conservation, explicit work limits, a credential-free HTTP
  boundary and a generated SDK parser that independently checks arithmetic and provenance.
- [x] Add an isolated OKX spot/swap/futures public adapter and normalized registry metadata.
- [x] Add bounded selected-instrument OKX/Gate/Hyperliquid/Deribit/Kraken/Coinbase/dYdX/KuCoin/MEXC
  public WebSocket feeds and a continuous route-family discovery bridge. OKX/Gate/Deribit/Coinbase/
  KuCoin/MEXC retain protocol sequence proof; Kraken Spot uses checksum proof, Kraken Futures and
  dYdX stay sequence-observed, and Hyperliquid remains an atomic-snapshot signal. The operator-
  configurable server lifecycle, read-only API/strict SDK and EN/RU/KK browser source/route view with
  dynamic venue/source filters are runtime-connected; actual subscriptions still require explicit
  operator allowlist activation, and dedicated venue pages/chart selectors are not delivered.
- [x] Add server-owned `continuous-market-economics-v1` evaluation to the same bounded route-family
  snapshot. It evaluates the complete compatible universe below the 24-instrument/552-candidate
  hard bound before a maximum-500 publication slice, with separate evaluated/published counts and
  net quote-value/basis/capacity/continuity/freshness ranking. It matches the maximum common quantity visible at two fresh sequence/checksum-verified
  top-book entry quotes, fences connection generations and reports entry quote-value difference and
  basis before/after operator-environment public taker quote-equivalent fee estimates. Fee asset and
  exposure impact are unverified. Ordered long/short economic identity provenance includes
  source/version/as-of/valid-until, while identity validity and all derived arithmetic fail closed
  in the engine and strict SDK. Every result remains `readOnly`, `researchOnly`, `executable: false`
  and strategy-blocked: account tier, balances, inventory, networks, borrow, margin, full-horizon
  funding, convergence, expiry/delivery, exit and execution evidence are not inferred.
- [x] Publish explicit continuous runtime/discovery coverage (`complete`, `current`, retained-prior
  state and reason). A failed later registry refresh can retain previous discovery only as
  incomplete/non-current evidence; a first failure has no successful `refreshedAt`. Continuous
  lifecycle skips market-data-blocked zero-evidence candidates, preserves exact failure codes and
  propagates refresh state, stale sources and candidate/economics truncation while keeping every
  accepted market observation evidence-incomplete and `actionable: false`.
- [x] Add a bounded file-backed continuous-route allowlist loader and the reviewed
  `config/continuous-routes.research.json` research configuration. The file is not auto-activated:
  a deployment must set the absolute `ARBITRAGE_CONTINUOUS_ROUTES_FILE` path (or the mutually
  exclusive inline JSON variable), and repository/deterministic fixture presence is not proof that
  a running process opened those subscriptions.
- [x] Mount the public no-store `continuous-feed-health-v1` endpoint, strict generated SDK parser/
  client method and EN/RU/KK browser diagnostics for aggregate state, reconnect generation, last
  receive and fresh current-generation continuity. This is bounded public transport observability;
  `idle`, `healthy` or protocol-ready does not prove route economics, private evidence, soak or
  production readiness.
- [x] Add a daily/manual nine-target credential-free public-feed canary with deterministic
  route-ready/research-only book, continuity-protocol and funding requirements, bounded schema-v3
  JSON, always-uploaded failure artifacts and explicit no-order, no-soak and
  no-mainnet-readiness fields. The 2026-07-14 local run passed OKX, Gate, Hyperliquid, Deribit
  public testnet, Coinbase, dYdX, KuCoin and MEXC; Kraken remained an explicit host TLS-egress
  failure. Live runs exposed and regression-tested KuCoin binary-marked JSON, Coinbase's
  connection-global cross-channel sequence and the MEXC snapshot/delta bootstrap race. The earlier
  Coinbase 4.8 MiB/43k-row snapshot bounds remain fixed without increasing retained book depth.

### Arbitrage P2 reproducibility, scale and extension surface — 2026-07-14

- [x] Add immutable replay manifests, event digests, point-in-time listing/delisting, version provenance and deterministic basis backtests using executable entry and exit depth.
- [x] Prove 10,000-route dependency-indexed recomputation, bounded browser snapshots and the deterministic slow-client disconnect policy; a real overloaded-socket transport test remains separate from the policy proof.
- [x] Add a generated, transport-validating, public/read-only TypeScript SDK with no credential or order methods.
- [x] Add a bounded machine-readable documentation truth contract and deterministic CI guard that
  imports the rendered scanner modes, shared public registry and continuous protocol allowlist,
  probes each continuous factory branch without networking, and cross-checks generated endpoint
  totals plus the canonical English capability rows.
- [x] Add one bounded public market-data facade for allowlisted venue adapters with typed upstream errors.
- [x] Add isolated credential-free Gate.io and Hyperliquid public adapters with recorded fixtures and fail-closed native quantity rules.
- [x] Add and expose the isolated Deribit futures/options public adapter plus pure put-call parity,
  conversion/reversal, box and synthetic-forward engine through a bounded strict HTTP/SDK research
  surface and lazy EN/RU/KK caller-supplied scenario UI; live selected-book wiring, private execution
  and order controls remain absent by design.
- [x] Add an isolated dYdX public Indexer perpetual metadata/selected-book/funding adapter plus
  bounded pure reducers for Indexer logical sequencing and decoded full-node optimistic/finalized
  state. It is registered in the shared public facade, instrument registry and generic SDK path.
  The shared continuous hub opens bounded unbatched Indexer books with connected identity and exact
  `message_id` continuity, but publishes them only as `sequence-observed`; streaming funding is not
  invented. Every book remains non-canonical and route-ineligible. Owned-node reconnect/reorg
  evidence, dedicated venue UX and all wallet/private execution remain open.
- [x] Verify the scanner's RU/KK mode cycle, keyboard activation, semantic tables, axe audit, mobile containment and 200% text-size behavior; mobile workspace buttons retain localized accessible names when their visible labels collapse to icons.

### Arbitrage verification, scenario and operator surfaces — 2026-07-14

- [x] Add a selected-route triangular verifier that reconstructs three bounded Binance/Bybit Spot
  L2 books, checks sequence and connection-generation leases, and repeats exact fee, lot, depth,
  VWAP and residual simulation through non-executable HTTP, strict SDK and EN/RU/KK browser views.
- [x] Mount `funding-curve-v1` through public HTTP and the strict read-only SDK, and add a lazy
  localized scenario workspace for fresh perpetual instruments with verified discrete schedules,
  exact reviewed economic identity and additive stress. The result is a rate projection, not P&L.
- [x] Replace the browser-side capability/registry join with a server-owned funding universe that
  intersects fresh verified trading perpetuals with the adapters actually implemented by Funding
  Curve. Strict API/SDK bounds, catalog validity and accessible loading/error/empty/partial states
  prevent unsupported Binance/Bybit selections from appearing as usable.
- [x] Add the localized collapsible fork guide for double/pairwise, triple/triangular,
  intra-exchange and bounded four-to-eight-leg terminology without presenting any route as atomic
  or guaranteed profit.
- [x] Mount the protected family-aware research-alert policy/outbox API, server lifecycle and
  EN/RU/KK operator UI. Its account-aware evaluator still has no server-owned candidate/economics
  producer connection; continuous market-only lifecycle observations remain evidence-incomplete and
  do not cross this boundary. It therefore cannot yet originate a notification from live research
  candidates and has no order path.
- [x] Deliver the versioned static reviewed network-identity registry and mount its bounded public
  `GET /api/network-identity/registry` plus fail-closed `POST /api/network-identity/preflight` through
  the strict public SDK. The snapshot contains reviewed Binance/Bybit BTC/ETH native and Ethereum
  USDT/USDC representation mappings; it proves identity compatibility only. Dynamic deposit/
  withdrawal status, fees, limits, confirmations and an arrival observer are absent, so
  `transferCapabilities` stays empty and preflight cannot establish live transfer readiness.

No item above claims mainnet readiness. The funded 7–14-day Binance/Bybit soak remains explicitly
excluded by project decision; authenticated exchange smoke is manual and cannot be replaced by a
fixture or public canary.

### Reviewed installed-PWA Share Target — 2026-07-13

- [x] Register one file-only Share Target for exact Pine, strategy and plugin formats.
- [x] Exclude title, text, URL, generic JSON, trading data and order actions from the manifest.
- [x] Intercept only the exact same-origin multipart POST while all runtime/trading POST remains network-only.
- [x] Keep at most five opaque temporary batches for 24 hours with count, total and per-format bounds.
- [x] Show the metadata-only review in the root shell before Strategy Studio loads or contents are read.
- [x] Delete temporary data after Cancel or normal review hand-off and fail closed on invalid/expired records.
- [x] Reuse Pine Convert/Add, strategy checksum/schema and plugin signature/capability reviews.
- [x] Publish typed EN/RU/KK interface copy and documentation.

Verification covers strict URL tokens and worker messaging, no early content reads, generated
manifest/worker policy, a real production multipart share with unsupported/oversized files, record
deletion, axe and offline receive/cancel while runtime requests remain unavailable.

### Reviewed installed-PWA file handling — 2026-07-13

- [x] Register only exact `.pine`, `.strategy` and `.saltanat-plugin` desktop file handlers.
- [x] Keep manual Strategy Studio file inputs as the complete unsupported-browser fallback.
- [x] Show a metadata-only outer confirmation before reading file contents.
- [x] Bound launches to ten files and format-specific 1/2/5 MB limits; reject spoofed names and generic JSON.
- [x] Require Pine Convert/Add, checksum/schema strategy confirmation and full plugin signature/capability review.
- [x] Queue consecutive OS launches without replacing an active review.
- [x] Guarantee that opening a file cannot start a backtest, bot, paper session or live order.
- [x] Publish EN/RU/KK documentation and typed interface copy.

Verification covers feature detection, metadata-only collection, extension/name spoofing, size/count
limits, unreadable handles, exact manifest policy and production Chromium launch/review/import flows
for all three formats with axe and no library mutation before final confirmation.

### Distribution incident-response and rollback drill — 2026-07-13

- [x] Manifest every extracted release file with a sorted path, byte size and SHA-256.
- [x] Fail closed on changed, missing, extra, symbolic-link or release-identity mismatches.
- [x] Exercise immutable candidate/previous slots, controlled corruption detection and atomic pointer rollback.
- [x] Verify the previous slot and untouched source distribution after rollback.
- [x] Emit credential-free JSON evidence and include it in release checksums/attestations.
- [x] Publish an operational EN/RU/KK runbook that separates binary, database and venue recovery.

Verification covers manifest tampering, extra files, symlinks, identity binding and a complete fixture
drill plus a full locally packaged distribution whose internal/external manifest digest matched.

### Blank-screen-safe application startup — 2026-07-13

- [x] Keep a styled localized pre-React surface visible when the main application module fails.
- [x] Catch React render and lazy-module failures with a global accessible recovery boundary.
- [x] Offer retry, ordinary reload and selective application-file refresh without clearing user data.
- [x] Remove only the Saltanat worker and `saltanat-shell-*` caches, including stale workers in Vite development.
- [x] Limit automatic dynamic-import recovery to one attempt per tab and clear the marker after healthy startup.
- [x] Document operations and safety behavior in EN/RU/KK.

Verification covers error classification, loop prevention, selective cleanup and localized boundary
retry plus a production main-bundle failure with semantic recovery controls and axe.

### Local plugin signer blocklist — 2026-07-13

- [x] Store at most 100 strictly validated, deduplicated blocked fingerprints separately from package contents.
- [x] Make local trust and blocking mutually exclusive; blocking removes trust and unblocking never restores it.
- [x] Fail closed when the active signer or any authenticated rotation-chain key is blocked.
- [x] Prevent version/signer risk acknowledgements from bypassing a blocked-key decision.
- [x] Provide explicit reversible block/unblock controls in import review and the installed catalog.
- [x] State in EN/RU/KK that local blocking is not independently authenticated global revocation.

Verification covers corruption, bounds, deduplication, trust/block transitions and rotation-chain
matching plus a production import/catalog/block/re-import/acknowledge/unblock/cancel journey with axe.

### Authenticated plugin signer rotation — 2026-07-13

- [x] Define strict version-3 envelopes with at most eight sequential key transitions.
- [x] Require old-key and new-key ECDSA signatures over every domain-separated transition statement.
- [x] Reject missing/reordered steps, repeated keys, altered proofs and chains whose endpoint differs from the package signer.
- [x] Rotate the device-local identity only after destructive confirmation and atomically persist the new non-extractable key plus proof chain.
- [x] Serialize identity mutations with a same-origin exclusive Web Lock and reject stale-fingerprint rotation attempts.
- [x] Recognize verified continuity from any installed chain key without silently trusting the new fingerprint.
- [x] Preserve rotation provenance in installed artifacts/catalog and document compromise-recovery limitations in EN/RU/KK.

Verification covers one- and two-step rotation, dual-signature tampering, missing intermediates,
mismatched private keys, strict v2/v3 fields, update classification and production browser
create/rotate/export/parse/IndexedDB-reload plus authenticated-update review.

### Plugin update and signer-continuity review — 2026-07-13

- [x] Compare repeated package IDs against their highest installed semantic version.
- [x] Distinguish upgrades, same-version content changes, exact duplicates and downgrades.
- [x] Independently detect stable, changed, introduced, removed and absent signer keys.
- [x] Require separate explicit acknowledgements for every dangerous version and signer transition.
- [x] Preserve separate local installations rather than silently replacing editable or running state.
- [x] Provide complete EN/RU/KK review copy and production accessibility coverage.

Verification covers the pure transition matrix plus a production signed downgrade with an unrelated
key, sequentially blocked acknowledgements, axe review and cancellation without library mutation.

### Signed plugin identity and local trust — 2026-07-13

- [x] Add a strict signed envelope version while preserving visibly unsigned version-1 compatibility.
- [x] Verify ECDSA P-256/SHA-256 signatures, canonical embedded keys and SHA-256 fingerprints before app compatibility or library mutation.
- [x] Create the signing identity only after explicit user action and persist its private key as a non-extractable IndexedDB `CryptoKey`.
- [x] Keep bounded fingerprint trust pins separate from package contents and require explicit trust or forget actions.
- [x] Preserve signature scheme, fingerprint and trust-at-import provenance in installed artifacts and the package catalog.
- [x] Document identity, trust, loss, XSS and future rotation/recovery boundaries in English, Russian and Kazakh.

Verification covers signed round trips, signature/manifest tampering, malformed keys, mismatched key
pairs, strict v1/v2 fields, trust-store corruption/deduplication and a production create, sign,
download, parse, IndexedDB reload, trust, forget and re-trust journey.

### Installed plugin catalog and safe local uninstall — 2026-07-13

- [x] Reconstruct separate local installations from persisted plugin provenance, including legacy imports.
- [x] Persist and display package identity, publisher HTTPS link, license, compatibility, permissions and checksum.
- [x] Show package artifacts, local modification count and repeated imports independently.
- [x] Require destructive confirmation before removing editable artifacts, history and parameter overrides.
- [x] Block uninstall while any external library artifact depends on package contents.
- [x] State that independent bot/chart runtime snapshots are not stopped by library uninstall.
- [x] Provide typed EN/RU/KK catalog, empty, legacy, blocked, warning and completion states.

Verification covers grouping, repeated imports, input cleanup, dependency blockers and exact-installation
removal in the pure model plus a production import, reload, accessible catalog, blocked uninstall,
successful uninstall and second-reload journey.

### Plugin package review and authoring — 2026-07-13

- [x] Require explicit review of identity, integrity, capabilities and contents before import mutates the library.
- [x] Leave the library unchanged when review is cancelled with a button, backdrop or `Escape`.
- [x] Build packages from selected local artifacts with automatic transitive dependency closure.
- [x] Derive minimum capability permissions and deterministic package-local artifact IDs.
- [x] Download a checksum-protected file that passes the same strict parser used by import.
- [x] Provide typed EN/RU/KK authoring, review, validation and completion states.

Verification covers dependency closure/error cases, strict encode/parse compatibility, mandatory
review cancellation and confirmation, accessibility, browser download and parser re-verification.

### Declarative plugin foundation — 2026-07-12

- [x] Define a strict versioned `.saltanat-plugin` JSON envelope with a complete manifest SHA-256.
- [x] Reject unknown/executable fields, unsupported permissions, oversize packages and incompatible schemas/app versions.
- [x] Require package-local acyclic dependencies and capability declarations matching indicator/strategy behavior.
- [x] Remap imported artifact IDs/dependencies while retaining plugin, publisher, version and manifest provenance.
- [x] Keep import local and non-executing; every artifact remains editable and uses the normal compiler/backtest/run gates.
- [x] Provide typed EN/RU/KK import, safety, success and failure messaging plus a production accessibility journey.

Verification covers the pure envelope validator, tamper and capability/dependency failures, batch
artifact mapping, TypeScript workspace boundary and a real production file-input import.

### Shared-capital portfolio backtests — 2026-07-12

- [x] Run one compiled strategy across two to six unique markets over their common candle range.
- [x] Replay candidate fills chronologically through one mark-to-market equity pool.
- [x] Enforce concurrent-position, total gross-exposure, per-position and minimum-allocation limits.
- [x] Report accepted/rejected entries, funding, exposure, contribution and synchronized return correlation.
- [x] Measure historical VaR/expected shortfall, Ulcer Index, recovery duration and allocation concentration.
- [x] Run a deterministic, CPU-bounded moving-block bootstrap over shared-equity returns.
- [x] Reprice accepted trades under execution-cost, adverse-exit, doubled-funding and combined stress scenarios.
- [x] Report stressed drawdown and the break-even additional per-fill cost buffer without claiming a new market path.
- [x] Attribute accepted-fill commission, configured slippage and traced funding into a reconciled modeled TCA report.
- [x] Break execution cost and net outcome down by market and exit reason without claiming venue telemetry.
- [x] Export a versioned research file and disclose the market-local signal-equity limitation of v1.
- [x] Provide typed EN/RU/KK controls and semantic report tables.

Verification covers the pure allocator, market-loading orchestration, localized semantic rendering
and a production Chromium journey with axe checks.

### Complete Kazakh application locale — 2026-07-12

- [x] Add compile-time-complete Kazakh catalogs for Chart, Strategy Studio, Pine/backtest and Trading.
- [x] Cycle EN → RU → KK with persisted locale, browser-language discovery and localized document metadata.
- [x] Use `kk-KZ` for dates/numbers and remove binary EN/RU branches from components.
- [x] Keep Pine identifiers, command syntax and reviewed trading terms semantically stable.
- [x] Split the former 599-line shell catalog into independent language modules and a small facade.
- [x] Verify locale registry, safety copy, command reference, semantic rendering, browser persistence and axe.

Verification includes the complete 46-scenario Chromium gate, ten tagged Firefox critical journeys
and compile-time equality of every EN/RU/KK domain catalog.

### Installable network-truth-safe shell — 2026-07-12

- [x] Add a root-scoped standalone web manifest with a verified 512×512 PNG icon.
- [x] Register a generated service worker only in production and use a content-derived cache version.
- [x] Precache the exact same-origin static build while leaving manifest/worker updates network-managed.
- [x] Keep APIs, authentication and all market/trading streams network-only with no background sync or replay.
- [x] Align Express cache headers with immutable hashed assets and revalidated shell metadata.
- [x] Verify emitted assets at build time, cache policy in unit tests and real offline behavior in Chromium.

Offline availability means only that the static interface opens; it never claims current market
data, authenticated trading access or deferred execution.

### Optional offline Strategy Studio — 2026-07-13

- [x] Derive a separate Strategy Studio dependency graph from the final production bundle.
- [x] Install/remove it only through an explicit localized EN/RU/KK control, without delaying shell installation.
- [x] Include Blockly media and optimizer worker while excluding Trading View and every runtime route.
- [x] Add safe installed-app Chart/Strategy shortcuts and fail unknown/trading launch values closed to Chart.
- [x] Verify the build graph and a real offline Strategy Studio restart in Chromium.

### Mobile chart panels — 2026-07-12

- [x] Keep the mobile chart unobstructed by default instead of restoring two open desktop docks.
- [x] Expose markets and instrument statistics as mutually exclusive native modal bottom sheets.
- [x] Support initial focus, focus restoration, `Escape`, backdrop and explicit close dismissal.
- [x] Close the market sheet after symbol selection and preserve desktop panel persistence independently.
- [x] Use dynamic/small viewport units, safe-area insets and coarse-pointer targets.
- [x] Verify Chromium, Firefox, axe and a deterministic mobile visual baseline.

### Touch-first chart navigation — 2026-07-12

- [x] Add data-anchored two-finger pinch and simultaneous horizontal pan on the interaction Canvas.
- [x] Hand a remaining finger back to ordinary pan without a viewport jump.
- [x] Keep native page scroll/zoom containment scoped to the chart and retain wheel, trackpad, pointer and keyboard paths.
- [x] Add coarse-pointer guidance and 48px scale/reset controls.
- [x] Verify the pure gesture model and a production-build Chromium multi-touch journey.

### Earlier trading-safety and architecture closure slice — 2026-07-11

- [x] Require complete `MarketKey` envelopes for trading candle events and prove Bybit/linear routing.
- [x] Persist protected-entry lifecycle stages and Binance entry/SL/TP identities; after an accepted
  entry, fail closed on rejected protection without rewriting the entry as rejected or releasing its
  reservation.
- [x] Persist bot-attributed Bybit spot inventory and constrain closes independently of account-wide
  holdings; keep Binance live spot disabled until authenticated spot execution accounting exists.
- [x] Require explicit positive base `qty` for every risk-increasing live order and reserve
  accepted/partial/filled-but-unaccounted journal rows plus pending spot-sell inventory.
- [x] Retain unaccounted partial fills after cancel/expiry and legacy replaced entries; compare
  futures venue positions with a durable gross-exposure shadow ledger.
- [x] Merge matched venue/local orders by conservative maximum, fail closed on identity conflicts,
  forbid live collision overrides and pause on terminal REST status without execution accounting.
- [x] Migrate the trading store to schema v2 with orders, events, fills, positions and strategy runs.
- [x] Reconcile every non-terminal order state before resumed automation can trade; ambiguous outcomes require operator action.
- [x] Enforce a repository-wide 600-line source budget with four reviewed pure-domain exceptions.
- [x] Complete deterministic scripted-exchange fixtures for failures, private-stream disconnect/reconnect and state recovery.

Verification:

- At that slice, TypeScript, Biome, documentation, architecture, Vitest, production build,
  bundle-budget, 44-scenario Playwright and three-baseline visual gates passed; this historical gate
  does not mark the later thirty-row scanner ledger complete.
- The largest production JavaScript request is below the enforced 200 KiB gzip ceiling; Blockly remains outside the initial Chart shell and is cached separately from project-owned block definitions.
- The funded 7–14-day Binance/Bybit soak and mainnet-readiness claim remain explicitly excluded.

### Accessibility and open-source release baseline — 2026-07-11

- [x] Enforce initial focus, Tab containment, Escape and focus restoration across core modal dialogs.
- [x] Apply visible focus and global reduced-motion behavior across the application.
- [x] Correct secondary text colours to meet current WCAG AA automated contrast checks.
- [x] Audit Chart, Strategy and Trading with axe WCAG 2/2.1 A/AA without application exclusions.
- [x] Verify keyboard operation, semantic chart tables and a 200% text-size monitoring path in Playwright.
- [x] Update `<html lang>`, direction metadata and localized document titles at runtime.
- [x] Publish accessibility evidence, contributor routing, asset provenance and migration policies.
- [x] Categorize automatic GitHub release notes alongside signed/SBOM/checksum release assets.

Verification:

- Dedicated production browser accessibility scenarios pass on Chromium.
- TypeScript, Biome, documentation and dependency-audit gates pass.

### Versioned Strategy and Indicator Studio — 2026-07-11

- [x] Separate Build, Validate, Preview, Backtest, Optimize, Run and Learn workflows.
- [x] Add a complete inspector contract and block-linked compiler diagnostics.
- [x] Generate editable EMA-cross, RSI-threshold and breakout strategies from a guided wizard.
- [x] Carry validated default/min/max/step/optimization metadata through Blockly, IR and optimizer.
- [x] Inline bounded non-recursive Blockly functions with numeric argument substitution.
- [x] Add schema-v2 artifact history, semantic versions, dependency validation, diff and rollback.
- [x] Verify SHA-256 portable strategy files and explicitly migrate legacy schema-v1 payloads.
- [x] Document the workflow and trust boundary in English, Russian and Kazakh.

Verification:

- Dedicated artifact, dependency, file, wizard, inspector and compiler-diagnostic tests pass.
- Frontend/backend TypeScript and repository lint pass.

### Professional chart workspace — 2026-07-11

- [x] Add keyboard/pointer-resizable side docks, dock swapping and 1/2/4 chart presets.
- [x] Link or unlink symbol, timeframe, crosshair and absolute visible time range for every secondary chart.
- [x] Add native indicator pane placement and independent left/right/hidden scales.
- [x] Add a drawing object tree with visibility, locks, style templates, undo and redo.
- [x] Add replay jump-to-signal/trade event controls and explicit feed gap/fallback status.
- [x] Multiplex watchlist quotes over one runtime-validated WebSocket with REST polling fallback.
- [x] Window watchlists above 80 rows while leaving smaller lists fully exposed to assistive technology.
- [x] Add conflict-checked, persisted and discoverable custom keyboard shortcuts.
- [x] Version workspaces with bounded autosave history, rollback and SHA-256 verified export/import.
- [x] Preserve semantic chart tables and responsive monitoring layouts.
- [x] Render real Binance/Bybit aggressor prints as a live footprint with per-candle delta and cumulative delta, backed by a bounded shared public stream.
- [x] Add documented live-only diagonal/stacked imbalance and potential-absorption heuristics with Canvas annotations and an accessible DOM summary.
- [x] Add persisted, bounded and deduplicated in-chart alerts for footprint clusters, CVD spikes and large prints with optional sound/desktop delivery.

Verification:

- Workspace/checksum, virtual-list, data-quality, shortcut, drawing-template, pane-render and resize tests pass.
- Production build and the 44-scenario Playwright suite pass (the funded exchange soak remains excluded).

### Runtime backup and recovery — 2026-07-11

- [x] Create consistent online SQLite snapshots instead of copying active database files directly.
- [x] Preserve `trading.db`, optional `candles.db` and `.secret` with owner-only modes; accept legacy backup manifests that already contain retired `.authtoken`.
- [x] Generate a versioned SHA-256 manifest and reject missing, extra, symlinked or modified files.
- [x] Run SQLite `PRAGMA quick_check` before backup, after backup and before restore.
- [x] Refuse accidental overwrite and use a verified staging directory plus rollback-safe atomic swap.
- [x] Add isolated tests for backup, verification, tamper detection, overwrite refusal and restore.
- [x] Document backup/recovery in English, Russian and Kazakh.
- [x] Replace implicit table creation with ordered transactional schema migrations.
- [x] Preserve legacy rows, record applied migration metadata and reject newer unsupported schemas.

Verification:

- Dedicated runtime backup/restore and schema-migration tests pass without reading or modifying real `backend/data`.
- Biome and documentation link/command checks pass.

### Exchange request safety — 2026-07-11

- [x] Share a signed-request rate-limit circuit across bots targeting the same exchange.
- [x] Honour bounded `Retry-After` periods for HTTP 429 and Binance 418 responses.
- [x] Detect Binance `-1021` and Bybit `10002` clock-skew failures with operator remediation.
- [x] Keep mutating calls non-retrying and preserve existing ambiguous transport classification.
- [x] Add deterministic guard, throttle, cap, expiry and clock-offset tests.

### Open-source security intake — 2026-07-11

- [x] Add structured secret-safe bug and outcome-focused feature request forms.
- [x] Route vulnerabilities to private GitHub security advisories and disable unsafe blank issues.
- [x] Add a PR verification/safety/compatibility checklist.
- [x] Publish assets, trust boundaries, mitigations, residual risks and explicit non-goals.
- [x] State that funded soak/mainnet readiness has not been proven.

### Frontend performance budgets — 2026-07-11

- [x] Record reviewed HTML, CSS, single-JS and total-JS gzip ceilings in version control.
- [x] Measure production output deterministically after build.
- [x] Fail pull-request, push and release CI when a budget regresses.
- [x] Keep the large Blockly chunk visible as an explicit optimization target.

### Shared deterministic test fixtures — 2026-07-11

- [x] Add a transport-neutral `@saltanatbotv2/test-fixtures` workspace.
- [x] Provide validated candle-series builders with timing, spread, volume and provenance controls.
- [x] Provide real Fetch API JSON/text responses and fail-closed scripted routing.
- [x] Migrate cross-runtime parity and exchange failure-injection tests to the shared fixtures.
- [x] Add a transport-neutral structural fake exchange with fail-closed submission queues, mutable account/position/order reads and private-stream recovery controls.
- [x] Type-check the package independently and cover validation/unexpected-network behavior.

### Canonical execution core — 2026-07-11

- [x] Add a UI/transport/storage-free `@saltanatbotv2/execution-core` workspace.
- [x] Centralize adverse slippage and stop/target price resolution.
- [x] Centralize units, equity-percent and fail-closed risk-percent sizing with leverage/step caps.
- [x] Centralize monotonic durable order transitions and result-status derivation.
- [x] Connect both backtest-core and backend trading through compatibility facades.
- [x] Change live/paper risk-percent sizing without a stop from max-exposure fallback to skipped entry.
- [x] Check generated runtime/declarations and enforce the dependency boundary with parity tests.

### Runtime contracts and final P0 characterization — 2026-07-11

- [x] Upgrade `@saltanatbotv2/contracts` from declarations-only to generated runtime/declarations.
- [x] Validate catalog, candle-history and sparkline REST responses at the frontend transport edge.
- [x] Validate all snapshot/candle/status/error WebSocket variants and reject unknown messages.
- [x] Add OHLC consistency, enum, finite-number and unexpected-message failure coverage.
- [x] Move malformed WebSocket payloads into an explicit frontend error state.
- [x] Add direct chart drawing hit-test coverage for handles, bodies, z-order, locks and position areas.
- [x] Complete the P0 package/contract baseline; remaining work starts at P1.

### Foundation — commit `3a98684`

- [x] Fix zero-price synthetic fallback for dynamically discovered crypto pairs.
- [x] Seed dynamic instruments from positive Binance ticker prices.
- [x] Return explicit REST `503` / WebSocket error when neither real nor synthetic data is valid.
- [x] Add provider/discovery/fallback regression tests.
- [x] Add stateful frontend-preview/backend-evaluator parity coverage.
- [x] Fix `setvarb` preview parity defect.
- [x] Introduce `@saltanatbotv2/contracts` and canonical market/stream types.
- [x] Introduce `@saltanatbotv2/strategy-core` and canonical IR types/version.
- [x] Begin Pine converter decomposition with arguments, errors, language, text and expression-history modules.
- [x] Remove Blockly duplicate-registration warnings without breaking saved XML.
- [x] Add initial typed EN/RU UI locale support.
- [x] Add Russian README and documentation index.
- [x] Add architecture/testing/i18n/master-plan documents and source-folder READMEs.
- [x] Upgrade Vitest to a non-vulnerable release; full dependency audit is clean.
- [x] Add Playwright production-build harness.

Verification at commit:

- Biome passed.
- TypeScript passed for backend and frontend.
- 26 Vitest files / 267 tests passed in the integrated tree.
- Production build passed.
- 6 Playwright scenarios passed.
- `npm audit` reported zero vulnerabilities.

### Browser research and access flows — commit `bbf1f79`

- [x] Persist named chart workspaces through reload.
- [x] Run a real browser backtest and verify assumptions/metrics.
- [x] Verify invalid and valid Trade access tokens in explicit legacy/demo compatibility mode.
- [x] Convert Trade token entry to a semantic accessible form.

Verification:

- 9 Playwright scenarios passed on the production build.
- Biome, TypeScript and Vitest passed.

### Cycles Analysis compatibility — commit `8bda112`

- [x] Render imported Cycles Analysis with phase shading, crest lines and neutral reversal markers.
- [x] Add marker colors and optional box opacity/borders to the generic chart overlay model.
- [x] Replace obsolete generic converter warnings with explicit compatibility notes.
- [x] Normalize previously saved Cycles Analysis artifacts.
- [x] Show a compact cycle summary in the active chart chip.

Verification:

- Dedicated preview, compatibility and chart-overlay tests pass.
- Full Vitest and Playwright suites pass.

### Indicator and paper-trading browser flows — commit `eac37ec`

- [x] Configure and persist a built-in chart indicator.
- [x] Import a custom Pine indicator and add it to the live chart.
- [x] Create, start, command, inspect and stop a paper bot.

Verification:

- 12 Playwright scenarios passed on the production build.
- Biome, TypeScript and all 267 Vitest tests passed.

### Keyboard and responsive browser flows — commit `cff3382`

- [x] Trap command-palette focus and restore it to the opener on Escape.
- [x] Verify the chart remains usable at a narrow mobile viewport.
- [x] Stabilize catalog-dependent browser scenarios under full parallel load.

Verification:

- 14 Playwright scenarios passed together on the production build.
- Biome, TypeScript and all 267 Vitest tests passed.

### Pine display primitives and richer Cycles Analysis — commit `4f4134f`

- [x] Upgrade the shared strategy IR to version 4 with projection-zone and table-metric statements.
- [x] Round-trip both display primitives through Blockly, schema validation and text preview.
- [x] Map time-based Pine `box.new` calls to future projection zones.
- [x] Map numeric Pine `table.cell` calls to accessible HTML metric tables.
- [x] Add chart-side editors with persisted overrides for numeric and boolean Pine inputs.
- [x] Expand Cycles Analysis with crest labels, aggregate/percentile statistics and prediction zones.
- [x] Keep display-only nodes inert in live execution while rendering them in chart preview.

Verification:

- 27 Vitest files / 271 tests pass, including IR round-trip, schema, preview and Pine-conversion coverage.
- Biome and backend/frontend TypeScript checks pass.

### Backtest decomposition — commits `0e024cb`, `a5dda9b`

- [x] Extract display-metric collection and table shaping into `previewTables.ts`.
- [x] Extract public backtest contracts into `backtestTypes.ts` without breaking facade imports.
- [x] Extract deterministic performance analytics into `backtestMetrics.ts`.
- [x] Preserve all existing broker, preview, optimizer and report behavior through regression tests.

### Cycles Analysis modes and future chart space — commit `a5dda9b`

- [x] Add Percentage, Duration and Both direction modes with day/candle units.
- [x] Add minimum-duration filters, first-direction selection, stagnation and high/low markers.
- [x] Reserve chart space for future prediction zones and keep time/pixel transforms invertible.
- [x] Add collapsible accessible statistics/prediction tables and typed chart controls.

Verification:

- 28 Vitest files / 275 tests pass, including duration-mode and projection-viewport coverage.
- Biome and backend/frontend TypeScript checks pass.

### Trading frontend decomposition — commits `94d68d1`, `f45ed09`, `3461c2a`

- [x] Move the authentication gate and empty trading state into feature-owned components.
- [x] Move bot creation and validation into a feature-owned semantic form.
- [x] Add stable names to bot controls and retain native validation/submission behavior.
- [x] Reduce `TradingView.tsx` from 982 to 741 lines while preserving its controller role.
- [x] Move live arming, kill switch, API-key and notification settings into `TradingSettings.tsx`.
- [x] Give secret/notification controls visible labels, stable names and semantic submit behavior.
- [x] Reduce `TradingView.tsx` further to 578 lines.
- [x] Move bot lifecycle actions, runtime cards, command console and journals into `BotDetail.tsx`.
- [x] Reduce `TradingView.tsx` to a 241-line socket/list/selection controller.

### Strategy Lab decomposition — commits `cbf6b4c`, `1effaae`

- [x] Move artifact browsing, import/export, Pine entry and template gallery into `strategy/components/StrategyLibrary.tsx`.
- [x] Add a feature-folder README documenting the new UI boundary.
- [x] Reduce `StrategyLab.tsx` from 1,138 to 931 lines without changing its public facade.
- [x] Move optimizer/walk-forward controls and results into `OptimizePanel.tsx`.
- [x] Move sweep-state creation and worker-spec shaping into `optimization/model.ts`.
- [x] Reduce `StrategyLab.tsx` further to 617 lines and add direct model tests.
- [x] Extract backtest configuration, execution toolbar, diagnostics and result/preview rendering into `StrategyExecutionPanel.tsx`.
- [x] Reduce `StrategyLab.tsx` to a Blockly lifecycle and execution controller.
- [x] Reduce `StrategyLab.tsx` further to 332 lines by extracting research orchestration.
- [x] Extract Blockly injection, theme, resize, preview debounce, artifact loading, autosave and teardown into `useStrategyWorkspace`.
- [x] Reduce `StrategyLab.tsx` to a 149-line feature composition facade.

### Trading engine decomposition — commit `9e048b6`

- [x] Extract pure position-sizing and stop/target calculations into `engineRisk.ts`.
- [x] Add focused quote/equity/risk sizing and long/short stop/target tests.
- [x] Keep exchange orchestration and order lifecycle unchanged behind the `TradingEngine` facade.

### Trading localization — commit `11783cd`

- [x] Add a typed EN/RU trading message catalog.
- [x] Localize trading access, empty state, bot creation labels and primary actions.
- [x] Pass locale explicitly through the trading feature boundary.
- [x] Extend browser locale coverage into the Russian Trade authentication flow.

### Pine compiler public contracts — commit `4e8ffea`

- [x] Add a public AST type facade independent of parser implementation imports.
- [x] Add typed warning/error diagnostics with stable codes and source-span contracts.
- [x] Preserve legacy warning strings while exposing structured diagnostics to future editors.
- [x] Attach typed diagnostics to public `PineConvertError` instances.

### Pine semantic and drawing decomposition — commit `fe41a7a`

- [x] Extract pure boolean folding/type detection from `convert.ts`.
- [x] Extract collection/object call classification and reassignment analysis.
- [x] Extract fill/shading/label/line/box/projection/table lowering behind an explicit drawing context.
- [x] Add direct semantic-helper tests in addition to the Pine corpus.
- [x] Add direct drawing-lowering tests in addition to display-primitive corpus coverage.
- [x] Reduce `convert.ts` from 2,233 to 1,916 lines without changing its public facade.

### Pine numeric call decomposition

- [x] Extract numeric built-in dispatch behind a typed lowering context.
- [x] Extract boolean built-in dispatch and rising/falling window semantics behind a typed lowering context.
- [x] Extract numeric operators, ternaries and bounded history access behind a typed lowering context.
- [x] Extract logical/comparison operators, `na` tests, string selectors, ternaries and boolean history.
- [x] Centralize typed numeric/boolean identifier resolution and opaque-state degradation.
- [x] Extract value and statement switch lowering with deterministic default behavior.
- [x] Extract call-by-value user-function inlining, lexical restoration, tuple returns and recursion guards.
- [x] Extract ordered typed value classification without fallback guessing.
- [x] Extract strategy entries, closes, protections, sizing and fail-closed risk semantics.
- [x] Extract bounded generic statement/control-flow dispatch and constant branch folding.
- [x] Extract direct, user-function and built-in tuple destructuring.
- [x] Extract immutable/mutable assignment state, one-time initialization and special handle bindings.
- [x] Extract declaration/default sizing, plot/marker and alert statement calls.
- [x] Extract drawing, mutation, collection and unsupported-call statement coordination.
- [x] Split Blockly XML serialization into XML primitives, statement, numeric and boolean modules.
- [x] Preserve `irToXml.ts` as a backward-compatible facade and add direct serializer round-trip tests.
- [x] Introduce exception-safe nested value/type scopes and a typed global function symbol table.
- [x] Apply lexical scopes to `if`/`for`/`while` bodies and user-function inlining.
- [x] Add direct tests for indicator, arithmetic, external boolean-series and fail-closed paths.
- [x] Add direct tests for cross, multi-bar trend, external boolean-series and conservative timeframe paths.
- [x] Reduce `convert.ts` from 1,916 to 977 lines after completing statement lowering decomposition.

### Trading activity decomposition — commit `4335465`

- [x] Split command composition/saved commands into `BotCommandConsole.tsx`.
- [x] Split orders, order journal, fills and logs into `BotActivity.tsx`.
- [x] Replace journal layout divs with semantic HTML tables and labeled sections.
- [x] Isolate below-the-fold journal rendering with `content-visibility` plus intrinsic-size and containment fallback.
- [x] Reduce `BotDetail.tsx` from 349 to 97 lines.

## Completed browser baseline

### Critical browser E2E expansion

Current: 44 scenarios implemented; the critical-flow and accessibility checklists are complete.

- [x] Terminal/chart smoke.
- [x] Keyboard command palette and symbol switch.
- [x] Lazy Strategy workspace.
- [x] Theme persistence.
- [x] Pine indicator import.
- [x] EN/RU locale persistence.
- [x] Named workspace persistence.
- [x] Backtest execution/report.
- [x] Trade authentication gate.
- [x] Add/configure/persist a built-in indicator.
- [x] Add a saved custom indicator to the chart.
- [x] Create/start/stop a paper bot and inspect its order journal.
- [x] Keep paper lifecycle E2E independent from public exchange latency via the deterministic local feed.
- [x] WebSocket disconnect/reconnect without duplicated candles.
- [x] Visible unavailable/fallback market-data state.
- [x] Keyboard/focus behavior for modal dialogs and menus.
- [x] Responsive monitoring smoke test.

## Completed architecture program

### Pine compiler

- [x] Resolve explicit Pine v4/v5/v6 profiles before lexing removes pragmas.
- [x] Reject unsupported versions and surface missing/mixed-version APIs through typed diagnostics.
- [x] Attach remediation to all public compiler diagnostics.
- [x] Enforce canonical source, token, AST, nesting, loop and generated-IR resource budgets.
- [x] Test deterministic profile metadata, diagnostics and budget failures.
- [x] Add exact token ranges and propagated AST spans without changing executable semantics.
- [x] Link semantic diagnostics and generated body/init IR paths back to Pine statements.
- [x] Replace the scattered unsupported-function decision tree with a public ordered registry.
- [x] Emit a versioned exact/approximation/display-only/rejected evidence report without confidence percentages.
- [x] Preserve reports through import and render localized summary labels, source lines and remediation.
- [x] Check byte-stable v4/v6 conversion-result golden hashes.
- [x] Record source, author, SPDX decision, acquisition date and SHA-256 for every external Pine file.
- [x] Restrict real-world compiler corpus tests to hash-verified MPL-2.0 samples; keep unknown-license files audit-only.
- [x] Fail docs CI when Pine provenance, file coverage, license headers or hashes drift.
- [x] Persist immutable Pine source/profile/diagnostic/report evidence with imported artifacts.
- [x] Show original Pine, generated Blockly workspace and compiled preview side by side in Strategy Studio.
- [x] Focus the exact read-only source selection when a user activates a diagnostic.

- [x] Extract AST and public diagnostic types with source-span contracts.
- [x] Extract semantic scope/symbol/function analysis.
  - [x] Extract current pure semantic classification helpers from lowering.
  - [x] Introduce explicit nested scopes and typed symbol/function tables.
  - [x] Add a pure pre-lowering analysis pass for scope trees, symbols, references, shadowing, forward functions and reassignment classification.
- [x] Extract expression lowering.
  - [x] Extract numeric built-in function-call dispatch.
  - [x] Extract boolean built-in function-call dispatch.
  - [x] Extract numeric operators and history access.
  - [x] Extract remaining boolean expression lowering.
  - [x] Extract identifier resolution.
  - [x] Extract switch lowering.
  - [x] Extract user-function inlining.
  - [x] Extract general value coordination.
- [x] Extract statement and strategy-call lowering.
  - [x] Extract strategy-call lowering.
  - [x] Extract generic statement/control-flow lowering.
  - [x] Extract tuple statements.
  - [x] Extract assignment state.
  - [x] Extract declaration, plot/marker and alert statements.
  - [x] Extract final drawing/fallback call coordinator.
- [x] Extract drawing lowering.
- [x] Extract Blockly serialization.
- [x] Add a typed compatibility registry and Markdown matrix generated from both Pine corpora.
- [x] Fail documentation CI when generated compatibility artifacts are stale.
- [x] Add deterministic parser fuzz, valid-seed mutation and conversion-determinism property tests.
- [x] Move the pure compiler into `packages/pine-compiler`.
  - [x] Give the package one deliberate public entry point and an independent TypeScript check.
  - [x] Preserve old frontend implementation imports through one-line compatibility facades.
  - [x] Enforce the browser/UI-free dependency boundary with an architecture test.

### Strategy and backtest core

- [x] Make every backtest result a self-contained schema-v1 research report.
- [x] Freeze symbol, timeframe, exchange, market/price type, strategy hash, data range and normalized execution config.
- [x] Publish pessimistic intrabar, gap, stop/target, fee, funding, leverage, liquidation and final-close assumptions.
- [x] Detect partially loaded history and bounded missing-bar gap details.
- [x] Fingerprint settings, data range/quality and provenance; reject incompatible report comparisons with field reasons.
- [x] Export a versioned `.saltanat-report.json` envelope from the report UI.
- [x] Build a deterministic random-access replay timeline joining strategy explanations, variable changes, broker events, equity, signals and trades.
- [x] Add accessible previous/next/range replay controls to every non-empty backtest report.
- [x] Publish versioned deterministic execution benchmarks for next-open/final-close, gap stops, favourable gap targets and pessimistic stop priority.
- [x] Verify reviewed expected trades and byte-deterministic reports for every benchmark.
- [x] Add expanding anchored and independent rolling walk-forward modes.
- [x] Keep OOS windows disjoint, compound stitched equity and expose deterministic fold boundaries.
- [x] Calculate winning-parameter min/max/mean/deviation/normalized range and label unstable neighbours in the UI.
- [x] Add a canonical OHLCV market/limit/stop order simulator with gap-aware prices, volume participation, partial fills and quote-fee accounting.
- [x] Keep current Strategy IR market-intent semantics explicit while exposing the simulator for future order-type blocks.

- [x] Move shared TA implementations into `strategy-core` and retain frontend/backend compatibility facades.
- [x] Move the canonical evaluator, reusable runtime, execution budgets, security-series alignment and intent types into `strategy-core`.
- [x] Create `backtest-core` with canonical contracts, broker, portfolio, warm-up, reporting and analytics modules.
  - [x] Keep frontend import compatibility through one-line facades.
  - [x] Independently compile runtime/declaration artifacts and fail checks when they are stale.
  - [x] Enforce the UI/browser-free package boundary with an architecture test.
- [x] Split backtest into execution, portfolio/accounting, analytics, preview and trace/report modules.
  - [x] Extract chart preview, display-statement execution and preview result types.
  - [x] Extract execution/fill simulation.
    - [x] Extract slippage, protective-price and stop/target hit primitives.
    - [x] Move historical execution orchestration behind a dedicated module and stable facade.
  - [x] Extract portfolio sizing and accounting.
    - [x] Extract sizing, leverage/quantity guardrails and unrealized-PnL primitives.
    - [x] Extract pure position open/close accounting, commissions, excursions and trade records.
  - [x] Move deterministic analytics into `backtest-core/metrics.ts`.
  - [x] Extract trace/report assembly.
    - [x] Extract exhaustive warm-up/lookback analysis, including nested control flow and dynamic floors.
    - [x] Extract position/daily-stat evaluator context and bounded variable-trace collection.
    - [x] Move measured-range, metrics, trace and provenance assembly into `backtest-core/report.ts`.
- [x] Add versioned golden event traces across preview/backtest/paper/live.
  - [x] Add JSON-safe StrategyBarTrace v1 intents with fixed semantic ordering.
  - [x] Check one golden fixture through preview, backtest and the evaluator used by paper/live.
  - [x] Extend traces with expression/variable explanations, fill decisions, position/equity transitions, warnings and provenance.
    - [x] Add BacktestExecutionTrace v1 for scheduled/dropped fills and rejected entries.
    - [x] Record position/equity transitions, funding, stable warning codes and final provenance.
    - [x] Prove JSON safety and byte determinism with direct execution-trace tests.
    - [x] Add bounded statement-path explanations and compact sorted variable-change events in StrategyBarTrace v2.
    - [x] Preserve the V1 semantic golden while comparing complete V2 traces across preview/backtest/paper/live.
- [x] Add missing/fallback-data provenance to every report.
  - [x] Aggregate source labels across chart and `request.security` candles in `backtest-core`.
  - [x] Treat synthetic, routed fallback, mixed and unlabelled inputs as invalid for performance claims.
  - [x] Surface status, bar counts, source details and an accessible warning in every backtest report.
  - [x] Cover real, fallback, mixed, external-series and browser-report paths.

### Frontend decomposition

- [x] Split the 1,096-line Blockly definition monolith into eleven domain category modules behind a 188-line stable registration/toolbox facade.
  - [x] Preserve every saved XML type and generated catalog entry.
  - [x] Enforce globally unique block types and per-row field/input names.
  - [x] Make registration idempotent across HMR/module re-evaluation without overwrite warnings.
- [x] Split the 671-line Blockly compiler into statement orchestration, numeric lowering, boolean lowering and shared diagnostic context modules.
  - [x] Preserve the public `compileWorkspace` facade and block-linked diagnostic contracts.
  - [x] Keep numeric/boolean mutual composition as bounded static module calls without executable code generation.
- [x] Split `StrategyLab` into build/validate/preview/backtest/optimize/library controllers and panels.
  - [x] Extract library, optimizer and execution/result panels.
  - [x] Extract Blockly workspace lifecycle/autosave controller.
  - [x] Extract shared paginated history loading for backtest, optimizer and security-data windows.
  - [x] Extract cancellable backtest/optimizer orchestration into `useStrategyResearch`.
  - [x] Ignore stale progress/results and abort in-flight history/security requests on teardown.
- [x] Split `TradingView` into auth/bots/orders/portfolio/settings feature modules.
- [x] Reduce `App.tsx` to composition and routing state.
  - [x] Extract strategy artifact persistence, sharing, creation, import, version/hash and linked-indicator synchronization into `useArtifactLibrary` plus a pure model.
  - [x] Keep `App.tsx` below the architecture budget enforced by `config/source-file-budgets.json` without changing workspace flows.
  - [x] Extract artifact compilation, `request.security`, preview/backtest overlay, input overrides and chart focus into `useChartArtifactOverlay`.
  - [x] Reject stale async overlay results after market/timeframe/request changes and cover the race directly.
  - [x] Extract shell/workspace persistence, compare migration and preferences into `useAppShell` plus `shellStorage`.
  - [x] Extract command construction, palette state and global shortcuts into `useAppCommands`.
  - [x] Apply persisted theme before React boot and synchronize native `color-scheme`/theme metadata.
  - [x] Extract shell, artifact, command and chart-overlay responsibilities from `App.tsx`.
  - [ ] Continue decomposing pane, PWA and screener composition before the enforced budget is reached. Exact line counts are intentionally not frozen here because they change with ongoing composition work.
- [x] Split chart orchestration into dirty render layers.
  - [x] Separate persistent base and transparent interaction canvases.
  - [x] Coalesce rapid invalidations in one RAF with base-before-interaction ordering.
  - [x] Prove crosshair-only invalidation never calls the base renderer.
  - [x] Split the base layer into axes/grid, primary series, indicators and drawing/strategy overlay canvases.
  - [x] Reuse one prepared viewport/indicator render plan across passes and rebind volatile overlay inputs without recomputation.
  - [x] Extract canvas ownership/ResizeObserver/invalidation into `useChartRenderer` and chart chrome into a focused renderer.
  - [x] Verify primary, indicator and overlay pass isolation with recording-context tests.
  - [x] Reduce the 960-line `ChartCanvas` facade below 600 lines by extracting drawing controls, menus, accessible overlays, pure interaction helpers and its prop contract.
  - [x] Localize every extracted drawing context action and add direct immutable movement/legend/format tests.
- [x] Add an accessible DOM/table alternative for focused OHLC, signals and trades.
  - [x] Link the Canvas accessible description to a synchronized focused/latest-candle summary without pointer-driven live-region noise.
  - [x] Add a keyboard-operable panel with native tables for focused and recent OHLC, signals and executed trades.
  - [x] Bound each history view to 20 newest rows and preserve total signal/trade counts.
  - [x] Cover table semantics, empty data and keyboard opening in component and browser tests.
- [x] Enforce a 600-line application/package source ceiling in push, PR and release CI.
  - [x] Give four cohesive pure-domain algorithm modules narrow reviewed ceilings and concrete reasons.
  - [x] Fail undocumented, enlarged or stale exceptions.

### Trading engine hardening

- [x] Reduce the 940-line `TradingEngine` below 600 lines by extracting runtime contracts, adapter routing, durable state/context, portfolio aggregation and order/reconciliation coordination.
  - [x] Retain one public lifecycle/market-event facade and serial per-bot actor queues.
  - [x] Keep polling/private-stream events on the same durable identity and execution-accounting boundary.
- [x] Preserve Binance USDⓈ-M and Bybit v5 private execution IDs, incremental quantities/prices,
  actual fee assets and venue realized PnL; Bybit v5 covers enabled spot/linear bots.
- [x] Deduplicate replayed private executions before durable fill/accounting writes.
- [x] Display fee amount and asset in the localized fill journal.
- [x] Reserve proactive exchange request weight with safety headroom and reconcile usage from venue headers.
- [x] Reject stale live candles before they mutate price/runtime state and log missing-interval gaps.
- [x] Publish EN/RU/KK capability matrices and a future security-review checklist; label every
  retained live control dormant and unreachable in `public-http-paper`.

- [x] Complete durable exchange order state machine.
  - [x] Persist intent before exchange I/O in a dedicated lifecycle module.
  - [x] Persist accepted, rejected and fill outcomes in deterministic order.
  - [x] Classify thrown/ambiguous adapter outcomes as `unknown` and rethrow them.
  - [x] Prevent exchange submission when durable intent persistence fails.
  - [x] Reconcile `intent` and `unknown` records against visible exchange orders after restart.
  - [x] Pause resumed trading when an unresolved result cannot be proven from exchange state.
  - [x] Model accepted, partial-fill, filled, cancel, expire and replace states explicitly.
  - [x] Correlate asynchronous paper fills to their original resting-order journal entries.
  - [x] Ingest asynchronous exchange events that advance accepted/partial states to terminal states.
    - [x] Resolve aggregate snapshots to one durable intent by venue or client identity.
    - [x] Share one ingest boundary between signed polling and future private streams.
    - [x] Ignore duplicate/replayed updates and reject identity conflicts or state/quantity regressions.
    - [x] Connect authenticated Binance USDⓈ-M and Bybit v5 stream events to the ingest boundary
      without treating the Binance futures stream as spot accounting.
- [x] Add private fill/order stream with polling fallback.
  - [x] Add bounded signed REST order-status polling for Binance and Bybit.
  - [x] Normalize partial, filled, cancelled, expired and rejected venue states.
  - [x] Persist idempotent aggregate execution snapshots and polling audit events.
  - [x] Add authenticated Binance USDⓈ-M and Bybit v5 private order/execution streams with
    heartbeat, reconnect and REST gap reconciliation; Bybit uses `order` + `execution` for enabled
    spot/linear bots.
- [x] Require explicit Binance/Bybit SL/TP acknowledgement before protected runtime state.
- [x] When requested SL/TP fails after an accepted entry, preserve the accepted entry and managed
  state, pause the bot, retain its reservation, and issue a separately identified best-effort
  reduce-only emergency close whose acknowledgement/failure is explicit.
- [x] Complete startup reconciliation for every in-flight state.
  - [x] Query signed venue status sequentially for `intent`, `unknown`, `accepted` and `partially_filled` rows before resume.
  - [x] Fall back to matching open orders only when that evidence proves the original command outcome.
  - [x] Require terminal evidence for interrupted cancel commands and manual review for ambiguous replace commands.
  - [x] Mark crash-left intent `unknown` and pause the bot whenever an outcome remains unproven.
- [x] Disable Binance live spot until authenticated spot execution accounting exists and retain the
  Bybit spot implementation only as dormant code; `ENABLE_LIVE_SPOT` conflicts with the current
  runtime and stops startup.
  - [x] Persist deduplicated bot-attributed quantity, weighted average, per-asset fees and remaining
    quantity from confirmed Bybit v5 executions.
  - [x] Constrain automated/manual bot closes to attributed inventory and pause instead of using account-wide balance when attribution is missing.
  - [x] Restore attributed inventory on restart and require operator balance verification before resume.
- [x] Require explicit positive base `qty` for every risk-increasing live order.
- [x] Keep risk reserved for accepted, partially filled and venue-filled-but-not-accounted journal
  rows; reserve pending spot sells against attributed inventory.
- [x] Retain only unaccounted partial fills for cancelled/expired rows and conservatively retain
  legacy replaced entries until execution accounting is proven.
- [x] Use the maximum of exact-symbol venue gross positions and the durable futures exposure ledger;
  merge matched venue/local orders by maximum quantity/price and fail closed on identity conflicts.
- [x] Disable live `replace` and `turnover` until child lifecycles exist, forbid live collision
  override and pause a bot when terminal REST reconciliation lacks authenticated execution evidence.
- [x] Serialize live starts by exchange+symbol and keep managed state after an accepted live close
  until its authenticated execution is committed.
- [x] Add fake-exchange transport, protection, status-polling and failure-injection suites.
- [x] Add opt-in Binance/Bybit testnet release checks.
  - [x] Refuse network access without an explicit runtime arm flag and reject every production/non-HTTPS base URL.
  - [x] Verify Binance signed balance plus listenKey lifecycle and Bybit signed wallet/open-order reads without placing orders.
  - [x] Add signing, endpoint-guard and request-contract tests with fake transports.
  - [x] Add a manually dispatched workflow behind the protected `exchange-testnet` GitHub environment.

### Documentation, localization and open source

- [x] Move remaining UI strings into typed messages.
  - [x] Localize the accessible chart-data panel, captions, headers, empty states and signal/trade terminology through typed EN/RU messages.
  - [x] Localize the complete trading workspace: bot creation, settings/secrets, confirmations, runtime cards, command console/reference and order/fill journals.
  - [x] Localize Strategy Studio controls, template library, Pine import, backtest reports and optimizer/walk-forward research.
  - [x] Localize command search/actions, watchlist filters/favorites, bar/feed statistics and price-alert controls/toasts.
  - [x] Localize chart drawings, indicator/artifact inputs, compare controls, chart types and saved workspaces.
  - [x] Add hollow candles, step line, a DOM price/countdown HUD and a trailing 24-hour range indicator.
  - [x] Add explicitly labelled OHLCV-estimated visible-range Volume Profile with directional volume, POC, contiguous 70% value area and an accessible toggle/summary.
  - [x] Add real Binance/Bybit public top-20 order-book heatmap with a shared upstream, price-aligned 60-second history, throttling and explicit stale/reconnect states.
- [x] Complete Russian user-guide parity for the current chart, strategy research and trading product surfaces.
  - [x] Add the Russian chart navigation and accessible table-data guide.
  - [x] Add the Russian paper/live trading, key safety, recovery, command-console and journal guide.
  - [x] Add the Russian Strategy Studio, Pine import, backtest assumptions and optimization guide.
- [x] Generate API/block/Pine compatibility reference from source contracts.
  - [x] Generate Pine compatibility TypeScript and Markdown references from corpus metadata.
  - [x] Generate the Express HTTP/WS endpoint index and strategy block-catalog reference with deterministic check mode.
- [x] Add `SECURITY.md`, `CODE_OF_CONDUCT.md`, changelog and support policy.
- [x] Add documentation link/example checks to CI.
- [x] Add nightly/alpha/beta/stable release channels, SPDX SBOMs, SHA-256 checksums and GitHub/Sigstore-signed provenance/SBOM attestations.

### Per-pane timezone axis

- [x] Add exchange UTC, local and curated IANA city zones to every chart pane through a labelled native select.
- [x] Apply one cached locale/DST-aware formatter to Canvas ticks/crosshair and the matching DOM HUD, tables, AVWAP and flow-alert timestamps.
- [x] Keep candle time, linked ranges, regional-session membership and strategy execution absolute and unchanged.
- [x] Version automatic sessions at v5 and named workspaces at schema v7, preserving local display for legacy state and exchange UTC for new panes.
- [x] Cover DST transitions, zone validation, EN/RU/KK control semantics, workspace/session round trips and independent 2×2 reload behavior.

## Quality gates for every following commit

Required unless the commit only changes prose:

```bash
npm run lint
npm run check
npm test
npm run build
```

Run `npm run test:e2e` for any user-visible frontend, API or persistence change. Run `npm audit` after dependency changes.
