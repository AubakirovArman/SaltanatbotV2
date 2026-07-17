# Testing strategy

The purpose of testing is to prove that a strategy means the same thing through import, editing, preview, research, paper execution and live execution.

## Test layers

| Layer | Tool/direction | Purpose |
| --- | --- | --- |
| Static | TypeScript, Biome, dependency rules | Invalid types, imports and common defects |
| Unit | Vitest | Pure parser, TA, fill, accounting and UI model behavior |
| Property/fuzz | fast-check or a small dedicated harness | Parser safety, invariants and round trips |
| Component | React Testing Library + user-event | Forms, dialogs, panels and keyboard behavior |
| Contract | Zod schemas + generated fixtures | REST/WS compatibility across client/server |
| Integration | Vitest with fake stores/providers/exchanges | Use cases across multiple modules |
| Browser E2E | Playwright | Complete user journeys in real browsers |
| Visual | Playwright screenshots | Layout, themes, locales and chart regressions |
| Accessibility | axe-core + keyboard/manual matrix | Semantic and operable UI |
| Performance | browser traces + benchmarks | INP, render time, bundle and computation budgets |
| Exchange conformance | fake HTTP/WS + official testnets | Adapter signing, filters and lifecycle |
| Recovery | process/failure injection | Restart, duplicate event and partial failure safety |

## Critical browser journeys

The initial Playwright suite must cover:

1. application loads, catalog resolves and a live/synthetic chart renders;
2. symbol, exchange, timeframe and chart type can be changed;
3. indicator is added, configured, persisted and restored;
4. drawing can be created, selected, edited and deleted;
5. identical symbols in separate panes retain isolated drawing sets through reload;
6. keyboard-only pane cycling moves focus and continues through maximized charts without resetting state;
7. the keyboard layout menu creates four distinct symbols and restores them after reload;
8. secondary chart types unlink on manual selection, relink to primary and survive migration/reload;
9. identical-symbol panes keep different validated Renko/Kagi/Line Break/P&F construction settings through reload;
10. Pine strategy imports, reports diagnostics, opens as blocks and runs a backtest;
11. Pine indicator imports and appears on the current chart;
12. strategy is created from a template, edited, compiled and saved;
13. backtest shows assumptions, trades, metrics and chart markers;
14. optimizer runs in a worker and can be cancelled;
15. named workspace and bounded last-chart-session state save and restore after reload, while malformed/future storage fails closed;
16. paper bot is created, started, receives a signal, records an order and stops;
17. authentication, CSRF expiry and logout behave correctly;
18. kill switch requires the right role and visibly updates state;
19. WebSocket disconnect reconnects without duplicating candles or orders;
20. invalid/fallback market data is visibly distinguished from real data.

Live-mainnet orders must never run in generic E2E. Exchange testnets require an explicit opt-in environment and isolated credentials.

### R4 canonical paper-portfolio matrix

R4 adds a mandatory cross-store and browser matrix:

- PostgreSQL schema-12 migration/checksum, unprivileged test role, bounded
  executor queue, owner fairness, leases, generation/token fencing, retention,
  idempotency and authorization-revision/epoch rejection;
- SQLite schema-9 migration from legacy paper bots, exact capital conservation,
  epochs, allocations, valuation marks, immutable receipts/evidence,
  tombstones, projections and foreign-key/integrity checks;
- golden-ledger metrics, restart at lifecycle boundaries, duplicate closed-bar
  handling, crash-left intent, terminal rejection replay, lost-ack recovery and
  fresh-command reauthorization;
- two-owner and administrator non-bypass tests across list/detail/mutations,
  with expected-owner, CSRF, idempotency, revision and ledger-epoch assertions;
- shutdown ordering and failure injection proving an active apply callback is
  drained/aborted before the engine or SQLite can close;
- desktop 1440×900, mobile 390×844 and narrow 320×700 journeys covering
  portfolio lifecycle, table/cards, journal curve/metrics/fills/events,
  confirmations, stale fallback, focus/Escape, reflow, scrolling and 44 px
  coarse-pointer targets;
- Axe WCAG 2.0/2.1 A/AA on the complete initial portfolio center and on the
  same center with its named robot dialog open, with no application exclusions;
- paired PostgreSQL/SQLite backup, isolated replacement restore, 11→12 and 8→9
  migration, repeat no-op migration, extended inventory, rollback drill and
  post-cutover generation.

See [R4 release evidence](./evidence/R4_PAPER_PORTFOLIOS.md). Live exchange I/O
is forbidden throughout this matrix.

R4 is accepted and deployed from final SHA
`bb455facdfe5a1b3cabe15490c86c299ea684ee7` in slot
`r4c-schema12-bb455fa`; CI run `29560112312` passed `6/6`. Production visual
acceptance used Chromium 149 at 1440×900, 390×844 and 320×700 and retained
eight accepted PNG captures. Axe reported zero violations, the touch-target
and document-overflow checks reported zero findings, and opener-focus
restoration plus robot-drawer scrolling passed. This is automated browser
evidence only: it is not a manual Opera/real-Android-device or
VoiceOver/NVDA/TalkBack result, and it does not validate HTTPS, private/live
exchange access, real borrowing or real margin telemetry.

### R5.1 accepted-release alert matrix

R5.1 is an accepted and deployed release. Production now runs the accepted
R5.1 slot `r5a-schema13-66394fd` on PostgreSQL schema 13. The release
introduced schema 13 and passed this matrix, exact-SHA CI run `29574600648`
(`6/6`) and the isolated upgrade/restore drill; acceptance evidence is in
[R5.1 owner alerts](./evidence/R5_1_OWNER_ALERTS.md). The canonical contract and
safety boundary are documented in [Owner-scoped server
alerts](./ALERTS.md), with [Russian](./ru/ALERTS.md) and
[Kazakh](./kk/ALERTS.md) translations.

The mandatory R5.1 matrix covers:

- checksum-locked 12→13 migration and no-op restart under an unprivileged
  PostgreSQL role, immutable revision/receipt/event/outbox rows, composite
  owner foreign keys and child-first retention;
- database-session ownership, `X-SBV2-Expected-User`, CSRF, authorization and
  rule-revision fences, administrator non-bypass, malformed body rejection and
  unsupported-channel fail-closed behavior;
- beta quotas of 100 active and 200 non-archived rules per owner, 400 total
  retained rule/history rows per owner and 480 globally active rules, including
  concurrent 479→480 admission and archive-always-wins deletion behavior;
- exact public closed-candle evaluation, false-to-true crossing, decimal
  threshold precision, one-bar durable cursor advancement, long-outage catch-up
  and malformed/stale/forming/future evidence rejection;
- a default 100/hard 500-claim sweep, four concurrent public reads, 16 unique
  reads per sweep and eight per provider, with equal scope/cursor coalescing,
  provider fairness, bounded capacity deferral and no leaked lease;
- owner-bound `alert-event-page-v1` forward cursors with at most 200 events per
  page, complete `hasMore` draining, cursor-ahead recovery and at-least-once
  publish-before-checkpoint behavior;
- same-owner multi-tab Lamport/BroadcastChannel convergence, browser-storage
  failure, create/delete races, stale local-copy fencing and browser-closed
  restart/dedup behavior;
- desktop and mobile rule creation, lifecycle/history/toast semantics,
  keyboard/focus behavior, 200% text, 390×844 and 320×700 reflow, 44 px coarse
  pointer targets, axe and visual regression;
- 2-day evaluation-receipt retention and 30-day event/outbox/terminal-delivery/
  old-state/old-revision/archive retention with bounded batches, time budget,
  lock contention and dependency-order tests.

This matrix concerns generic owner price alerts (`price-threshold`, public
Binance/Bybit last-price candles and in-app delivery). It is not acceptance of
the older account-aware arbitrage research-alert policy/outbox, whose
engine-owned candidate/economics producers remain disconnected. R5.2 technical
screener production, R5.3 notification worker/Telegram delivery and the R11
integrated 100-user workload all remain pending and unproven.

## Pine compiler matrix

For each supported construct, test:

- lexical and parser unit cases;
- source location accuracy;
- successful lowering or a stable diagnostic code;
- deterministic Blockly XML;
- XML -> IR round trip;
- preview output where visual;
- backtest output where executable;
- backend schema acceptance;
- rejection of future/unknown nodes;
- resource-limit behavior.

Corpus entries carry expected classification: `EXACT`, `APPROXIMATION`, `DISPLAY_ONLY`, `REJECT`. Coverage documentation should be generated from this data.

## Cross-runtime golden traces

StrategyBarTrace v2 is implemented in `strategy-core`. Tests preserve the same V1 semantic golden JSON and compare the complete V2 payload through preview, backtest and the backend evaluator used by paper/live:

```text
bar index/time
entry/exit/risk intents
alerts/markers
execution-budget status
bounded statement-path explanations
sorted variable changes
```

Historical execution additionally verifies BacktestExecutionTrace v1:

```text
scheduled/dropped/rejected fills
position/equity transitions and funding
stable warnings and provenance
```

Run the same candles and IR through preview, backtest, paper and backend evaluator. Differences must be intentional and declared by layer; unexplained differences fail CI. See [Strategy event traces](./EVENT_TRACES.md).

`BACKTEST_BENCHMARKS` is the public reviewed execution catalog. Every entry owns
deterministic candles, Strategy IR, normalized zero-cost settings and exact
expected trades. Default CI covers next-open timing/final close, a gap through a
market stop, a favourable gap through a limit target and the pessimistic
stop-before-target rule when both prices occur in one candle.

## Chart testing

- pure tests for time/price coordinate round trips;
- viewport zoom/pan invariants;
- hit-testing fixtures for every drawing;
- dirty-layer scheduler tests proving crosshair invalidations do not redraw the base chart;
- recording-context tests proving primary, indicator and overlay renderer isolation plus render-plan reuse;
- renderer tests against a recording/mock canvas context;
- screenshot tests for representative candles and indicators;
- DPR 1/2/3 and resize tests;
- empty, one-bar, NaN, gap, extreme-price and long-history datasets;
- interaction tests for wheel, drag, touch and keyboard equivalents;
- pure two-finger midpoint/zoom-limit/invalid-geometry invariants plus real Chromium CDP multi-touch and same-task coalesced move/up journeys proving pinch containment, immutable queued gesture frames, data-anchored scaling, stable repeated 40% boundary handling, no page-scroll leakage and no recovery screen, page error, navigation or reload;
- explicit DPR 1/2 browser checks for Canvas backing resolution, pointer/HUD alignment and density-invariant CSS interaction targets;
- multi-chart focus/command-routing/market-context/maximize/restore checks proving top-bar, watchlist and statistics affect or describe only the active pane while hidden panes stay mounted and retain symbol, zoom, tools and accessible state;
- shared-market transport checks proving matching pane keys fan out one physical socket, distinct keys stay isolated, late subscribers receive open state and the final consumer closes the resource;
- per-pane indicator tests covering bounded untrusted-state normalization, canonical logic retention, unlink-on-edit, primary isolation, v1→v2 session migration, reload persistence and explicit relinking;
- per-pane compare tests covering legacy/global normalization, three-overlay caps, linked-state reuse, unlink-on-edit, primary isolation, v1/v2→v3 session migration, named-workspace export/rollback, reload persistence and relinking;
- component semantics for captions, scoped column headers, empty states and focused-bar synchronization across OHLC, signals and trades;
- typed English/Russian/Kazakh parity for chart-table accessible names, headers, domain terms, dates and numbers;
- typed English/Russian/Kazakh parity for trading settings, destructive confirmations, command references, runtime cards and semantic order/fill tables;
- typed English/Russian/Kazakh parity for Strategy Studio, Pine-import diagnostics, backtest assumptions/metrics and optimizer controls;
- production-browser switching and reload persistence for `lang=ru` and `lang=kk`, localized document titles and safety-critical trading copy;
- browser flow proving the Canvas alternative opens from the keyboard and exposes named native tables.
- lifecycle tests proving that high-frequency candle, compare, position and
  watchlist resources are owned by the Monitoring-only chart runtime, release
  sockets/timers when disabled and cannot keep rendering the application shell
  after that runtime unmounts;
- quote-feed tests proving that the watchlist subscribes only while its desktop
  panel or mobile sheet is visible, while the shell-level alert feed subscribes
  only to distinct untriggered/armed alert symbols and opens no socket for an
  empty armed set;
- candle-buffer tests proving that a same-timestamp provisional update creates
  an O(1) tail snapshot over an immutable structural history, while snapshots,
  new timestamps and explicit history prepends remain the only operations that
  copy retained candle elements.

Avoid pixel snapshots for every candle. Use semantic renderer assertions for logic and a small stable visual suite for integration.

### Visual regression baselines

The required `visual regression (Chromium)` CI job compares six reviewed Linux/Chromium baselines:

- the complete dark desktop terminal with side panels and a deterministic chart;
- the narrow mobile terminal with its focus-managed market bottom sheet and unobscured chart context;
- the narrow mobile drawing-tool bottom sheet with its searchable grouped catalog;
- the isolated four-market chart grid, including compact pane controls and active-pane treatment;
- Strategy Studio with its library, Blockly workspace and artifact inspector;
- the mobile Strategy Studio with one full-width operable pane.

The suite fixes UTC time, browser locale, reduced motion, catalog, sparklines, candle history and
WebSocket messages. It also waits for a verified non-empty Canvas readback before capture. Only
latency/feed/countdown text is masked; layout and chart geometry remain fully compared. The required
job and authoritative local commands use the pinned official Playwright v1.61.1 Noble container, so
browser, libraries and font metrics do not drift with the host. Baselines live in
`e2e/__screenshots__/visual/`. Run `npm run test:visual:container` to compare them. After intentionally
reviewing the rendered change, regenerate with `npm run test:visual:update:container` and commit the
PNG diff together with the implementation that requires it. The uncontainerized `npm run test:visual`
commands are intended for the pinned CI container or quick same-host iteration only.

## Backtest invariants

Every result records chart and `request.security` candle provenance. Only fully labelled real-provider data validates performance claims; synthetic, fallback, mixed and unknown inputs must remain visibly labelled in the report.

- no fill before a signal is actionable;
- `next_open` never uses the signalling close as its fill;
- stops are pessimistic when stop and target touch in one unknown-path bar;
- gaps receive the documented fill treatment;
- slippage never improves a market fill;
- commission/funding reconcile with final equity;
- declarative plugin checksums, strict fields, capability permissions, version limits and local acyclic dependencies fail closed before library mutation;
- leverage and quantity caps are enforced;
- no negative/NaN quantity or price enters accounting;
- liquidation terminates or transitions exactly as specified;
- same seed produces the same optimizer/Monte Carlo result;
- warm-up bars are excluded consistently;
- missing/fallback data invalidates or labels a report.

## Trading and exchange tests

### Public venue plugin certification

`backend/src/venues/conformance` provides the repeatable credential-free part of the adapter gate.
Each descriptor declares a semantic adapter/contract version, official-doc review date, exact public
capability manifest, operation/market scopes and output limits. Registration fails on duplicate
plugin or venue identity, a factory/manifest mismatch, unsupported advertised operations or any
private authority.

For every advertised scope the shared runner executes five deterministic cases:

1. normalized success and snapshot invariants;
2. pre-aborted caller cancellation;
3. injected timeout;
4. injected rate limit;
5. injected generic HTTP failure.

The reference fake venue currently covers nine scopes and produces exactly 45 immutable case
results. Missing fixtures fail all five cases for that advertised scope. Reports are capped at 128
cases, structured errors are bounded and credential-like messages are replaced rather than copied
to evidence. Run it with:

```bash
npx vitest run backend/tests/publicVenuePluginConformance.test.ts
```

This proves the REST-style public snapshot contract and failure semantics only. It does not certify
real-network availability, WebSocket reconstruction, account reads, signing, orders or recovery.

### Scheduled credential-free public-feed canary

`npm run test:public-feed-canary` observes one bounded selected instrument for each of all nine
generic continuous venues. Spot targets require a reconstructed public book; derivative targets
require a book plus a public funding observation. The explicitly non-canonical dYdX target instead
requires its reviewed research-only book evidence and exact continuity protocol; its WebSocket does
not invent funding. The daily/manual `Credential-free public feed canary` workflow stores the
schema-v3 JSON result for 30 days even when the job fails. The envelope permanently records that no
credentials, orders, funded soak or mainnet-readiness claim were used.

The canary is intentionally stricter than a curl health check and weaker than conformance or soak:
it proves only that the selected public protocol produced its required evidence at that time. A
venue failure stays red and visible in the artifact. The 2026-07-14 local schema-v3 run passed
eight of nine: OKX, Gate, Hyperliquid, Deribit public testnet, Coinbase, dYdX, KuCoin and MEXC.
Kraken Spot was unreachable through the current host's TLS path, so scheduled evidence from an
eligible network remains required. The live runs exposed KuCoin binary-marked JSON, Coinbase's
connection-global cross-channel sequence, and the MEXC snapshot/delta bootstrap race; each now has
deterministic regression coverage. One observation is never a soak or execution-readiness proof.

Every adapter must pass a shared conformance suite:

- symbol/filter normalization;
- quantity and price rounding;
- request signing and clock skew;
- market, limit, stop and take-profit mapping;
- partial fill and fee normalization;
- cancel/replace/idempotency;
- protection confirmation;
- rate-limit and retry behavior;
- timeout followed by lookup, not blind resubmission;
- reconciliation of positions, open orders and fills.

Failure-injection scenarios include dropped WebSockets, out-of-order events, duplicates, process death at each order state, SQLite write failure and exchange rejection after entry.

## Component and accessibility coverage

Components with dialogs, menus, listboxes or forms require tests for:

- accessible name and description;
- initial focus, tab order, Escape and focus restoration;
- Enter/Space/arrow behavior appropriate to the widget;
- visible validation and live-region announcement;
- 200% zoom and narrow viewport;
- status not communicated by color alone;
- reduced-motion behavior.

Prefer native `<dialog>`, form controls and buttons. Canvas information must have a DOM/table alternative. Experimental HTML-in-Canvas is optional progressive enhancement only.

## Browser matrix

Pull requests:

- Chromium desktop for all E2E;
- Firefox for eighteen tagged critical journeys covering chart input, multi-market layout, accessibility,
  EN/RU/KK localization, Pine import, backtest, authentication, paper execution and mobile panels.

Nightly/release:

- the complete production suite on Chromium, Firefox and WebKit in the scheduled/tag-triggered
  `Browser matrix` workflow;
- desktop dark/light;
- one narrow touch viewport for monitoring workflows;
- English and Russian;
- reduced motion and forced/high contrast smoke checks.

## Performance budgets

The production bundle has an enforced CI gate after `npm run build`:

```bash
npm run perf:check
```

Reviewed raw/gzip ceilings live in `performance-budgets.json`. The checker resolves the emitted
static import graph rather than assuming every emitted feature is part of startup. It enforces HTML,
initial CSS, every CSS asset, total distributable CSS, the initial JavaScript graph, every directly
reachable lazy-route graph, every individual JavaScript chunk and total distributable JavaScript.
A limit may only be raised with a measured explanation.

The 2026-07-14 review split the old aggregate-only model after the scanner, Strategy Studio,
Trading workspace and their nested tools were confirmed to be separate lazy routes. The 2026-07-15
review added three optional, lazy research surfaces: market-opportunity handoff, the structural
strategy generator and L2 ML research. The 2026-07-16 mobile release measurement is 57.9 KiB
initial JS, 142.2 KiB for the largest incremental lazy-route graph, 198.2 KiB for the largest
single chunk (lazy Blockly), 776.0 KiB for the complete distributable JS set and 40.9 KiB for the
complete CSS set. The configured ceilings are 170 KiB, 336 KiB, 225 KiB, 900 KiB and 48 KiB
respectively; the checker permits only 90% of each cap, preserving a mandatory 10% reserve.
Initial navigation remains small, while the lazy Blockly, total JS and total CSS policies no longer
depend on a byte-for-byte snapshot. Total-distributable size is a secondary regression guard and
must not be reported as bytes downloaded on initial navigation.

The accepted 2026-07-17 R4 portfolio/journal release measured 831.0 KiB total JavaScript and 46.4 KiB
total CSS. Its protected predecessor already occupied 810.0/810.0 KiB of the usable JavaScript
budget and 43.1/43.2 KiB of usable CSS. Concatenating every release JavaScript asset into one
ideal gzip stream still measured 820.7 KiB, so chunk regrouping could not honestly satisfy the old
total cap without removing the new strict parser, localized workflow or journal. Only the
secondary total caps were therefore reviewed to 960 KiB JavaScript and 56 KiB CSS; the mandatory
10% checker reserve is unchanged. The release occupies 86.6% and 82.9% of those raw caps,
respectively. Initial, lazy-route, single-chunk and per-file CSS caps remain unchanged.

- initial JS gzip <= 150 KB target;
- no JavaScript chunk > 200 KiB gzip (enforced); the stable Blockly vendor boundary is currently
  about 198 KiB and remains lazy with Strategy Studio;
- chart crosshair update p95 <= 16 ms on reference hardware;
- pan/zoom maintains responsive frames on 10,000 visible/loaded candles;
- Pine import of the maximum supported file completes or rejects within a fixed timeout;
- backtest throughput benchmark for 10k/100k bars;
- no unbounded DOM growth in watchlists, journals or reports;
- reconnect does not increase active subscriptions/listeners.

### R2 stream/render soak

The R2.3 harness is implemented in `e2e/stream-render-soak.spec.ts`. It installs
an entirely synthetic same-origin market runtime, loads 12,000 retained candles,
emits a forming-candle update every 100 ms by default and runs desktop
`1440x900` and mobile `390x844` Chromium profiles serially. Each profile warms
up, measures an active Monitoring phase, switches to Strategy Studio to verify
resource release, returns to Monitoring and measures exact subscription
recovery. It makes no external market request and is not exchange, production
capacity or live-trading evidence.

The application boundary exercised by the harness is:

- `ChartWorkspaceRuntime` owns candle streams, compare polling, visible
  watchlist quotes and chart-position polling and is mounted only for
  Monitoring;
- panes hidden by maximize are marked non-operational and release their market
  and compare resources;
- closing the desktop markets panel or mobile markets sheet releases its
  watchlist quote feed;
- `PriceAlertFeed` stays outside the chart runtime so an armed alert may still
  be evaluated in another workspace, but it subscribes only to distinct
  untriggered alert symbols and an empty armed set creates no quote socket;
- a provisional update of the current candle is coalesced to at most one React
  commit per 250 ms and replaces only the O(1) tail view; a structural copy is
  recorded only for an initial snapshot, a new candle timestamp or an explicit
  history prepend.

Run a short wiring check locally or in the pinned container:

```bash
npm run test:soak:quick
npm run test:soak:quick:container
```

The 15-second quick profile is diagnostic only and cannot close R2. The
acceptance-shaped command enables strict thresholds and required
instrumentation, uses five minutes per desktop/mobile profile by default and
attaches one JSON summary per profile:

```bash
npm run test:soak
npm run test:soak:container
```

The JSON `acceptanceDuration` field must be true; lowering the default duration
or disabling `SOAK_ENFORCE_THRESHOLDS`/`SOAK_REQUIRE_INSTRUMENTATION` is not
acceptance evidence. Current harness thresholds are:

| Signal | Gate |
| --- | --- |
| Stream delivery | at least 75% of the expected synthetic candle count |
| Visible subscriptions | exactly one chart stream; desktop watchlist quotes `1`, closed mobile markets quotes `0` |
| Hidden workspace | chart and watchlist quote subscriptions both `0` when the no-alert fixture is in Strategy Studio |
| Recovery | one exact close/recreate cycle with no duplicate active subscription |
| Retained-heap checkpoint stability | after bounded GC warm-up, each three-reading paused/frame-settled/post-GC checkpoint spread at most `max(1 MiB, 5% of its median)` |
| Retained JS heap | conservative upper growth at most `max(8 MiB, 10% of recovered baseline)` |
| Retained JS heap rate | conservative upper net growth rate at most `1 MiB/min` across resumed Monitoring |
| Long tasks | maximum `150 ms`, total blocking time at most `250 ms` |
| Event-loop delay | maximum `250 ms` |
| Main-thread duty | desktop at most `0.35`, mobile at most `0.45` |
| DOM retention | documents delta `<= 0`, nodes `<= 50`, listeners `<= 10` |
| Candle copy pressure | at most `64` copied retained elements per processed message; every copy classified as snapshot, new bar, finalization or prepend |
| Root render isolation | `App` renders / processed market messages at most `0.01` |
| Integrity | render/stream probes present; no page error, console error or external HTTP request |

Ordinary `Runtime.getHeapUsage.usedSize` samples are retained in the summary,
including `rawJsHeapOlsSlopeMiBPerMinute`, but that GC-driven sawtooth is
diagnostic only. Memory acceptance uses equivalent paused, frame-settled,
post-GC checkpoints and records both their median net growth and the
conservative `max(final) - min(baseline)` upper bound. This measures V8
JavaScript heap retention, not total renderer/process memory.

Record the environment, both attached summaries and the still-manual device
results in [R2 stream/render soak evidence](./evidence/R2_STREAM_RENDER_SOAK.md).
The authoritative 2026-07-16 pinned run passed desktop and mobile without retry
(`2/2` in `11.7 min`). Both profiles emitted `2,402` candles against the
`1,800` minimum, released hidden subscriptions and recovered exactly, reported
zero `App` renders per message, and kept copy pressure at `34.9854`/`35.0146`
elements per message. Desktop/mobile retained upper heap growth was
`-3,055,496`/`-1,046,944 B`; maximum long tasks were `50`/`114 ms`, total
blocking time `0`/`204 ms`, event-loop delay `14`/`42.6 ms`, and task duty
`0.16577`/`0.21037`. Every strict summary check is true; the evidence page
retains the full table and SHA-256 hashes.

This accepts the automated browser soak only. R2 remains open until real Android
Opera and VoiceOver/NVDA/TalkBack smoke checks are recorded. HTTPS, live
execution and external exchange readiness remain separate, explicitly deferred
gates.

## PWA and offline boundary

`npm run build` runs `scripts/check-pwa.mjs` after Vite. The verifier requires a root-scoped
standalone manifest, usable PNG icon, content-derived generated precache, complete emitted JS/CSS
coverage, explicit runtime endpoint guards and the absence of `skipWaiting` or background sync.

The Chromium production journey additionally checks real server headers and Cache Storage, waits
for an active controller, disables the browser network and reloads the shell. It then proves that a
fresh `/api/*` request rejects rather than resolving from the worker. This is a safety invariant:
an offline UI must never be evidence of fresh market state or a queued trading command.

The optional research-cache scenario additionally installs the generated Strategy Studio graph,
asserts that Trading View and runtime routes are absent, disables the browser network, launches
`/?view=strategy` and requires the local editor to render while an API probe still rejects.

The same build gate parses `file_handlers` and permits only exact `.pine`, `.strategy` and
`.saltanat-plugin` contracts routed to Strategy Studio. Unit tests prove feature detection,
metadata-only collection, count/size limits and spoof rejection. Production Chromium journeys inject
all three launch types and require outer consent plus their existing format-specific reviews before
the artifact library changes. Unsupported browsers continue through the ordinary file inputs.

The gate also requires one file-only Share Target with its exact multipart action, field and accept
list, plus a generated worker containing bounded, expiring IndexedDB storage, 303 hand-off and discard
protocol. Unit tests require one strict UUID, bounded messaging, metadata-only collection, URL cleanup
and fail-closed invalid/expired records. Production Chromium submits a native multipart form through
the real worker, mixes accepted, unsupported and oversized files, verifies no Strategy Studio load or
library mutation before consent, then proves record deletion and the normal Pine Convert/Add flow.
The offline shell journey receives and cancels a share while a fresh API request still rejects.

A separate EN/RU/KK production journey aborts the content-hashed main module before React can mount.
It requires the static recovery surface to replace a blank screen after two seconds, expose native
reload/selective-refresh controls and pass axe. Unit tests independently verify the React boundary,
chunk-error classification, one-shot loop guard and selective worker/cache cleanup.

## Test data policy

- deterministic clocks, random seeds and candle fixtures;
- no production keys or personal data;
- permissive provenance recorded for external Pine samples;
- secrets represented by obvious fake values;
- golden files reviewed like code;
- large corpora stored separately if they materially slow default CI.

External Pine provenance is enforced by `npm run pine:provenance:check`. The
manifest must cover every `pine/*.pine` file and match its SHA-256. Only
allow-listed SPDX entries with preserved headers run in
`pineGoldenAndExternalCorpus.test.ts`; unknown-license files are audit-only.
The same suite verifies reviewed byte-level v4/v6 conversion golden hashes.

## Release distribution and rollback

`releaseWorkflow.test.ts` verifies channel/version policy, immutable source identity, required SBOM
and Sigstore workflow permissions, strict extracted-file manifests and the rollback drill contract.
Changed, extra and symbolic-link fixture files must fail closed.

Every release workflow then runs the drill against the exact full staging directory used for its
archive and SBOM. The candidate slot is activated, its frontend entry file is deliberately changed,
manifest verification must reject it, and a same-directory atomic pointer must return to a verified
previous slot. The credential-free JSON evidence and external distribution manifest are included in
`SHA256SUMS` and provenance. This tests distribution mechanics; each real host still requires a
platform-specific proxy/supervisor/persistent-volume rehearsal.

## CI tiers

### Pull request

- check, lint, unit, component, contract;
- the complete production-build Chromium E2E suite in the required `end-to-end (Chromium)` CI job;
- 18 tagged production journeys in the required `critical journeys (Firefox)` CI job;
- six deterministic interface baselines in the required `visual regression (Chromium)` CI job;
- a seven-day Playwright report/trace/screenshot/video artifact when that browser job fails;
- reviewed visual snapshot changes;
- heuristic secret scan;
- documentation link and generated-reference checks.

The browser gates use `DEMO_MODE=1`, which disables live trade execution, and a disposable test-only
authentication token. Critical provider routes are mocked by their owning scenarios, but the test
harness does not yet enforce complete outbound isolation for every public market-data request. It
never receives exchange credentials. Authenticated exchange checks remain isolated in the manually
dispatched, protected workflow described below.

### Scheduled browser matrix

- the complete production-journey Chromium, Firefox and WebKit matrix, with per-browser failure evidence
  retained for 14 days;

The current scheduled workflow runs the browser matrix only. Separate scheduled fuzz/property,
long performance/leak, exchange fake-server and database migration/restore jobs remain roadmap work;
their ordinary deterministic suites still run through the repository's unit/integration gates.

### Release candidate

- manually dispatched Binance Futures Demo and Bybit Testnet authenticated smoke through the protected `exchange-testnet` environment;
- recovery rehearsal;
- accessibility manual checklist;
- SBOM, dependency audit, signed artifacts and clean-install verification.

## Coverage policy

Line percentage is not the primary target. Required coverage is risk-based:

- 100% node-kind/command/action handling matrix;
- every critical state-machine transition;
- table-driven startup reconciliation across every in-flight order status, cancel/replace ambiguity, signed-query failure and sequential rate-limit behavior;
- every documented Pine compatibility row;
- every public API success and authorization failure class;
- every critical browser journey;
- explicit tests for every fixed production or audit defect.

Coverage reports remain useful for finding untouched code, but a high percentage never replaces invariant and scenario coverage.
