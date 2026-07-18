# R5 chart research tools — acceptance evidence (completes R5)

Status: accepted, pushed to `main`, deployed on port 4180. Release commit
`2ff6101b950b42a77c378233dabecf1a5ee76ce7`
(`feat: add chart text notes and parallel channel`); exact-SHA GitHub Actions
run `29629886774` completed with 6/6 successful jobs. Production runs the
protected slot `r5f-schema16-2ff6101` on unchanged PostgreSQL schema 16 and
trading SQLite schema 9 — this release adds NO migration. With this
increment every R5 deliverable is accepted: R5.1 owner alerts, R5.2.1
technical screener, R5.3a screener alert promotion, R5.3b-1 Telegram
delivery and binding, R5.3b-2 Telegram paper commands, and the chart
research tools. **R5 is complete.**

## Exact-worktree local gates (clean tree at the release SHA)

- typecheck, Biome lint (1 785 files), `architecture:check` (1 139 files, all
  ≤600 lines), `docs:check`, production build with verified exit status,
  `perf:check` (bundle budgets hold, no cap change), `pwa:check`.
- Vitest: 3 183 passed / 130 skipped, including the new canonical-geometry
  contract matrix, workspace v9 accept/reject matrices with byte-for-byte v8
  compatibility proofs, drawing-store normalizer and old-store compatibility,
  channel geometry math, note/channel hit tests, note-editor jsdom
  interaction and en/ru/kk localization parity.
- Container browser gates: Chromium e2e 92/92 including the new journey
  (mobile bottom-sheet note placement → autofocused editor → typed multiline
  text → 44 px Save/Cancel → axe with the editor open → localStorage
  persistence across reload → object-list label; desktop three-click
  parallel-channel placement → unified body drag verified by equal shifts of
  all three anchors), Firefox critical journeys 19/19, visual regression 6/6
  with the drawing-tools baseline deliberately regenerated for the 21-tool
  sheet. The journey's axe audit exposed two real WCAG AA contrast defects
  (the 9 px note-editor hints and the pre-existing mobile drawing-tools
  trigger caption at 4.37:1) — both fixed by moving to the accessible muted
  token before acceptance.

## Accepted behavior

- **Text note** (one data-space anchor): wrapped theme-aware label (≤240 px,
  8 lines with ellipsis), optional text (1–500 chars, multiline through a
  dedicated validator that stays newline-only), optional author (session
  login snapshot, documented as informational client-document metadata) and
  creation time; accessible inline editor (dialog role, Esc/Ctrl+Enter,
  44 px targets), re-editable from the canvas, context menu and object list.
- **Parallel channel** (three anchors): the second line derives from the
  base line plus a signed price width; the body moves as one unit, endpoint
  drags reshape the base line preserving the width, the width anchor changes
  only the width; translucent fill and a measurable "Δ price" label;
  degenerate geometry is refused at click, drag, store and import time.
- **Canonical geometry contract**: `packages/contracts/chartGeometry`
  (anchor/horizontal/trend/channel parsers) is enforced identically by the
  canvas helpers, the drawing store, frontend workspace validation and the
  new backend workspace schema v9 — the single contract the roadmap requires
  for canvas, export/import and the future server drawing-alert evaluator.
- **Workspace schema v9**: additive composition over the untouched v8
  schema; v7/v8 documents remain byte-for-byte valid; the backend accepts
  7|8|9 and rejects newer; lineage advance covered by contract tests.
- Both tools live in the shared bottom-sheet catalog (21 tools, 7 groups;
  the fragile positional slices are replaced by group filters) with en/ru/kk
  labels; no reduced mobile set.

## Release chronology (no-migration release)

Only project resources were used (units `saltanatbotv2*`, container
`11-postgres-1` at `127.0.0.1:55434`, data dir `/home/arman/11/backend/data`,
port 4180 unchanged).

| Step | Generation / resource | Result |
| --- | --- | --- |
| Pre-cutover generation `pre-r5tools-schema16-v9-20260718T040000Z` | `7a734401-c578-458a-a1e0-eae61eb01376` | Backup + verify passed at schema 16 |
| Production cutover | slot `r5f-schema16-2ff6101` | Drop-ins installed for all three units; restart through the slot launchers with a byte-identical migration ledger (schema unchanged); all three units active with `NRestarts=0`; `/api/ready` `ready`; served asset SHA-256 identical to the slot frontend dist |
| Post-cutover generation `post-r5tools-schema16-v9-20260718T042000Z` | `83c4b37e-7eb0-414a-a3fe-aa02818ec070` | Backup + verify passed at schema 16; isolated drill passed and self-cleaned |

Rollback remains replacement-only; the previous accepted slot
`r5e-schema16-17e12f1` and the verified pre-cutover generation are retained.
