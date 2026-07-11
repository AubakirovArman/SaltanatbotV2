# Repository scripts

This folder contains deterministic maintenance and release helpers invoked by root npm commands or CI.

- `check-backtest-core-generated.mjs`: verifies generated backtest-core runtime/declarations remain synchronized.
- `check-strategy-core-generated.mjs`: verifies generated strategy-core runtime/declarations remain synchronized.
- `check-docs.mjs`: validates tracked Markdown links and documented root npm commands.
- `generate-pine-compatibility.mjs`: generates and checks the Pine compatibility registry.
- `generate-reference-docs.mjs`: generates and checks the Express endpoint index and strategy block catalog.
- `package-release.mjs`: validates release channels and creates a deterministic, secret-free application archive plus build metadata.
- `exchange-testnet-smoke.mjs`: explicitly armed, read-only authenticated Binance Futures Demo and Bybit Testnet release checks.

## Invariants

- Scripts must be non-interactive and return a non-zero exit code on failure.
- Check-mode scripts never rewrite source files.
- Networked scripts require an explicit opt-in guard and must reject production endpoints.
- Secrets are read only from runtime environment variables and are never printed.
- Release archives must exclude runtime data, databases, environment files and dependency directories.

## Testing

Pure signing, validation and request assembly belong in Vitest with fake transports. Real exchange testnet execution is isolated in a manually dispatched protected workflow.
