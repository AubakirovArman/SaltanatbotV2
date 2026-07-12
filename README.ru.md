<div align="center">

[English](README.md) · **Русский** · [Қазақша](README.kk.md)

<img src="assets/logo.svg" alt="Логотип SaltanatbotV2" width="140" height="140" />

# SaltanatbotV2 🐘

**Бесплатный open-source торговый терминал с локальным хранением данных.**

Графики в реальном времени · визуальный конструктор · импорт Pine Script · backtest · paper/live trading

</div>

## О проекте

SaltanatbotV2 — ранняя alpha-версия самостоятельной альтернативы TradingView для исследования и автоматизации торговых идей. Приложение запускается на компьютере пользователя: ключи, стратегии, история и настройки не отправляются в облачный сервис проекта.

Основные возможности:

- собственный Canvas-график со свечами, Heikin-Ashi, барами, линиями, area, baseline, стабильными Renko, Three Line Break, Kagi и Point & Figure, а также VPVR, тепловой картой стакана, живым trade footprint/CVD и подсветкой imbalance/возможного absorption;
- локально сохраняемые настройки размера Renko/P&F-клетки, процента разворота Kagi, глубины Line Break и числа P&F-клеток разворота с полным согласованным пересчётом Canvas, индикаторов и доступной OHLC-таблицы;
- быстрая линейка `Shift + перетаскивание` показывает изменение цены, проценты, число свечей и время, не добавляя временный результат в сохранённые рисунки;
- компоновки из одного, двух или четырёх графиков независимо связывают символ, интервал, перекрестие и видимый UTC-диапазон, сохраняя zoom/pan синхронными даже для разных рынков;
- локально сохраняемые flow-алерты для stacked imbalance, возможного absorption, всплесков CVD и крупных принтов со звуком и системными уведомлениями по желанию;
- Binance и Bybit market data с REST-историей и WebSocket-обновлениями;
- визуальный Blockly-конструктор индикаторов и стратегий;
- импорт поддерживаемого подмножества Pine Script v4–v6 в редактируемые блоки;
- безопасный JSON IR без `eval` и выполнения пользовательского JavaScript;
- backtest с `next_open`, комиссиями, slippage, funding, gap-aware stop/target и liquidation;
- optimizer, walk-forward и Monte Carlo;
- paper trading и экспериментальные Binance/Bybit live adapters;
- локальная SQLite, шифрование API-ключей и журнал действий.

> Импорт Pine пока не означает полную совместимость с TradingView. Приложение показывает ошибки и предупреждения об аппроксимациях. Результат необходимо проверять на графике и в paper-режиме.

> Live trading является экспериментальным. Начинайте с paper/testnet, используйте ключи без права вывода средств и собственные лимиты риска.

## Быстрый старт

Требуется Node.js 24+.

```bash
npm install
npm run dev
```

В режиме разработки:

- frontend: `http://localhost:4180`;
- backend/API: `http://localhost:4181`.

Production-сборка:

```bash
npm run build
npm start
```

По умолчанию production backend доступен только на `127.0.0.1:4180`. Для внешнего доступа используйте TLS reverse proxy и firewall.

## Проверки

```bash
npm run check       # TypeScript
npm run lint        # Biome
npm test            # unit/integration/parity
npm run test:e2e    # Playwright + production build
npm run build
```

## Документация

- [Русский индекс документации](docs/ru/README.md)
- [Публичная страница проекта](https://aubakirovarman.github.io/SaltanatbotV2/)
- [Архитектура](docs/ARCHITECTURE.md)
- [Стратегии и backtest](docs/STRATEGIES.md)
- [Сгенерированная матрица совместимости Pine](docs/PINE_COMPATIBILITY.generated.md)
- [Trading](docs/TRADING.md)
- [Конфигурация и безопасность](docs/CONFIGURATION.md)
- [Резервное копирование и восстановление](docs/ru/BACKUP_RESTORE.md)
- [Общий план развития](docs/MASTER_IMPROVEMENT_PLAN.md)
- [Целевая модульная архитектура](docs/MODULAR_ARCHITECTURE.md)
- [Стратегия тестирования](docs/TESTING_STRATEGY.md)
- [Локализация и документация](docs/I18N_AND_DOCUMENTATION.md)
- [Политика безопасности](SECURITY.md)
- [Краткая политика безопасности на русском](docs/ru/SECURITY.md)
- [Поддержка](SUPPORT.md)
- [Кодекс поведения](CODE_OF_CONDUCT.md)
- [История изменений](CHANGELOG.md)
- [Обновление за 90 коммитов](docs/ru/RELEASE_2026-07-11.md)
- [Реестр актуальности документации](docs/DOCUMENTATION_STATUS.md)

Полный перевод технической документации выполняется поэтапно. Английские документы пока являются каноническими.

## Безопасность

- Никогда не публикуйте `backend/data/`, `.env`, API-ключи и access token.
- Используйте API-ключи без разрешения на вывод средств.
- Для внешнего доступа обязательны HTTPS, firewall и сильный `AUTH_TOKEN`.
- Paper mode включён по умолчанию; live требует нескольких явных подтверждений.

## Лицензия

MIT. Проект предназначен для исследований и обучения и не является финансовой рекомендацией.
