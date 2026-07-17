import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { parseScreenerDefinitionV1, type ScreenerDefinitionV1 } from "@saltanatbotv2/contracts";
import { canonicalJson, iso, positiveSafeInteger, sha256 } from "../alerts/repositoryRows.js";
import {
  MAX_ACTIVE_SCREENER_PRESETS_GLOBAL,
  MAX_ACTIVE_SCREENER_PRESETS_PER_OWNER,
  SCREENER_GLOBAL_CAPACITY_LOCK,
  SCREENER_OWNER_ADVISORY_LOCK_NAMESPACE,
  SCREENER_REPOSITORY_DEFAULT_LIST_LIMIT,
  SCREENER_REPOSITORY_MAX_LIST_LIMIT,
  ScreenerAuthorizationConflictError,
  ScreenerCapacityError,
  ScreenerIdempotencyConflictError,
  ScreenerNotFoundError,
  ScreenerQuotaError,
  ScreenerRevisionConflictError,
  type ArchiveScreenerPresetInput,
  type CreateScreenerPresetInput,
  type ScreenerPresetRecord,
  type ScreenerRepositoryContract,
  type UpdateScreenerPresetInput
} from "./repositoryTypes.js";

export {
  ScreenerAuthorizationConflictError,
  ScreenerCapacityError,
  ScreenerIdempotencyConflictError,
  ScreenerNotFoundError,
  ScreenerQuotaError,
  ScreenerRevisionConflictError
} from "./repositoryTypes.js";

const CLIENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

interface ScreenerPresetRow {
  id: string;
  owner_user_id: string;
  client_id: string;
  revision: string | number;
  authorization_revision: string | number;
  created_at: Date | string;
  updated_at: Date | string;
  archived_at: Date | string | null;
  definition: unknown;
  definition_hash: string;
}

/** Canonical serialization shared by the repository and the run worker so preset hashes match. */
export function parseAndHashScreenerDefinition(value: unknown): { definition: ScreenerDefinitionV1; serialized: string; hash: string } {
  const definition = parseScreenerDefinitionV1(value);
  const serialized = canonicalJson(definition);
  return { definition, serialized, hash: sha256(serialized) };
}

export class ScreenerRepository implements ScreenerRepositoryContract {
  constructor(private readonly pool: Pool) {}

  async create(input: CreateScreenerPresetInput): Promise<ScreenerPresetRecord> {
    assertSelfActor(input.ownerUserId, input.actorUserId);
    assertAuthorizationRevision(input.authorizationRevision);
    if (!CLIENT_ID.test(input.clientId)) throw new Error("Screener preset client ID is invalid.");
    const parsed = parseAndHashScreenerDefinition(input.definition);
    return this.transaction(async (client) => {
      await this.lockOwner(client, input.ownerUserId);
      await assertActiveOwner(client, input.ownerUserId, input.authorizationRevision);
      const existing = await client.query<ScreenerPresetRow>(`${selectScreenerPresetSql()} WHERE owner_user_id = $1 AND client_id = $2 LIMIT 1`, [input.ownerUserId, input.clientId]);
      if (existing.rows[0]) {
        if (existing.rows[0].definition_hash !== parsed.hash) throw new ScreenerIdempotencyConflictError("The client ID is already associated with a different screener preset definition.");
        return mapScreenerPreset(existing.rows[0]);
      }
      await assertGlobalActiveCapacity(client);
      const quota = await client.query<{ active: string }>("SELECT count(*)::text AS active FROM screener_presets WHERE owner_user_id = $1 AND archived_at IS NULL", [input.ownerUserId]);
      if (Number(quota.rows[0]?.active ?? 0) >= MAX_ACTIVE_SCREENER_PRESETS_PER_OWNER) {
        throw new ScreenerQuotaError(`At most ${MAX_ACTIVE_SCREENER_PRESETS_PER_OWNER} screener presets may be active per owner.`);
      }
      const id = randomUUID();
      await client.query(
        `INSERT INTO screener_presets (id, owner_user_id, client_id, name, definition, definition_hash, authorization_revision)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)`,
        [id, input.ownerUserId, input.clientId, parsed.definition.name, parsed.serialized, parsed.hash, input.authorizationRevision]
      );
      return requirePreset(await readPreset(client, input.ownerUserId, id));
    });
  }

  async list(ownerUserId: string, limit = SCREENER_REPOSITORY_DEFAULT_LIST_LIMIT): Promise<ScreenerPresetRecord[]> {
    const result = await this.pool.query<ScreenerPresetRow>(
      `${selectScreenerPresetSql()} WHERE owner_user_id = $1
       ORDER BY CASE WHEN archived_at IS NULL THEN 0 ELSE 1 END, updated_at DESC, id DESC LIMIT $2`,
      [ownerUserId, boundedLimit(limit)]
    );
    return result.rows.map(mapScreenerPreset);
  }

  async get(ownerUserId: string, presetId: string): Promise<ScreenerPresetRecord | undefined> {
    const result = await this.pool.query<ScreenerPresetRow>(`${selectScreenerPresetSql()} WHERE owner_user_id = $1 AND id = $2 LIMIT 1`, [ownerUserId, presetId]);
    return result.rows[0] && mapScreenerPreset(result.rows[0]);
  }

  async update(input: UpdateScreenerPresetInput): Promise<ScreenerPresetRecord> {
    assertSelfActor(input.ownerUserId, input.actorUserId);
    assertAuthorizationRevision(input.authorizationRevision);
    const parsed = parseAndHashScreenerDefinition(input.definition);
    return this.transaction(async (client) => {
      await this.lockOwner(client, input.ownerUserId);
      await assertActiveOwner(client, input.ownerUserId, input.authorizationRevision);
      const current = requirePresetRow(await lockPreset(client, input.ownerUserId, input.presetId));
      const currentRevision = positiveSafeInteger(current.revision, "screener preset revision");
      if (currentRevision !== input.expectedRevision) {
        if (currentRevision > input.expectedRevision && current.definition_hash === parsed.hash) return mapScreenerPreset(current);
        throw new ScreenerRevisionConflictError("The screener preset revision has changed.");
      }
      if (current.archived_at) throw new ScreenerRevisionConflictError("Archived screener presets cannot be updated.");
      if (current.definition_hash === parsed.hash) {
        await client.query("UPDATE screener_presets SET authorization_revision = $3, updated_at = clock_timestamp() WHERE owner_user_id = $1 AND id = $2", [input.ownerUserId, input.presetId, input.authorizationRevision]);
        return requirePreset(await readPreset(client, input.ownerUserId, input.presetId));
      }
      await client.query(
        `UPDATE screener_presets SET name = $3, definition = $4::jsonb, definition_hash = $5,
           revision = $6, authorization_revision = $7, updated_at = clock_timestamp()
         WHERE owner_user_id = $1 AND id = $2`,
        [input.ownerUserId, input.presetId, parsed.definition.name, parsed.serialized, parsed.hash, currentRevision + 1, input.authorizationRevision]
      );
      return requirePreset(await readPreset(client, input.ownerUserId, input.presetId));
    });
  }

  async archive(input: ArchiveScreenerPresetInput): Promise<ScreenerPresetRecord> {
    assertSelfActor(input.ownerUserId, input.actorUserId);
    assertAuthorizationRevision(input.authorizationRevision);
    return this.transaction(async (client) => {
      await this.lockOwner(client, input.ownerUserId);
      await assertActiveOwner(client, input.ownerUserId, input.authorizationRevision);
      const current = requirePresetRow(await lockPreset(client, input.ownerUserId, input.presetId));
      if (positiveSafeInteger(current.revision, "screener preset revision") !== input.expectedRevision) {
        throw new ScreenerRevisionConflictError("The screener preset revision has changed.");
      }
      if (!current.archived_at) {
        await client.query(
          `UPDATE screener_presets SET archived_at = clock_timestamp(), authorization_revision = $3, updated_at = clock_timestamp()
           WHERE owner_user_id = $1 AND id = $2`,
          [input.ownerUserId, input.presetId, input.authorizationRevision]
        );
      }
      return requirePreset(await readPreset(client, input.ownerUserId, input.presetId));
    });
  }

  private async lockOwner(client: PoolClient, ownerUserId: string): Promise<void> {
    await client.query("SELECT pg_advisory_xact_lock($1::integer, hashtext($2))", [SCREENER_OWNER_ADVISORY_LOCK_NAMESPACE, ownerUserId]);
  }

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const value = await operation(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

function selectScreenerPresetSql(): string {
  return `SELECT id, owner_user_id, client_id, revision, authorization_revision,
    created_at, updated_at, archived_at, definition, definition_hash
  FROM screener_presets`;
}

async function readPreset(database: Pick<Pool, "query"> | Pick<PoolClient, "query">, ownerUserId: string, presetId: string): Promise<ScreenerPresetRow | undefined> {
  const result = await database.query<ScreenerPresetRow>(`${selectScreenerPresetSql()} WHERE owner_user_id = $1 AND id = $2 LIMIT 1`, [ownerUserId, presetId]);
  return result.rows[0];
}

async function lockPreset(client: PoolClient, ownerUserId: string, presetId: string): Promise<ScreenerPresetRow | undefined> {
  const result = await client.query<ScreenerPresetRow>(`${selectScreenerPresetSql()} WHERE owner_user_id = $1 AND id = $2 FOR UPDATE`, [ownerUserId, presetId]);
  return result.rows[0];
}

function mapScreenerPreset(row: ScreenerPresetRow): ScreenerPresetRecord {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    clientId: row.client_id,
    revision: positiveSafeInteger(row.revision, "screener preset revision"),
    authorizationRevision: positiveSafeInteger(row.authorization_revision, "authorization revision"),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    ...(row.archived_at ? { archivedAt: iso(row.archived_at) } : {}),
    definitionHash: row.definition_hash,
    definition: parseScreenerDefinitionV1(row.definition)
  };
}

async function assertActiveOwner(client: PoolClient, ownerUserId: string, authorizationRevision: number): Promise<void> {
  const result = await client.query<{ status: string; must_change_password: boolean; authorization_revision: string }>("SELECT status, must_change_password, authorization_revision FROM users WHERE id = $1 FOR SHARE", [ownerUserId]);
  const owner = result.rows[0];
  if (!owner || owner.status !== "active" || owner.must_change_password || positiveSafeInteger(owner.authorization_revision, "user authorization revision") !== authorizationRevision) {
    throw new ScreenerAuthorizationConflictError("The owner authorization is no longer valid.");
  }
}

async function assertGlobalActiveCapacity(client: PoolClient): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock($1::integer)", [SCREENER_GLOBAL_CAPACITY_LOCK]);
  const result = await client.query<{ active: string }>("SELECT count(*)::text AS active FROM screener_presets WHERE archived_at IS NULL");
  if (Number(result.rows[0]?.active ?? 0) >= MAX_ACTIVE_SCREENER_PRESETS_GLOBAL) {
    throw new ScreenerCapacityError(`The R5.2 beta supports at most ${MAX_ACTIVE_SCREENER_PRESETS_GLOBAL} globally active screener presets.`);
  }
}

function requirePreset(row: ScreenerPresetRow | undefined): ScreenerPresetRecord {
  if (!row) throw new ScreenerNotFoundError("Screener preset was not found for this owner.");
  return mapScreenerPreset(row);
}

function requirePresetRow(row: ScreenerPresetRow | undefined): ScreenerPresetRow {
  if (!row) throw new ScreenerNotFoundError("Screener preset was not found for this owner.");
  return row;
}

function boundedLimit(limit: number): number {
  if (!Number.isFinite(limit)) return SCREENER_REPOSITORY_DEFAULT_LIST_LIMIT;
  return Math.max(1, Math.min(SCREENER_REPOSITORY_MAX_LIST_LIMIT, Math.floor(limit)));
}

function assertSelfActor(ownerUserId: string, actorUserId: string): void {
  if (ownerUserId !== actorUserId) throw new ScreenerNotFoundError("Screener presets can only be mutated by their owner.");
}

function assertAuthorizationRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Authorization revision is invalid.");
}
