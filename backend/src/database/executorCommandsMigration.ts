import {
  MAX_EXECUTOR_COMMAND_ATTEMPTS,
  MAX_EXECUTOR_COMMAND_ERROR_MESSAGE_CHARS,
  MAX_EXECUTOR_COMMAND_PAYLOAD_BYTES,
  MAX_EXECUTOR_COMMAND_RESULT_BYTES
} from "./executorCommandTypes.js";

export const EXECUTOR_COMMANDS_MIGRATION_SQL = `
  CREATE TABLE executor_commands (
    id UUID PRIMARY KEY,
    owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    session_id_hash VARCHAR(64) NOT NULL
      CHECK (session_id_hash ~ '^[0-9a-f]{64}$'),
    authorization_revision BIGINT NOT NULL
      CHECK (authorization_revision > 0),
    authorization_epoch BIGINT NOT NULL
      CHECK (authorization_epoch >= 0),
    command_type VARCHAR(64) NOT NULL,
    target_type VARCHAR(64) NOT NULL,
    target_id VARCHAR(160) NOT NULL,
    idempotency_key VARCHAR(160) NOT NULL,
    request_hash VARCHAR(64) NOT NULL
      CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    payload JSONB NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'queued'
      CHECK (status IN ('queued', 'applying', 'applied', 'rejected')),
    attempt SMALLINT NOT NULL DEFAULT 0
      CHECK (attempt BETWEEN 0 AND ${MAX_EXECUTOR_COMMAND_ATTEMPTS}),
    max_attempts SMALLINT NOT NULL
      CHECK (max_attempts BETWEEN 1 AND ${MAX_EXECUTOR_COMMAND_ATTEMPTS}),
    lease_generation BIGINT NOT NULL DEFAULT 0
      CHECK (lease_generation >= 0),
    lease_owner VARCHAR(128),
    lease_token UUID,
    lease_acquired_at TIMESTAMPTZ,
    lease_expires_at TIMESTAMPTZ,
    sqlite_receipt_hash VARCHAR(64)
      CHECK (
        sqlite_receipt_hash IS NULL
        OR sqlite_receipt_hash ~ '^[0-9a-f]{64}$'
      ),
    result JSONB,
    error_code VARCHAR(96),
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    terminal_at TIMESTAMPTZ,
    applied_at TIMESTAMPTZ,
    UNIQUE (owner_user_id, idempotency_key),
    CHECK (command_type ~ '^[a-z][a-z0-9._-]{0,63}$'),
    CHECK (target_type ~ '^[a-z][a-z0-9._-]{0,63}$'),
    CHECK (
      target_id = btrim(target_id)
      AND char_length(target_id) BETWEEN 1 AND 160
      AND target_id !~ '[[:cntrl:]]'
    ),
    CHECK (
      idempotency_key = btrim(idempotency_key)
      AND char_length(idempotency_key) BETWEEN 1 AND 160
      AND idempotency_key !~ '[[:cntrl:]]'
    ),
    CHECK (
      jsonb_typeof(payload) = 'object'
      AND octet_length(convert_to(payload::text, 'UTF8')) <= ${MAX_EXECUTOR_COMMAND_PAYLOAD_BYTES}
    ),
    CHECK (
      result IS NULL
      OR (
        jsonb_typeof(result) = 'object'
        AND octet_length(convert_to(result::text, 'UTF8')) <= ${MAX_EXECUTOR_COMMAND_RESULT_BYTES}
      )
    ),
    CHECK (
      error_code IS NULL
      OR error_code ~ '^[a-z][a-z0-9._-]{0,95}$'
    ),
    CHECK (
      error_message IS NULL
      OR char_length(error_message) BETWEEN 1 AND ${MAX_EXECUTOR_COMMAND_ERROR_MESSAGE_CHARS}
    ),
    CHECK (attempt <= max_attempts),
    CHECK (lease_generation = attempt),
    CHECK (
      (lease_owner IS NULL) = (lease_token IS NULL)
      AND (lease_owner IS NULL) = (lease_acquired_at IS NULL)
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
    CHECK ((status = 'applying') = (lease_owner IS NOT NULL)),
    CHECK (
      lease_expires_at IS NULL
      OR lease_expires_at > lease_acquired_at
    ),
    CHECK (
      (status IN ('applied', 'rejected')) = (terminal_at IS NOT NULL)
    ),
    CHECK ((status = 'applied') = (applied_at IS NOT NULL)),
    CHECK ((status = 'applied') = (sqlite_receipt_hash IS NOT NULL)),
    CHECK ((status = 'rejected') = (error_code IS NOT NULL)),
    CHECK (result IS NULL OR status = 'applied'),
    CHECK (error_message IS NULL OR status = 'rejected'),
    CHECK (
      updated_at >= created_at
      AND (lease_acquired_at IS NULL OR lease_acquired_at >= created_at)
      AND (terminal_at IS NULL OR terminal_at >= created_at)
      AND (applied_at IS NULL OR applied_at = terminal_at)
    )
  );

  CREATE INDEX executor_commands_queue_claim_index
    ON executor_commands (created_at ASC, id ASC)
    WHERE status = 'queued';
  CREATE UNIQUE INDEX executor_commands_one_applying_per_owner
    ON executor_commands (owner_user_id)
    WHERE status = 'applying';
  CREATE INDEX executor_commands_expired_lease_index
    ON executor_commands (lease_expires_at ASC, id ASC)
    WHERE status = 'applying';
  CREATE INDEX executor_commands_owner_status_recent_index
    ON executor_commands (owner_user_id, status, created_at DESC, id DESC);
  CREATE INDEX executor_commands_owner_target_recent_index
    ON executor_commands (
      owner_user_id,
      target_type,
      target_id,
      created_at DESC,
      id DESC
    );
  CREATE INDEX executor_commands_owner_terminal_retention_index
    ON executor_commands (owner_user_id, terminal_at ASC, id ASC)
    WHERE status IN ('applied', 'rejected');
`;
