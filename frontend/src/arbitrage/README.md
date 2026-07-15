# Arbitrage research frontend

This folder owns the lazy EN/RU/KK arbitrage research workspace. Its browser modes are
Binance/Bybit same- and cross-venue spot/perpetual basis, single-venue triangular
top-book simulation, Bybit venue-native spreads, caller-supplied European options parity and
point-in-time public perpetual funding stress, plus operator-allowlisted continuous route families.

- `client.ts` validates basis REST and `/arbitrage-stream` contracts. Depth responses are
  bound to the exact selected symbol, venues, sides and verified instrument identities.
- `triangularClient.ts` accepts the bounded Binance/Bybit REST result only when it is explicitly
  `rest-top-book`, `rest-snapshot`, unsequenced and a `non-executable-candidate`;
  it also delegates selected-route L2 proof to the strict public SDK parser. `TriangularScreener.tsx`
  renders the top-book boundary, exposes one explicit verify action, and shows all three
  sequence/generation leases without exposing an order action.
- `nativeSpreadClient.ts` fails closed on Bybit native-spread metadata, tick/lot grids,
  top-book capacity, provenance timestamps, aggregate counts and the fixed read-only risk contract;
  a row is never treated as an executable order instruction.
- `marketOpportunityAdapters.ts` maps basis, unsequenced triangular and venue-native spread rows to
  `market-opportunity-v1` without upgrading their execution boundary. `marketOpportunityHandoff.ts`
  persists one size-bounded, expiring session record and emits a same-tab typed event for the
  Automation workspace. Only a sequence- and timestamp-verified `n-leg-v1` envelope may advertise a
  ready paper plan; every live path remains blocked.
- `NativeSpreadScreener.tsx` renders Bybit venue-native spread books without exposing an order path.
- `OptionsParityWorkbench.tsx` builds a strict caller-supplied call/put/underlying scenario and
  renders only SDK-validated visible-depth research candidates. Capacity, margin, borrow, rates and
  fees remain explicit assumptions; the lazy mode has no credentials or order action.
- `FundingCurveWorkbench.tsx` loads one server-owned funding universe that already intersects fresh
  verified perpetuals with the adapters actually supported by `FundingCurveService`; the browser
  never joins generic capability and registry endpoints. It submits an explicit bounded
  horizon/stress request and compares cumulative rates only while the central reviewed identity
  catalog is valid. Its separate client/text/style files preserve accessible loading/error/empty/
  partial states and the read-only no-notional/no-P&L boundary.
- `useArbitrageStream.ts` owns reconnect, hidden-tab pause and REST fallback behavior.
- `scannerPrefs.ts` owns the bounded version-2 local workspace schema, version-1 migration,
  required-column enforcement and the twelve-preset limit. Invalid or oversized storage fails back
  to defaults without blocking live research.
- `ScannerWorkbench.tsx` provides custom columns, table/heatmap/route-compare views and accessible
  exact-value alternatives. Visual rows stop updating while the document is hidden. Presets store
  filters and presentation only; they never store credentials or grant execution permission.
- `ScannerModeNav.tsx` keeps the mode switch and the collapsible EN/RU/KK fork guide separate from
  orchestration. The guide maps informal double, triple, intra-exchange and multi-leg wording to
  exact route shapes and repeats the research-only boundary.
- `LifecycleStatus.tsx` consumes the visibility-aware read-only lifecycle hook. It exposes aggregate
  `first-seen`/`confirmed`/`decaying` state and never turns lifecycle status into an order action.
- `ArbitrageScreener.tsx` coordinates client filters, notification preferences, depth and paper state.
- `ArbitrageTable.tsx`, `ArbitrageControls.tsx`, `ArbitrageHistoryChart.tsx` and
  `ArbitragePaperPanel.tsx` own focused accessible UI regions. Every basis row exposes its timing
  quality; fresh rows rank before unverified/skewed/stale candidates.
- `ArbitrageServerAlerts.tsx` manages authenticated notification-only rules.
- `fees.ts` is a user-maintained cost estimate; it is not account fee/borrow telemetry.
- `paper.ts` validates matched position math; `paperLedger.ts` stores a bounded append-only event
  ledger with legacy migration, deterministic replay, explicit manual-confirmed funding and
  exit-depth provenance. Open and close reject depth from a different route or instrument ID. It is
  not the trading-engine paper broker or an exchange account.
- `text.ts`, `triangularText.ts`, `forkGuideText.ts`, `nativeSpreadText.ts`, `analysisText.ts` and
  `alertDeliveryText.ts` contain the domain EN/RU/KK catalogs; `loadArbitrageScreener.ts` keeps the
  workspace out of the initial chart bundle.

The screen never places orders. Basis mode compares the spot ask required to buy with the perpetual bid
available to short on the same or another exchange. Its paper entry and realized close use matched
entry/exit depth VWAP; only the open mark uses executable top-book quotes. Current funding projection counts discrete
settlements only when `nextFundingTime` and a contract-specific interval are verified. Unknown
positive funding receives no credit; unknown negative funding is charged for at least one settlement
for every non-zero holding horizon, even without `nextFundingTime`. Ledger funding is never inferred retroactively
from that estimate: the operator must enter a settlement confirmed by venue history or an account
statement.

Browser paper positions apply only to basis mode. Triangular and native-spread rows are read-only
candidate simulations with chart links and a research handoff to Automation; they do not share the
basis paper ledger and the handoff does not place orders.
All three modes share the local workspace controls and compact snapshot visualizations. The heatmap
uses rank plus exact text values rather than color alone. Route comparison shows ordered legs and a
semantic metric table; it compares current candidates and is not an execution forecast.
Paper entry and exit additionally require venue-provided timestamps for both depth books; a locally
received but venue-untimestamped book remains `unverified` and cannot be marked complete.

Quotes are asynchronous and no two-leg atomicity is claimed. Funding, transfer/rebalance delay,
borrow availability, margin, liquidation, partial fills and future exit basis can remove a displayed
edge. See the canonical [math](../../../docs/ARBITRAGE_MATH_AND_ASSUMPTIONS.md) and
[taxonomy](../../../docs/ARBITRAGE_TAXONOMY.md).
