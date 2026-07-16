# Workspace domain

This folder owns owner-scoped, portable workspace state and authenticated synchronization. React presentation stays in `components/topbar/WorkspacesMenu.tsx`; persisted JSON must always pass the domain parsers here.

## Schema v8

`workspaces.ts` stores the complete reproducible workspace:

- monitoring, strategy, trade and screener mode;
- one, vertical-split, horizontal-split and four-chart layouts;
- chart symbol, timeframe, type, market/price source, timezone and link settings;
- full indicator definitions, per-pane overrides and comparison overlays;
- chart-scoped drawings;
- an optional strategy artifact reference with revision, hash and parameters;
- bounded local history for unauthenticated/offline rollback.

Schema v7 is the only portable legacy import shape. It is validated exactly and then hydrated into v8. Missing legacy indicator IDs are reported instead of silently enabling an unrelated indicator. Older local-storage snapshots may still be normalized for backwards-compatible browser migration, but are not accepted as portable imports.

## Server wrapper and revisions

The authenticated API owns wrapper metadata: server document ID, client ID, optimistic wrapper revision, active/archived status, archive timestamp and quota. Archive state never belongs in the v8 payload.

The v8 payload also has a content `revision`, `savedAt` and `updatedAt`. Server mutations advance that lineage. Name-only changes use `PATCH /api/workspaces/:id/name`; content changes use the full optimistic `PUT`. Server revision history and rollback are authoritative across devices, while local history remains a convenience cache.

## Synchronization rules

`remoteSync.ts` exposes explicit `loading`, `saving`, `saved`, `offline`, `conflict`, `quota` and `failed` states.

- A `409` is never overwritten automatically.
- Concurrent conflicts are queued and resolved one at a time.
- A workspace deleted on another device becomes a `workspace_deleted` conflict; local edits are kept until the user discards them or saves a copy with a new client ID.
- Per-workspace mutations are serialized, including create/update/archive/restore, rollback and permanent purge.
- Quota-reducing archive operations run before quota-increasing creates/restores.
- Permanent local removal happens only after a server purge acknowledgement or an authoritative list proves that no remote document exists.
- Late responses from a disposed authentication session do not publish state or callbacks.
- UUID-ordered list pages are exhausted sequentially and de-duplicated by client ID before absence,
  conflict or tombstone decisions. The same pager protects purge recovery.
- Rollback walks descending revision pages only until it finds a materially different prior
  snapshot or exhausts history.
- Legacy servers without page metadata remain one-page compatible. New pagination fails closed on
  repeated/non-advancing cursors, more than 128 list or 32 revision pages, a page above 4 MiB, or
  an aggregate collection above 80 MiB.

Known remote client IDs are retained as tombstones so stale browser cache cannot recreate a server-purged workspace as if it were new.

## Import, export and public HTTP

`.saltanat-workspace.json` files use canonical JSON plus SHA-256. Import validates the exact envelope, checksum, optional metadata and v7/v8 payload before normalization. The persisted payload is limited to 1 MiB by default; the compact file/request envelope has a separate fixed 64 KiB overhead allowance.

Web Crypto is preferred. `security/browserSha256.ts` provides a deterministic SHA-256 fallback for the current pre-HTTPS/public-HTTP deployment, where `crypto.subtle` may be unavailable. It is only an integrity checksum, never password hashing.

## Browser ownership migration

`tenantLocalStorage.ts` assigns pre-authentication browser data to at most one database user. Web Locks provide the primary cross-tab barrier; an IndexedDB atomic add-if-absent claim is the fallback. If neither is available, migration fails closed and does not expose legacy data to a second owner.

Primary regression suites:

- `frontend/tests/workspaces.test.ts`
- `frontend/tests/workspaceRemoteSync.test.ts`
- `frontend/tests/tenantPrivateStorage.test.ts`
- `frontend/tests/usePersistentDrawings.test.tsx`
