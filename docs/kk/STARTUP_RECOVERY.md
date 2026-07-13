# Қолданбаны іске қосуды қалпына келтіру

SaltanatbotV2 іске қосу қатесін түсініксіз бос экранға айналдырмайды. React басталғанға дейін
`index.html` минималды локализацияланған күй экранын көрсетеді. React render немесе lazy workspace
қате берсе, global boundary интерфейсті қалпына келтіру экранымен ауыстырады.

Үш әрекет бар:

- **Интерфейсті қайта іске қосу** — storage-ті өзгертпей React-ты қайта mount жасайды.
- **Бетті қайта жүктеу** — қалыпты reload орындайды.
- **Қолданба файлдарын жаңарту** — тек өз `/service-worker.js` тіркеуін және
  `saltanat-shell-` prefix-і бар Cache Storage жазбаларын жойып, бетті қайта жүктейді.

Графиктер, workspace, стратегиялар, IndexedDB signing identity, exchange баптаулары, bot journal,
localStorage және trading database тазаланбайды. Dynamic import/chunk қатесі әр tab үшін тек бір
automatic shell refresh алады, сондықтан шексіз reload loop болмайды. Қалыпты application қатесі
пайдаланушының анық әрекетін күтеді.

Файлдарды жаңартқаннан кейін де экран қалса, HTML, startup assets және content-hashed
`/assets/*.js` үшін `200` жауабын, JavaScript MIME type, CSP және reverse proxy cache headers
тексеріңіз. Production E2E негізгі bundle-ды әдейі бұғаттап, KK/RU/EN recovery негізін және
axe-compatible controls-ты тексереді.
