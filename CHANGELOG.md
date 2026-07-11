# Changelog

This project follows a keep-a-changelog style. Until the first tagged release, completed work is recorded under **Unreleased** and in `docs/IMPLEMENTATION_STATUS.md`.

## Unreleased

### Added

- Shared contracts and strategy-core workspaces with versioned strategy IR.
- Pine Script import with explicit compatibility diagnostics and a native Cycles Analysis preview.
- IR v4 projection zones, accessible metric tables and chart-side Pine input controls.
- Production Playwright suite covering chart, strategy, backtest, paper trading, reconnect, accessibility and responsive flows.
- English/Russian documentation structure and an executable implementation ledger.

### Changed

- Began modular decomposition of Pine conversion and backtest preview/analytics.
- Removed zero-price synthetic fallback and made unavailable market data explicit.
- Upgraded the test toolchain and removed known dependency audit findings.

### Security

- Live trading remains opt-in; demo mode disables exchange keys and live execution.
- Dynamic fallback prices require a positive real reference and are never accepted by strict live-trading routes.
