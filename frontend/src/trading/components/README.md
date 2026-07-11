# Trading UI components

Feature-owned trading components live here instead of the shared component directory.

- `TradeAccess.tsx` owns authentication and the empty-state entry flow.
- `CreateBotForm.tsx` owns validated paper/live bot configuration and creation.
- `TradingSettings.tsx` owns live arming, the kill switch, exchange secrets and notifications.

Components receive typed domain inputs and callbacks. API orchestration that coordinates multiple panels remains in `TradingView` until it moves into a controller hook.
