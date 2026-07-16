import type { PoolClient } from "pg";
import {
  quotaSnapshot,
  type WorkspaceQuotaLimits,
  type WorkspaceQuotaSnapshot
} from "./quotas.js";
import type { WorkspaceDocument } from "./repository.js";
import {
  mapWorkspace,
  readWorkspaceQuotaUsage,
  safeDatabaseInteger,
  workspaceColumns,
  type WorkspaceRow
} from "./repositorySupport.js";
import { WORKSPACE_RESPONSE_BYTE_LIMIT } from "./workspaceLimits.js";

export const WORKSPACE_LIST_PAGE_MAX_ITEMS = 25;
export const WORKSPACE_REVISION_PAGE_MAX_ITEMS = 10;
export { WORKSPACE_RESPONSE_BYTE_LIMIT } from "./workspaceLimits.js";

export type WorkspaceStatus = "active" | "archived";
export type WorkspaceListStatus = WorkspaceStatus | "all";

export interface WorkspacePageMetadata {
  itemLimit: number;
  responseByteLimit: number;
  returnedItems: number;
  returnedPayloadBytes: number;
  responseBytes: number;
  hasMore: boolean;
  nextCursor: string | null;
}

export interface WorkspaceListPage {
  workspaces: WorkspaceDocument[];
  quota: WorkspaceQuotaSnapshot;
  page: WorkspacePageMetadata;
}

export interface WorkspaceRevisionPage {
  revisions: WorkspaceDocument[];
  page: WorkspacePageMetadata;
}

export class WorkspaceResponseItemTooLargeError extends Error {
  readonly code = "workspace_response_item_too_large";

  constructor() {
    super("A persisted workspace cannot fit within the bounded response.");
    this.name = "WorkspaceResponseItemTooLargeError";
  }
}

interface PayloadMetadataRow {
  id: string;
  payload_bytes: string;
}

interface RevisionPayloadMetadataRow {
  revision: string;
  payload_bytes: string;
}

interface PageEntry {
  cursor: string;
  payloadBytes: number;
  workspace: WorkspaceDocument;
}

export async function readWorkspaceListPage(
  client: PoolClient,
  ownerUserId: string,
  status: WorkspaceListStatus,
  cursor: string | undefined,
  itemLimit: number,
  limits: WorkspaceQuotaLimits
): Promise<WorkspaceListPage> {
  const statusClause =
    status === "active"
      ? "AND archived_at IS NULL"
      : status === "archived"
        ? "AND archived_at IS NOT NULL"
        : "";
  const metadata = await client.query<PayloadMetadataRow>(
    `SELECT id, payload_bytes::text
     FROM workspaces
     WHERE owner_user_id = $1 AND deleted_at IS NULL
       ${statusClause}
       AND ($2::uuid IS NULL OR id > $2::uuid)
     ORDER BY id ASC
     LIMIT $3`,
    [ownerUserId, cursor ?? null, itemLimit + 1]
  );
  const selected = selectMetadata(
    metadata.rows.map((row) => ({
      cursor: row.id,
      payloadBytes: safeDatabaseInteger(
        row.payload_bytes,
        "workspace payload bytes"
      )
    })),
    itemLimit
  );
  const rows = selected.entries.length
    ? await client.query<WorkspaceRow>(
        `SELECT ${workspaceColumns}
         FROM workspaces
         WHERE owner_user_id = $1 AND deleted_at IS NULL
           ${statusClause}
           AND id = ANY($2::uuid[])
         ORDER BY id ASC`,
        [ownerUserId, selected.entries.map((entry) => entry.cursor)]
      )
    : { rows: [] as WorkspaceRow[] };
  const entries = mapEntries(rows.rows, selected.entries, (row) => row.id);
  const quota = quotaSnapshot(
    await readWorkspaceQuotaUsage(client, ownerUserId),
    limits
  );
  return fitResponsePage(
    "workspaces",
    entries,
    selected.hasMore,
    itemLimit,
    { quota }
  );
}

export async function readWorkspaceRevisionPage(
  client: PoolClient,
  ownerUserId: string,
  workspaceId: string,
  cursor: number | undefined,
  itemLimit: number
): Promise<WorkspaceRevisionPage> {
  const metadata = await client.query<RevisionPayloadMetadataRow>(
    `SELECT r.revision::text, r.payload_bytes::text
     FROM workspace_revisions r
     JOIN workspaces w
       ON w.id = r.workspace_id AND w.owner_user_id = r.owner_user_id
     WHERE r.owner_user_id = $1 AND r.workspace_id = $2
       AND w.deleted_at IS NULL
       AND ($3::bigint IS NULL OR r.revision < $3::bigint)
     ORDER BY r.revision DESC
     LIMIT $4`,
    [ownerUserId, workspaceId, cursor ?? null, itemLimit + 1]
  );
  const selected = selectMetadata(
    metadata.rows.map((row) => ({
      cursor: row.revision,
      payloadBytes: safeDatabaseInteger(
        row.payload_bytes,
        "workspace revision payload bytes"
      )
    })),
    itemLimit
  );
  const rows = selected.entries.length
    ? await client.query<WorkspaceRow>(
        `SELECT w.id, w.client_id, r.name, r.schema_version, r.payload,
                r.payload_bytes, r.revision, w.archived_at,
                w.created_at, r.created_at AS updated_at
         FROM workspace_revisions r
         JOIN workspaces w
           ON w.id = r.workspace_id AND w.owner_user_id = r.owner_user_id
         WHERE r.owner_user_id = $1 AND r.workspace_id = $2
           AND w.deleted_at IS NULL
           AND r.revision = ANY($3::bigint[])
         ORDER BY r.revision DESC`,
        [
          ownerUserId,
          workspaceId,
          selected.entries.map((entry) => entry.cursor)
        ]
      )
    : { rows: [] as WorkspaceRow[] };
  const entries = mapEntries(
    rows.rows,
    selected.entries,
    (row) => row.revision
  );
  return fitResponsePage(
    "revisions",
    entries,
    selected.hasMore,
    itemLimit
  );
}

function selectMetadata(
  entries: Array<{ cursor: string; payloadBytes: number }>,
  itemLimit: number
): {
  entries: Array<{ cursor: string; payloadBytes: number }>;
  hasMore: boolean;
} {
  const selected: Array<{ cursor: string; payloadBytes: number }> = [];
  let payloadBytes = 0;
  for (const entry of entries) {
    if (
      selected.length >= itemLimit ||
      payloadBytes + entry.payloadBytes > WORKSPACE_RESPONSE_BYTE_LIMIT
    ) {
      break;
    }
    selected.push(entry);
    payloadBytes += entry.payloadBytes;
  }
  if (entries.length > 0 && selected.length === 0) {
    throw new WorkspaceResponseItemTooLargeError();
  }
  return { entries: selected, hasMore: selected.length < entries.length };
}

function mapEntries(
  rows: WorkspaceRow[],
  metadata: Array<{ cursor: string; payloadBytes: number }>,
  cursor: (row: WorkspaceRow) => string
): PageEntry[] {
  if (rows.length !== metadata.length) {
    throw new Error("Workspace page changed inside a repeatable-read snapshot.");
  }
  return rows.map((row, index) => {
    const entry = metadata[index];
    if (!entry || cursor(row) !== entry.cursor) {
      throw new Error("Workspace page order changed inside a repeatable-read snapshot.");
    }
    return {
      cursor: entry.cursor,
      payloadBytes: entry.payloadBytes,
      workspace: mapWorkspace(row)
    };
  });
}

function fitResponsePage<Key extends "workspaces" | "revisions">(
  key: Key,
  candidates: PageEntry[],
  hasMoreAfterCandidates: boolean,
  itemLimit: number,
  extra: Record<string, unknown> = {}
): Key extends "workspaces" ? WorkspaceListPage : WorkspaceRevisionPage {
  let entries = candidates;
  while (true) {
    const hasMore =
      hasMoreAfterCandidates || entries.length < candidates.length;
    const nextCursor =
      hasMore && entries.length > 0 ? entries.at(-1)!.cursor : null;
    const pageBase = {
      itemLimit,
      responseByteLimit: WORKSPACE_RESPONSE_BYTE_LIMIT,
      returnedItems: entries.length,
      returnedPayloadBytes: entries.reduce(
        (total, entry) => total + entry.payloadBytes,
        0
      ),
      hasMore,
      nextCursor
    };
    let responseBytes = 0;
    let body: Record<string, unknown> = {};
    for (let attempt = 0; attempt < 4; attempt += 1) {
      body = {
        [key]: entries.map((entry) => entry.workspace),
        ...extra,
        page: { ...pageBase, responseBytes }
      };
      const measured = Buffer.byteLength(JSON.stringify(body), "utf8");
      if (measured === responseBytes) break;
      responseBytes = measured;
    }
    body = {
      [key]: entries.map((entry) => entry.workspace),
      ...extra,
      page: { ...pageBase, responseBytes }
    };
    const measured = Buffer.byteLength(JSON.stringify(body), "utf8");
    if (measured <= WORKSPACE_RESPONSE_BYTE_LIMIT && measured === responseBytes) {
      return body as unknown as Key extends "workspaces"
        ? WorkspaceListPage
        : WorkspaceRevisionPage;
    }
    if (entries.length <= 1) throw new WorkspaceResponseItemTooLargeError();
    entries = entries.slice(0, -1);
  }
}
