# Roadmap

> P0, P1 and P2 delivery evidence is maintained in
> [MASTER_IMPROVEMENT_PLAN.md](./MASTER_IMPROVEMENT_PLAN.md) and
> [IMPLEMENTATION_STATUS.md](./IMPLEMENTATION_STATUS.md). This page contains only work beyond that
> completed repository scope.

SaltanatbotV2 is a strong open-source alpha for charting, Pine import, visual strategy authoring,
reproducible research, paper trading and experimental exchange execution. Live trading is not
production-ready until the explicitly deferred funded soak and mainnet-readiness program are done.

## Delivered baseline

- Strict Binance/Bybit market routing, shared feeds, persistent history and explicit unavailable/fallback states.
- Version-aware Pine compiler with typed fidelity diagnostics, corpus, compatibility matrix and fuzz tests.
- Versioned Strategy Studio, shared evaluator/backtest cores, reproducible reports, replay, optimizer and walk-forward.
- Multi-symbol portfolio backtests with one shared capital pool, correlated returns and portfolio-level exposure limits.
- Modeled portfolio TCA with reconciled commission, configured slippage, funding and per-market/exit-reason attribution.
- Checksummed and optionally ECDSA-signed local declarative plugin packages with strict permissions, device-local author identity, dual-signed bounded key rotation, explicit fingerprint trust, fail-closed local signer/chain blocking, version/signer-continuity update review, automatic dependency-aware authoring, an installed-package catalog, dependency-safe uninstall and no arbitrary JavaScript.
- Durable order/fill/position/run lifecycle, private streams plus polling, recovery and bot-attributed spot inventory.
- Professional multi-chart workspaces, pane/scales, drawing management, accessible tables and responsive monitoring.
- Per-pane IANA time-zone axes with DST-safe chart labels and versioned workspace/session persistence.
- Scoped session security, encrypted keys, audit logs, verified backup/restore and fail-closed demo mode.
- Complete EN/RU/KK UI and user documentation, public Pages, release artifacts, SBOM, checksums and attestations.
- Enforced TypeScript, Biome, docs, architecture, unit/integration, build, performance and Playwright gates.
- Blank-screen-safe startup with a localized pre-React fallback, global React recovery boundary and data-preserving stale-shell refresh.
- Attested release archives with per-file manifests and an enforced controlled-corruption/atomic-rollback drill plus EN/RU/KK incident runbooks.

## Explicitly deferred external validation

| Item | Why deferred | Required before claim |
| --- | --- | --- |
| Continuous 7–14-day Binance/Bybit testnet soak | Requires funded accounts and protected external credentials | Reconnect, fills, protection and recovery evidence over the full window |
| Mainnet readiness | Requires the soak plus controlled real-account operational review | Signed operator evidence and removal of every Experimental warning only after approval |

These are not silently marked complete and are not included in the P0/P1/P2 repository closure.

## P3 product opportunities

| Epic | Outcome | Relative effort |
| --- | --- | --- |
| Additional exchange adapters | Conformance-tested OKX and later KuCoin/MEXC data/execution adapters | L |
| Order-book and derivatives data | Depth, tape, funding, open interest and licensed advanced feeds | L–XL |
| Plugin capability expansion | Additional reviewed declarative extension points beyond editable indicator/strategy packages | L–XL |
| Moderated community registry | Signed indicator/strategy discovery, publisher verification, compromise revocation and supply-chain policy beyond local dual-signed rotation | XL |
| Optional encrypted sync | User-controlled cross-device strategies and workspace synchronization | XL |
| Hosted read-only demo | Public deployment of the existing non-mutating demo mode | M, infrastructure |
| PWA follow-on | The installable network-truth-safe shell is delivered; richer OS integration and optional offline local research artifacts remain | M |
| More locale and RTL coverage | Formatting, long-string and bidirectional layout conformance | L |
| AI-assisted strategy drafts | Optional BYO-model natural language to validated blocks/IR | M |
| Collaboration | Opt-in review/sharing service separated from local-first core | XL |
| Live venue-quality telemetry | Compare measured latency, spread, order-book impact and execution quality across connected venues | L, external data |

## Stable-release gates beyond alpha

- Complete the funded exchange validation above.
- Maintain a current manual multi-screen-reader/browser matrix in addition to automated axe checks.
- Rehearse the delivered incident-response/rollback runbook against each real hosting platform's proxy, supervisor and persistent volumes.
- Promote release channels only through the documented alpha → beta → stable criteria.

## See also

- [Configuration and deployment](./CONFIGURATION.md)
- [Trading engine](./TRADING.md)
- [Strategies and backtesting](./STRATEGIES.md)
- [Release verification](./RELEASING.md)
