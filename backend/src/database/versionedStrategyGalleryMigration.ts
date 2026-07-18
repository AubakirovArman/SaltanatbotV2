/**
 * PostgreSQL schema v18: versioned strategy gallery with content-frozen
 * publications (R9.3). Each publication is one immutable (id, version) row
 * carrying a SANITIZED artifact bundle — the sanitizer whitelist guarantees
 * no owner ids, workspace refs, run ids or lineage user data are ever stored,
 * and the BEFORE UPDATE trigger makes the published content immutable at the
 * SQL level: after publish only visibility, status, revoked_at, revoke_reason
 * and updated_at may change. Revocation therefore never rewrites history and
 * an imported bundle can never change silently underneath its hash.
 */
export const VERSIONED_STRATEGY_GALLERY_MIGRATION_SQL = `
  CREATE TABLE gallery_artifacts (
    id UUID NOT NULL,
    version INTEGER NOT NULL
      CHECK (version >= 1),
    owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(120) NOT NULL,
    summary VARCHAR(2000) NOT NULL,
    artifact JSONB NOT NULL,
    artifact_hash VARCHAR(64) NOT NULL
      CHECK (artifact_hash ~ '^[0-9a-f]{64}$'),
    visibility VARCHAR(16) NOT NULL DEFAULT 'private'
      CHECK (visibility IN ('private', 'unlisted', 'public')),
    status VARCHAR(16) NOT NULL DEFAULT 'active'
      CHECK (status IN ('active', 'revoked')),
    rating JSONB NOT NULL,
    published_at BIGINT NOT NULL
      CHECK (published_at > 0),
    revoked_at BIGINT,
    revoke_reason VARCHAR(400),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (id, version),
    CHECK (title = btrim(title)),
    CHECK (char_length(title) BETWEEN 1 AND 120),
    CHECK (title !~ '[[:cntrl:]]'),
    CHECK (char_length(summary) <= 2000),
    CHECK (
      jsonb_typeof(artifact) = 'object'
      AND octet_length(convert_to(artifact::text, 'UTF8')) <= 262144
    ),
    CHECK (
      jsonb_typeof(rating) = 'object'
      AND octet_length(convert_to(rating::text, 'UTF8')) <= 4096
    ),
    CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
    CHECK (revoked_at IS NULL OR revoked_at >= published_at),
    CHECK (revoke_reason IS NULL OR revoked_at IS NOT NULL),
    CHECK (revoke_reason IS NULL OR char_length(revoke_reason) BETWEEN 1 AND 400),
    CHECK (updated_at >= created_at)
  );

  CREATE INDEX gallery_artifacts_public_feed_index
    ON gallery_artifacts (visibility, status, published_at DESC);
  CREATE INDEX gallery_artifacts_owner_recent_index
    ON gallery_artifacts (owner_user_id, published_at DESC);

  CREATE FUNCTION reject_gallery_content_update()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = pg_catalog, public
  AS $$
  BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id
      OR NEW.version IS DISTINCT FROM OLD.version
      OR NEW.owner_user_id IS DISTINCT FROM OLD.owner_user_id
      OR NEW.title IS DISTINCT FROM OLD.title
      OR NEW.summary IS DISTINCT FROM OLD.summary
      OR NEW.artifact IS DISTINCT FROM OLD.artifact
      OR NEW.artifact_hash IS DISTINCT FROM OLD.artifact_hash
      OR NEW.rating IS DISTINCT FROM OLD.rating
      OR NEW.published_at IS DISTINCT FROM OLD.published_at
      OR NEW.created_at IS DISTINCT FROM OLD.created_at
    THEN
      RAISE EXCEPTION 'gallery_artifacts published content is immutable';
    END IF;
    RETURN NEW;
  END;
  $$;

  CREATE TRIGGER gallery_artifacts_content_frozen
    BEFORE UPDATE ON gallery_artifacts
    FOR EACH ROW
    EXECUTE FUNCTION reject_gallery_content_update();
`;
