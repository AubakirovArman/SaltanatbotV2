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

## Accepted R5.1 release

The accepted R5.1 release was deployed on PostgreSQL schema 13 from
protected slot `r5a-schema13-66394fd` (commit
`66394fd38765d8da36174411cecd95a33fda1ea0`, exact-SHA CI run `29574600648`,
`6/6`). R5.1 is accepted and deployed, but it remains notification-only and is
still not proven as a 100-user service.

The release adds generic owner-scoped `price-threshold` alerts over public
Binance/Bybit last-price closed candles with durable in-app history. It is
notification-only and cannot trade, borrow, change margin, read exchange
credentials or grant trading authority. Its conservative beta bounds are 100
active and 200 non-archived rules per owner, 400 total retained rule/history
rows per owner and 480 globally active rules. The scheduler performs at most
four public reads concurrently, 16 unique reads per sweep and eight per
provider; evaluation receipts retain for 2 days and event/outbox/archive history
for 30 days.

Acceptance passed the checksum-locked upgrade/recovery gate, owner-forward
cursor and intentional at-least-once UI behavior, same-owner multi-tab
convergence, browser-storage failure handling and desktop/mobile
accessibility/visual evidence; see the recorded
[R5.1 acceptance evidence](./evidence/R5_1_OWNER_ALERTS.md). This generic
price-alert control plane is not the older account-aware arbitrage
research-alert policy/outbox: its engine-owned candidate/economics producers
remain disconnected. The R5.2.1 technical screener MVP and the R5.3a
screener alert promotion are now accepted and deployed (see below); the
R5.3b notification worker/Telegram delivery and R11 integrated 100-user
capacity proof remain pending and unproven.

See [Owner-scoped server alerts](./ALERTS.md),
[Russian](./ru/ALERTS.md), [Kazakh](./kk/ALERTS.md) and the detailed
[pre-HTTPS release order](./PRE_HTTPS_ROADMAP.md).

## Accepted R5.2.1 release

The accepted R5.2.1 technical screener MVP was deployed on PostgreSQL
schema 14 from protected slot `r5b-schema14-20be5b1` (commit
`20be5b1d2fb87df38cc298953dfe7a2f414dd831`, exact-SHA CI run `29584556266`,
`6/6`). R5.2.1 is accepted and deployed, but it remains research-only and is
still not proven as a 100-user service.

The release adds an on-demand indicator screener over the public Binance spot
USDT universe: owner-scoped server presets with revisions and archive, runs
executed as bounded compute jobs, closed-candle-only evaluation with
fail-closed unavailability, deterministic bounded results and click-to-chart
indicator parity. It cannot trade, borrow, change margin, read exchange
credentials or grant trading authority. Its conservative beta bounds are 40
active presets per owner, 400 globally active presets, a universe of at most
200 symbols and the existing five-active compute-job quota per owner; they are
not R11 capacity evidence.

Acceptance passed the checksum-locked schema-14 upgrade/recovery gate and an
end-to-end screener rehearsal on the isolated replacement pair — 30/30 symbols
evaluated, 30 matched, 0 unavailable against live Binance closed candles; see
the recorded
[R5.2.1 acceptance evidence](./evidence/R5_2_1_TECHNICAL_SCREENER.md).
Saved-screen promotion into a server alert is now delivered by the accepted
R5.3a release (see below); the R5.3b notification worker with owner-bound
Telegram delivery, chart research tools and the R11 integrated 100-user
capacity proof remain pending and unproven.

See [On-demand technical screener](./SCREENER.md),
[Russian](./ru/SCREENER.md), [Kazakh](./kk/SCREENER.md) and the detailed
[pre-HTTPS release order](./PRE_HTTPS_ROADMAP.md).

## Accepted R5.3a release

Production now runs the accepted R5.3a screener alert promotion from
protected slot `r5c-schema14-86712ba` (commit
`86712bac3293ac8d746b638218eb66995d8e5edb`, exact-SHA CI run `29590401183`,
`6/6`). The release adds no migration: PostgreSQL schema 14 and trading
SQLite schema 9 are unchanged, and the runtime remains `public-http-paper`.

The release promotes a saved screen into the server alert rule kind
`screener`: the embedded screen re-runs at the timeframe-derived cadence on
closed candles and raises an on-change alert event when the matched symbol
set changes, with unknown carry-over, the 30% availability floor, cooldown
fencing and the 5-per-owner/40-global quotas. Delivery stays in-app only;
`telegram` on a screener rule still answers a clear `400` until R5.3b. It
cannot trade, borrow, change margin, read exchange credentials or grant
trading authority.

Acceptance passed the exact-SHA CI gate and the paired no-migration
backup/recovery drill, and the production journal shows the dedicated
screener-alert worker lane running; see the recorded
[R5.3a acceptance evidence](./evidence/R5_3A_SCREENER_ALERTS.md). The R5.3b
notification worker with owner-bound Telegram binding/commands, chart
research tools and the R11 integrated 100-user capacity proof remain
pending and unproven.

See [Owner-scoped server alerts](./ALERTS.md), [Russian](./ru/ALERTS.md),
[Kazakh](./kk/ALERTS.md) and the detailed
[pre-HTTPS release order](./PRE_HTTPS_ROADMAP.md).

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
