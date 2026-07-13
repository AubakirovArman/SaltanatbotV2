# Реагирование на инцидент и rollback дистрибутива

Этот runbook относится к повреждённому или неработающему дистрибутиву SaltanatbotV2. Он не
отменяет биржевые ордера и позиции и не выполняет автоматический rollback схемы базы данных.

Каждый release содержит внутренний и внешний file manifest с путём, размером и SHA-256 каждого
файла, SBOM, `SHA256SUMS`, Sigstore provenance и `rollback-drill.json`. Проверка отклоняет
изменённые, отсутствующие, лишние файлы и symlink, а release identity сверяется с
`release-info.json`.

Локальная репетиция:

```bash
ALLOW_DIRTY_RELEASE=1 npm run release:package -- --channel nightly --version nightly-local-drill
npm run release:rollback-drill -- \
  --distribution .release-staging/saltanatbotv2-nightly-local-drill \
  --output release/saltanatbotv2-nightly-local-drill.rollback-drill.json
```

Drill создаёт изолированные immutable candidate/previous slots, активирует candidate, намеренно
изменяет его HTML, требует обнаружить подмену и атомарно возвращает verified previous slot. Реальный
`backend/data` не читается и не изменяется.

При настоящем инциденте остановите promotion, отдельно проверьте биржевые ордера/позиции, сохраните
логи и supply-chain evidence, проверьте предыдущий release на чистой машине и запустите его на
изолированном порту. Binary rollback не отменяет migrations: при несовместимости остановите оба
процесса и используйте проверенный [backup/restore](BACKUP_RESTORE.md). Переключайте только
атомарный pointer/symlink или upstream reverse proxy, затем сверяйте health, auth, streams, bot state
и состояние непосредственно на биржах. Исправление выпускается новой версией; assets существующего
tag никогда не заменяются.
