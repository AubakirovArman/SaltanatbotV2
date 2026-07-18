import { randomUUID } from "node:crypto";
import {
  GALLERY_FEED_MAX_LIMIT,
  GALLERY_OWN_LIST_MAX_LIMIT,
  GalleryForbiddenError,
  GalleryHashMismatchError,
  GalleryNotFoundError,
  GalleryRevokedError,
  type GalleryArtifactRecord,
  type GalleryPublishInput,
  type GalleryStore,
  type GalleryVisibility
} from "../../src/gallery/repository.js";
import { galleryArtifactHash, type GalleryArtifactV1 } from "../../src/gallery/sanitizer.js";

/**
 * In-memory GalleryStore double mirroring the PostgreSQL repository semantics
 * the gallery suites depend on: append-only (id, version) rows (version 1 for
 * a fresh id, max+1 for the owner's own artifact), the viewer visibility
 * matrix with latest-ACTIVE-version-default resolution, DISTINCT-ON-id public
 * feed cards, owner-gated moderation that only ever flips
 * visibility/status/revoked_at/revoke_reason, and the import-time sha256
 * re-verification. Rows are cloned on the way in and out (JSONB round-trip
 * semantics) and timestamps are pinned for stable golden assertions. The
 * content-frozen trigger itself lives in galleryPostgres.integration.test.ts —
 * here immutability holds by construction because nothing ever rewrites a row.
 */

const FIXED_TIMESTAMP = "2026-07-18T00:00:00.000Z";

export interface MemoryGalleryStoreOptions {
  /** Deterministic id source for golden route assertions; defaults to randomUUID. */
  nextId?: () => string;
}

export class MemoryGalleryStore implements GalleryStore {
  private readonly rows: GalleryArtifactRecord[] = [];
  private readonly nextId: () => string;

  constructor(options: MemoryGalleryStoreOptions = {}) {
    this.nextId = options.nextId ?? randomUUID;
  }

  /** Test seam: every stored row (all owners) in insertion order. */
  allRows(): GalleryArtifactRecord[] {
    return this.rows.map(clone);
  }

  /**
   * Test seam for the belt-and-braces import check: mutate a stored artifact
   * WITHOUT updating its hash — the PostgreSQL trigger makes this impossible
   * for real, so the double simulates the corruption the re-verification
   * exists to catch.
   */
  tamperStoredArtifact(id: string, version: number, mutate: (artifact: GalleryArtifactV1) => void): void {
    const row = this.rows.find((entry) => entry.id === id && entry.version === version);
    if (!row) throw new Error(`No gallery row ${id} v${version} to tamper with`);
    mutate(row.artifact);
  }

  async publish(input: GalleryPublishInput): Promise<GalleryArtifactRecord> {
    let id = input.artifactId;
    let version = 1;
    if (id === undefined) {
      id = this.nextId();
    } else {
      const versions = this.versionsOf(id);
      const head = versions.at(-1);
      if (!head) throw new GalleryNotFoundError("Gallery artifact not found.");
      if (head.ownerUserId !== input.ownerUserId) {
        throw new GalleryForbiddenError("Only the owner can publish a new gallery version.");
      }
      version = head.version + 1;
    }
    const record: GalleryArtifactRecord = {
      id,
      version,
      ownerUserId: input.ownerUserId,
      title: input.title,
      summary: input.summary,
      artifact: clone(input.artifact),
      artifactHash: input.artifactHash,
      visibility: input.visibility,
      status: "active",
      rating: clone(input.rating),
      publishedAt: input.publishedAt,
      createdAt: FIXED_TIMESTAMP,
      updatedAt: FIXED_TIMESTAMP
    };
    this.rows.push(record);
    return clone(record);
  }

  async getForViewer(viewerUserId: string, id: string, version?: number): Promise<GalleryArtifactRecord> {
    const record = this.loadRecord(id, version);
    if (!record) throw new GalleryNotFoundError("Gallery artifact not found.");
    if (record.ownerUserId === viewerUserId) return clone(record);
    if (record.visibility === "private") throw new GalleryNotFoundError("Gallery artifact not found.");
    if (record.status === "revoked") throw new GalleryRevokedError("Gallery artifact has been revoked.");
    return clone(record);
  }

  async getForImport(viewerUserId: string, id: string, version?: number): Promise<GalleryArtifactRecord> {
    const record = await this.getForViewer(viewerUserId, id, version);
    if (record.status === "revoked") throw new GalleryRevokedError("Revoked gallery artifacts cannot be imported.");
    if (galleryArtifactHash(record.artifact) !== record.artifactHash) {
      throw new GalleryHashMismatchError("Stored gallery artifact does not match its recorded hash.");
    }
    return record;
  }

  async listPublicFeed(options: { limit: number; before?: number }): Promise<GalleryArtifactRecord[]> {
    const bounded = Math.max(1, Math.min(GALLERY_FEED_MAX_LIMIT, Math.floor(options.limit)));
    const latestPerId = new Map<string, GalleryArtifactRecord>();
    for (const row of this.rows) {
      if (row.visibility !== "public" || row.status !== "active") continue;
      const current = latestPerId.get(row.id);
      if (!current || row.version > current.version) latestPerId.set(row.id, row);
    }
    return [...latestPerId.values()]
      .filter((row) => options.before === undefined || row.publishedAt < options.before)
      .sort(newestFirst)
      .slice(0, bounded)
      .map(clone);
  }

  async listOwn(ownerUserId: string, limit: number): Promise<GalleryArtifactRecord[]> {
    const bounded = Math.max(1, Math.min(GALLERY_OWN_LIST_MAX_LIMIT, Math.floor(limit)));
    return this.rows
      .filter((row) => row.ownerUserId === ownerUserId)
      .sort((left, right) => newestFirst(left, right) || right.version - left.version)
      .slice(0, bounded)
      .map(clone);
  }

  async revoke(ownerUserId: string, id: string, reason: string, revokedAt: number): Promise<GalleryArtifactRecord[]> {
    return this.moderate(ownerUserId, id, (row) => {
      // An already-revoked version keeps its original revocation record.
      if (row.status !== "active") return;
      row.status = "revoked";
      row.revokedAt = revokedAt;
      row.revokeReason = reason;
    });
  }

  async setVisibility(ownerUserId: string, id: string, visibility: GalleryVisibility): Promise<GalleryArtifactRecord[]> {
    return this.moderate(ownerUserId, id, (row) => {
      row.visibility = visibility;
    });
  }

  /** Shared owner gate for the moderation mutations: not-found and forbidden precede the update. */
  private moderate(ownerUserId: string, id: string, mutate: (row: GalleryArtifactRecord) => void): GalleryArtifactRecord[] {
    const versions = this.versionsOf(id);
    const head = versions.at(-1);
    if (!head) throw new GalleryNotFoundError("Gallery artifact not found.");
    if (head.ownerUserId !== ownerUserId) throw new GalleryForbiddenError("Only the owner can manage this gallery artifact.");
    for (const row of versions) mutate(row);
    return versions.map(clone);
  }

  /** Without an explicit version the latest ACTIVE version wins; else the latest revoked one. */
  private loadRecord(id: string, version?: number): GalleryArtifactRecord | undefined {
    const versions = this.versionsOf(id);
    if (version !== undefined) return versions.find((row) => row.version === version);
    return versions.filter((row) => row.status === "active").at(-1) ?? versions.at(-1);
  }

  private versionsOf(id: string): GalleryArtifactRecord[] {
    return this.rows.filter((row) => row.id === id).sort((left, right) => left.version - right.version);
  }
}

function newestFirst(left: GalleryArtifactRecord, right: GalleryArtifactRecord): number {
  return right.publishedAt - left.publishedAt || (left.id < right.id ? 1 : left.id > right.id ? -1 : 0);
}

/** JSONB round-trip semantics: drops undefined, breaks aliasing between caller and storage. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
