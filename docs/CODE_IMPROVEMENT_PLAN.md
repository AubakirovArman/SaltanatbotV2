# План улучшения кода: фактическое закрытие P0–P2

Дата первоначального аудита: 2026-07-10
Последняя проверка: 2026-07-11
Статус: P0, P1 и P2 реализованы и проверяются обязательными gates.

Единственное исключение — **Mainnet readiness и непрерывный 7–14-дневный funded soak Binance/Bybit**.
Владелец проекта явно отложил этот внешний прогон. Live trading остаётся Experimental, и документы
или интерфейс не должны утверждать, что mainnet-готовность доказана.

## Итог

Проект имеет проверяемую alpha-базу: один и тот же Strategy IR используется в preview, backtest,
paper и live evaluator; торговые намерения и результаты журналируются; неоднозначные исходы fail
closed; состояние восстанавливается после перезапуска; крупные фасады разделены на модули; P2
пользовательские сценарии, доступность, документация и open-source release pipeline реализованы.

## P0.1 — полный MarketKey во всех trading data flows

Статус: **выполнено**.

- Канонический `MarketKey` содержит venue, market type, symbol, timeframe и price type.
- `TradingEngine` строит route из конфигурации бота и не использует неявный Binance/spot default.
- Строгий `subscribeMarket()` выдаёт каждую execution-свечу в envelope с полным `MarketKey`.
- Bybit futures направляется в Bybit linear feed; live запрещает synthetic fallback.
- Неполный execution route отклоняется до подписки.

Доказательства: `marketProviders.test.ts`, `engineLifecycle.e2e.test.ts`, runtime contract tests.

## P0.2 — подтверждённая exchange-side защита

Статус: **выполнено в доступном offline/test-fixture scope**.

- Журнал моделирует `entry_submitted`, `entry_confirmed`, `protection_submitted`,
  `protection_confirmed`, `open_protected`, `open_unprotected`, `exiting`, `error`.
- Binance возвращает ID entry, SL и TP; цепочка сохраняется в lifecycle result event.
- Bybit сохраняет ID entry и подтверждение position-level `trading-stop`; endpoint Bybit не возвращает
  отдельные SL/TP IDs, поэтому используется явный тип доказательства `exchange_ack`.
- Отклонение SL/TP приводит к best-effort emergency close и ошибке; automation не получает
  `open_protected`.
- После рестарта открытая futures-позиция без видимой защиты требует ручного действия.

Доказательства: `binanceProtection.test.ts`, `bybitProtection.test.ts`, `orderLifecycle.test.ts`,
`reconciliation.test.ts`.

## P0.3 — per-bot actor и idempotency

Статус: **выполнено**.

- Все market/order события одного бота проходят через последовательную очередь.
- `lastEvaluatedBarTime` устраняет повторную оценку закрытого бара.
- `orderInFlight` не допускает параллельные entry/exit.
- `clientOrderId` записывается до exchange I/O; timeout становится `unknown`, а не повторной отправкой.
- Startup reconciliation сначала ищет результат по exchange/client identity; недоказанный исход
  переводит runtime в `requires_manual_action`.

Доказательства: `engineLifecycle.e2e.test.ts`, `orderLifecycle.test.ts`,
`startupOrderReconciliation.test.ts`, failure-injection tests.

## P0.4 — bot-attributed spot inventory

Статус: **выполнено**.

- Подтверждённые fills формируют durable quantity, weighted average, fees по asset и remaining qty.
- Повторный execution ID не меняет inventory второй раз.
- Engine и manual bot-close заменяют `closePct` на attributed quantity.
- Отсутствие inventory отклоняет close и ставит automation на паузу вместо продажи account balance.
- После restart inventory восстанавливается, но требуется ручная сверка биржевого баланса.
- Live spot требует явного feature flag и встроенную версию inventory model 1.

Доказательства: `spotInventoryModel.test.ts`, `spotInventory.test.ts`, lifecycle/reconnect tests. Сценарий
«бот купил 0.25 BTC при account balance 2 BTC» отправляет только 0.25 BTC до exchange rounding.

Низкоуровневый adapter `closePct` сохранён только для совместимости raw manual API; engine bot-close
не использует account-wide ветку.

## P0.5 — durable journal и реальный PnL

Статус: **выполнено**.

- Transactional schema v2 содержит `orders`, `order_events`, `fills`, `positions`, `strategy_runs`.
- Bot status transitions создают и закрывают ровно один активный strategy run.
- Runtime persistence обновляет durable position snapshot, включая manual-action state.
- Private Binance/Bybit streams и REST polling сохраняют partial fills, execution ID, fee amount,
  fee asset и venue realized PnL.
- Повторные executions дедуплицируются до accounting write.
- Daily-loss guard считает только durable confirmed fills.
- Backup/restore проверяет SQLite, SHA-256 manifest и rollback-safe atomic swap; forward migrations
  транзакционны и не удаляют legacy rows.

Доказательства: `storeSchema.test.ts`, `storeLifecycle.test.ts`, `privateOrderStreams.test.ts`,
`executionAccounting.test.ts`, `orderEventIngest.test.ts`, `runtimeDataBackup.test.ts`.

## P0.6 — startup reconciliation

Статус: **выполнено**.

- Resume выполняет reconciliation до подписки и до перехода к разрешённой автоматической торговле.
- Последовательно проверяются `intent`, `unknown`, `accepted`, `partially_filled`, exchange position,
  open orders, durable fills и managed state.
- Terminal status восстанавливается по signed order-status; open-order fallback используется только
  когда действительно доказывает исход команды.
- `ENTERING`, partial, interrupted cancel/replace, unprotected position и `EXITING` не продолжаются
  вслепую: неоднозначность сохраняется и требует оператора.
- Spot inventory после restart также всегда проходит ручную balance verification.

Доказательства: `startupOrderReconciliation.test.ts`, `reconciliation.test.ts`,
`engineLifecycle.e2e.test.ts`, private-stream reconnect tests.

## P1 — архитектура и техническая достоверность

Статус: **выполнено**.

- Созданы независимые packages: contracts, strategy-core, execution-core, backtest-core,
  pine-compiler и test-fixtures.
- Pine — version-aware compiler pipeline с budgets, spans, typed diagnostics, compatibility registry,
  golden corpus, fuzz/property tests и честными fidelity категориями.
- Strategy/backtest используют общий evaluator, immutable provenance, gap/fallback detection,
  reference benchmarks, historical order simulator, walk-forward, stability и replay trace.
- Большие Strategy Lab, TradingView, App, ChartCanvas, Blockly blocks/compiler и TradingEngine
  разделены на feature/domain modules с совместимыми фасадами.
- CI запрещает source-файлы больше 600 строк без конкретного reviewed exception. Четыре цельных
  pure-domain алгоритма имеют узкие лимиты в `config/source-file-budgets.json`; любое увеличение
  требует явного архитектурного изменения.

## P2 — пользовательский продукт и open source

Статус: **выполнено**.

- Профессиональные 1/2/4-chart workspaces, связанные symbol/timeframe/crosshair, panes/scales,
  drawing tree/templates/undo, replay, data status, virtual watchlist и custom shortcuts.
- Strategy Studio разделяет Build/Validate/Preview/Backtest/Optimize/Run/Learn; имеет inspector,
  wizard, linked diagnostics, bounded functions, version history, dependency graph, diff/rollback и
  checksum-verified share files.
- Keyboard-only flow, modal focus, reduced motion, 200% text, semantic chart tables и automated axe
  WCAG A/AA входят в browser gate.
- UI и пользовательская документация полностью локализованы на EN/RU/KK; каталоги разделены по
  языкам и проверяются TypeScript на полное совпадение ключей.
- Security policy, Code of Conduct, issue/PR templates, threat model, contributor map, asset policy,
  demo-mode, changelog, Pages site, release notes, SBOM, checksums и attestations опубликованы.

## Обязательные release invariants

Локальные и CI-тесты доказывают:

1. Один бар не создаёт два одинаковых order intent.
2. Bybit-бот не принимает Binance market route.
3. Позиция не считается защищённой без подтверждения exchange stop.
4. После restart неоднозначное local/exchange состояние не получает право торговать.
5. Daily-loss limit считается по подтверждённым fills.
6. Timeout submission не вызывает слепой повторный order.
7. Partial fill корректно меняет qty, fee и PnL.
8. Spot close 100% ограничен bot-attributed объёмом.
9. Preview/backtest/paper/live evaluator trace имеет единые семантики.
10. Research run воспроизводится по versioned manifest и fingerprints.

## Что не считается выполненным

- 7–14-дневный непрерывный Binance/Bybit testnet soak;
- mainnet readiness и production-ready live claim;
- ручная проверка реальными деньгами.

Эти пункты требуют внешних средств и отдельно отложены владельцем. Они не блокируют закрытие
репозиторных P0/P1/P2 работ, но блокируют снятие Experimental label с live trading.

Дальнейшие продуктовые возможности находятся в [ROADMAP.md](./ROADMAP.md).
