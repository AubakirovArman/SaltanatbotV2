# Repository scripts

This folder contains deterministic maintenance and release helpers invoked by root npm commands or CI.

- `check-backtest-core-generated.mjs`: verifies generated backtest-core runtime/declarations remain synchronized.
- `check-contracts-generated.mjs`: verifies generated contracts runtime/declarations remain synchronized.
- `check-execution-core-generated.mjs`: verifies generated execution-core runtime/declarations remain synchronized.
- `check-strategy-core-generated.mjs`: verifies generated strategy-core runtime/declarations remain synchronized.
- `check-docs.mjs`: validates tracked Markdown links and documented root npm commands.
- `check-docs-semantic.ts`: compares the source-backed scanner-mode, public venue, continuous
  protocol and generated endpoint-total facts with `docs/CAPABILITY_TRUTHS.json`, then verifies the
  corresponding canonical English documentation rows. It is deterministic and opens no sockets.
- `check-site.mjs`: validates the EN/RU/KK GitHub Pages entry points, relative assets, language
  metadata, semantic main/skip navigation and baseline focus/reduced-motion CSS requirements.
- `build-frontend.mjs`: builds Vite into a unique staging directory, verifies the candidate PWA and
  bundle budgets, then publishes it into the live `frontend/dist` without an index/entry gap.
- `check-bundle-budgets.mjs`: resolves the production static/dynamic import graph and enforces
  reviewed raw/gzip ceilings for startup, each lazy route, individual assets and the complete
  distributable JS/CSS set from `performance-budgets.json`.
- `check-pwa.mjs`: validates the emitted shell/research graphs, exact desktop file handlers and the
  bounded file-only Share Target/worker contract while rejecting runtime caching or trading actions.
- `generate-pine-compatibility.mjs`: generates and checks the Pine compatibility registry.
- `generate-reference-docs.mjs`: generates and checks the Express endpoint index and strategy block catalog.
- `package-release.mjs`: validates release channels and creates a deterministic, secret-free
  application archive from the active frontend generation plus build metadata and a per-file SHA-256
  distribution manifest.
- `release-rollback-drill.mjs`: exercises controlled candidate corruption, fail-closed manifest verification and atomic restoration of a verified immutable slot, emitting credential-free JSON evidence.
- `lib/distribution-manifest.mjs`: shared strict manifest writer/verifier and atomic pointer-file helper for release tooling.
- `exchange-testnet-smoke.mjs`: explicitly armed, read-only authenticated Binance Futures Demo and Bybit Testnet release checks.
- `public-feed-canary.ts`: credential-free, order-free public WebSocket evidence for all nine
  generic continuous venues. Spot targets require a reconstructed book; derivative targets require
  a book plus a public funding observation, while the explicitly non-canonical dYdX research target
  requires its reviewed book-only evidence. The scheduled workflow preserves the bounded schema-v3
  JSON result even when a venue fails. The 2026-07-14 local run passed eight targets and retained
  Kraken's host-specific TLS-egress failure instead of hiding it.
- `runtime-data.mjs`: creates checksum-manifested online SQLite backups, verifies integrity and
  performs explicit atomic restore of `backend/data` while preserving secret file permissions.

## Invariants

- Scripts must be non-interactive and return a non-zero exit code on failure.
- Check-mode scripts never rewrite source files.
- Authenticated or mutating network scripts require an explicit opt-in guard and must reject
  production endpoints. The scheduled public-feed canary is the narrow exception: it uses only
  credential-free public market-data endpoints, has no order path and explicitly denies soak or
  mainnet-readiness claims in its output.
- Secrets are read only from runtime environment variables and are never printed.
- Release archives must exclude runtime data, databases, environment files and dependency directories.
- Extracted release verification must reject missing, changed, extra, symbolic-link and identity-mismatched files before activation.
- Frontend publication keeps the old HTML pointer and its hashed assets available while a candidate
  is copied. It swaps `index.html` atomically, publishes `service-worker.js` last, and retains at most
  the active plus immediately previous generation.

## Testing

Pure signing, validation and request assembly belong in Vitest with fake transports. Real exchange testnet execution is isolated in a manually dispatched protected workflow.
