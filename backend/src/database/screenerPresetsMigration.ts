/** PostgreSQL schema v14: owner-scoped technical screener presets. */
export const SCREENER_PRESETS_MIGRATION_SQL = `
  CREATE TABLE screener_presets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client_id VARCHAR(160) NOT NULL,
    name VARCHAR(120),
    definition JSONB NOT NULL
      CHECK (octet_length(definition::text) <= 16384),
    definition_hash CHAR(64) NOT NULL
      CHECK (definition_hash ~ '^[0-9a-f]{64}$'),
    revision BIGINT NOT NULL DEFAULT 1
      CHECK (revision > 0),
    authorization_revision BIGINT NOT NULL
      CHECK (authorization_revision > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    archived_at TIMESTAMPTZ,
    UNIQUE (owner_user_id, id),
    UNIQUE (owner_user_id, client_id),
    CHECK (
      client_id = btrim(client_id)
      AND client_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'
    ),
    CHECK (
      name IS NULL
      OR (
        name = btrim(name)
        AND char_length(name) BETWEEN 1 AND 120
        AND name !~ '[[:cntrl:]]'
      )
    ),
    CHECK (jsonb_typeof(definition) = 'object'),
    CHECK (
      updated_at >= created_at
      AND (archived_at IS NULL OR archived_at >= created_at)
    )
  );

  CREATE INDEX screener_presets_owner_recent_index
    ON screener_presets (owner_user_id, archived_at, updated_at DESC);
  CREATE INDEX screener_presets_retention_index
    ON screener_presets (created_at ASC);
`;
