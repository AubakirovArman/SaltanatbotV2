<div align="center">

[English](README.md) · **Русский** · [Қазақша](README.kk.md)

<img src="assets/logo.svg" alt="Логотип SaltanatbotV2" width="140" height="140" />

# SaltanatbotV2 🐘

**Бесплатный open-source терминал для исследований и paper-торговли с локальным хранением данных.**

Графики в реальном времени · визуальный конструктор · импорт Pine Script · backtest · paper-автоматизация

</div>

## О проекте

SaltanatbotV2 — ранняя alpha-версия самостоятельной альтернативы TradingView для исследования и автоматизации торговых идей. Приложение запускается на компьютере пользователя: ключи, стратегии, история и настройки не отправляются в облачный сервис проекта.

Основные возможности:

- отдельные рабочие пространства **Мониторинг**, **Автоматизация** (Стратегии/Роботы) и read-only **Скринер**, а также глобальная кнопка «Запущено», открывающая центр роботов и портфеля;
- центр роботов группирует принадлежащие текущему пользователю метаданные аккаунтов и изолированные paper-боты; в `public-http-paper` доступны только доказуемые paper-баланс/капитал, P&L, позиции и открытые ордера, а приватная биржевая телеметрия, маржа и заимствования показываются как недоступные;
- метаданные торговых аккаунтов и сохранённые legacy credentials изолированы по владельцу и конкретному аккаунту; активация или изменение роли администратором не открывает ему чужие аккаунты, ключи, workspaces и paper-портфель, а текущий профиль не принимает и не расшифровывает биржевые ключи для использования;
- собственный Canvas-график со свечами, Heikin-Ashi, барами, линиями, area, baseline, стабильными Renko, Three Line Break, Kagi и Point & Figure, а также VPVR, тепловой картой стакана, живым trade footprint/CVD и подсветкой imbalance/возможного absorption;
- горизонтальный Volume Profile может использовать таймфрейм графика или независимый источник **1m/5m/15m/1h/4h/1d**; неполная, синтетическая или слишком широкая исходная выборка отключается fail-closed;
- локально сохраняемые настройки размера Renko/P&F-клетки, процента разворота Kagi, глубины Line Break и числа P&F-клеток разворота с полным согласованным пересчётом Canvas, индикаторов и доступной OHLC-таблицы;
- быстрая линейка `Shift + перетаскивание` показывает изменение цены, проценты, число свечей и время, не добавляя временный результат в сохранённые рисунки;
- правая ось цены независимо масштабируется колесом/трекпадом, вертикальным перетаскиванием и клавиатурой; `Home` или двойной щелчок возвращает автоматический диапазон, не меняя видимые свечи;
- компоновки из одного, двух или четырёх графиков независимо связывают символ, интервал, перекрестие и видимый UTC-диапазон, сохраняя zoom/pan синхронными даже для разных рынков;
- каждое окно независимо отображает биржевой UTC, локальное время браузера или выбранный IANA-пояс; ось, перекрестие, OHLC-таблицы и легенды одинаково учитывают DST, а выбор сохраняется в сессии и рабочем пространстве;
- локально сохраняемые flow-алерты для stacked imbalance, возможного absorption, всплесков CVD и крупных принтов со звуком и системными уведомлениями по желанию;
- Binance и Bybit market data с REST-историей и WebSocket-обновлениями;
- read-only арбитражная область: строгий venue-native basis и проверенный BTC/ETH cross-venue basis Binance/Bybit, направленные top-book симуляции треугольных циклов,
  нативные спреды Bybit, согласованная глубина, durable alerts и event-sourced paper ledger;
- операторские continuous public feeds OKX/Gate/Hyperliquid/Deribit/Kraken/Coinbase/dYdX/KuCoin/MEXC показывают только
  fail-closed разницу quote value/basis входа с публичной quote-equivalent оценкой taker-комиссий, а
  не торговый финансовый результат; identity provenance, coverage refresh и арифметика проверяются,
  каждый маршрут остаётся strategy-blocked и non-actionable;
- публичный TypeScript SDK и ограниченные адаптеры всех девяти generic-бирж, а также pure
  options-parity engine для custom исследований без credential/order API;
- визуальный Blockly-конструктор индикаторов и стратегий;
- импорт поддерживаемого подмножества Pine Script v4–v6 в редактируемые блоки;
- безопасный JSON IR без `eval` и выполнения пользовательского JavaScript;
- backtest с `next_open`, комиссиями, slippage, funding, gap-aware stop/target и liquidation;
- optimizer, walk-forward и Monte Carlo;
- ограниченный grid/genetic-оптимизатор параметров с seed, мутациями, crossover, elitism и train/validation fitness; нетронутый финальный test проходит только заранее выбранный кандидат №1, а прошедшие параметры записываются обратно в Blockly в точном research-контексте;
- отдельный структурный генератор создаёт и импортирует валидированные trend/mean-reversion/breakout/momentum IR-кандидаты с воспроизводимым provenance; его текущая UI-панель ещё не запускает и не ранжирует multi-market fitness;
- paper trading; экспериментальные Binance/Bybit live adapters сохранены в кодовой базе, но текущий профиль `public-http-paper` не позволяет их включить;
- передача basis/triangular/native-spread и совместимых continuous-кандидатов из Скринера в Автоматизацию как `market-opportunity-v1` research card с ногами, экономикой, evidence и blockers; это не исполняемый order plan, live всегда заблокирован, а точный paper multi-leg plan остаётся отдельным короткоживущим артефактом;
- admin-only Order-book ML research принимает загруженные реконструированные sequence-verified aggregate L2 snapshots, строит leakage-controlled dataset и обучает прозрачный ridge baseline; сессии ephemeral/in-memory, личности участников и calibrated probability не определяются, paper/live orders недоступны;
- отдельная PostgreSQL для пользователей, сессий, рабочих пространств и очереди исследований; существующая SQLite с роботами и зашифрованными API-ключами сохраняется без автоматического разрушительного переноса.

> Импорт Pine пока не означает полную совместимость с TradingView. Приложение показывает ошибки и предупреждения об аппроксимациях. Результат необходимо проверять на графике и в paper-режиме.

> Текущий релиз работает только в Research / Paper. Live trading и ввод биржевых ключей остаются заблокированы до отдельного HTTPS/security-релиза.

## Быстрый старт

Рекомендуются Docker Engine и Compose. Для установки без Docker нужны Node.js 24+, npm и
отдельная PostgreSQL.

```bash
git clone https://github.com/AubakirovArman/SaltanatbotV2.git
cd SaltanatbotV2
mkdir -p .secrets
umask 077
openssl rand -base64 48 > .secrets/postgres_password
docker compose up -d --build
docker compose exec saltanatbotv2 \
  node backend/dist/cli/bootstrapAdmin.js --login ваш-логин-администратора
```

Команда создания администратора один раз показывает временный пароль. После первого входа его
необходимо заменить. Обычная регистрация создаёт неактивную учётную запись; администратор включает
её из панели аккаунта. PostgreSQL проекта доступна только на `127.0.0.1:55434` и не затрагивает
другие PostgreSQL или существующие SQLite.

В режиме разработки сначала запустите базу, затем приложение:

```bash
docker compose up -d postgres
npm install
export AUTH_MODE=database PGPASSWORD_FILE="$PWD/.secrets/postgres_password"
npm run dev
```

Адреса разработки:

- frontend: `http://localhost:4180`;
- backend/API: `http://localhost:4181`.

Основная навигация и стабильные пользовательские сценарии доступны на английском, русском и
казахском языках. Кнопка языка в верхней панели переключает EN → RU → KK и сохраняет выбор после
перезагрузки; точные API-схемы и внутренняя документация остаются каноническими на английском.

По умолчанию production backend доступен только на `127.0.0.1:4180`. До отдельного HTTPS-релиза
не выставляйте его в недоверенную публичную сеть: используйте только private network/VPN/IP
allowlist и firewall.

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
- [Декларативные плагины](docs/ru/PLUGINS.md)
- [Арбитражный скринер: triangular L2, funding-сценарии, вилки и continuous entry basis](docs/ru/ARBITRAGE_SCREENER.md)
- [Каноническая классификация арбитража](docs/ru/ARBITRAGE_TAXONOMY.md)
- [Защищённые исследовательские уведомления](docs/ru/RESEARCH_ALERTS.md)
- [Идентификация сетей и совместимость переводов](docs/ru/NETWORK_IDENTITY.md)
- [Математика и допущения скринера](docs/ARBITRAGE_MATH_AND_ASSUMPTIONS.md)
- [Матрица текущих и планируемых бирж](docs/VENUE_CAPABILITIES.md)
- [Качество арбитражных market data](docs/MARKET_DATA_QUALITY.md)
- [Сгенерированная матрица совместимости Pine](docs/PINE_COMPATIBILITY.generated.md)
- [Trading](docs/TRADING.md)
- [Конфигурация и безопасность](docs/CONFIGURATION.md)
- [Самостоятельная установка с авторизацией](docs/SELF_HOSTING.md)
- [Архитектура и лимиты для первых 100 пользователей](docs/CAPACITY_100_USERS.md)
- [Подробный план R2–R12 до появления HTTPS](docs/ru/PRE_HTTPS_ROADMAP.md)
- [Резервное копирование и восстановление](docs/ru/BACKUP_RESTORE.md)
- [Локальные исследования офлайн](docs/ru/OFFLINE_RESEARCH.md)
- [Безопасное открытие и системное «Поделиться» через PWA](docs/ru/PWA_FILE_HANDLING.md)
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

- Никогда не публикуйте `backend/data/`, `.secrets/`, `.env`, дампы PostgreSQL и API-ключи.
- Не вводите биржевые API-ключи через публичный HTTP; существующие encrypted-значения остаются неактивными.
- До появления HTTPS используйте только private network/VPN/IP allowlist и firewall. Пароль первого администратора меняется сразу;
  новые учётные записи остаются неактивными до ручного одобрения.
- Профиль `public-http-paper` неизменяемо блокирует live, signed REST и private WebSocket.
- Арбитражный скринер не размещает ордера: continuous entry basis и оценки комиссии — только
  сравнение публичных цен входа; отдельно моделируемый paper-результат также исследовательский, а
  котировки разных бирж не являются атомарными.
- Production-версию можно установить как PWA и открыть её статический интерфейс без сети. API, котировки, стакан, сделки и торговые команды не кешируются и не воспроизводятся после reconnect.
- Strategy Studio можно отдельно сохранить для офлайн-исследований из верхней панели; локальные артефакты остаются на устройстве, а торговля — только в сети.
- Установленное Chromium-family PWA открывает и получает через системное «Поделиться» `.pine`, `.strategy` и `.saltanat-plugin` только после обязательной локальной проверки; ручной импорт остаётся доступен во всех браузерах.

## Лицензия

MIT. Проект предназначен для исследований и обучения и не является финансовой рекомендацией.
