import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { WorkspaceInput } from "./documentContract.js";
import { workspaceChecksum } from "./documentContract.js";
import type {
  WorkspaceCurrentMetadata,
  WorkspaceDocument
} from "./repository.js";
import {
  assertWorkspaceQuota,
  quotaSnapshot,
  type WorkspaceQuotaLimits,
  type WorkspaceQuotaSnapshot,
  type WorkspaceQuotaUsage
} from "./quotas.js";

export interface WorkspaceRow {
  id: string;
  client_id: string;
  name: string;
  schema_version: number;
  payload: Record<string, unknown>;
  payload_bytes: string;
  revision: string;
  archived_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface QuotaUsageRow {
  active_count: string;
  total_count: string;
  payload_bytes_used: string;
}

export const workspaceColumns =
  "id, client_id, name, schema_version, payload, payload_bytes, revision, archived_at, created_at, updated_at";
export const workspaceSelect = `SELECT ${workspaceColumns}`;

export async function insertWorkspace(
  client: PoolClient,
  ownerUserId: string,
  input: WorkspaceInput
): Promise<WorkspaceRow | undefined> {
  const result = await client.query<WorkspaceRow>(
    `INSERT INTO workspaces (
       id, owner_user_id, client_id, name, schema_version, payload, content_hash
     ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)
     ON CONFLICT (owner_user_id, client_id) WHERE deleted_at IS NULL DO NOTHING
     RETURNING ${workspaceColumns}`,
    [
      randomUUID(),
      ownerUserId,
      input.clientId,
      input.name,
      input.schemaVersion,
      JSON.stringify(input.payload),
      workspaceChecksum(input.payload)
    ]
  );
  return result.rows[0];
}

export async function insertRevision(
  client: PoolClient,
  ownerUserId: string,
  row: WorkspaceRow
): Promise<void> {
  await client.query(
    `INSERT INTO workspace_revisions (
       workspace_id, owner_user_id, revision, name, schema_version,
       payload, content_hash, created_by_user_id
     ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$2)`,
    [
      row.id,
      ownerUserId,
      row.revision,
      row.name,
      row.schema_version,
      JSON.stringify(row.payload),
      workspaceChecksum(row.payload)
    ]
  );
}

export async function pruneRevisions(
  client: PoolClient,
  ownerUserId: string,
  workspaceId: string,
  limit: number
): Promise<void> {
  await client.query(
    `DELETE FROM workspace_revisions
     WHERE owner_user_id = $1 AND workspace_id = $2
       AND revision NOT IN (
         SELECT revision
         FROM workspace_revisions
         WHERE owner_user_id = $1 AND workspace_id = $2
         ORDER BY revision DESC
         LIMIT $3
       )`,
    [ownerUserId, workspaceId, limit]
  );
}

export async function findWorkspaceById(
  client: PoolClient,
  ownerUserId: string,
  id: string,
  forUpdate = false
): Promise<WorkspaceRow | undefined> {
  const result = await client.query<WorkspaceRow>(
    `${workspaceSelect}
     FROM workspaces
     WHERE owner_user_id = $1 AND id = $2 AND deleted_at IS NULL
     ${forUpdate ? "FOR UPDATE" : ""}`,
    [ownerUserId, id]
  );
  return result.rows[0];
}

export async function findWorkspaceByClientId(
  client: PoolClient,
  ownerUserId: string,
  clientId: string
): Promise<WorkspaceDocument | undefined> {
  const result = await client.query<WorkspaceRow>(
    `${workspaceSelect}
     FROM workspaces
     WHERE owner_user_id = $1 AND client_id = $2 AND deleted_at IS NULL`,
    [ownerUserId, clientId]
  );
  return result.rows[0] && mapWorkspace(result.rows[0]);
}

export async function enforceWorkspaceQuota(
  client: PoolClient,
  ownerUserId: string,
  limits: WorkspaceQuotaLimits
): Promise<WorkspaceQuotaSnapshot> {
  const snapshot = quotaSnapshot(
    await readWorkspaceQuotaUsage(client, ownerUserId),
    limits
  );
  assertWorkspaceQuota(snapshot);
  return snapshot;
}

export async function readWorkspaceQuotaUsage(
  database: Pick<Pool, "query"> | Pick<PoolClient, "query">,
  ownerUserId: string
): Promise<WorkspaceQuotaUsage> {
  const result = await database.query<QuotaUsageRow>(
    `SELECT
       (
         SELECT count(*)::text
         FROM workspaces
         WHERE owner_user_id = $1 AND deleted_at IS NULL AND archived_at IS NULL
       ) AS active_count,
       (
         SELECT count(*)::text
         FROM workspaces
         WHERE owner_user_id = $1 AND deleted_at IS NULL
       ) AS total_count,
       (
         COALESCE((
           SELECT sum(payload_bytes)
           FROM workspaces
           WHERE owner_user_id = $1 AND deleted_at IS NULL
         ), 0)
         +
         COALESCE((
           SELECT sum(r.payload_bytes)
           FROM workspace_revisions r
           JOIN workspaces w
             ON w.id = r.workspace_id AND w.owner_user_id = r.owner_user_id
           WHERE r.owner_user_id = $1 AND w.deleted_at IS NULL
         ), 0)
       )::text AS payload_bytes_used`,
    [ownerUserId]
  );
  const row = result.rows[0];
  return {
    activeCount: safeDatabaseInteger(row?.active_count, "active workspace count"),
    totalCount: safeDatabaseInteger(row?.total_count, "total workspace count"),
    payloadBytesUsed: safeDatabaseInteger(
      row?.payload_bytes_used,
      "workspace payload bytes"
    )
  };
}

export function isClientIdConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const postgresError = error as { code?: unknown; constraint?: unknown };
  return (
    postgresError.code === "23505" &&
    postgresError.constraint === "workspaces_owner_client_id_active_unique"
  );
}

export function mapWorkspace(row: WorkspaceRow): WorkspaceDocument {
  const revision = safeDatabaseInteger(row.revision, "workspace revision");
  const status = row.archived_at ? "archived" : "active";
  return {
    id: row.id,
    clientId: row.client_id,
    name: row.name,
    schemaVersion: row.schema_version,
    payload: row.payload,
    revision,
    status,
    archivedAt: row.archived_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

export function workspaceMetadata(
  workspace: WorkspaceDocument
): WorkspaceCurrentMetadata {
  const { payload: _payload, ...metadata } = workspace;
  return metadata;
}

export function mapRowInput(row: WorkspaceRow): WorkspaceInput {
  return {
    clientId: row.client_id,
    name: row.name,
    schemaVersion: row.schema_version,
    payload: row.payload
  };
}

export function safeDatabaseInteger(value: string | undefined, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid ${label} in database`);
  }
  return parsed;
}

export function defaultDuplicateName(name: string): string {
  const suffix = " copy";
  return `${name.slice(0, 120 - suffix.length)}${suffix}`;
}
