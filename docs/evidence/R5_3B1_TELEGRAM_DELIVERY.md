# R5.3b-1 Telegram delivery and chat binding — acceptance evidence

Status: accepted, pushed to `main`, deployed on port 4180. Release commit
`cd34ec8d11810a652bf087718f498dcece3b75fa`
(`feat: add Telegram delivery worker and chat binding`); exact-SHA GitHub
Actions run `29622330910` completed with 6/6 successful jobs. Production runs
PostgreSQL schema 15 and unchanged trading SQLite schema 9 from the protected
slot `r5d-schema15-cd34ec8`, now with THREE project-owned units: the API, the
research worker and the new `saltanatbotv2-notification-worker.service`. The
runtime remains `public-http-paper`. No Telegram bot token is provisioned on
this host, so the notification worker runs in its designed idle mode
(`notification_worker_idle{reason:"token_absent"}`) with a healthy
`notification-worker` heartbeat; readiness treats the worker as optional
unless `OPERATIONS_REQUIRE_NOTIFICATION_WORKER` is set, and `/api/ready`
reports the same six components as before.

Migration 15 (`telegram_notification_ingress`) checksum:
`1265ad195e84411807c64b35330d611520a2caacc2cafe6cebce75626a7cec25`.

## Exact-worktree local gates (clean tree at the release SHA)

- typecheck, Biome lint (1 760 files), `architecture:check` (1 126 files),
  `docs:check` (166 HTTP / 6 WS endpoints), production build with verified
  exit status, `perf:check` (no cap change), `pwa:check`.
- Vitest: 3 101 passed / 124 skipped, including the new token-file idle
  semantics, Telegram API backoff, binding service, ingress
  dedupe/cursor/lease-fencing and worker idle-boot suites. The test pass
  found and fixed one real implementation bug: the delivery-lane settle SQL
  reused parameter `$5` with two deduced types, which PostgreSQL rejects —
  without the fix no Telegram delivery could ever reach a terminal state.
- Real-PostgreSQL: the env-gated `telegramIngressPostgres` and
  `notificationWorkerBoot` integration suites ran against an isolated
  unprivileged role/database in the project container (migration v15;
  hashed-code create/consume/expiry/one-consume race; binding
  activate/replace/revoke with revision fences; queued-delivery insertion by
  BOTH the price and screener completion paths; delivery
  claim/retry/backoff/dead-letter/cancelled-on-revoke round trips against a
  fake Telegram API; consumer-lease takeover with fenced forward-only cursor;
  crash-before/after-cursor replay no-ops) — all green and wired into the CI
  postgres-security job.
- Container browser gates: Chromium e2e 91/91 (new
  `r53b-telegram-binding.spec.ts` covers the one-time code display, quota,
  telegram-channel arming and revoke with exact request envelopes), Firefox
  critical journeys 19/19, visual regression 6/6. Pre-existing fail-closed
  fixtures were taught the benign `GET /api/alerts/bindings` poll that the
  alerts panel now performs in server-synced sessions.

## Recovery and cutover chronology

Only project resources were used (units `saltanatbotv2*`, container
`11-postgres-1` at `127.0.0.1:55434`, data dir `/home/arman/11/backend/data`,
port 4180 unchanged; the new notification unit opens no listener).

| Step | Generation / resource | Result |
| --- | --- | --- |
| Online pre-upgrade generation `pre-r53b1-rehearsal-schema14-v9-20260718T000000Z` | `47645c55-08d2-4dfd-aade-97d0ef3ec3de` | Backup + verify passed at schema 14; isolated drill passed and self-cleaned |
| Isolated 14→15 rehearsal | replacement DB `saltanatbotv2_restore_r53b1rehearsal20260718` + candidate build data dir | Candidate API on `127.0.0.1:4190` migrated to schema 15 with the exact checksum and all three new tables; restart produced a byte-identical migration ledger (no-op); research worker ready; the notification worker booted WITHOUT a token, logged `notification_worker_idle{reason:"token_not_configured"}` and pulsed a `ready` heartbeat at schema 15; `/api/ready` stayed green with the standard six components |
| Rehearsal binding smoke | same replacement pair | Guarded `admin:recover` on the replacement copy only; `GET /api/alerts/bindings` returned the empty owner-scoped list; three one-consume codes issued (26 chars, raw value returned exactly once, unique); the fourth request answered `429 binding_code_quota_exceeded` with no code in the response; the database held exactly three distinct sha256 hex hashes and no raw codes |
| Rehearsal cleanup | exact replacement DB and data dir | Dropped/removed |
| Stopped pre-cutover rollback source `pre-r53b1-cutover-stopped-schema14-v9-20260718T003000Z` | `d86692ad-5d2d-42f5-ba36-b4f1ac2068e7` | Captured with services stopped; verify passed at schema 14 |
| Production cutover | slot `r5d-schema15-cd34ec8` | Drop-ins installed for the two existing units and the NEW `saltanatbotv2-notification-worker.service` (created from the research-worker template with its own slot launcher and `TELEGRAM_BOT_TOKEN_FILE` path); API started first and migrated production to schema 15 with the exact checksum; API restart confirmed a migration no-op; research worker and notification worker started next; all three units active with `NRestarts=0`; both worker heartbeats `ready` at schema 15 |
| Post-upgrade generation `post-r53b1-schema15-v9-20260718T004000Z` | `ba4f9d40-f734-49ab-908e-df35ab32e440` | Backup + verify passed at schema 15; isolated drill passed and self-cleaned |
| Replacement-only rollback evidence | `saltanatbotv2_restore_r53b1rollback20260718` + `replacements/r53b1-r5c-rollback-20260718T004500Z` | Stopped schema-14 generation restored into new isolated resources, verified and retained unopened |

Rollback remains replacement-only: schema-15 data was never deleted and the
previous accepted slot `r5c-schema14-86712ba` is retained.

## Production runtime acceptance

- `/api/health` `ok`; `/api/ready` `ready` for the six standard components;
  the notification worker is intentionally absent from the public readiness
  payload while `OPERATIONS_REQUIRE_NOTIFICATION_WORKER` is unset;
- `/api/alerts/bindings` is mounted behind the full session/owner stack
  (unauthenticated `401`); the served frontend asset is byte-identical to the
  slot dist;
- the notification worker idles with `reason:"token_absent"` and a healthy
  heartbeat — provisioning
  `/home/arman/.config/saltanatbotv2/telegram_bot_token` (owner-only 0600,
  BotFather token) later activates delivery without another release;
- external Telegram delivery remains at-least-once by design: a crash after a
  provider send can repeat the message with the same deduplication key, as
  documented in ALERTS.md and the threat model.
