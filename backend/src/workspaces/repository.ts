import type { Pool, PoolClient } from "pg";
import {
  advanceWorkspaceV8Content,
  assertWorkspaceInputSize,
  type WorkspaceInput,
  withWorkspaceIdentity,
  workspaceChecksum,
  workspaceInputSchema
} from "./documentContract.js";
import {
  loadWorkspaceQuotaLimits,
  quotaSnapshot,
  type WorkspaceQuotaLimits,
  type WorkspaceQuotaSnapshot
} from "./quotas.js";
import {
  WorkspaceArchivedError,
  WorkspaceAuthorizationChangedError,
  WorkspaceConflictError,
  WorkspaceInvalidTransitionError,
  WorkspaceNotArchivedError,
  WorkspaceNotFoundError
} from "./repositoryErrors.js";
import {
  defaultDuplicateName,
  enforceWorkspaceQuota,
  findWorkspaceByClientId,
  findWorkspaceById,
  insertRevision,
  insertWorkspace,
  isClientIdConflict,
  mapRowInput,
  mapWorkspace,
  pruneRevisions,
  readWorkspaceQuotaUsage,
  workspaceColumns,
  workspaceSelect,
  type WorkspaceRow
} from "./repositorySupport.js";
import {
  readWorkspaceListPage,
  readWorkspaceRevisionPage,
  type WorkspaceListPage,
  type WorkspaceListStatus,
  type WorkspaceRevisionPage,
  type WorkspaceStatus
} from "./workspacePagination.js";

export type {
  WorkspaceListPage,
  WorkspaceListStatus,
  WorkspaceRevisionPage,
  WorkspaceStatus
} from "./workspacePagination.js";

export interface WorkspaceDocument extends WorkspaceInput {
  id: string;
  revision: number;
  status: WorkspaceStatus;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type WorkspaceCurrentMetadata = Omit<WorkspaceDocument, "payload">;

export class WorkspaceRepository {
  constructor(
    private readonly pool: Pool,
    readonly limits: WorkspaceQuotaLimits = loadWorkspaceQuotaLimits()
  ) {}

  async quota(ownerUserId: string): Promise<WorkspaceQuotaSnapshot> {
    return quotaSnapshot(
      await readWorkspaceQuotaUsage(this.pool, ownerUserId),
      this.limits
    );
  }

  async listPage(
    ownerUserId: string,
    status: WorkspaceListStatus,
    cursor: string | undefined,
    itemLimit: number
  ): Promise<WorkspaceListPage> {
    return this.readTransaction((client) =>
      readWorkspaceListPage(
        client,
        ownerUserId,
        status,
        cursor,
        itemLimit,
        this.limits
      )
    );
  }

  async get(ownerUserId: string, id: string): Promise<WorkspaceDocument | undefined> {
    const result = await this.pool.query<WorkspaceRow>(
      `${workspaceSelect}
       FROM workspaces
       WHERE owner_user_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [ownerUserId, id]
    );
    return result.rows[0] && mapWorkspace(result.rows[0]);
  }

  async create(
    ownerUserId: string,
    input: WorkspaceInput,
    authorizationRevision: number
  ): Promise<{ workspace: WorkspaceDocument; quota: WorkspaceQuotaSnapshot }> {
    workspaceInputSchema.parse(input);
    assertWorkspaceInputSize(input, this.limits);
    try {
      return await this.transaction(
        ownerUserId,
        authorizationRevision,
        async (client) => {
        const workspace = await insertWorkspace(client, ownerUserId, input);
        if (!workspace) {
          throw new WorkspaceConflictError(
            await findWorkspaceByClientId(client, ownerUserId, input.clientId)
          );
        }
        await insertRevision(client, ownerUserId, workspace);
        const quota = await enforceWorkspaceQuota(client, ownerUserId, this.limits);
        return { workspace: mapWorkspace(workspace), quota };
        }
      );
    } catch (error) {
      if (!isClientIdConflict(error)) throw error;
      throw new WorkspaceConflictError(
        await this.getByClientId(ownerUserId, input.clientId)
      );
    }
  }

  async update(
    ownerUserId: string,
    id: string,
    expectedRevision: number,
    input: WorkspaceInput,
    authorizationRevision: number
  ): Promise<{ workspace: WorkspaceDocument; quota: WorkspaceQuotaSnapshot }> {
    workspaceInputSchema.parse(input);
    assertWorkspaceInputSize(input, this.limits);
    try {
      return await this.transaction(
        ownerUserId,
        authorizationRevision,
        async (client) => {
        const result = await client.query<WorkspaceRow>(
          `UPDATE workspaces SET
             name = $5, schema_version = $6, payload = $7::jsonb,
             content_hash = $8, revision = revision + 1, updated_at = clock_timestamp()
           WHERE owner_user_id = $1 AND id = $2 AND revision = $3
             AND client_id = $4 AND deleted_at IS NULL AND archived_at IS NULL
           RETURNING ${workspaceColumns}`,
          [
            ownerUserId,
            id,
            expectedRevision,
            input.clientId,
            input.name,
            input.schemaVersion,
            JSON.stringify(input.payload),
            workspaceChecksum(input.payload)
          ]
        );
        const row = result.rows[0];
        if (!row) await throwMutationConflict(client, ownerUserId, id, true);
        await insertRevision(client, ownerUserId, row!);
        await pruneRevisions(
          client,
          ownerUserId,
          id,
          this.limits.maxRevisionsPerWorkspace
        );
        const quota = await enforceWorkspaceQuota(client, ownerUserId, this.limits);
        return { workspace: mapWorkspace(row!), quota };
        }
      );
    } catch (error) {
      if (!isClientIdConflict(error)) throw error;
      throw new WorkspaceConflictError(
        await this.getByClientId(ownerUserId, input.clientId)
      );
    }
  }

  async rename(
    ownerUserId: string,
    id: string,
    expectedRevision: number,
    name: string,
    authorizationRevision: number
  ): Promise<{ workspace: WorkspaceDocument; quota: WorkspaceQuotaSnapshot }> {
    return this.transaction(ownerUserId, authorizationRevision, async (client) => {
      const current = await requireWorkspaceForUpdate(client, ownerUserId, id);
      if (current.archived_at) {
        throw new WorkspaceArchivedError(mapWorkspace(current));
      }
      if (Number(current.revision) !== expectedRevision) {
        throw new WorkspaceConflictError(mapWorkspace(current));
      }
      const payload = advanceWorkspaceV8Content(
        withWorkspaceIdentity(current.payload, { name }),
        current.payload
      );
      const input = {
        clientId: current.client_id,
        name,
        schemaVersion: current.schema_version,
        payload
      };
      workspaceInputSchema.parse(input);
      assertWorkspaceInputSize(input, this.limits);
      const updated = await client.query<WorkspaceRow>(
        `UPDATE workspaces SET
           name = $4, payload = $5::jsonb, content_hash = $6,
           revision = revision + 1, updated_at = clock_timestamp()
         WHERE owner_user_id = $1 AND id = $2 AND revision = $3 AND deleted_at IS NULL
         RETURNING ${workspaceColumns}`,
        [
          ownerUserId,
          id,
          expectedRevision,
          name,
          JSON.stringify(payload),
          workspaceChecksum(payload)
        ]
      );
      const row = updated.rows[0];
      if (!row) await throwMutationConflict(client, ownerUserId, id, false);
      await insertRevision(client, ownerUserId, row!);
      await pruneRevisions(
        client,
        ownerUserId,
        id,
        this.limits.maxRevisionsPerWorkspace
      );
      const quota = await enforceWorkspaceQuota(client, ownerUserId, this.limits);
      return { workspace: mapWorkspace(row!), quota };
    });
  }

  async duplicate(
    ownerUserId: string,
    id: string,
    expectedRevision: number,
    clientId: string,
    name: string | undefined,
    authorizationRevision: number
  ): Promise<{ workspace: WorkspaceDocument; quota: WorkspaceQuotaSnapshot }> {
    return this.transaction(ownerUserId, authorizationRevision, async (client) => {
      const source = await requireWorkspaceForUpdate(client, ownerUserId, id);
      if (Number(source.revision) !== expectedRevision) {
        throw new WorkspaceConflictError(mapWorkspace(source));
      }
      const duplicateName = name ?? defaultDuplicateName(source.name);
      const now = Date.now();
      const input: WorkspaceInput = {
        clientId,
        name: duplicateName,
        schemaVersion: source.schema_version,
        payload: withWorkspaceIdentity(source.payload, {
          clientId,
          name: duplicateName,
          resetRevision: true,
          now
        })
      };
      workspaceInputSchema.parse(input);
      assertWorkspaceInputSize(input, this.limits);
      const row = await insertWorkspace(client, ownerUserId, input);
      if (!row) {
        throw new WorkspaceConflictError(
          await findWorkspaceByClientId(client, ownerUserId, clientId)
        );
      }
      await insertRevision(client, ownerUserId, row);
      const quota = await enforceWorkspaceQuota(client, ownerUserId, this.limits);
      return { workspace: mapWorkspace(row), quota };
    });
  }

  async archive(
    ownerUserId: string,
    id: string,
    expectedRevision: number,
    authorizationRevision: number
  ): Promise<{ workspace: WorkspaceDocument; quota: WorkspaceQuotaSnapshot }> {
    return this.setArchived(
      ownerUserId,
      id,
      expectedRevision,
      true,
      authorizationRevision
    );
  }

  async restore(
    ownerUserId: string,
    id: string,
    expectedRevision: number,
    authorizationRevision: number
  ): Promise<{ workspace: WorkspaceDocument; quota: WorkspaceQuotaSnapshot }> {
    return this.setArchived(
      ownerUserId,
      id,
      expectedRevision,
      false,
      authorizationRevision
    );
  }

  async purge(
    ownerUserId: string,
    id: string,
    expectedRevision: number,
    authorizationRevision: number
  ): Promise<{
    purged: Pick<WorkspaceDocument, "id" | "clientId" | "name">;
    quota: WorkspaceQuotaSnapshot;
  }> {
    return this.transaction(ownerUserId, authorizationRevision, async (client) => {
      const current = await requireWorkspaceForUpdate(client, ownerUserId, id);
      const mapped = mapWorkspace(current);
      if (Number(current.revision) !== expectedRevision) {
        throw new WorkspaceConflictError(mapped);
      }
      if (!current.archived_at) throw new WorkspaceNotArchivedError(mapped);
      const removed = await client.query(
        `DELETE FROM workspaces
         WHERE owner_user_id = $1 AND id = $2 AND revision = $3
           AND deleted_at IS NULL AND archived_at IS NOT NULL`,
        [ownerUserId, id, expectedRevision]
      );
      if (removed.rowCount !== 1) {
        await throwMutationConflict(client, ownerUserId, id, false);
      }
      const quota = quotaSnapshot(
        await readWorkspaceQuotaUsage(client, ownerUserId),
        this.limits
      );
      return {
        purged: {
          id: mapped.id,
          clientId: mapped.clientId,
          name: mapped.name
        },
        quota
      };
    });
  }

  async revisionPage(
    ownerUserId: string,
    id: string,
    cursor: number | undefined,
    itemLimit: number
  ): Promise<WorkspaceRevisionPage> {
    return this.readTransaction((client) =>
      readWorkspaceRevisionPage(client, ownerUserId, id, cursor, itemLimit)
    );
  }

  async rollback(
    ownerUserId: string,
    id: string,
    expectedRevision: number,
    targetRevision: number,
    authorizationRevision: number
  ): Promise<{ workspace: WorkspaceDocument; quota: WorkspaceQuotaSnapshot }> {
    return this.transaction(ownerUserId, authorizationRevision, async (client) => {
      const current = await findWorkspaceById(client, ownerUserId, id, true);
      if (!current) throw new Error("workspace_revision_not_found");
      if (current.archived_at) {
        throw new WorkspaceArchivedError(mapWorkspace(current));
      }
      if (Number(current.revision) !== expectedRevision) {
        throw new WorkspaceConflictError(mapWorkspace(current));
      }
      const target = await client.query<WorkspaceRow>(
        `SELECT w.id, w.client_id, r.name, r.schema_version, r.payload,
                r.payload_bytes, r.revision, w.archived_at,
                w.created_at, r.created_at AS updated_at
         FROM workspace_revisions r
         JOIN workspaces w
           ON w.id = r.workspace_id AND w.owner_user_id = r.owner_user_id
         WHERE r.owner_user_id = $1 AND r.workspace_id = $2
           AND r.revision = $3 AND w.deleted_at IS NULL`,
        [ownerUserId, id, targetRevision]
      );
      const snapshot = target.rows[0];
      if (!snapshot) throw new Error("workspace_revision_not_found");
      if (snapshot.schema_version !== current.schema_version) {
        throw new WorkspaceInvalidTransitionError(mapWorkspace(current));
      }
      const targetPayload = withWorkspaceIdentity(snapshot.payload, {
        clientId: current.client_id
      });
      const payload = advanceWorkspaceV8Content(
        targetPayload,
        current.payload
      );
      const input = { ...mapRowInput(snapshot), payload };
      workspaceInputSchema.parse(input);
      assertWorkspaceInputSize(input, this.limits);
      const updated = await client.query<WorkspaceRow>(
        `UPDATE workspaces SET
           name = $4, schema_version = $5, payload = $6::jsonb,
           content_hash = $7, revision = revision + 1,
           updated_at = clock_timestamp()
         WHERE owner_user_id = $1 AND id = $2 AND revision = $3
           AND deleted_at IS NULL AND archived_at IS NULL
         RETURNING ${workspaceColumns}`,
        [
          ownerUserId,
          id,
          expectedRevision,
          snapshot.name,
          snapshot.schema_version,
          JSON.stringify(payload),
          workspaceChecksum(payload)
        ]
      );
      const row = updated.rows[0];
      if (!row) await throwMutationConflict(client, ownerUserId, id, false);
      await insertRevision(client, ownerUserId, row!);
      await pruneRevisions(
        client,
        ownerUserId,
        id,
        this.limits.maxRevisionsPerWorkspace
      );
      const quota = await enforceWorkspaceQuota(client, ownerUserId, this.limits);
      return { workspace: mapWorkspace(row!), quota };
    });
  }

  private async setArchived(
    ownerUserId: string,
    id: string,
    expectedRevision: number,
    archived: boolean,
    authorizationRevision: number
  ): Promise<{ workspace: WorkspaceDocument; quota: WorkspaceQuotaSnapshot }> {
    return this.transaction(ownerUserId, authorizationRevision, async (client) => {
      const current = await requireWorkspaceForUpdate(client, ownerUserId, id);
      const mapped = mapWorkspace(current);
      if (Number(current.revision) !== expectedRevision) {
        throw new WorkspaceConflictError(mapped);
      }
      if ((current.archived_at !== null) === archived) {
        throw new WorkspaceConflictError(mapped);
      }
      if (!archived) {
        const input = mapRowInput(current);
        workspaceInputSchema.parse(input);
        assertWorkspaceInputSize(input, this.limits);
      }
      const archivedAt = archived ? new Date().toISOString() : null;
      const result = await client.query<WorkspaceRow>(
        `UPDATE workspaces SET
           archived_at = ${archived ? "$4::timestamptz" : "NULL"},
           revision = revision + 1, updated_at = clock_timestamp()
         WHERE owner_user_id = $1 AND id = $2 AND revision = $3
           AND deleted_at IS NULL
           AND archived_at IS ${archived ? "NULL" : "NOT NULL"}
         RETURNING ${workspaceColumns}`,
        archived
          ? [ownerUserId, id, expectedRevision, archivedAt]
          : [ownerUserId, id, expectedRevision]
      );
      const row = result.rows[0];
      if (!row) await throwMutationConflict(client, ownerUserId, id, false);
      const quota = archived
        ? quotaSnapshot(
            await readWorkspaceQuotaUsage(client, ownerUserId),
            this.limits
          )
        : await enforceWorkspaceQuota(client, ownerUserId, this.limits);
      return { workspace: mapWorkspace(row!), quota };
    });
  }

  private async getByClientId(
    ownerUserId: string,
    clientId: string
  ): Promise<WorkspaceDocument | undefined> {
    const result = await this.pool.query<WorkspaceRow>(
      `${workspaceSelect}
       FROM workspaces
       WHERE owner_user_id = $1 AND client_id = $2 AND deleted_at IS NULL`,
      [ownerUserId, clientId]
    );
    return result.rows[0] && mapWorkspace(result.rows[0]);
  }

  private async transaction<T>(
    ownerUserId: string,
    expectedAuthorizationRevision: number,
    operation: (client: PoolClient) => Promise<T>
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const owner = await client.query<{
        status: string;
        authorization_revision: string;
      }>(
        `SELECT status, authorization_revision::text
         FROM users WHERE id = $1 FOR UPDATE`,
        [ownerUserId]
      );
      const authority = owner.rows[0];
      if (
        !authority ||
        authority.status !== "active" ||
        Number(authority.authorization_revision) !== expectedAuthorizationRevision
      ) {
        throw new WorkspaceAuthorizationChangedError();
      }
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

  private async readTransaction<T>(
    operation: (client: PoolClient) => Promise<T>
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query(
        "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"
      );
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

async function requireWorkspaceForUpdate(
  client: PoolClient,
  ownerUserId: string,
  id: string
): Promise<WorkspaceRow> {
  const row = await findWorkspaceById(client, ownerUserId, id, true);
  if (!row) throw new WorkspaceNotFoundError();
  return row;
}

async function throwMutationConflict(
  client: PoolClient,
  ownerUserId: string,
  id: string,
  rejectArchived: boolean
): Promise<never> {
  const current = await findWorkspaceById(client, ownerUserId, id);
  if (!current) {
    if (rejectArchived) throw new WorkspaceConflictError();
    throw new WorkspaceNotFoundError();
  }
  const mapped = mapWorkspace(current);
  if (rejectArchived && mapped.status === "archived") {
    throw new WorkspaceArchivedError(mapped);
  }
  throw new WorkspaceConflictError(mapped);
}
