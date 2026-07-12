<div align="center">

[English](README.md) · [Русский](README.ru.md) · **Қазақша**

<img src="assets/logo.svg" alt="SaltanatbotV2 логотипі" width="140" height="140" />

# SaltanatbotV2 🐘

**Деректерді жергілікті сақтайтын тегін әрі ашық кодты сауда терминалы.**

Нақты уақыттағы графиктер · визуалды стратегия құрастырушы · Pine Script импорты · backtest · paper/live trading

</div>

## Жоба туралы

SaltanatbotV2 — сауда идеяларын зерттеуге және автоматтандыруға арналған TradingView баламасының
ерте alpha-нұсқасы. Қолданба пайдаланушының компьютерінде іске қосылады: кілттер, стратегиялар,
тарих және баптаулар жоба бұлтына жіберілмейді.

Негізгі мүмкіндіктер:

- candlestick, Heikin-Ashi, bars, line, area, baseline және renko түрлері, VPVR, order-book heatmap, live trade footprint/CVD және imbalance/potential absorption белгілеуі бар жеке Canvas-график;
- stacked imbalance, potential absorption, CVD spike және large print үшін жергілікті сақталатын in-chart alert-тер, optional sound және desktop notification;
- Binance және Bybit үшін REST тарихы мен WebSocket жаңартулары;
- индикаторлар мен стратегияларға арналған Blockly визуалды құрастырушысы;
- Pine Script v4–v6 қолдау көрсетілетін бөлігін өңделетін блоктарға импорттау;
- `eval` және пайдаланушы JavaScript-ын орындамайтын қауіпсіз JSON IR;
- `next_open`, комиссия, slippage, funding, gap-aware stop/target және liquidation бар backtest;
- optimizer, walk-forward және Monte Carlo зерттеулері;
- paper trading және эксперименттік Binance/Bybit live adapter-лері;
- жергілікті SQLite, API кілттерін шифрлау және әрекеттер журналы.

> Pine импорты TradingView-пен толық үйлесімді дегенді білдірмейді. Қолданба қателер мен
> жуықтаулар туралы ескертулерді көрсетеді. Нәтижені графикте және paper режимінде тексеріңіз.

> Live trading эксперименттік күйде. Алдымен paper/testnet қолданыңыз, қаражат шығаруға құқығы жоқ
> API кілттерін және жеке тәуекел лимиттерін орнатыңыз.

## Жылдам бастау

Node.js 24+ қажет.

```bash
git clone https://github.com/AubakirovArman/SaltanatbotV2.git
cd SaltanatbotV2
npm install
npm run dev
```

Әзірлеу режимі:

- frontend: `http://localhost:4180`;
- backend/API: `http://localhost:4181`.

Production құрастыру:

```bash
npm run build
npm start
```

Production backend әдепкіде тек `127.0.0.1:4180` мекенжайында қолжетімді. Сыртқы қолжетімділік
үшін TLS reverse proxy, firewall және күшті `AUTH_TOKEN` пайдаланыңыз.

## Тексеру

```bash
npm run check       # TypeScript
npm run lint        # Biome
npm test            # unit/integration/parity
npm run test:e2e    # Playwright + production build
npm run build
```

## Құжаттама

- [Қазақша құжаттама индексі](docs/kk/README.md)
- [График және қолжетімді кестелік деректер](docs/kk/CHART.md)
- [Strategy Studio, Pine Script және backtest](docs/kk/STRATEGY_STUDIO.md)
- [Paper/live trading](docs/kk/TRADING.md)
- [Оқиғалар мен орындалу трассалары](docs/kk/EVENT_TRACES.md)
- [Қауіпсіздік бойынша қысқаша нұсқаулық](docs/kk/SECURITY.md)
- [Backup және қалпына келтіру](docs/kk/BACKUP_RESTORE.md)
- [90 коммит жаңартуы](docs/kk/RELEASE_2026-07-11.md)
- [Құжаттаманың өзектілік тізілімі](docs/DOCUMENTATION_STATUS.md)
- [Толық ағылшын құжаттамасы](README.md#documentation)

Нақты API схемалары мен әзірлеуші құжаттамасының канондық нұсқасы — ағылшын тілінде.

## Қауіпсіздік

- `backend/data/`, `.env`, API кілттері мен access token-ді жарияламаңыз.
- Қаражат шығаруға рұқсаты жоқ бөлек API кілтін қолданыңыз.
- Сыртқы қолжетімділікке HTTPS, firewall және күшті `AUTH_TOKEN` міндетті.
- Paper mode әдепкіде қосулы; live бірнеше анық растауды қажет етеді.
- Бұл жоба қаржылық кеңес бермейді және сауда нәтижесіне кепілдік бермейді.

## Лицензия

MIT. Жоба зерттеу мен оқуға арналған.
