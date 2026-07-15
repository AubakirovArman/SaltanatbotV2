# Bybit UTA UI

This folder owns the authenticated Unified Trading Account risk surface.

- `BybitUtaPanel.tsx` loads account/collateral/debt state and renders risk metrics.
- `BybitUtaForms.tsx` contains explicit-confirmation borrow and repay mutations.

Mutations follow the backend's secure-origin verdict and remain disabled on insecure non-local HTTP pages unless the explicit development override is active. Repayment does not convert collateral unless the operator selects and separately confirms that mode.
