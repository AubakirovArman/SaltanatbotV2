# Contributor map

This map routes a change to the correct boundary, tests and documentation. It describes domains,
not personal ownership; maintainers can add CODEOWNERS when a stable reviewer group exists.

| Domain | Primary source | Contract/facade | Required evidence | User documentation |
| --- | --- | --- | --- | --- |
| Chart/rendering | `frontend/src/chart`, `frontend/src/components/ChartCanvas.tsx` | `ChartEngine`, renderer plan and chart types | viewport, render-layer, hit-test, semantic-table and browser tests | `docs/ru/CHART.md`, `docs/kk/CHART.md` |
| Pine compiler | `packages/pine-compiler/src` | package `index.ts`, frontend Pine facade | corpus, snapshots, fuzz/property, source-map and compatibility generation | `docs/PINE_COVERAGE.md`, generated matrix |
| Strategy core | `packages/strategy-core` | generated runtime/declarations | evaluator/TA/parity/golden trace tests | `docs/STRATEGIES.md` and localized Studio guides |
| Research/backtest | `packages/backtest-core`, `frontend/src/strategy/backtest` | browser facade `backtest.ts` | benchmark, accounting, provenance, report and replay tests | `docs/STRATEGIES.md` |
| Market providers | `backend/src/providers`, frontend market hooks | `packages/contracts` REST/WS schemas | provider/router/fallback/reconnect contract tests | `docs/API.md`, chart guides |
| Execution | `backend/src/trading`, `packages/execution-core` | exchange ports, durable lifecycle and store | fake-exchange, failure injection, reconciliation and migration tests | `docs/TRADING.md`, capability matrix |
| Security/operations | auth, runtime data and workflows | configuration and release contracts | auth/CSRF, secret scan, backup/restore, package verification | `SECURITY.md`, threat model, operations guides |

Start with the nearest source-folder `README.md`. Cross-domain changes require reviewers/evidence from
every affected row; execution semantics must remain identical across preview, backtest, paper and live.
