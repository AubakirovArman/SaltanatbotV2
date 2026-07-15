# Trading UI components

Feature-owned trading components live here instead of the shared component directory.

- `TradeAccess.tsx` owns authentication and the empty-state entry flow.
- `CreateBotForm.tsx` owns validated paper/live bot configuration, including mandatory live risk limits, and creation.
- `TradingSettings.tsx` owns secure-origin-aware live arming, the kill switch, exchange secrets and notifications.
- `AccountTelemetryPanel.tsx` is an admin-only, GET-only view of bounded fee, borrow, transfer-network and stablecoin-FX evidence. Its strict browser parser lives in `../accountTelemetry.ts`; snapshots are not persisted and cannot enable execution.
- `BotDetail.tsx` owns bot runtime/risk cards, Antares commands, order/fill journals and lifecycle actions.
- `BotCommandConsole.tsx` owns command composition, dry runs, references and saved commands.
- `BotActivity.tsx` renders open orders, order history, fills and logs with semantic tables.
- `paper-multi-leg/` owns the lazy, paper-only deterministic multi-leg run and recovery journal workspace.

Components receive typed domain inputs and callbacks. API orchestration that coordinates multiple panels remains in `TradingView` until it moves into a controller hook.

All user-facing labels, confirmations, accessible names, table headers and trading-domain terms come from `i18n/trading.ts`. The Antares reference localizes descriptions while preserving executable command syntax exactly.
