/** PostgreSQL schema v15: Telegram notification ingress and binding codes. */
export const TELEGRAM_NOTIFICATION_INGRESS_MIGRATION_SQL = `
  ALTER TABLE notification_bindings
    ADD COLUMN recipient_chat_id VARCHAR(64);

  CREATE TABLE notification_binding_codes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    code_hash CHAR(64) NOT NULL
      CHECK (code_hash ~ '^[0-9a-f]{64}$'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    consumed_binding_id UUID,
    UNIQUE (owner_user_id, id),
    UNIQUE (code_hash),
    CHECK (expires_at > created_at),
    CHECK (consumed_at IS NULL OR consumed_at >= created_at)
  );

  CREATE INDEX notification_binding_codes_owner_recent_index
    ON notification_binding_codes (owner_user_id, created_at DESC);
  CREATE INDEX notification_binding_codes_retention_index
    ON notification_binding_codes (created_at ASC);

  CREATE TABLE telegram_ingress_consumers (
    bot_fingerprint CHAR(64) PRIMARY KEY
      CHECK (bot_fingerprint ~ '^[0-9a-f]{64}$'),
    lease_generation BIGINT NOT NULL DEFAULT 0
      CHECK (lease_generation >= 0),
    lease_owner VARCHAR(128),
    lease_token CHAR(64),
    lease_expires_at TIMESTAMPTZ,
    cursor_update_id BIGINT NOT NULL DEFAULT 0
      CHECK (cursor_update_id >= 0),
    cursor_advanced_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (
      (lease_owner IS NULL) = (lease_token IS NULL)
      AND (lease_owner IS NULL) = (lease_expires_at IS NULL)
    ),
    CHECK (
      lease_owner IS NULL
      OR (
        lease_owner = btrim(lease_owner)
        AND char_length(lease_owner) BETWEEN 1 AND 128
        AND lease_owner !~ '[[:cntrl:]]'
      )
    ),
    CHECK (lease_token IS NULL OR lease_token ~ '^[0-9a-f]{64}$'),
    CHECK (updated_at >= created_at)
  );

  CREATE TABLE telegram_updates (
    bot_fingerprint CHAR(64) NOT NULL
      CHECK (bot_fingerprint ~ '^[0-9a-f]{64}$'),
    update_id BIGINT NOT NULL
      CHECK (update_id >= 0),
    received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    chat_fingerprint CHAR(64)
      CHECK (chat_fingerprint IS NULL OR chat_fingerprint ~ '^[0-9a-f]{64}$'),
    kind VARCHAR(32) NOT NULL
      CHECK (kind ~ '^[a-z][a-z0-9._-]{0,31}$'),
    outcome VARCHAR(32) NOT NULL
      CHECK (outcome ~ '^[a-z][a-z0-9._-]{0,31}$'),
    PRIMARY KEY (bot_fingerprint, update_id)
  );

  CREATE INDEX telegram_updates_retention_index
    ON telegram_updates (received_at ASC);
`;
