import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateDatabase } from "../src/database/migrations.js";
import { LATEST_DATABASE_SCHEMA_VERSION } from "../src/database/schema.js";
import {
  GalleryForbiddenError,
  GalleryNotFoundError,
  GalleryRepository,
  GalleryRevokedError
} from "../src/gallery/repository.js";
import {
  buildGalleryArtifactV1,
  computeGalleryRating,
  galleryArtifactHash,
  type GallerySanitizedBundle
} from "../src/gallery/sanitizer.js";
import { assertIsolatedTestDatabase } from "./support/postgresTestDatabase.js";

/**
 * Versioned strategy gallery against isolated PostgreSQL (schema v18, R9.3).
 * Beyond the repository seams, the content-frozen invariant is asserted at
 * the SQL level: the gallery_artifacts_content_frozen trigger must reject
 * every direct UPDATE of published content (artifact, artifact_hash, title,
 * summary, version, published_at, owner_user_id, rating, created_at) while
 * the moderation columns (visibility, status, revoked_at, revoke_reason,
 * updated_at) stay mutable — revocation never rewrites history and imported
 * bundles can never change silently underneath their hash.
 */

const connectionString = process.env.GALLERY_TEST_DATABASE_URL ?? process.env.ALERTS_TEST_DATABASE_URL;
const describePostgres = connectionString ? describe : describe.skip;
const OWNER_A = "00000000-0000-4000-8000-000000000241";
const OWNER_B = "00000000-0000-4000-8000-000000000242";
const PASSWORD_HASH = "test-auth-hash-placeholder";
const PUBLISHED_AT = 1_752_800_000_000;
let pool: Pool;
let repository: GalleryRepository;

const VALID_IR = {
  name: "Gallery MA cross",
  inputs: [{ name: "fast", value: 12 }],
  body: [
    {
      k: "entry",
      direction: "long",
      when: { k: "cross", dir: "above", a: { k: "price", field: "close" }, b: sma() }
    },
    { k: "exit", when: { k: "cross", dir: "below", a: { k: "price", field: "close" }, b: sma() } }
  ]
};

function sma(): Record<string, unknown> {
  return { k: "ma", kind: "sma", period: { k: "num", v: 50 }, source: { k: "price", field: "close" } };
}

describePostgres("versioned strategy gallery against isolated PostgreSQL (schema v18)", () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString, max: 8 });
    await assertIsolatedTestDatabase(pool, "GALLERY_TEST_DATABASE_URL");
    await migrateDatabase(pool);
    await pool.query(
      `INSERT INTO users (id, login, login_normalized, password_hash, status)
       VALUES ($1, 'gallery-owner-a', 'gallery-owner-a', $3, 'active'),
              ($2, 'gallery-owner-b', 'gallery-owner-b', $3, 'active')
       ON CONFLICT (id) DO NOTHING`,
      [OWNER_A, OWNER_B, PASSWORD_HASH]
    );
    repository = new GalleryRepository(pool);
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE gallery_artifacts CASCADE");
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.query("TRUNCATE gallery_artifacts CASCADE").catch(() => undefined);
    await pool.end();
  });

  it("migrates to schema v18 with the gallery table, feed indexes and content-frozen trigger installed", async () => {
    const applied = await pool.query<{ version: number }>("SELECT max(version)::integer AS version FROM schema_migrations");
    expect(applied.rows[0]?.version).toBe(LATEST_DATABASE_SCHEMA_VERSION);
    expect(applied.rows[0]?.version).toBe(18);
    const objects = await pool.query<Record<string, string | null>>(
      `SELECT to_regclass('public.gallery_artifacts')::text AS gallery_table,
         to_regclass('public.gallery_artifacts_public_feed_index')::text AS feed_index,
         to_regclass('public.gallery_artifacts_owner_recent_index')::text AS owner_index,
         (SELECT tgname FROM pg_trigger
          WHERE tgrelid = 'public.gallery_artifacts'::regclass AND NOT tgisinternal) AS frozen_trigger,
         (SELECT proname FROM pg_proc WHERE proname = 'reject_gallery_content_update') AS frozen_function`
    );
    expect(objects.rows[0]).toEqual({
      gallery_table: "gallery_artifacts",
      feed_index: "gallery_artifacts_public_feed_index",
      owner_index: "gallery_artifacts_owner_recent_index",
      frozen_trigger: "gallery_artifacts_content_frozen",
      frozen_function: "reject_gallery_content_update"
    });
  });

  it("blocks every content UPDATE at the SQL level while moderation columns stay mutable", async () => {
    const record = await publish(OWNER_A, { title: "Frozen", visibility: "public" });
    const immutableUpdates: [string, unknown[]][] = [
      ["UPDATE gallery_artifacts SET artifact = '{}'::jsonb WHERE id = $1", [record.id]],
      ["UPDATE gallery_artifacts SET artifact_hash = $2 WHERE id = $1", [record.id, "f".repeat(64)]],
      ["UPDATE gallery_artifacts SET title = 'Renamed' WHERE id = $1", [record.id]],
      ["UPDATE gallery_artifacts SET summary = 'Rewritten' WHERE id = $1", [record.id]],
      ["UPDATE gallery_artifacts SET version = version + 100 WHERE id = $1", [record.id]],
      ["UPDATE gallery_artifacts SET published_at = published_at + 1 WHERE id = $1", [record.id]],
      ["UPDATE gallery_artifacts SET owner_user_id = $2 WHERE id = $1", [record.id, OWNER_B]],
      ["UPDATE gallery_artifacts SET rating = '{}'::jsonb WHERE id = $1", [record.id]],
      ["UPDATE gallery_artifacts SET created_at = now() WHERE id = $1", [record.id]]
    ];
    for (const [sql, values] of immutableUpdates) {
      await expect(pool.query(sql, values), sql).rejects.toMatchObject({
        message: expect.stringContaining("published content is immutable")
      });
    }

    // The moderation columns move freely (paired per the status/revoked_at CHECK).
    await pool.query("UPDATE gallery_artifacts SET visibility = 'unlisted', updated_at = now() WHERE id = $1", [record.id]);
    await pool.query(
      "UPDATE gallery_artifacts SET status = 'revoked', revoked_at = $2, revoke_reason = 'Moderated', updated_at = now() WHERE id = $1",
      [record.id, PUBLISHED_AT + 1_000]
    );
    // The SQL-level revocation carries through the repository read path.
    await expect(repository.getForImport(OWNER_B, record.id)).rejects.toBeInstanceOf(GalleryRevokedError);

    // But status flips must stay consistent: revoked requires revoked_at.
    const fresh = await publish(OWNER_A, { title: "Consistent", visibility: "public" });
    await expect(
      pool.query("UPDATE gallery_artifacts SET status = 'revoked' WHERE id = $1 AND version = 1", [fresh.id])
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("enforces the bounded-artifact, hash-format, version and title CHECK constraints", async () => {
    const bundle = libraryBundle();
    const insert = (overrides: Partial<Record<string, unknown>>) =>
      pool.query(
        `INSERT INTO gallery_artifacts (id, version, owner_user_id, title, summary, artifact, artifact_hash, visibility, rating, published_at, revoked_at, revoke_reason)
         VALUES (gen_random_uuid(), $1, $2, $3, '', $4::jsonb, $5, 'private', '{}'::jsonb, $6, $7, $8)`,
        [
          overrides.version ?? 1,
          OWNER_A,
          overrides.title ?? "Valid",
          overrides.artifact ?? JSON.stringify(bundle.artifact),
          overrides.artifactHash ?? bundle.artifactHash,
          overrides.publishedAt ?? PUBLISHED_AT,
          overrides.revokedAt ?? null,
          overrides.revokeReason ?? null
        ]
      );

    await expect(insert({ version: 0 })).rejects.toMatchObject({ code: "23514" });
    await expect(insert({ title: "control\u0007char" })).rejects.toMatchObject({ code: "23514" });
    await expect(insert({ title: " padded " })).rejects.toMatchObject({ code: "23514" });
    await expect(insert({ artifactHash: "not-a-hash" })).rejects.toMatchObject({ code: "23514" });
    await expect(insert({ artifact: JSON.stringify({ pad: "x".repeat(263_000) }) })).rejects.toMatchObject({ code: "23514" });
    await expect(insert({ publishedAt: 0 })).rejects.toMatchObject({ code: "23514" });
    // revoked_at implies consistency with published_at; revoke_reason implies revoked_at.
    await expect(insert({ revokedAt: PUBLISHED_AT - 1, revokeReason: "early" })).rejects.toMatchObject({ code: "23514" });
    await expect(insert({ revokeReason: "reason without revoked_at" })).rejects.toMatchObject({ code: "23514" });
    await insert({});
  });

  it("appends versions per owner, serializes concurrent publishes and keeps version 1 byte-identical", async () => {
    const first = await publish(OWNER_A, { title: "Version one", visibility: "public" });
    expect(first.version).toBe(1);

    // Concurrent appends to the same artifact serialize on the head lock.
    const [secondResult, thirdResult] = await Promise.all([
      repository.publish(publishInput(OWNER_A, { title: "Concurrent A", visibility: "public", artifactId: first.id, publishedAt: PUBLISHED_AT + 1_000 })),
      repository.publish(publishInput(OWNER_A, { title: "Concurrent B", visibility: "public", artifactId: first.id, publishedAt: PUBLISHED_AT + 2_000 }))
    ]);
    expect([secondResult.version, thirdResult.version].sort()).toEqual([2, 3]);

    const v1 = await repository.getForViewer(OWNER_A, first.id, 1);
    expect(v1).toMatchObject({ title: "Version one", artifactHash: first.artifactHash, publishedAt: PUBLISHED_AT });
    expect(galleryArtifactHash(v1.artifact)).toBe(first.artifactHash);

    // Cross-owner appends and appends to unknown ids are refused.
    await expect(
      repository.publish(publishInput(OWNER_B, { title: "Hijack", visibility: "public", artifactId: first.id, publishedAt: PUBLISHED_AT }))
    ).rejects.toBeInstanceOf(GalleryForbiddenError);
    await expect(
      repository.publish(publishInput(OWNER_A, { title: "Ghost", visibility: "public", artifactId: OWNER_B, publishedAt: PUBLISHED_AT }))
    ).rejects.toBeInstanceOf(GalleryNotFoundError);
  });

  it("applies the visibility matrix, feed projection and own list against real rows", async () => {
    const pub = await publish(OWNER_A, { title: "Public", visibility: "public" });
    await repository.publish(publishInput(OWNER_A, { title: "Public v2", visibility: "public", artifactId: pub.id, publishedAt: PUBLISHED_AT + 5_000 }));
    const unlisted = await publish(OWNER_A, { title: "Unlisted", visibility: "unlisted", publishedAt: PUBLISHED_AT + 1_000 });
    const priv = await publish(OWNER_A, { title: "Private", visibility: "private", publishedAt: PUBLISHED_AT + 2_000 });
    const otherPub = await publish(OWNER_B, { title: "Other public", visibility: "public", publishedAt: PUBLISHED_AT + 3_000 });
    await repository.revoke(OWNER_B, otherPub.id, "Withdrawn", PUBLISHED_AT + 4_000);

    // Feed: latest public+active version per id, newest first — no unlisted,
    // private or revoked rows.
    const feed = await repository.listPublicFeed({ limit: 10 });
    expect(feed.map((row) => ({ id: row.id, version: row.version, title: row.title }))).toEqual([
      { id: pub.id, version: 2, title: "Public v2" }
    ]);

    // Direct-id reads: owner always; others per visibility/status.
    await expect(repository.getForViewer(OWNER_B, priv.id)).rejects.toBeInstanceOf(GalleryNotFoundError);
    expect((await repository.getForViewer(OWNER_B, unlisted.id)).title).toBe("Unlisted");
    expect((await repository.getForViewer(OWNER_B, otherPub.id)).status).toBe("revoked");
    await expect(repository.getForViewer(OWNER_A, otherPub.id)).rejects.toBeInstanceOf(GalleryRevokedError);

    const own = await repository.listOwn(OWNER_A, 10);
    expect(own.map((row) => row.title)).toEqual(["Public v2", "Private", "Unlisted", "Public"]);
  });

  it("refuses the import of revoked rows and re-verifies the stored sha256 on import", async () => {
    const record = await publish(OWNER_A, { title: "Importable", visibility: "public" });
    const imported = await repository.getForImport(OWNER_B, record.id);
    expect(imported.artifactHash).toBe(record.artifactHash);
    expect(galleryArtifactHash(imported.artifact)).toBe(imported.artifactHash);

    const versions = await repository.revoke(OWNER_A, record.id, "Superseded", PUBLISHED_AT + 1_000);
    expect(versions).toEqual([
      expect.objectContaining({ version: 1, status: "revoked", revokedAt: PUBLISHED_AT + 1_000, revokeReason: "Superseded" })
    ]);
    // Import refused for everyone — the owner included — while the owner's
    // direct read keeps working and history stays intact.
    await expect(repository.getForImport(OWNER_A, record.id)).rejects.toBeInstanceOf(GalleryRevokedError);
    await expect(repository.getForImport(OWNER_B, record.id)).rejects.toBeInstanceOf(GalleryRevokedError);
    expect((await repository.getForViewer(OWNER_A, record.id)).artifactHash).toBe(record.artifactHash);

    const replay = await repository.revoke(OWNER_A, record.id, "Different reason", PUBLISHED_AT + 9_000);
    expect(replay[0]).toMatchObject({ revokedAt: PUBLISHED_AT + 1_000, revokeReason: "Superseded" });
    await expect(repository.revoke(OWNER_B, record.id, "Not mine", PUBLISHED_AT)).rejects.toBeInstanceOf(GalleryForbiddenError);
  });
});

function libraryBundle(): GallerySanitizedBundle {
  return buildGalleryArtifactV1({
    type: "library",
    artifact: {
      ir: structuredClone(VALID_IR),
      markets: [{ symbol: "BTCUSDT", timeframe: "1h" }],
      metrics: { inSample: { netProfitPct: 12.5, maxDrawdownPct: 4.25, sharpe: 1.3 } }
    },
    ownerUserId: OWNER_A
  });
}

function publishInput(
  ownerUserId: string,
  overrides: { title: string; visibility: "private" | "unlisted" | "public"; artifactId?: string; publishedAt?: number }
) {
  const bundle = libraryBundle();
  const publishedAt = overrides.publishedAt ?? PUBLISHED_AT;
  return {
    ...(overrides.artifactId !== undefined ? { artifactId: overrides.artifactId } : {}),
    ownerUserId,
    title: overrides.title,
    summary: "",
    visibility: overrides.visibility,
    artifact: bundle.artifact,
    artifactHash: bundle.artifactHash,
    rating: computeGalleryRating(bundle.artifact, { publishedAt }),
    publishedAt
  };
}

async function publish(
  ownerUserId: string,
  overrides: { title: string; visibility: "private" | "unlisted" | "public"; publishedAt?: number }
) {
  return repository.publish(publishInput(ownerUserId, overrides));
}
