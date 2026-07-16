# Owner-scoped workspace API

PostgreSQL schema v10 stores one current workflow document plus bounded immutable content
snapshots. The database wrapper `revision` is the optimistic-concurrency fence; it is deliberately
independent from the workflow payload's own `revision/history`.
For schema v8, server-created content mutations preserve that separation while advancing content
lineage: rename increments the current payload revision, and rollback restores the selected state
with `currentPayload.revision + 1`; both set payload `savedAt/updatedAt` to server time. Archive and
restore change only wrapper metadata. Legacy schema v1–v7 payload revision fields remain untouched.

Current schema v8 strictly validates the saved chart/workflow contract: layout, 1–4 chart panes,
timezone and market routing, full indicator settings, compare overlays, drawing scopes, selected
strategy revision and bounded history. Existing schema v1–v7 API writes remain readable/updateable
for compatibility. File import accepts strict v8 and checksum-protected strict v7 files; older
unversioned shapes must first be opened/migrated by a compatible frontend.

## HTTP contract

All routes require the authenticated owner and, in database auth mode, the exact
`X-SBV2-Expected-User` header. Responses are `Cache-Control: no-store`.

- `GET /api/workspaces?status=active|archived|all` lists owner documents in UUID order and quota
  usage. `cursor=<last UUID>` and `limit=1..25` provide stable keyset pages;
  `includeArchived=true` is an additive alias for `status=all`.
- `GET /api/workspaces/quota` returns the current quota snapshot.
- `POST /api/workspaces` creates `{clientId,name,schemaVersion,payload}`.
- `PUT /api/workspaces/:id` replaces an active document and requires wrapper `revision`.
- `PATCH /api/workspaces/:id/name` renames an active document with `{revision,name}`.
- `POST /api/workspaces/:id/duplicate` copies an active or archived document into a new active
  document with `{revision,clientId,name?}`.
- `DELETE /api/workspaces/:id?revision=N` is backward-compatible archive.
- `POST /api/workspaces/:id/archive` accepts `{revision}`; `archived:false` is a restore alias.
- `POST /api/workspaces/:id/restore` accepts `{revision}`.
- `DELETE /api/workspaces/:id/permanent?revision=N` permanently deletes only an already archived
  workspace and cascades its revisions.
- `GET /api/workspaces/:id/export` returns the portable
  `saltanatbotv2.workspace` v1 SHA-256 envelope.
- `POST /api/workspaces/import` accepts that strict v8/v7 envelope directly or as
  `{document,clientId?,name?}`.
- `GET /api/workspaces/:id/revisions` uses descending revision keysets with
  `cursor=<last revision>` and `limit=1..10`. `POST /api/workspaces/:id/rollback` is same-schema
  only; cross-schema history is rejected with `workspace_invalid_transition` so a legacy document
  cannot corrupt v8 content lineage.

List and revision responses include
`page={itemLimit,responseByteLimit,returnedItems,returnedPayloadBytes,responseBytes,hasMore,nextCursor}`.
Every serialized page, including wrappers and quota, is at most 4 MiB. The repository reads bounded
payload metadata first and fetches only rows selected for the page. A list page and its quota are
read in one read-only repeatable-read transaction; separate pages intentionally use separate
snapshots, while immutable UUID ordering and client-side de-duplication make traversal stable under
concurrent updates.

Conflict responses use `409 workspace_conflict` with full `current` for old clients and
payload-free `currentMetadata` for conflict UI. Archived documents reject update, rename and
rollback with `workspace_archived`. Active permanent deletion rejects with
`workspace_not_archived`. Quota errors are
`workspace_active_quota_exceeded`, `workspace_total_quota_exceeded`,
`workspace_storage_quota_exceeded`, `workspace_document_too_large` and
`workspace_database_document_too_large` and `workspace_envelope_too_large`.
`maxDocumentBytes` limits compact JSON to at most 1 MiB. Before writing, the iterative validator
also bounds PostgreSQL `jsonb::text` bytes from separator spacing and exact finite-number exponent
expansion. Persisted current/revision rows are capped at 4 MiB minus a 64 KiB response-envelope
reserve, and schema v10 enforces the same database constraint. JSON request and file-import
envelopes receive a separate 64 KiB allowance, so the API can re-import its compact export at the
document limit.
Their `quota` object is always reread after transaction rollback and therefore
describes durable committed usage. The optional `attempted` object describes the
rejected projected counts/bytes (or oversized payload/envelope bytes); clients must not
replace durable usage with that projection.

Every mutation locks the owner row, requires `status=active` plus the authenticated principal's
exact durable authorization revision, and completes document, revision pruning and quota
evaluation in one transaction. A request that waited behind disable/role/password fencing fails
with `workspace_authorization_changed` before writing. Over-limit writes roll back. Archive and
archived-only purge remain available even when an operator has lowered quotas below existing
usage; restore is quota-enforced.
