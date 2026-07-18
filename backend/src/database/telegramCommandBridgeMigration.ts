/** PostgreSQL schema v16: Telegram command replies and fenced control confirmations. */
export const TELEGRAM_COMMAND_BRIDGE_MIGRATION_SQL = `
  CREATE TABLE telegram_command_replies (
    command_id UUID PRIMARY KEY
      REFERENCES executor_commands(id) ON DELETE CASCADE,
    owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    binding_id UUID NOT NULL,
    binding_revision BIGINT NOT NULL CHECK (binding_revision > 0),
    purpose VARCHAR(32) NOT NULL
      CHECK (purpose ~ '^[a-z][a-z0-9-]{0,31}$'),
    request_context JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    replied_at TIMESTAMPTZ,
    UNIQUE (owner_user_id, command_id),
    FOREIGN KEY (owner_user_id, binding_id, binding_revision)
      REFERENCES notification_bindings(owner_user_id, id, revision),
    CHECK (
      jsonb_typeof(request_context) = 'object'
      AND octet_length(convert_to(request_context::text, 'UTF8')) <= 2048
    ),
    CHECK (replied_at IS NULL OR replied_at >= created_at)
  );

  CREATE INDEX telegram_command_replies_pending_index
    ON telegram_command_replies (created_at ASC, command_id ASC)
    WHERE replied_at IS NULL;
  CREATE INDEX telegram_command_replies_retention_index
    ON telegram_command_replies (created_at ASC);
  CREATE INDEX telegram_command_replies_owner_recent_index
    ON telegram_command_replies (owner_user_id, created_at DESC);

  CREATE TABLE telegram_confirmations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    binding_id UUID NOT NULL,
    binding_revision BIGINT NOT NULL CHECK (binding_revision > 0),
    chat_fingerprint CHAR(64) NOT NULL
      CHECK (chat_fingerprint ~ '^[0-9a-f]{64}$'),
    action VARCHAR(16) NOT NULL
      CHECK (action IN ('pause', 'resume', 'stop')),
    portfolio_id VARCHAR(200) NOT NULL,
    bot_id VARCHAR(200) NOT NULL,
    bot_status_at_issue VARCHAR(16)
      CHECK (
        bot_status_at_issue IS NULL
        OR bot_status_at_issue ~ '^[a-z][a-z0-9_-]{0,15}$'
      ),
    portfolio_revision BIGINT NOT NULL CHECK (portfolio_revision > 0),
    ledger_epoch BIGINT NOT NULL CHECK (ledger_epoch > 0),
    bot_revision BIGINT NOT NULL CHECK (bot_revision > 0),
    authorization_revision BIGINT NOT NULL
      CHECK (authorization_revision > 0),
    token_hash CHAR(64) NOT NULL
      CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    consumed_update_id BIGINT,
    UNIQUE (owner_user_id, id),
    UNIQUE (token_hash),
    FOREIGN KEY (owner_user_id, binding_id, binding_revision)
      REFERENCES notification_bindings(owner_user_id, id, revision),
    CHECK (
      portfolio_id = btrim(portfolio_id)
      AND char_length(portfolio_id) BETWEEN 1 AND 200
      AND portfolio_id !~ '[[:cntrl:]]'
    ),
    CHECK (
      bot_id = btrim(bot_id)
      AND char_length(bot_id) BETWEEN 1 AND 200
      AND bot_id !~ '[[:cntrl:]]'
    ),
    CHECK (expires_at > created_at),
    CHECK (consumed_at IS NULL OR consumed_at >= created_at),
    CHECK ((consumed_at IS NULL) = (consumed_update_id IS NULL)),
    CHECK (consumed_update_id IS NULL OR consumed_update_id >= 0)
  );

  CREATE INDEX telegram_confirmations_owner_pending_index
    ON telegram_confirmations (owner_user_id, created_at ASC)
    WHERE consumed_at IS NULL;
  CREATE INDEX telegram_confirmations_retention_index
    ON telegram_confirmations (created_at ASC);
`;
