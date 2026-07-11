# Frontend hooks

This directory owns reusable React controllers that are independent of a single feature component.

- `useCatalog`, `useMarketStream` and `useSparklines` connect typed market transports to React state.
- `useModalFocus` enforces initial focus, Tab containment, Escape dismissal and focus restoration for modal dialogs.

Hooks may depend on typed frontend clients and React, but not on presentation CSS or feature-specific storage internals. Transport hooks must reject stale work after teardown; modal consumers must retain semantic `role="dialog"` and `aria-modal="true"` markup. Cover observable behavior in component or Playwright tests.
