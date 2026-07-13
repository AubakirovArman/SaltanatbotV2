# Декларативті плагиндер

SaltanatbotV2 плагині — өңделетін индикаторлар мен стратегиялары бар жергілікті
JSON пакет. Бұл JavaScript extension немесе қашықтан жүктелетін module емес.

## Сенім шекарасы

- Ең көбі 5 МБ және 25 артефакт.
- Тек нақты рұқсат етілген fields қабылданады; белгісіз fields қабылданбайды.
- SHA-256 толық canonical manifest өзгермегенін тексереді, бірақ publisher
  тұлғасын немесе сенімділігін растамайды.
- `strategy_start` түбірі бар Blockly XML ғана рұқсат етіледі. `<script>` және
  arbitrary JavaScript fields қабылданбайды.
- Dependencies сол пакет ішінде болуы және self/cycle байланыс жасамауы керек.
- Қолдау көрсетілмейтін schema version және жаңа `minAppVersion` қабылданбайды.
- Import стратегияны іске қоспайды және live trading ашпайды. Әр артефакт қалыпты
  compile, validation, backtest және run-readiness кезеңдерінен өтеді.

Қолдау көрсетілетін permissions: `market.read`, `chart.overlay`, `trade.intent`
және `alert.emit`. Indicator үшін `chart.overlay`, strategy үшін `trade.intent`
қажет. Олар network, filesystem, credentials немесе тікелей exchange API қол
жетімділігін бермейді.

## Пакет жасау

Strategy Studio ішінде **Плагин құрастыру** әрекетін таңдаңыз. Пакет ID,
semantic version, лицензия және publisher деректерін толтырып, жергілікті
индикаторлар мен стратегияларды белгілеңіз. Құрастырушы барлық транзитивті
тәуелділіктерді автоматты қосады, тұрақты package-local IDs жасайды, ең аз
permissions жинағын есептейді және checksum қорғалған `.saltanat-plugin` файлын
жүктейді. Міндетті емес publisher URL тек HTTPS болуы керек. Бос таңдау, жоқ
тәуелділік және цикл қабылданбайды.

Автоматтандыру үшін `@saltanatbotv2/plugin-core` ішіндегі `encodePluginFile()`
қолдануға болады.

## Тексеру және импорттау

**Плагин** әрекетін таңдап, файлды ашыңыз. Техникалық тексеруден кейін міндетті
review терезесі ашылады; жергілікті кітапхана әлі өзгермейді. Пакет пен нұсқаны,
publisher, лицензияны, қолданбаның ең төменгі нұсқасын, толық checksum,
permissions және тәуелділіктері бар әр артефактті тексеріңіз. Тек **Тексерілген
плагинді импорттау** батырмасы мазмұнды қосады. Болдырмау немесе `Escape`
кітапхананы өзгертпейді. Import кезінде IDs және dependencies жаңа жергілікті
IDs-ке ауысады; plugin ID, version, publisher және checksum provenance ішінде
сақталады.

Marketplace, URL арқылы install, executable hooks, third-party UI, auto-update
және publisher signatures әзірге әдейі жоқ. Олар үшін алдымен permissions,
moderation, signing және supply-chain security саясаты қажет.
