# PWA арқылы файл ашу және жүйелік «Бөлісу»

Орнатылған SaltanatbotV2 PWA үш шектеулі зерттеу форматын жүйе арқылы файлды ашқанда немесе
**Бөлісу** мәзірінен қолданбаны таңдағанда қабылдай алады.

| Кеңейтім | Мақсаты | Ең үлкен өлшемі |
| --- | --- | ---: |
| `.pine` | Жергілікті түрлендіруге арналған Pine бастапқы коды | 1 МБ |
| `.strategy` | Checksum қорғалған өңделетін артефакт | 2 МБ |
| `.saltanat-plugin` | Декларативті плагин пакеті | 5 МБ |

Екі интеграция да орнатылған Chromium-family PWA үшін progressive enhancement болып табылады.
Қолдау браузер мен операциялық жүйеге байланысты; manifest өзгергеннен кейін рұқсат немесе қайта
орнату қажет болуы мүмкін. Firefox, Safari, жай бет және қолдау көрсетілмейтін жүйелерде Strategy
Studio ішіндегі **Pine**, **Import** және **Plugin** қолмен таңдау жолдары сақталады.

## Импортқа дейінгі міндетті тексеру

Алдымен root shell тек файл атын, жарияланған түрін және өлшемін көрсетеді. **Файлдарды жергілікті
тексеру** әрекетіне дейін ол Strategy Studio-ны жүктемейді және мазмұнды оқымайды. Бас тарту ашу не
бөлісу әрекетін жояды.

Сыртқы тексеруден кейін:

- Pine converter ішіне жүктеледі, бірақ **Түрлендіру** және **Қосу** бөлек қажет;
- `.strategy` ресурс шектерінен және schema/checksum тексеруінен өтіп, metadata диалогын көрсетеді;
- plugin checksum, қолтаңба, signer continuity, permission, dependency және package content
  тексерулерін сақтайды.

Файлды ашу не бөлісу backtest, bot, paper session немесе live order іске қоспайды. Мазмұн браузерде
қалады және backend не биржаға жіберілмейді. Generic `.json`, қос кеңейтім, handler/name сәйкессіздігі
және оннан артық файл қабылданбайды.

## Жүйелік файл өңдеушілері

Manifest `/?view=strategy` және `single-client` үшін үш бөлек `file_handlers` жариялайды. Кезекті
launch әрекеттері queue ішінде сақталады. Қолдау user-agent sniffing не polyfill орнына
`window.launchQueue` арқылы анықталады.

## Жүйелік Share Target

Manifest тек файлдарға арналған бір `share_target` жариялайды. Ол title, text, URL, generic JSON,
сауда деректері мен order қабылдамайды. Браузер `multipart/form-data` сұрауын дәл same-origin
`/share-target` жолына жібереді. Production service worker тек осы POST-ты жергілікті өңдейді; басқа
POST және runtime/trading сұраулары network-only болып, cache-ке жазылмайды және қайталанбайды.

Қабылданған `File` объектілері мен шектеулі rejection metadata POST-ты app shell-ге redirect ету үшін
бөлек browser IndexedDB ішінде уақытша сақталады. URL ішінде файл аты не мазмұны емес, тек opaque UUID
болады. Storage ең көбі бес pending batch, 24 сағатпен шектеледі және Cancel не қалыпты форматтық
review-ге берілгеннен кейін өшіріледі. Мерзімі өткен немесе қолжетімсіз record fail closed болады.

Шектер: он файл, жалпы 10 МБ қабылданған data, форматқа 1/2/5 МБ және best-effort 12 МБ request guard.
Файл атындағы control character жойылып, ұзын ат қысқартылады. Қабылданбаған файл parsed болмайды.

Cache-тегі root shell offline кезде share қабылдап, одан бас тарта алады. Импортты offline аяқтау үшін
сол build-тің optional Strategy Studio bundle-і де орнатылуы керек. Ол жоқ болса, record Cancel,
сәтті hand-off, bounded pruning немесе expiry болғанға дейін retry үшін сақталады.

## Тексеру

- `npm run pwa:check` дәл manifest келісімдерін, bounded hand-off, expiration және generic
  JSON/trading handler жоқтығын тексереді.
- Unit test feature detection, ерте оқымау, limit, spoofing, strict UUID, worker messaging, URL cleanup
  және fail-closed record-тарды қамтиды.
- Production Chromium E2E нақты multipart-ты generated service worker арқылы жіберіп, consent,
  rejection, deletion және қалыпты Pine import-ты тексереді. Offline scenario shell runtime data-ны
  cache-ке жазбай share қабылдап, одан бас тарта алатынын дәлелдейді.
