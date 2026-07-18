# R5.3b-2 Telegram paper commands — acceptance evidence

Status: accepted, pushed to `main`, deployed on port 4180. Release commit
`17e12f17933de5ffb047d63358a05fad8f0211f0`
(`feat: add Telegram paper commands over the fenced executor`); exact-SHA
GitHub Actions run `29625979877` completed with 6/6 successful jobs.
Production runs PostgreSQL schema 16 and unchanged trading SQLite schema 9
from the protected slot `r5e-schema16-17e12f1` with the same three
project-owned units. The runtime remains `public-http-paper`; the notification
worker continues to idle by design without a provisioned bot token, and the
command lane activates together with delivery once
`/home/arman/.config/saltanatbotv2/telegram_bot_token` is provisioned.

Migration 16 (`telegram_command_bridge`) checksum:
`499297dca5cc11a4c84f4988d5c159dc71160b4a8acfe864cc3c04e15d163b8e`.

## Exact-worktree local gates (clean tree at the release SHA)

- typecheck, Biome lint (1 773 files), `architecture:check` (1 133 files, all
  ≤600 lines), `docs:check` (166 HTTP / 6 WS endpoints), production build
  with verified exit status, `perf:check` (no cap change), `pwa:check`.
- Vitest: 3 144 passed / 130 skipped, including new unit suites for the
  command parser, the four snapshot views (unavailable never rendered as
  zero), confirmation lifecycle with every fence race (wrong chat/owner/
  binding, revoke race, authorization-revision change — all reject WITHOUT
  consuming the token), the replies lane (settle-before-send `replied_at`
  fencing, 10-minute timeout, rate-limit deferral) and the executor read
  kinds.
- Real-PostgreSQL: the env-gated `telegramCommandsPostgres` integration suite
  (wired into CI) proved on an isolated unprivileged role/database with a
  REAL fenced executor and an isolated trading store: the `/balance` round
  trip with every enqueue fence field asserted; the full
  `/pause → confirm-target → token → /confirm → paper-robot.action → reply`
  round trip including a real engine pause call and a SQLite mutation
  receipt; one durable command per `update_id` across crash-before-commit
  and consumer takeover; cross-owner, expired, revoked-binding and stale
  authorization-revision `/confirm` all failing closed; the ≤3 outstanding
  confirmation quota with expiry release.
- Container browser gates: Chromium e2e 91/91, Firefox critical journeys
  19/19, visual regression 6/6 (no frontend changes in this increment).

## Accepted behavior

- Commands `/help /balance /daily /profit /performance /trades /alerts` and
  the two-step `/pause /resume /stop` + `/confirm` operate only for the
  bound owner's paper robots; `/alerts` is answered from PostgreSQL, every
  paper read flows through two new READ-ONLY executor kinds
  (`paper-portfolio.snapshot`, `paper-robot.trades`) computed from the
  existing evidence-aware read models; the notification service never opens
  the trading SQLite.
- Phase A writes ONE durable executor command per update in the same ingress
  batch transaction (idempotency key `telegram:<bot>:<update_id>`,
  `origin: "telegram"` payload, null actor, synthetic session digest) — the
  frozen v12 `executor_commands` table needed no DDL. The executor's
  authorize step recognizes the documented owner-scoped telegram principal
  and re-proves owner-active, paper-trade role and the exact durable
  `authorization_revision` before apply.
- Control confirmations are 16-character one-time tokens stored hashed-only
  with a 120-second TTL, at most three outstanding per owner, consumed under
  `FOR UPDATE` with chat/binding-revision/authorization-revision re-proof;
  revision/epoch fences captured at issue time ride the
  `paper-robot.action` payload.
- The replies lane formats terminal outcomes, re-proves the binding before
  every send, fences duplicates via `replied_at` (at-most-once replies,
  documented) and posts a single timeout notice after 10 minutes.
  Retention prunes consumed/expired confirmations after 2 days and replied
  rows after 7 days; command deletion cascades from executor retention.

## Recovery and cutover chronology

Only project resources were used (units `saltanatbotv2*`, container
`11-postgres-1` at `127.0.0.1:55434`, data dir `/home/arman/11/backend/data`,
port 4180 unchanged).

| Step | Generation / resource | Result |
| --- | --- | --- |
| Online pre-upgrade generation `pre-r53b2-rehearsal-schema15-v9-20260718T020000Z` | `3e4dc4f1-35e1-46da-91dd-63257d059ab2` | Backup + verify passed at schema 15; isolated drill passed and self-cleaned |
| Isolated 15→16 rehearsal | replacement DB `saltanatbotv2_restore_r53b2rehearsal20260718` + candidate build data dir | Candidate API on `127.0.0.1:4190` migrated to schema 16 with the exact checksum and both new tables; restart produced a byte-identical migration ledger (no-op); research and notification workers pulsed `ready` heartbeats at schema 16; `/api/ready` green |
| Rehearsal cleanup | exact replacement DB and data dir | Dropped/removed |
| Stopped pre-cutover rollback source `pre-r53b2-cutover-stopped-schema15-v9-20260718T021000Z` | `0898a08d-600e-4e69-a9e8-bd879eb6a6fd` | Captured with all three services stopped; verify passed at schema 15 |
| Production cutover | slot `r5e-schema16-17e12f1` | Drop-ins installed for all three units; API started first and migrated production to schema 16 with the exact checksum; API restart confirmed a migration no-op; both workers started next; all three units active with `NRestarts=0`, heartbeats `ready` at 16, served asset SHA-256 identical to the slot dist |
| Post-upgrade generation `post-r53b2-schema16-v9-20260718T022000Z` | `08b6defe-0ed0-4ee8-b396-a42ba531e0a3` | Backup + verify passed at schema 16; isolated drill passed and self-cleaned |
| Replacement-only rollback evidence | `saltanatbotv2_restore_r53b2rollback20260718` + `replacements/r53b2-r5d-rollback-20260718T022500Z` | Stopped schema-15 generation restored into new isolated resources, verified and retained unopened |

Rollback remains replacement-only; the previous accepted slot
`r5d-schema15-cd34ec8` is retained. The live Telegram round trip could not be
exercised in production because no bot token is provisioned on this host —
the command lane's end-to-end proof is the real-executor PostgreSQL
integration suite above, and the lane activates with the token file without
another release.
