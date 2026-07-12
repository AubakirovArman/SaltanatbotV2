# Documentation status

Last full repository documentation audit: **2026-07-12**
Application version reviewed: `0.1.0` in the current `main` worktree

This register prevents documentation from silently drifting away from the application. “Verified”
means local links and documented npm commands pass `npm run docs:check`, generated references match
their source contracts, and user-facing claims were compared with the current implementation.

## Canonical engineering and reference documents

| Document | Audience | Status | Last verified |
| --- | --- | --- | --- |
| [README](../README.md) | users/contributors | current | 2026-07-12 |
| [Architecture](ARCHITECTURE.md) | contributors | current | 2026-07-11 |
| [Modular architecture](MODULAR_ARCHITECTURE.md) | contributors | current | 2026-07-11 |
| [API reference](API.md) | integrators | current, hand-maintained | 2026-07-11 |
| [Generated endpoint index](API_ENDPOINTS.generated.md) | integrators | generated/current | 2026-07-11 |
| [Strategy and backtest guide](STRATEGIES.md) | users/contributors | current | 2026-07-11 |
| [Trading guide](TRADING.md) | users/operators | current; live is experimental | 2026-07-11 |
| [Configuration](CONFIGURATION.md) | operators | current | 2026-07-11 |
| [Backup and restore](BACKUP_RESTORE.md) | operators | current; tested | 2026-07-11 |
| [Pine coverage](PINE_COVERAGE.md) | users/contributors | current | 2026-07-11 |
| [Exchange capabilities](EXCHANGE_CAPABILITIES.md) | operators/users | current | 2026-07-11 |
| [Generated Pine matrix](PINE_COMPATIBILITY.generated.md) | users/contributors | generated/current | 2026-07-11 |
| [Generated block catalog](BLOCK_CATALOG.generated.md) | users/contributors | generated/current | 2026-07-11 |
| [Event traces](EVENT_TRACES.md) | contributors/auditors | current | 2026-07-11 |
| [Testing strategy](TESTING_STRATEGY.md) | contributors | current | 2026-07-11 |
| [Release verification](RELEASING.md) | maintainers/users | current | 2026-07-11 |
| [Threat model](THREAT_MODEL.md) | operators/contributors | current alpha baseline | 2026-07-11 |
| [Roadmap](ROADMAP.md) | community | current | 2026-07-11 |
| [Implementation status](IMPLEMENTATION_STATUS.md) | maintainers | current ledger | 2026-07-11 |
| [Master improvement plan](MASTER_IMPROVEMENT_PLAN.md) | maintainers/community | current backlog | 2026-07-11 |
| [I18n and documentation](I18N_AND_DOCUMENTATION.md) | contributors | updated for EN/RU/KK | 2026-07-11 |
| [Accessibility baseline](ACCESSIBILITY.md) | users/contributors | current alpha baseline | 2026-07-11 |
| [Contributor map](CONTRIBUTOR_MAP.md) | contributors | current | 2026-07-11 |
| [Asset provenance policy](ASSET_POLICY.md) | contributors | current | 2026-07-11 |
| [Migration notes](MIGRATIONS.md) | operators/contributors | current | 2026-07-11 |

Planning and audit documents describe research or target architecture rather than shipped behavior.
They must be read together with `IMPLEMENTATION_STATUS.md` and must not be presented as release notes.

## Language coverage

| User journey | English | Russian | Kazakh |
| --- | --- | --- | --- |
| Project overview / quick start | [README](../README.md) | [README](../README.ru.md) | [README](../README.kk.md) |
| Chart and accessible data | canonical source docs | [guide](ru/CHART.md) | [guide](kk/CHART.md) |
| Strategy Studio / Pine / backtest | [strategy reference](STRATEGIES.md) | [guide](ru/STRATEGY_STUDIO.md) | [guide](kk/STRATEGY_STUDIO.md) |
| Paper/live trading | [trading reference](TRADING.md) | [guide](ru/TRADING.md) | [guide](kk/TRADING.md) |
| Event/execution traces | [reference](EVENT_TRACES.md) | [guide](ru/EVENT_TRACES.md) | [guide](kk/EVENT_TRACES.md) |
| Safety summary | [security policy](../SECURITY.md) | [summary](ru/SECURITY.md) | [summary](kk/SECURITY.md) |
| Backup and recovery | [operator guide](BACKUP_RESTORE.md) | [guide](ru/BACKUP_RESTORE.md) | [guide](kk/BACKUP_RESTORE.md) |
| 90-commit update | [changelog](../CHANGELOG.md) | [release notes](ru/RELEASE_2026-07-11.md) | [release notes](kk/RELEASE_2026-07-11.md) |

The complete runtime UI follows the same EN/RU/KK coverage. Locale catalogs are typed against one
canonical key set; the production browser suite verifies Russian and Kazakh switching/persistence.

English remains canonical for exact API schemas and developer internals. Generated reference tables
are not copied by hand into translations; localized guides link to the single generated source.

## Verification commands

```bash
npm run docs:check
npm run docs:generate:check
npm run check
npm run lint
```

Any change to routes, blocks, Pine support, commands, security controls or user-visible workflows
must update the corresponding document and this register in the same pull request.
