# Documentation status

Last full repository documentation audit: **2026-07-14**
Application version reviewed: `0.1.0` in the current `main` worktree

This register prevents documentation from silently drifting away from the application. “Verified”
means local links and documented npm commands pass `npm run docs:check`, generated references match
their source contracts, and user-facing claims were compared with the current implementation.

## Canonical engineering and reference documents

| Document | Audience | Status | Last verified |
| --- | --- | --- | --- |
| [README](../README.md) | users/contributors | current | 2026-07-14 |
| [Architecture](ARCHITECTURE.md) | contributors | current | 2026-07-14 |
| [Modular architecture](MODULAR_ARCHITECTURE.md) | contributors | current | 2026-07-11 |
| [API reference](API.md) | integrators | current, hand-maintained | 2026-07-14 |
| [Generated endpoint index](API_ENDPOINTS.generated.md) | integrators | generated/current | 2026-07-14 |
| [Machine-readable capability truths](CAPABILITY_TRUTHS.json) | maintainers/release reviewers | source-backed semantic guard for scanner modes, public/continuous venues and generated endpoint totals | 2026-07-14 |
| [Public arbitrage SDK](../packages/arbitrage-sdk/README.md) | integrators/SDK users | current; public/read-only | 2026-07-14 |
| [Strategy and backtest guide](STRATEGIES.md) | users/contributors | current | 2026-07-11 |
| [Declarative plugin contract](PLUGINS.md) | users/plugin authors | current foundation | 2026-07-12 |
| [Trading guide](TRADING.md) | users/operators | current; Binance spot disabled, Bybit spot experimental | 2026-07-14 |
| [Configuration](CONFIGURATION.md) | operators | current | 2026-07-14 |
| [Backup and restore](BACKUP_RESTORE.md) | operators | current; tested | 2026-07-11 |
| [Pine coverage](PINE_COVERAGE.md) | users/contributors | current | 2026-07-11 |
| [Exchange capabilities](EXCHANGE_CAPABILITIES.md) | operators/users | current; live remains experimental | 2026-07-14 |
| [Generated Pine matrix](PINE_COMPATIBILITY.generated.md) | users/contributors | generated/current | 2026-07-11 |
| [Generated block catalog](BLOCK_CATALOG.generated.md) | users/contributors | generated/current | 2026-07-11 |
| [Event traces](EVENT_TRACES.md) | contributors/auditors | current | 2026-07-11 |
| [Testing strategy](TESTING_STRATEGY.md) | contributors | current | 2026-07-11 |
| [Release verification](RELEASING.md) | maintainers/users | current | 2026-07-11 |
| [Threat model](THREAT_MODEL.md) | operators/contributors | current alpha baseline | 2026-07-14 |
| [Roadmap](ROADMAP.md) | community | current | 2026-07-12 |
| [Implementation status](IMPLEMENTATION_STATUS.md) | maintainers | current ledger | 2026-07-14 |
| [Master improvement plan](MASTER_IMPROVEMENT_PLAN.md) | maintainers/community | current backlog | 2026-07-11 |
| [I18n and documentation](I18N_AND_DOCUMENTATION.md) | contributors | updated for EN/RU/KK | 2026-07-11 |
| [Accessibility baseline](ACCESSIBILITY.md) | users/contributors | current alpha baseline | 2026-07-12 |
| [Contributor map](CONTRIBUTOR_MAP.md) | contributors | current | 2026-07-11 |
| [Asset provenance policy](ASSET_POLICY.md) | contributors | current | 2026-07-11 |
| [Migration notes](MIGRATIONS.md) | operators/contributors | current | 2026-07-14 |
| [Application startup recovery](STARTUP_RECOVERY.md) | users/operators | current; production-build browser-tested | 2026-07-13 |
| [Distribution incident response](INCIDENT_RESPONSE.md) | operators/maintainers | current; drill-tested | 2026-07-13 |
| [Offline local research](OFFLINE_RESEARCH.md) | users/operators | current; production-build browser-tested | 2026-07-13 |
| [PWA file opening and sharing](PWA_FILE_HANDLING.md) | users/contributors | current; production-build browser-tested | 2026-07-13 |
| [Cross-exchange arbitrage screener](ARBITRAGE_SCREENER.md) | users/contributors | current; read-only L2 verification, funding scenarios, fork guide and fail-closed continuous entry value/basis evidence | 2026-07-14 |
| [Protected account economics telemetry](ACCOUNT_TELEMETRY.md) | operators/contributors | current; admin-session read-only, non-executable | 2026-07-14 |
| [Arbitrage taxonomy](ARBITRAGE_TAXONOMY.md) | product/users/contributors | canonical vocabulary; current/planned separated | 2026-07-14 |
| [Research arbitrage alerts](RESEARCH_ALERTS.md) | operators/contributors | current protected UI/runtime; engine producers pending | 2026-07-14 |
| [Arbitrage math and assumptions](ARBITRAGE_MATH_AND_ASSUMPTIONS.md) | users/quant contributors | canonical calculation boundary | 2026-07-14 |
| [Arbitrage market-data quality](MARKET_DATA_QUALITY.md) | adapter authors/operators | canonical current/target quality policy | 2026-07-14 |
| [Venue capability matrix](VENUE_CAPABILITIES.md) | users/operators/contributors | current; nine generic continuous venues separated from private/regional eligibility | 2026-07-14 |
| [Network identity](NETWORK_IDENTITY.md) | adapter authors/operators | current pure fail-closed registry/proof boundary; synthetic only and not runtime-wired | 2026-07-14 |
| [Exchange adapter contract](EXCHANGE_ADAPTER_CONTRACT.md) | adapter authors | target contract; not a support claim | 2026-07-14 |
| [Arbitrage verification matrix](ARBITRAGE_TEST_MATRIX.md) | contributors/release reviewers | current evidence + P0–P2 gates | 2026-07-14 |
| [OKX public adapter](OKX_PUBLIC_ADAPTER.md) | adapter authors/users | current read-only scope | 2026-07-14 |
| [Gate public adapter](GATE_PUBLIC_ADAPTER.md) | adapter authors/users | current read-only scope | 2026-07-14 |
| [Hyperliquid public adapter](HYPERLIQUID_PUBLIC_ADAPTER.md) | adapter authors/users | current read-only scope | 2026-07-14 |
| [Deribit/options research](DERIBIT_OPTIONS_RESEARCH.md) | quant/adapter contributors | current non-executable research scope | 2026-07-14 |
| [dYdX public and chain-aware data](DYDX_PUBLIC_ADAPTER.md) | adapter authors/users | current shared-facade plus generic continuous Indexer WS; non-canonical research-only | 2026-07-14 |
| [Kraken/Coinbase public adapters](KRAKEN_COINBASE_PUBLIC_ADAPTERS.md) | adapter authors/users | current public + selected continuous scope | 2026-07-14 |
| [KuCoin/MEXC public adapters](KUCOIN_MEXC_PUBLIC_ADAPTERS.md) | adapter authors/users | current shared REST facade plus bounded continuous socket/factory/hub paths | 2026-07-14 |
| [P0/P1/P2 execution ledger](P0_P1_P2_EXECUTION_PLAN.md) | maintainers/release reviewers | active requirement-by-requirement completion contract | 2026-07-14 |

Planning and audit documents describe research or target architecture rather than shipped behavior.
They must be read together with `IMPLEMENTATION_STATUS.md` and must not be presented as release notes.

## Language coverage

| User journey | English | Russian | Kazakh |
| --- | --- | --- | --- |
| Project overview / quick start | [README](../README.md) | [README](../README.ru.md) | [README](../README.kk.md) |
| Chart and accessible data | canonical source docs | [guide](ru/CHART.md) | [guide](kk/CHART.md) |
| Strategy Studio / Pine / backtest | [strategy reference](STRATEGIES.md) | [guide](ru/STRATEGY_STUDIO.md) | [guide](kk/STRATEGY_STUDIO.md) |
| Declarative plugin import | [plugin contract](PLUGINS.md) | [guide](ru/PLUGINS.md) | [guide](kk/PLUGINS.md) |
| Paper/live trading | [trading reference](TRADING.md) | [guide](ru/TRADING.md) | [guide](kk/TRADING.md) |
| Event/execution traces | [reference](EVENT_TRACES.md) | [guide](ru/EVENT_TRACES.md) | [guide](kk/EVENT_TRACES.md) |
| Safety summary | [security policy](../SECURITY.md) | [summary](ru/SECURITY.md) | [summary](kk/SECURITY.md) |
| Backup and recovery | [operator guide](BACKUP_RESTORE.md) | [guide](ru/BACKUP_RESTORE.md) | [guide](kk/BACKUP_RESTORE.md) |
| Application startup recovery | [guide](STARTUP_RECOVERY.md) | [guide](ru/STARTUP_RECOVERY.md) | [guide](kk/STARTUP_RECOVERY.md) |
| Distribution incident response | [runbook](INCIDENT_RESPONSE.md) | [runbook](ru/INCIDENT_RESPONSE.md) | [runbook](kk/INCIDENT_RESPONSE.md) |
| Offline local research | [guide](OFFLINE_RESEARCH.md) | [guide](ru/OFFLINE_RESEARCH.md) | [guide](kk/OFFLINE_RESEARCH.md) |
| PWA file opening and sharing | [guide](PWA_FILE_HANDLING.md) | [guide](ru/PWA_FILE_HANDLING.md) | [guide](kk/PWA_FILE_HANDLING.md) |
| Cross-exchange screener, triangular L2, funding curve, fork guide and continuous entry value/basis | [guide](ARBITRAGE_SCREENER.md) | [guide](ru/ARBITRAGE_SCREENER.md) | [guide](kk/ARBITRAGE_SCREENER.md) |
| Account economics telemetry | [guide](ACCOUNT_TELEMETRY.md) | [guide](ru/ACCOUNT_TELEMETRY.md) | [guide](kk/ACCOUNT_TELEMETRY.md) |
| Arbitrage fork taxonomy | [canonical reference](ARBITRAGE_TAXONOMY.md) | [guide](ru/ARBITRAGE_TAXONOMY.md) | [guide](kk/ARBITRAGE_TAXONOMY.md) |
| Research arbitrage alerts | [reference](RESEARCH_ALERTS.md) | [guide](ru/RESEARCH_ALERTS.md) | [guide](kk/RESEARCH_ALERTS.md) |
| Venue capability/expansion matrix | [reference](VENUE_CAPABILITIES.md) | [guide](ru/VENUE_CAPABILITIES.md) | [guide](kk/VENUE_CAPABILITIES.md) |
| Network identity and transfer proof | [reference](NETWORK_IDENTITY.md) | [guide](ru/NETWORK_IDENTITY.md) | [guide](kk/NETWORK_IDENTITY.md) |
| OKX public adapter | [reference](OKX_PUBLIC_ADAPTER.md) | [guide](ru/OKX_PUBLIC_ADAPTER.md) | [guide](kk/OKX_PUBLIC_ADAPTER.md) |
| Gate public adapter | [reference](GATE_PUBLIC_ADAPTER.md) | [guide](ru/GATE_PUBLIC_ADAPTER.md) | [guide](kk/GATE_PUBLIC_ADAPTER.md) |
| Hyperliquid public adapter | [reference](HYPERLIQUID_PUBLIC_ADAPTER.md) | [guide](ru/HYPERLIQUID_PUBLIC_ADAPTER.md) | [guide](kk/HYPERLIQUID_PUBLIC_ADAPTER.md) |
| Deribit/options research | [reference](DERIBIT_OPTIONS_RESEARCH.md) | [guide](ru/DERIBIT_OPTIONS_RESEARCH.md) | [guide](kk/DERIBIT_OPTIONS_RESEARCH.md) |
| dYdX public and chain-aware data | [reference](DYDX_PUBLIC_ADAPTER.md) | [guide](ru/DYDX_PUBLIC_ADAPTER.md) | [guide](kk/DYDX_PUBLIC_ADAPTER.md) |
| Kraken/Coinbase public adapters | [reference](KRAKEN_COINBASE_PUBLIC_ADAPTERS.md) | [guide](ru/KRAKEN_COINBASE_PUBLIC_ADAPTERS.md) | [guide](kk/KRAKEN_COINBASE_PUBLIC_ADAPTERS.md) |
| KuCoin/MEXC public adapters | [reference](KUCOIN_MEXC_PUBLIC_ADAPTERS.md) | [guide](ru/KUCOIN_MEXC_PUBLIC_ADAPTERS.md) | [guide](kk/KUCOIN_MEXC_PUBLIC_ADAPTERS.md) |
| Arbitrage vocabulary, venue status and engineering contracts | canonical English documents linked from localized indexes | overview links | overview links |
| 90-commit update | [changelog](../CHANGELOG.md) | [release notes](ru/RELEASE_2026-07-11.md) | [release notes](kk/RELEASE_2026-07-11.md) |

Core navigation and the stable user journeys listed above have EN/RU/KK guidance and localized UI
catalogs. This is workflow-level coverage, not a claim that every developer reference, exchange/API
message or experimental technical label has a word-for-word translation. The production browser suite
verifies Russian and Kazakh switching/persistence and critical localized journeys.

English remains canonical for exact API schemas, quantitative assumptions and developer internals.
Generated reference tables are not copied by hand into translations; localized guides summarize the
operator workflow and link to the single canonical source for exact contracts.

## Verification commands

```bash
npm run docs:check
npm run docs:generate:check
npm run check
npm run lint
```

Any change to routes, blocks, Pine support, commands, security controls or user-visible workflows
must update the corresponding document and this register in the same pull request.

`npm run docs:semantic:check` is intentionally narrow: it imports the rendered scanner-mode
definitions, public adapter registry and continuous protocol allowlist, probes every continuous
factory branch without opening a socket, and compares them with `CAPABILITY_TRUTHS.json`. It also
locks the two canonical venue rows and the canonical scanner-mode sentence to that contract. Full route
presence remains owned by the generated endpoint check; the semantic stage verifies its published
totals rather than implementing a second route parser.
