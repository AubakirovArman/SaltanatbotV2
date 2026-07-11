# Strategy Studio, Pine Script және backtest

Strategy Studio блоктардан индикатор/стратегия құруға, Pine Script-тің қолдау көрсетілетін бөлігін
импорттауға, тарихи деректермен тексеруге және параметрлерді зерттеуге мүмкіндік береді.

## Жұмыс тәртібі

1. **Стратегия** бөлімін ашып, жаңа артефакт, template, `.strategy` немесе Pine Script таңдаңыз.
2. Блоктарды біріктіріп, JSON preview мен diagnostics-ті тексеріңіз.
3. Нарық, биржа, timeframe, candle саны, капитал және шығын моделін таңдаңыз.
4. Backtest іске қосып, assumptions, data provenance, metrics, trades және equity curve қараңыз.
5. Сандық inputs болса, optimizer және walk-forward қолданыңыз.

## Pine импорты

Диалог мәтінді немесе 25-ке дейін `.pine` файлын қабылдайды. `indicator()` индикаторға,
`strategy()` стратегияға айналады. Pine v4–v6 танылады, алайда нақты үйлесімділік нұсқа нөмірімен
емес, іске асырылған конструкциялармен анықталады.

- exact конструкциялар блоктар мен IR-ге айналады;
- approximations ескерту береді;
- қауіпсіз candle execution мүмкін емес конструкциялар себеппен қабылданбайды;
- техникалық identifiers пен Pine коды аударылмайды.

Импорттан кейін Studio бастапқы Pine кодын, өңделетін blocks және compiled
preview-ді қатар көрсетеді. Pine source импорт дәлелі ретінде өзгермейді: blocks
өңдеу оны қайта жазбайды. Diagnostic code батырмасы тиісті source range-ті
таңдап, оған focus береді.

Ескерту TradingView-пен эквиваленттілікті растамайды. Бірдей candles қолданып сигналдарды салыстырыңыз.

## Нәтижені түсіндіру

Backtest execution model, комиссия, slippage, funding, warm-up және position sizing-ке тәуелді.
Report деректердің шығу тегін және versioned traces көрсетеді. Mixed, synthetic, fallback немесе
unknown деректер performance claim үшін жарамсыз. Monte Carlo — болжам емес, іске асқан trades
ретін өзгерту арқылы robustness зерттеуі.

Әр нәтиже immutable symbol/timeframe/exchange, market/price type, data range,
execution settings, fill assumptions және missing/partially-loaded history
мәліметтерін сақтайды. Export батырмасы versioned `.saltanat-report.json`
жасайды. Settings, range, quality немесе provenance әртүрлі runs салыстырылмайды.

Bar replay previous/next батырмалары және range control арқылы deterministic
қадам жасайды. Әр frame strategy/broker events, equity, expression explanations
және variable changes көрсетеді.

Live-ке дейін бірнеше нарық/кезеңді, out-of-sample нәтижені және paper журналын тексеріңіз.

Қосымша: [trading нұсқаулығы](TRADING.md) және [Pine матрицасы](../PINE_COMPATIBILITY.generated.md).
