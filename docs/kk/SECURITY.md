# Қауіпсіздік бойынша қысқаша нұсқаулық

- Осалдықты public issue-де жарияламаңыз; [SECURITY.md](../../SECURITY.md) арнасын қолданыңыз.
- `.env`, `.secrets/`, PostgreSQL dump, `backend/data/`, session cookie және exchange API кілттерін commit жасамаңыз.
- Қаражат шығаруға рұқсаты жоқ бөлек API кілтін және IP allowlist пайдаланыңыз.
- External access үшін HTTPS reverse proxy, firewall, қауіпсіз admin password және private database secret міндетті.
- Paper әдепкі режим; live эксперименттік және бірнеше растауды қажет етеді.
- Emergency stop-тан кейін де биржадағы positions/orders күйін тікелей тексеріңіз.

Бұл қысқаша аударма. Қолдау көрсетілетін нұсқалар мен хабарлау тәртібі үшін канондық
[Security Policy](../../SECURITY.md) құжатын қараңыз.
