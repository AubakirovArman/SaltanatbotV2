# Repository scripts

This folder contains deterministic maintenance and release helpers invoked by root npm commands or CI.

- `check-backtest-core-generated.mjs`: verifies generated backtest-core runtime/declarations remain synchronized.
- `check-contracts-generated.mjs`: verifies generated contracts runtime/declarations remain synchronized.
- `check-execution-core-generated.mjs`: verifies generated execution-core runtime/declarations remain synchronized.
- `check-strategy-core-generated.mjs`: verifies generated strategy-core runtime/declarations remain synchronized.
- `check-docs.mjs`: validates tracked Markdown links and documented root npm commands.
- `check-site.mjs`: validates the EN/RU/KK GitHub Pages entry points, relative assets, language
  metadata, semantic main/skip navigation and baseline focus/reduced-motion CSS requirements.
- `check-bundle-budgets.mjs`: measures production frontend HTML, CSS and JavaScript using raw/gzip
  sizes and enforces the reviewed limits in `performance-budgets.json`.
- `check-pwa.mjs`: validates the emitted shell/research graphs, exact desktop file handlers and the
  bounded file-only Share Target/worker contract while rejecting runtime caching or trading actions.
- `generate-pine-compatibility.mjs`: generates and checks the Pine compatibility registry.
- `generate-reference-docs.mjs`: generates and checks the Express endpoint index and strategy block catalog.
- `package-release.mjs`: validates release channels and creates a deterministic, secret-free application archive plus build metadata and a per-file SHA-256 distribution manifest.
- `release-rollback-drill.mjs`: exercises controlled candidate corruption, fail-closed manifest verification and atomic restoration of a verified immutable slot, emitting credential-free JSON evidence.
- `lib/distribution-manifest.mjs`: shared strict manifest writer/verifier and atomic pointer-file helper for release tooling.
- `exchange-testnet-smoke.mjs`: explicitly armed, read-only authenticated Binance Futures Demo and Bybit Testnet release checks.
- `runtime-data.mjs`: creates checksum-manifested online SQLite backups, verifies integrity and
  performs explicit atomic restore of `backend/data` while preserving secret file permissions.

## Invariants

- Scripts must be non-interactive and return a non-zero exit code on failure.
- Check-mode scripts never rewrite source files.
- Networked scripts require an explicit opt-in guard and must reject production endpoints.
- Secrets are read only from runtime environment variables and are never printed.
- Release archives must exclude runtime data, databases, environment files and dependency directories.
- Extracted release verification must reject missing, changed, extra, symbolic-link and identity-mismatched files before activation.

## Testing

Pure signing, validation and request assembly belong in Vitest with fake transports. Real exchange testnet execution is isolated in a manually dispatched protected workflow.
