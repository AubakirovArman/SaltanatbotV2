# Roadmap

> The broad repository baseline is maintained in
> [MASTER_IMPROVEMENT_PLAN.md](./MASTER_IMPROVEMENT_PLAN.md) and
> [IMPLEMENTATION_STATUS.md](./IMPLEMENTATION_STATUS.md). Scanner-specific P0/P1/P2 integration
> remains active in [P0_P1_P2_EXECUTION_PLAN.md](./P0_P1_P2_EXECUTION_PLAN.md); this page records
> longer-horizon product work without reclassifying that ledger as complete.

The ordered implementation plan for the current public Research / Paper deployment is maintained in
[PRE_HTTPS_ROADMAP.md](./PRE_HTTPS_ROADMAP.md). It deliberately excludes HTTPS and keeps all private
exchange execution disabled until a separate security review. The current build accepts only
`RUNTIME_PROFILE=public-http-paper`; environment variables cannot activate the retained future live
policy types.

SaltanatbotV2 is a strong open-source alpha for charting, Pine import, visual strategy authoring,
reproducible research and paper trading. It contains tested future execution-foundation components,
but production routes/adapters intentionally remain deny-only and live trading is not part of this
release.

## Delivered baseline

- Strict Binance/Bybit market routing, shared feeds, persistent history and explicit unavailable/fallback states.
- Version-aware Pine compiler with typed fidelity diagnostics, corpus, compatibility matrix and fuzz tests.
- Versioned Strategy Studio, shared evaluator/backtest cores, reproducible reports, replay, optimizer and walk-forward.
- Multi-symbol portfolio backtests with one shared capital pool, correlated returns and portfolio-level exposure limits.
- Modeled portfolio TCA with reconciled commission, configured slippage, funding and per-market/exit-reason attribution.
- Checksummed and optionally ECDSA-signed local declarative plugin packages with strict permissions, device-local author identity, dual-signed bounded key rotation, explicit fingerprint trust, fail-closed local signer/chain blocking, version/signer-continuity update review, automatic dependency-aware authoring, an installed-package catalog, dependency-safe uninstall and no arbitrary JavaScript.
- Durable order/fill/position/run lifecycle plus tested future private-stream, reconciliation and
  execution-authority foundations that are unreachable from the current production runtime.
- Professional multi-chart workspaces, pane/scales, drawing management, accessible tables and responsive monitoring.
- Per-pane IANA time-zone axes with DST-safe chart labels and versioned workspace/session persistence.
- Scoped session security, encrypted keys, audit logs, verified backup/restore and fail-closed demo mode.
- EN/RU/KK coverage for core stable UI journeys and operator guides, with exact developer contracts canonical in English; public Pages, release artifacts, SBOM, checksums and attestations.
- Enforced TypeScript, Biome, docs, architecture, unit/integration, build, performance and Playwright gates.
- Blank-screen-safe startup with a localized pre-React fallback, global React recovery boundary and data-preserving stale-shell refresh.
- Attested release archives with per-file manifests and an enforced controlled-corruption/atomic-rollback drill plus EN/RU/KK incident runbooks.
- Optional offline Strategy Studio bundle with explicit install/remove controls and safe installed-app Chart/Strategy shortcuts.
- Reviewed installed-PWA file opening and file-only Share Target for exact Pine, strategy and plugin
  formats, with bounded temporary local storage and cross-browser manual fallbacks.
- Nine operator-allowlisted venues in the generic read-only continuous module, exposed through
  dynamic browser venue/source filters. dYdX Indexer books remain non-canonical sequence-observed
  research, while KuCoin and MEXC use bounded connected public protocol paths; none adds private
  execution or mainnet readiness.

## Explicitly deferred external validation

| Item | Why deferred | Required before claim |
| --- | --- | --- |
| Continuous 7–14-day Binance/Bybit testnet soak | Requires funded accounts and protected external credentials | Reconnect, fills, protection and recovery evidence over the full window |
| Mainnet readiness | Requires the soak plus controlled real-account operational review | Signed operator evidence and removal of every Experimental warning only after approval |

These are not silently marked complete. The funded soak is excluded from the active scanner ledger,
while its remaining repository-connected work continues independently.

## P3 product opportunities

| Epic | Outcome | Relative effort |
| --- | --- | --- |
| Public venue expansion | Finish dedicated browser diagnostics for the nine registered continuous venues, accumulate repeated scheduled canary evidence and obtain a successful Kraken artifact from an eligible network, then add reviewed Crypto.com, BitMEX, Bitfinex, Gemini and Bitstamp public scopes; dYdX still needs an owned-node finality/reorg gate, while private execution remains a separate review | L–XL |
| Order-book and derivatives data | Depth, tape, funding, open interest and licensed advanced feeds | L–XL |
| Plugin capability expansion | Additional reviewed declarative extension points beyond editable indicator/strategy packages | L–XL |
| Moderated community registry | Signed indicator/strategy discovery, publisher verification, compromise revocation and supply-chain policy beyond local dual-signed rotation | XL |
| Optional encrypted sync | User-controlled cross-device strategies and workspace synchronization | XL |
| Hosted read-only demo | Public deployment of the existing non-mutating demo mode | M, infrastructure |
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
