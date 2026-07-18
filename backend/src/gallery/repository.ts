import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { galleryArtifactHash, type GalleryArtifactV1, type GalleryRating } from "./sanitizer.js";

/**
 * Persistence for the versioned strategy gallery (PG schema v18, R9.3). Each
 * publication is one immutable (id, version) row: the SQL trigger
 * `gallery_artifacts_content_frozen` rejects every content mutation, so this
 * class only ever appends versions or flips the mutable moderation columns
 * (visibility, status, revoked_at, revoke_reason). Import reads RE-VERIFY the
 * stored sha256 against the canonical artifact before returning — the trigger
 * makes tampering impossible in the first place, but the hash check keeps the
 * "cannot change silently after import" criterion observable end to end.
 */

export type GalleryVisibility = "private" | "unlisted" | "public";
export type GalleryStatus = "active" | "revoked";

export interface GalleryArtifactRecord {
  id: string;
  version: number;
  /** Tenant boundary: consumed for authorization only, NEVER serialized outward. */
  ownerUserId: string;
  title: string;
  summary: string;
  artifact: GalleryArtifactV1;
  artifactHash: string;
  visibility: GalleryVisibility;
  status: GalleryStatus;
  rating: GalleryRating;
  publishedAt: number;
  revokedAt?: number;
  revokeReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface GalleryPublishInput {
  /** Omitted for a brand-new artifact (version 1); set to append the next version. */
  artifactId?: string;
  ownerUserId: string;
  title: string;
  summary: string;
  visibility: GalleryVisibility;
  artifact: GalleryArtifactV1;
  artifactHash: string;
  rating: GalleryRating;
  publishedAt: number;
}

export class GalleryNotFoundError extends Error {}
export class GalleryForbiddenError extends Error {}
export class GalleryRevokedError extends Error {}
export class GalleryHashMismatchError extends Error {}

export interface GalleryStore {
  publish(input: GalleryPublishInput): Promise<GalleryArtifactRecord>;
  getForViewer(viewerUserId: string, id: string, version?: number): Promise<GalleryArtifactRecord>;
  getForImport(viewerUserId: string, id: string, version?: number): Promise<GalleryArtifactRecord>;
  listPublicFeed(options: { limit: number; before?: number }): Promise<GalleryArtifactRecord[]>;
  listOwn(ownerUserId: string, limit: number): Promise<GalleryArtifactRecord[]>;
  revoke(ownerUserId: string, id: string, reason: string, revokedAt: number): Promise<GalleryArtifactRecord[]>;
  setVisibility(ownerUserId: string, id: string, visibility: GalleryVisibility): Promise<GalleryArtifactRecord[]>;
}

interface GalleryArtifactRow {
  id: string;
  version: number;
  owner_user_id: string;
  title: string;
  summary: string;
  artifact: Record<string, unknown>;
  artifact_hash: string;
  visibility: GalleryVisibility;
  status: GalleryStatus;
  rating: Record<string, unknown>;
  published_at: string | number;
  revoked_at: string | number | null;
  revoke_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = "id, version, owner_user_id, title, summary, artifact, artifact_hash, visibility, status, rating, published_at, revoked_at, revoke_reason, created_at, updated_at";
export const GALLERY_FEED_MAX_LIMIT = 50;
export const GALLERY_OWN_LIST_MAX_LIMIT = 100;

export class GalleryRepository implements GalleryStore {
  constructor(private readonly pool: Pool) {}

  /**
   * Version 1 for a fresh id; otherwise append max+1 for the caller's own
   * artifact. The head row is locked so two concurrent publishes of the same
   * artifact serialize instead of racing for the same version number.
   */
  async publish(input: GalleryPublishInput): Promise<GalleryArtifactRecord> {
    if (input.artifactId === undefined) {
      return this.insertVersion(this.pool, input, randomUUID(), 1);
    }
    const artifactId = input.artifactId;
    return this.transaction(async (client) => {
      const head = await client.query<Pick<GalleryArtifactRow, "owner_user_id" | "version">>(
        "SELECT owner_user_id, version FROM gallery_artifacts WHERE id = $1 ORDER BY version DESC LIMIT 1 FOR UPDATE",
        [artifactId]
      );
      const row = head.rows[0];
      if (!row) throw new GalleryNotFoundError("Gallery artifact not found.");
      if (row.owner_user_id !== input.ownerUserId) throw new GalleryForbiddenError("Only the owner can publish a new gallery version.");
      return this.insertVersion(client, input, artifactId, row.version + 1);
    });
  }

  /**
   * Direct-id read under the visibility matrix: the owner always sees the row;
   * others see active public/unlisted rows only — private rows read as not
   * found and revoked rows as revoked. Without an explicit version the latest
   * ACTIVE version wins; only when every version is revoked does the latest
   * revoked row surface (for the owner's history view).
   */
  async getForViewer(viewerUserId: string, id: string, version?: number): Promise<GalleryArtifactRecord> {
    const record = await this.loadRecord(id, version);
    if (!record) throw new GalleryNotFoundError("Gallery artifact not found.");
    if (record.ownerUserId === viewerUserId) return record;
    if (record.visibility === "private") throw new GalleryNotFoundError("Gallery artifact not found.");
    if (record.status === "revoked") throw new GalleryRevokedError("Gallery artifact has been revoked.");
    return record;
  }

  /** Import fetch = viewer get + revocation refusal + server-side hash re-verification. */
  async getForImport(viewerUserId: string, id: string, version?: number): Promise<GalleryArtifactRecord> {
    const record = await this.getForViewer(viewerUserId, id, version);
    if (record.status === "revoked") throw new GalleryRevokedError("Revoked gallery artifacts cannot be imported.");
    if (galleryArtifactHash(record.artifact) !== record.artifactHash) {
      throw new GalleryHashMismatchError("Stored gallery artifact does not match its recorded hash.");
    }
    return record;
  }

  /** Newest-first active public feed, one card per artifact id (its latest public version). */
  async listPublicFeed(options: { limit: number; before?: number }): Promise<GalleryArtifactRecord[]> {
    const bounded = Math.max(1, Math.min(GALLERY_FEED_MAX_LIMIT, Math.floor(options.limit)));
    const result = await this.pool.query<GalleryArtifactRow>(
      `SELECT ${COLUMNS} FROM (
         SELECT DISTINCT ON (id) ${COLUMNS}
         FROM gallery_artifacts
         WHERE visibility = 'public' AND status = 'active'
         ORDER BY id, version DESC
       ) latest
       WHERE $2::bigint IS NULL OR published_at < $2
       ORDER BY published_at DESC, id DESC
       LIMIT $1`,
      [bounded, options.before ?? null]
    );
    return result.rows.map(mapRecord);
  }

  /** Every own version (any visibility/status) for the management view, newest first. */
  async listOwn(ownerUserId: string, limit: number): Promise<GalleryArtifactRecord[]> {
    const bounded = Math.max(1, Math.min(GALLERY_OWN_LIST_MAX_LIMIT, Math.floor(limit)));
    const result = await this.pool.query<GalleryArtifactRow>(
      `SELECT ${COLUMNS} FROM gallery_artifacts WHERE owner_user_id = $1 ORDER BY published_at DESC, id DESC, version DESC LIMIT $2`,
      [ownerUserId, bounded]
    );
    return result.rows.map(mapRecord);
  }

  /**
   * Owner-only revocation of every still-active version of the artifact.
   * Content stays frozen — only status/revoked_at/revoke_reason move — and an
   * already-revoked version keeps its original revocation record (history is
   * never rewritten). Returns the full version list after the change.
   */
  async revoke(ownerUserId: string, id: string, reason: string, revokedAt: number): Promise<GalleryArtifactRecord[]> {
    return this.moderate(ownerUserId, id, async (client) => {
      await client.query(
        `UPDATE gallery_artifacts SET status = 'revoked', revoked_at = $3, revoke_reason = $4, updated_at = now()
         WHERE id = $1 AND owner_user_id = $2 AND status = 'active'`,
        [id, ownerUserId, revokedAt, reason]
      );
    });
  }

  /** Owner-only visibility change across every version of the artifact id. */
  async setVisibility(ownerUserId: string, id: string, visibility: GalleryVisibility): Promise<GalleryArtifactRecord[]> {
    return this.moderate(ownerUserId, id, async (client) => {
      await client.query(
        "UPDATE gallery_artifacts SET visibility = $3, updated_at = now() WHERE id = $1 AND owner_user_id = $2",
        [id, ownerUserId, visibility]
      );
    });
  }

  private async insertVersion(executor: Pool | PoolClient, input: GalleryPublishInput, id: string, version: number): Promise<GalleryArtifactRecord> {
    const result = await executor.query<GalleryArtifactRow>(
      `INSERT INTO gallery_artifacts (id, version, owner_user_id, title, summary, artifact, artifact_hash, visibility, rating, published_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9::jsonb, $10)
       RETURNING ${COLUMNS}`,
      [id, version, input.ownerUserId, input.title, input.summary, JSON.stringify(input.artifact), input.artifactHash, input.visibility, JSON.stringify(input.rating), input.publishedAt]
    );
    return mapRecord(result.rows[0]!);
  }

  /** Shared owner gate for the moderation mutations: not-found and forbidden precede the update. */
  private async moderate(ownerUserId: string, id: string, mutate: (client: PoolClient) => Promise<void>): Promise<GalleryArtifactRecord[]> {
    return this.transaction(async (client) => {
      const head = await client.query<Pick<GalleryArtifactRow, "owner_user_id">>(
        "SELECT owner_user_id FROM gallery_artifacts WHERE id = $1 ORDER BY version DESC LIMIT 1 FOR UPDATE",
        [id]
      );
      const row = head.rows[0];
      if (!row) throw new GalleryNotFoundError("Gallery artifact not found.");
      if (row.owner_user_id !== ownerUserId) throw new GalleryForbiddenError("Only the owner can manage this gallery artifact.");
      await mutate(client);
      const result = await client.query<GalleryArtifactRow>(`SELECT ${COLUMNS} FROM gallery_artifacts WHERE id = $1 ORDER BY version ASC`, [id]);
      return result.rows.map(mapRecord);
    });
  }

  private async loadRecord(id: string, version?: number): Promise<GalleryArtifactRecord | undefined> {
    const result =
      version !== undefined
        ? await this.pool.query<GalleryArtifactRow>(`SELECT ${COLUMNS} FROM gallery_artifacts WHERE id = $1 AND version = $2`, [id, version])
        : await this.pool.query<GalleryArtifactRow>(
            `SELECT ${COLUMNS} FROM gallery_artifacts WHERE id = $1 ORDER BY (status = 'active') DESC, version DESC LIMIT 1`,
            [id]
          );
    return result.rows[0] && mapRecord(result.rows[0]);
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

function mapRecord(row: GalleryArtifactRow): GalleryArtifactRecord {
  const publishedAt = Number(row.published_at);
  if (!Number.isSafeInteger(publishedAt) || publishedAt <= 0) throw new Error("Invalid gallery published_at");
  return {
    id: row.id,
    version: row.version,
    ownerUserId: row.owner_user_id,
    title: row.title,
    summary: row.summary,
    artifact: row.artifact as unknown as GalleryArtifactV1,
    artifactHash: row.artifact_hash,
    visibility: row.visibility,
    status: row.status,
    rating: row.rating as unknown as GalleryRating,
    publishedAt,
    ...(row.revoked_at !== null ? { revokedAt: Number(row.revoked_at) } : {}),
    ...(row.revoke_reason !== null ? { revokeReason: row.revoke_reason } : {}),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}
