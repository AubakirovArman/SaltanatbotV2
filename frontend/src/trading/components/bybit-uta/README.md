# Bybit UTA UI

This folder owns the authenticated Unified Trading Account risk surface.

- `BybitUtaPanel.tsx` loads account/collateral/debt state and renders risk metrics.
- `BybitUtaForms.tsx` contains explicit-confirmation borrow and repay mutations.

Mutations remain disabled on insecure non-local HTTP pages. Repayment does not convert collateral unless the operator selects and separately confirms that mode.
