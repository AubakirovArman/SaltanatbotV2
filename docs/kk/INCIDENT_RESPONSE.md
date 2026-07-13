# Distribution incident response және rollback

Бұл runbook бұзылған немесе іске қосылмайтын SaltanatbotV2 distribution үшін. Ол exchange orders
мен positions-ды жоймайды және database schema migration-ды автоматты кері қайтармайды.

Әр release ішінде және сыртында әр файлдың path, size және SHA-256 мәндері бар manifest, SBOM,
`SHA256SUMS`, Sigstore provenance және `rollback-drill.json` болады. Verification өзгерген, жоқ,
артық файлдар мен symlink-ті қабылдамайды және release identity-ді `release-info.json` арқылы
салыстырады.

Жергілікті rehearsal:

```bash
ALLOW_DIRTY_RELEASE=1 npm run release:package -- --channel nightly --version nightly-local-drill
npm run release:rollback-drill -- \
  --distribution .release-staging/saltanatbotv2-nightly-local-drill \
  --output release/saltanatbotv2-nightly-local-drill.rollback-drill.json
```

Drill isolated immutable candidate/previous slots жасайды, candidate-ті іске қосып, оның HTML
файлын әдейі өзгертеді, өзгеріс міндетті түрде анықталғаннан кейін verified previous slot-қа atomic
түрде оралады. Нақты `backend/data` оқылмайды және өзгермейді.

Нақты incident кезінде promotion-ды тоқтатыңыз, exchange orders/positions күйін тікелей тексеріңіз,
logs және supply-chain evidence сақтаңыз, previous release-ті таза машинада тексеріп isolated port-та
іске қосыңыз. Binary rollback migration-ды кері қайтармайды: compatibility болмаса, екі process-ті
де тоқтатып, тексерілген [backup/restore](BACKUP_RESTORE.md) пайдаланыңыз. Тек atomic pointer/symlink
немесе reverse-proxy upstream ауыстырып, health, auth, streams, bot state және venue state қайта
тексеріледі. Existing tag assets ауыстырылмайды; fix жаңа version ретінде шығады.
