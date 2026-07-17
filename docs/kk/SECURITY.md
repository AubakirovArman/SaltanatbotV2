# Қауіпсіздік бойынша қысқаша нұсқаулық

- Осалдықты public issue-де жарияламаңыз; [SECURITY.md](../../SECURITY.md) арнасын қолданыңыз.
- `.env`, `.secrets/`, PostgreSQL dump, `backend/data/`, session cookie және exchange API кілттерін commit жасамаңыз.
- Қазіргі `public-http-paper` exchange key жазуды/қолдануды және барлық live
  orders жолдарын қабылдамайды; credentials енгізбеңіз.
- External access үшін private network/VPN/IP allowlist, firewall, қауіпсіз
  admin password және private database secret қолданыңыз. HTTPS кейінгі бөлек
  security roadmap-қа жатады.
- Қазіргі ақауларды `DEMO_MODE=1` немесе Paper режимінде қайталаңыз; opt-in
  testnet smoke тек read-only.
- Болашақ HTTPS/private-live review бөлек withdrawal құқығы жоқ key, IP
  allowlist және exchange-state reconciliation талап етеді.

Бұл қысқаша аударма. Қолдау көрсетілетін нұсқалар мен хабарлау тәртібі үшін канондық
[Security Policy](../../SECURITY.md) құжатын қараңыз.
