# Стратегия оқиғалары мен орындалу трассалары

SaltanatbotV2 әр есептелген candle үшін versioned deterministic trace жасайды. Ол preview, backtest,
paper және live evaluator нәтижелерін салыстыруға және сигналдың неге пайда болғанын зерттеуге көмектеседі.

## Strategy trace

- V1 тұрақты ретпен entry, exit, stop, target, trail, size, alert және marker intents сақтайды.
- V2 V1 мағынасын сақтап, condition/variable explanations, loop bounds және warnings қосады.
- Құндылықтар JSON-safe форматқа нормалданады; event саны bounded execution budget-пен шектеледі.

## Backtest execution trace

Execution trace жоспарланған/қабылданбаған fills, commissions, funding, position/equity transitions,
warning codes және data provenance-ті тіркейді. Бірдей input бірдей байттық JSON нәтижесін беруі тиіс.

Trace стратегияның дұрыстығын немесе табыстылығын дәлелдемейді. Ол implementation parity мен audit
үшін evidence береді. Канондық схема: [EVENT_TRACES.md](../EVENT_TRACES.md).
