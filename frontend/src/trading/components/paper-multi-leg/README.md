# Multi-leg paper journal UI

This folder owns the authenticated browser workspace for deterministic N-leg
and route-family paper runs.

- `PaperMultiLegPanel.tsx` loads restart-recovery status and recent runs,
  validates a short-lived plan before submission, and renders the append-only
  event journal.
- The panel calls only the internal `/api/trade/paper-multi-leg` client. It has
  no exchange credential fields and no live-order control.
- UI strings come from `paperMultiLegText.ts` in English, Russian and Kazakh.
- Polling pauses in hidden tabs and every response is parsed fail-closed before
  it reaches React state.

The current input workflow intentionally accepts the exact plan JSON produced
by a research engine. A one-click screener-to-paper-plan handoff is a separate
UX extension and must preserve the same strict plan boundary.
