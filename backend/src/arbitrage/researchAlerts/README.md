# Generic research arbitrage alerts

This module is a notification-only boundary over normalized route lifecycle and
`route-economics-v1`. It supports basis, all six pairwise route families, triangular,
native-spread, options-parity, N-leg and future CEX-DEX candidates without importing an
exchange credential or order adapter.

An alert can cross only when all of the following are true:

- an exact reviewed `economicAssetId` and ordered economic-leg identity are current;
- lifecycle evidence is complete, confirmed, fresh enough and explicitly actionable as
  research state;
- the server recomputes the supplied `RouteEconomicsRequest`, including fees, funding,
  borrow, transfer, margin and available account capital;
- conservative net profit, edge, capacity and risk-capital policy limits pass;
- a family-independent hash of the exact directed venue/instrument legs is outside cooldown.

Every envelope and outbox intent fixes `researchOnly: true` and
`executionPermission: false`. The outbox mirrors the legacy durable statuses and retry/lease
semantics but uses a separate state key, so migration cannot corrupt existing basis alerts.

`registerResearchAlertRoutes()` is intentionally isolated for conflict-free mounting under
the existing authenticated `/api/trade` router. The application composition root must create
and start `ResearchAlertService`, register the router with the `paper-trade` role, and feed it
only server-owned normalized snapshots. Until that wiring and per-engine adapters exist, the
module is a tested integration boundary rather than an automatically populated live alert feed.

The exact composition hook is:

```ts
// TradingApiOptions: researchAlerts?: ResearchAlertService
registerResearchAlertRoutes(router, options.researchAlerts, requireRole("paper-trade"));
```

It must stay after `router.use(requireAuth)` and `router.use(auditTradingMutation)`: cookie-session
mutations then inherit `requireAuth`'s CSRF check and all policy/delete calls enter the sanitized
trading audit log. Market/economics snapshots deliberately have no HTTP ingest route; server-owned
engine adapters call `ResearchAlertService.ingest()` in process. In `server.ts`, construct the service without credentials, pass it
through `TradingApiOptions`, call `start()` only after `createTradingApi()` has initialized the
store, and call `close()` during shutdown.
