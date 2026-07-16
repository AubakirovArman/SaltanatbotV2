# Документация SaltanatbotV2 на русском языке

Статус: пользовательские документы проверены против версии `0.1.0` 2026-07-14. Интерфейс
полностью типизирован на EN/RU/KK; английская документация остаётся канонической для точных
API-схем и инженерных внутренних контрактов.

## Пользователям

- [Обзор и быстрый старт](../../README.ru.md)
- [График и доступные табличные данные](CHART.md)
- [Студия стратегий, импорт Pine Script, бэктест и оптимизация](STRATEGY_STUDIO.md)
- [Paper/live trading, ключи, безопасность и журналы](TRADING.md)
- [Возможности бирж и operator checklist](EXCHANGE_CAPABILITIES.md)
- [Арбитражный скринер: triangular L2, funding-сценарии и справочник вилок](ARBITRAGE_SCREENER.md)
- [Защищённая телеметрия комиссий, займа, сетей и stablecoin FX](ACCOUNT_TELEMETRY.md)
- [Каноническая классификация арбитража](ARBITRAGE_TAXONOMY.md)
- [Защищённые account-aware исследовательские уведомления](RESEARCH_ALERTS.md)
- [Идентификация сетей и fail-closed совместимость переводов](NETWORK_IDENTITY.md)
- [Математика, допущения и ограничения скринера](../ARBITRAGE_MATH_AND_ASSUMPTIONS.md)
- [Текущие, планируемые, private и региональные возможности бирж](../VENUE_CAPABILITIES.md)
- [Публичный read-only адаптер OKX](OKX_PUBLIC_ADAPTER.md)
- [Публичный read-only адаптер Gate.io](GATE_PUBLIC_ADAPTER.md)
- [Публичные данные Hyperliquid](HYPERLIQUID_PUBLIC_ADAPTER.md)
- [Публичные данные Deribit и исследование опционного паритета](DERIBIT_OPTIONS_RESEARCH.md)
- [Публичные и chain-aware данные dYdX](DYDX_PUBLIC_ADAPTER.md)
- [Краткая политика безопасности](SECURITY.md)
- [Резервное копирование и восстановление](BACKUP_RESTORE.md)
- [Восстановление запуска вместо пустого экрана](STARTUP_RECOVERY.md)
- [Локальные исследования офлайн](OFFLINE_RESEARCH.md)
- [Безопасное открытие и системное «Поделиться» Pine, strategy и plugin через PWA](PWA_FILE_HANDLING.md)
- [Incident response и rollback дистрибутива](INCIDENT_RESPONSE.md)
- [Обновление за 90 коммитов](RELEASE_2026-07-11.md)

## Разработчикам

Пока используйте канонические документы:

- [Подробный план разработки до появления HTTPS](PRE_HTTPS_ROADMAP.md)
- [Архитектура](../ARCHITECTURE.md)
- [API](../API.md)
- [Стратегии](../STRATEGIES.md)
- [Декларативные плагины](PLUGINS.md)
- [Trading](../TRADING.md)
- [Конфигурация](../CONFIGURATION.md)
- [Master improvement plan](../MASTER_IMPROVEMENT_PLAN.md)
- [Модульная архитектура](../MODULAR_ARCHITECTURE.md)
- [Тестирование](../TESTING_STRATEGY.md)
- [Контракт exchange adapter](../EXCHANGE_ADAPTER_CONTRACT.md)
- [Матрица тестирования арбитража](../ARBITRAGE_TEST_MATRIX.md)
- [Политика качества market data](../MARKET_DATA_QUALITY.md)
- [Трассировка событий стратегии](EVENT_TRACES.md)
- [Реестр актуальности всей документации](../DOCUMENTATION_STATUS.md)

## Правила перевода

- Pine, JSON, API-поля, команды и идентификаторы блоков не переводятся.
- Предупреждения о рисках проходят отдельную ручную проверку.
- Числа, даты, проценты и валюты должны форматироваться через `Intl`.
- Русская страница должна указывать, если она отстаёт от канонической версии.
