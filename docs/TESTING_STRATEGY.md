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
5. Pine strategy imports, reports diagnostics, opens as blocks and runs a backtest;
6. Pine indicator imports and appears on the current chart;
7. strategy is created from a template, edited, compiled and saved;
8. backtest shows assumptions, trades, metrics and chart markers;
9. optimizer runs in a worker and can be cancelled;
10. named workspace and bounded last-chart-session state save and restore after reload, while malformed/future storage fails closed;
11. paper bot is created, started, receives a signal, records an order and stops;
12. authentication, CSRF expiry and logout behave correctly;
13. kill switch requires the right role and visibly updates state;
14. WebSocket disconnect reconnects without duplicating candles or orders;
15. invalid/fallback market data is visibly distinguished from real data.

Live-mainnet orders must never run in generic E2E. Exchange testnets require an explicit opt-in environment and isolated credentials.

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
- explicit DPR 1/2 browser checks for Canvas backing resolution, pointer/HUD alignment and density-invariant CSS interaction targets;
- multi-chart focus/command-routing/market-context/maximize/restore checks proving top-bar, watchlist and statistics affect or describe only the active pane while hidden panes stay mounted and retain symbol, zoom, tools and accessible state;
- shared-market transport checks proving matching pane keys fan out one physical socket, distinct keys stay isolated, late subscribers receive open state and the final consumer closes the resource;
- component semantics for captions, scoped column headers, empty states and focused-bar synchronization across OHLC, signals and trades;
- typed English/Russian parity for chart-table accessible names, headers, domain terms, dates and numbers;
- typed English/Russian parity for trading settings, destructive confirmations, command references, runtime cards and semantic order/fill tables;
- typed English/Russian parity for Strategy Studio, Pine-import diagnostics, backtest assumptions/metrics and optimizer controls;
- browser flow proving the Canvas alternative opens from the keyboard and exposes named native tables.

Avoid pixel snapshots for every candle. Use semantic renderer assertions for logic and a small stable visual suite for integration.

## Backtest invariants

Every result records chart and `request.security` candle provenance. Only fully labelled real-provider data validates performance claims; synthetic, fallback, mixed and unknown inputs must remain visibly labelled in the report.

- no fill before a signal is actionable;
- `next_open` never uses the signalling close as its fill;
- stops are pessimistic when stop and target touch in one unknown-path bar;
- gaps receive the documented fill treatment;
- slippage never improves a market fill;
- commission/funding reconcile with final equity;
- leverage and quantity caps are enforced;
- no negative/NaN quantity or price enters accounting;
- liquidation terminates or transitions exactly as specified;
- same seed produces the same optimizer/Monte Carlo result;
- warm-up bars are excluded consistently;
- missing/fallback data invalidates or labels a report.

## Trading and exchange tests

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
- Firefox for critical smoke journeys.

Nightly/release:

- Chromium, Firefox and WebKit;
- desktop dark/light;
- one narrow touch viewport for monitoring workflows;
- English and Russian;
- reduced motion and forced/high contrast smoke checks.

## Performance budgets

The production bundle has an enforced CI gate after `npm run build`:

```bash
npm run perf:check
```

Reviewed raw/gzip ceilings live in `performance-budgets.json`. The checker covers HTML, every CSS
asset, the largest individual JavaScript chunk and total JavaScript gzip size. A limit may only be
raised with measured justification. Current limits preserve a small regression margin around the
measured baseline; the longer-term targets remain:

- initial JS gzip <= 150 KB target;
- no lazy feature chunk > 200 KB gzip without an approved exception (Blockly is currently near this
  threshold and remains an explicit split/optimization target);
- chart crosshair update p95 <= 16 ms on reference hardware;
- pan/zoom maintains responsive frames on 10,000 visible/loaded candles;
- Pine import of the maximum supported file completes or rejects within a fixed timeout;
- backtest throughput benchmark for 10k/100k bars;
- no unbounded DOM growth in watchlists, journals or reports;
- reconnect does not increase active subscriptions/listeners.

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

## CI tiers

### Pull request

- check, lint, unit, component, contract;
- Chromium critical E2E;
- changed visual snapshots;
- dependency and secret scan;
- documentation link check.

### Nightly

- full browser matrix;
- fuzz/property suite;
- full Pine corpus;
- long performance and leak tests;
- exchange fake-server conformance;
- database migration/backup restore.

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
