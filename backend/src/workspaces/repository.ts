import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

export interface WorkspaceInput {
  clientId: string;
  name: string;
  schemaVersion: number;
  payload: Record<string, unknown>;
}

export interface WorkspaceDocument extends WorkspaceInput {
  id: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

interface WorkspaceRow {
  id: string;
  client_id: string;
  name: string;
  schema_version: number;
  payload: Record<string, unknown>;
  revision: string;
  created_at: Date;
  updated_at: Date;
}

export class WorkspaceConflictError extends Error {
  constructor(readonly current?: WorkspaceDocument) {
    super("Workspace revision conflict");
  }
}

export class WorkspaceRepository {
  constructor(private readonly pool: Pool) {}

  async list(ownerUserId: string): Promise<WorkspaceDocument[]> {
    const result = await this.pool.query<WorkspaceRow>(
      `SELECT id, client_id, name, schema_version, payload, revision, created_at, updated_at
       FROM workspaces WHERE owner_user_id = $1 AND deleted_at IS NULL ORDER BY updated_at DESC`,
      [ownerUserId]
    );
    return result.rows.map(mapWorkspace);
  }

  async get(ownerUserId: string, id: string): Promise<WorkspaceDocument | undefined> {
    const result = await this.pool.query<WorkspaceRow>(
      `SELECT id, client_id, name, schema_version, payload, revision, created_at, updated_at
       FROM workspaces WHERE owner_user_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [ownerUserId, id]
    );
    return result.rows[0] && mapWorkspace(result.rows[0]);
  }

  async create(ownerUserId: string, input: WorkspaceInput): Promise<WorkspaceDocument> {
    const id = randomUUID();
    const contentHash = hashPayload(input.payload);
    return this.transaction(async (client) => {
      const result = await client.query<WorkspaceRow>(
        `INSERT INTO workspaces (id, owner_user_id, client_id, name, schema_version, payload, content_hash)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)
         ON CONFLICT (owner_user_id, client_id) WHERE deleted_at IS NULL DO NOTHING
         RETURNING id, client_id, name, schema_version, payload, revision, created_at, updated_at`,
        [id, ownerUserId, input.clientId, input.name, input.schemaVersion, JSON.stringify(input.payload), contentHash]
      );
      const row = result.rows[0];
      if (!row) {
        const existing = await this.findByClientId(client, ownerUserId, input.clientId);
        throw new WorkspaceConflictError(existing);
      }
      await insertRevision(client, ownerUserId, row, contentHash);
      return mapWorkspace(row);
    });
  }

  async update(ownerUserId: string, id: string, expectedRevision: number, input: WorkspaceInput): Promise<WorkspaceDocument> {
    const contentHash = hashPayload(input.payload);
    try {
      return await this.transaction(async (client) => {
        const result = await client.query<WorkspaceRow>(
          `UPDATE workspaces SET
             client_id = $4, name = $5, schema_version = $6, payload = $7::jsonb,
             content_hash = $8, revision = revision + 1, updated_at = clock_timestamp()
           WHERE owner_user_id = $1 AND id = $2 AND revision = $3 AND deleted_at IS NULL
           RETURNING id, client_id, name, schema_version, payload, revision, created_at, updated_at`,
          [ownerUserId, id, expectedRevision, input.clientId, input.name, input.schemaVersion, JSON.stringify(input.payload), contentHash]
        );
        const row = result.rows[0];
        if (!row) throw new WorkspaceConflictError(await this.findById(client, ownerUserId, id));
        await insertRevision(client, ownerUserId, row, contentHash);
        await pruneRevisions(client, id);
        return mapWorkspace(row);
      });
    } catch (error) {
      if (!isClientIdConflict(error)) throw error;
      throw new WorkspaceConflictError(await this.getByClientId(ownerUserId, input.clientId));
    }
  }

  async remove(ownerUserId: string, id: string, expectedRevision: number): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE workspaces SET deleted_at = clock_timestamp(), updated_at = clock_timestamp(), revision = revision + 1
       WHERE owner_user_id = $1 AND id = $2 AND revision = $3 AND deleted_at IS NULL`,
      [ownerUserId, id, expectedRevision]
    );
    if (result.rowCount === 1) return true;
    const current = await this.get(ownerUserId, id);
    if (current) throw new WorkspaceConflictError(current);
    return false;
  }

  async revisions(ownerUserId: string, id: string): Promise<WorkspaceDocument[]> {
    const result = await this.pool.query<WorkspaceRow>(
      `SELECT w.id, w.client_id, r.name, r.schema_version, r.payload, r.revision,
              w.created_at, r.created_at AS updated_at
       FROM workspace_revisions r
       JOIN workspaces w ON w.id = r.workspace_id AND w.owner_user_id = r.owner_user_id
       WHERE r.owner_user_id = $1 AND r.workspace_id = $2
       ORDER BY r.revision DESC LIMIT 20`,
      [ownerUserId, id]
    );
    return result.rows.map(mapWorkspace);
  }

  async rollback(ownerUserId: string, id: string, expectedRevision: number, targetRevision: number): Promise<WorkspaceDocument> {
    return this.transaction(async (client) => {
      const target = await client.query<WorkspaceRow>(
        `SELECT w.id, w.client_id, r.name, r.schema_version, r.payload, r.revision,
                w.created_at, r.created_at AS updated_at
         FROM workspace_revisions r
         JOIN workspaces w ON w.id = r.workspace_id AND w.owner_user_id = r.owner_user_id
         WHERE r.owner_user_id = $1 AND r.workspace_id = $2 AND r.revision = $3`,
        [ownerUserId, id, targetRevision]
      );
      const snapshot = target.rows[0];
      if (!snapshot) throw new Error("workspace_revision_not_found");
      const contentHash = hashPayload(snapshot.payload);
      const updated = await client.query<WorkspaceRow>(
        `UPDATE workspaces SET name = $4, schema_version = $5, payload = $6::jsonb,
           content_hash = $7, revision = revision + 1, updated_at = clock_timestamp()
         WHERE owner_user_id = $1 AND id = $2 AND revision = $3 AND deleted_at IS NULL
         RETURNING id, client_id, name, schema_version, payload, revision, created_at, updated_at`,
        [ownerUserId, id, expectedRevision, snapshot.name, snapshot.schema_version, JSON.stringify(snapshot.payload), contentHash]
      );
      const row = updated.rows[0];
      if (!row) throw new WorkspaceConflictError(await this.findById(client, ownerUserId, id));
      await insertRevision(client, ownerUserId, row, contentHash);
      await pruneRevisions(client, id);
      return mapWorkspace(row);
    });
  }

  private async findById(client: PoolClient, ownerUserId: string, id: string): Promise<WorkspaceDocument | undefined> {
    const result = await client.query<WorkspaceRow>(
      `SELECT id, client_id, name, schema_version, payload, revision, created_at, updated_at
       FROM workspaces WHERE owner_user_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [ownerUserId, id]
    );
    return result.rows[0] && mapWorkspace(result.rows[0]);
  }

  private async findByClientId(client: PoolClient, ownerUserId: string, clientId: string): Promise<WorkspaceDocument | undefined> {
    const result = await client.query<WorkspaceRow>(
      `SELECT id, client_id, name, schema_version, payload, revision, created_at, updated_at
       FROM workspaces WHERE owner_user_id = $1 AND client_id = $2 AND deleted_at IS NULL`,
      [ownerUserId, clientId]
    );
    return result.rows[0] && mapWorkspace(result.rows[0]);
  }

  private async getByClientId(ownerUserId: string, clientId: string): Promise<WorkspaceDocument | undefined> {
    const result = await this.pool.query<WorkspaceRow>(
      `SELECT id, client_id, name, schema_version, payload, revision, created_at, updated_at
       FROM workspaces WHERE owner_user_id = $1 AND client_id = $2 AND deleted_at IS NULL`,
      [ownerUserId, clientId]
    );
    return result.rows[0] && mapWorkspace(result.rows[0]);
  }

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

async function insertRevision(client: PoolClient, ownerUserId: string, row: WorkspaceRow, contentHash: string): Promise<void> {
  await client.query(
    `INSERT INTO workspace_revisions (
       workspace_id, owner_user_id, revision, name, schema_version, payload, content_hash, created_by_user_id
     ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$2)`,
    [row.id, ownerUserId, row.revision, row.name, row.schema_version, JSON.stringify(row.payload), contentHash]
  );
}

async function pruneRevisions(client: PoolClient, workspaceId: string): Promise<void> {
  await client.query(
    `DELETE FROM workspace_revisions WHERE workspace_id = $1 AND revision NOT IN (
       SELECT revision FROM workspace_revisions WHERE workspace_id = $1 ORDER BY revision DESC LIMIT 20
     )`,
    [workspaceId]
  );
}

function isClientIdConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const postgresError = error as { code?: unknown; constraint?: unknown };
  return postgresError.code === "23505" && postgresError.constraint === "workspaces_owner_client_id_active_unique";
}

function mapWorkspace(row: WorkspaceRow): WorkspaceDocument {
  const revision = Number(row.revision);
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("Invalid workspace revision in database");
  return {
    id: row.id,
    clientId: row.client_id,
    name: row.name,
    schemaVersion: row.schema_version,
    payload: row.payload,
    revision,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

function hashPayload(payload: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
}
