# SaltanatbotV2 қазақша құжаттамасы

Статус: бұл құжаттар 2026-07-14 күнгі `0.1.0` ерте alpha-нұсқасымен салыстырылды. Қолданба UI-ы
EN/RU/KK тілдерінде толық типтелген; нақты API схемалары мен инженерлік ішкі құрылым үшін ағылшын
құжаттамасы канондық болып қалады.

## Пайдаланушыларға

- [Жоба шолуы және жылдам бастау](../../README.kk.md)
- [График және қолжетімді кестелік деректер](CHART.md)
- [Strategy Studio, Pine Script, backtest және optimizer](STRATEGY_STUDIO.md)
- [Paper/live trading, кілттер және журналдар](TRADING.md)
- [Exchange мүмкіндіктері және operator checklist](EXCHANGE_CAPABILITIES.md)
- [Арбитраж скринері: triangular L2, funding сценарийлері және бағыт түрлері](ARBITRAGE_SCREENER.md)
- [Fee, borrow, network және stablecoin FX қорғалған телеметриясы](ACCOUNT_TELEMETRY.md)
- [Арбитраждың канондық taxonomy құжаты](ARBITRAGE_TAXONOMY.md)
- [Қорғалған account-aware зерттеу ескертулері](RESEARCH_ALERTS.md)
- [Желі сәйкестігі және fail-closed аударым үйлесімділігі](NETWORK_IDENTITY.md)
- [Скринер математикасы, болжамдары және шекаралары](../ARBITRAGE_MATH_AND_ASSUMPTIONS.md)
- [Current, planned, private және regional exchange capability матрицасы](../VENUE_CAPABILITIES.md)
- [OKX public read-only адаптері](OKX_PUBLIC_ADAPTER.md)
- [Gate.io public read-only адаптері](GATE_PUBLIC_ADAPTER.md)
- [Hyperliquid public деректері](HYPERLIQUID_PUBLIC_ADAPTER.md)
- [Deribit public деректері және опцион паритетін зерттеу](DERIBIT_OPTIONS_RESEARCH.md)
- [dYdX public және chain-aware market data](DYDX_PUBLIC_ADAPTER.md)
- [Оқиғалар мен орындалу трассалары](EVENT_TRACES.md)
- [Қауіпсіздік бойынша қысқаша нұсқаулық](SECURITY.md)
- [Backup және қалпына келтіру](BACKUP_RESTORE.md)
- [Қолданбаны іске қосуды қалпына келтіру](STARTUP_RECOVERY.md)
- [Жергілікті офлайн зерттеу](OFFLINE_RESEARCH.md)
- [PWA арқылы Pine, strategy және plugin файлдарын қауіпсіз ашу және бөлісу](PWA_FILE_HANDLING.md)
- [Distribution incident response және rollback](INCIDENT_RESPONSE.md)
- [90 коммиттен тұратын жаңарту](RELEASE_2026-07-11.md)

## Әзірлеушілерге

- [Архитектура](../ARCHITECTURE.md)
- [API](../API.md)
- [Стратегиялар](../STRATEGIES.md)
- [Декларативті плагиндер](PLUGINS.md)
- [Trading](../TRADING.md)
- [Конфигурация](../CONFIGURATION.md)
- [Pine үйлесімділік матрицасы](../PINE_COMPATIBILITY.generated.md)
- [Тестілеу стратегиясы](../TESTING_STRATEGY.md)
- [Exchange adapter contract](../EXCHANGE_ADAPTER_CONTRACT.md)
- [Арбитраж test matrix](../ARBITRAGE_TEST_MATRIX.md)
- [Market data quality policy](../MARKET_DATA_QUALITY.md)
- [Құжаттама мәртебесі](../DOCUMENTATION_STATUS.md)

## Аударма ережелері

- Pine, JSON, API өрістері, командалар және block ID аударылмайды.
- Қауіп пен live trading туралы ескертулер қолмен тексеріледі.
- Сандар, күндер, пайыздар мен валюта `Intl` арқылы пішімделеді.
- Қазақша бет ағылшын канондық нұсқасынан артта қалса, оны ашық көрсетуі керек.
