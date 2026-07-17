import { ALERT_EVALUATION_RECEIPTS_MIGRATION_SQL } from "./alertEvaluationReceiptsMigration.js";
import { ALERT_EVENT_SEQUENCE_MIGRATION_SQL } from "./alertEventSequenceMigration.js";

/** PostgreSQL schema v13: tenant-owned alerts and notification outbox. */
export const ALERT_CONTROL_PLANE_MIGRATION_SQL = `
  CREATE TABLE alert_rules (
    id UUID PRIMARY KEY,
    owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    client_id VARCHAR(160) NOT NULL,
    rule_kind VARCHAR(40) NOT NULL
      CHECK (rule_kind IN (
        'price-threshold',
        'basis-spread',
        'research-route',
        'indicator',
        'drawing',
        'screener',
        'paper-robot-health',
        'paper-portfolio-drawdown'
      )),
    status VARCHAR(16) NOT NULL DEFAULT 'active'
      CHECK (status IN ('active', 'disabled', 'archived')),
    current_revision BIGINT NOT NULL DEFAULT 1
      CHECK (current_revision > 0),
    authorization_revision BIGINT NOT NULL
      CHECK (authorization_revision > 0),
    evaluation_interval_seconds INTEGER NOT NULL DEFAULT 60
      CHECK (evaluation_interval_seconds BETWEEN 60 AND 86400),
    next_evaluation_at TIMESTAMPTZ,
    evaluation_failure_count SMALLINT NOT NULL DEFAULT 0
      CHECK (evaluation_failure_count BETWEEN 0 AND 100),
    lease_generation BIGINT NOT NULL DEFAULT 0
      CHECK (lease_generation >= 0),
    lease_owner VARCHAR(128),
    lease_token UUID,
    lease_acquired_at TIMESTAMPTZ,
    lease_expires_at TIMESTAMPTZ,
    last_evaluated_at TIMESTAMPTZ,
    last_success_at TIMESTAMPTZ,
    last_error_code VARCHAR(96),
    last_error_at TIMESTAMPTZ,
    created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    archived_at TIMESTAMPTZ,
    UNIQUE (owner_user_id, id),
    UNIQUE (owner_user_id, client_id),
    CHECK (
      client_id = btrim(client_id)
      AND client_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'
    ),
    CHECK (
      (status = 'archived') = (archived_at IS NOT NULL)
      AND (status <> 'active' OR next_evaluation_at IS NOT NULL)
    ),
    CHECK (
      (lease_owner IS NULL) = (lease_token IS NULL)
      AND (lease_owner IS NULL) = (lease_acquired_at IS NULL)
      AND (lease_owner IS NULL) = (lease_expires_at IS NULL)
    ),
    CHECK (
      lease_owner IS NULL
      OR (
        status = 'active'
        AND lease_owner = btrim(lease_owner)
        AND char_length(lease_owner) BETWEEN 1 AND 128
        AND lease_owner !~ '[[:cntrl:]]'
        AND lease_expires_at > lease_acquired_at
      )
    ),
    CHECK (
      last_error_code IS NULL
      OR last_error_code ~ '^[a-z][a-z0-9._-]{0,95}$'
    ),
    CHECK (
      updated_at >= created_at
      AND (archived_at IS NULL OR archived_at >= created_at)
      AND (last_evaluated_at IS NULL OR last_evaluated_at >= created_at)
      AND (last_success_at IS NULL OR last_success_at >= created_at)
      AND (last_error_at IS NULL OR last_error_at >= created_at)
    )
  );
  CREATE INDEX alert_rules_due_evaluation_index
    ON alert_rules (next_evaluation_at ASC, owner_user_id ASC, id ASC)
    WHERE status = 'active' AND lease_owner IS NULL;
  CREATE INDEX alert_rules_expired_lease_index
    ON alert_rules (lease_expires_at ASC, id ASC)
    WHERE lease_owner IS NOT NULL;
  CREATE UNIQUE INDEX alert_rules_one_leased_per_owner
    ON alert_rules (owner_user_id)
    WHERE lease_owner IS NOT NULL;
  CREATE INDEX alert_rules_global_active_capacity_index
    ON alert_rules (id)
    WHERE status = 'active';
  CREATE INDEX alert_rules_owner_status_recent_index
    ON alert_rules (owner_user_id, status, updated_at DESC, id DESC);
  CREATE INDEX alert_rules_archived_retention_index
    ON alert_rules (archived_at ASC, owner_user_id, id)
    WHERE status = 'archived';

  CREATE TABLE alert_rule_revisions (
    owner_user_id UUID NOT NULL,
    alert_rule_id UUID NOT NULL,
    revision BIGINT NOT NULL CHECK (revision > 0),
    schema_version VARCHAR(32) NOT NULL
      CHECK (schema_version = 'alert-rule-v1'),
    rule_kind VARCHAR(40) NOT NULL,
    definition JSONB NOT NULL,
    definition_hash VARCHAR(64) NOT NULL
      CHECK (definition_hash ~ '^[0-9a-f]{64}$'),
    actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (owner_user_id, alert_rule_id, revision),
    FOREIGN KEY (owner_user_id, alert_rule_id)
      REFERENCES alert_rules(owner_user_id, id) ON DELETE CASCADE,
    CHECK (
      rule_kind IN (
        'price-threshold',
        'basis-spread',
        'research-route',
        'indicator',
        'drawing',
        'screener',
        'paper-robot-health',
        'paper-portfolio-drawdown'
      )
    ),
    CHECK (
      jsonb_typeof(definition) = 'object'
      AND octet_length(convert_to(definition::text, 'UTF8')) <= 32768
    )
  );
  ALTER TABLE alert_rules
    ADD CONSTRAINT alert_rules_current_revision_fkey
    FOREIGN KEY (owner_user_id, id, current_revision)
    REFERENCES alert_rule_revisions(owner_user_id, alert_rule_id, revision)
    DEFERRABLE INITIALLY DEFERRED;

  CREATE INDEX alert_rule_revisions_owner_recent_index
    ON alert_rule_revisions (
      owner_user_id,
      alert_rule_id,
      revision DESC
    );
  CREATE INDEX alert_rule_revisions_retention_index
    ON alert_rule_revisions (created_at ASC, owner_user_id, alert_rule_id, revision);

  CREATE TABLE alert_rule_states (
    owner_user_id UUID NOT NULL,
    alert_rule_id UUID NOT NULL,
    state_key VARCHAR(256) NOT NULL,
    rule_revision BIGINT NOT NULL CHECK (rule_revision > 0),
    state_revision BIGINT NOT NULL DEFAULT 1 CHECK (state_revision > 0),
    state_status VARCHAR(16) NOT NULL
      CHECK (state_status IN (
        'ineligible',
        'eligible',
        'stale',
        'unavailable',
        'error'
      )),
    initialized BOOLEAN NOT NULL DEFAULT FALSE,
    eligible BOOLEAN NOT NULL DEFAULT FALSE,
    armed BOOLEAN NOT NULL DEFAULT FALSE,
    last_observation_id VARCHAR(256),
    last_observation_hash VARCHAR(64),
    last_evaluated_bar_time BIGINT,
    state JSONB NOT NULL DEFAULT '{}'::jsonb,
    last_evaluated_at TIMESTAMPTZ NOT NULL,
    last_transition_at TIMESTAMPTZ,
    last_triggered_at TIMESTAMPTZ,
    cooldown_until TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (owner_user_id, alert_rule_id, state_key),
    FOREIGN KEY (owner_user_id, alert_rule_id, rule_revision)
      REFERENCES alert_rule_revisions(
        owner_user_id,
        alert_rule_id,
        revision
      ) ON DELETE CASCADE,
    CHECK (
      state_key = btrim(state_key)
      AND char_length(state_key) BETWEEN 1 AND 256
      AND state_key !~ '[[:cntrl:]]'
    ),
    CHECK (
      last_observation_id IS NULL
      OR (
        last_observation_id = btrim(last_observation_id)
        AND char_length(last_observation_id) BETWEEN 1 AND 256
        AND last_observation_id !~ '[[:cntrl:]]'
      )
    ),
    CHECK (
      last_observation_hash IS NULL
      OR last_observation_hash ~ '^[0-9a-f]{64}$'
    ),
    CHECK (
      last_evaluated_bar_time IS NULL
      OR last_evaluated_bar_time >= 0
    ),
    CHECK (
      jsonb_typeof(state) = 'object'
      AND octet_length(convert_to(state::text, 'UTF8')) <= 16384
    ),
    CHECK (eligible = (state_status = 'eligible')),
    CHECK (
      updated_at >= last_evaluated_at
      AND (
        last_transition_at IS NULL
        OR last_transition_at <= updated_at
      )
      AND (
        last_triggered_at IS NULL
        OR last_triggered_at <= updated_at
      )
    )
  );
  CREATE INDEX alert_rule_states_owner_status_index
    ON alert_rule_states (
      owner_user_id,
      state_status,
      updated_at DESC,
      alert_rule_id
    );
  CREATE INDEX alert_rule_states_retention_index
    ON alert_rule_states (updated_at ASC, owner_user_id, alert_rule_id)
    WHERE state_status IN ('ineligible', 'stale', 'unavailable', 'error');
  CREATE INDEX alert_rule_states_compaction_index
    ON alert_rule_states (updated_at ASC, owner_user_id, alert_rule_id, state_key);

${ALERT_EVALUATION_RECEIPTS_MIGRATION_SQL}

  CREATE TABLE alert_rule_events (
    id UUID PRIMARY KEY,
    owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    alert_rule_id UUID NOT NULL,
    rule_revision BIGINT NOT NULL CHECK (rule_revision > 0),
    state_key VARCHAR(256) NOT NULL,
    idempotency_key VARCHAR(160) NOT NULL,
    event_type VARCHAR(24) NOT NULL
      CHECK (event_type IN (
        'armed',
        'rearmed',
        'state_changed',
        'triggered',
        'suppressed',
        'evaluation_error'
      )),
    from_state VARCHAR(16),
    to_state VARCHAR(16),
    observation_id VARCHAR(256),
    observation_hash VARCHAR(64),
    evidence JSONB NOT NULL,
    notification_requested BOOLEAN NOT NULL DEFAULT FALSE,
    occurred_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (owner_user_id, id),
    UNIQUE (owner_user_id, idempotency_key),
    FOREIGN KEY (owner_user_id, alert_rule_id, rule_revision)
      REFERENCES alert_rule_revisions(
        owner_user_id,
        alert_rule_id,
        revision
      ) ON DELETE CASCADE,
    CHECK (
      state_key = btrim(state_key)
      AND char_length(state_key) BETWEEN 1 AND 256
      AND state_key !~ '[[:cntrl:]]'
      AND idempotency_key = btrim(idempotency_key)
      AND char_length(idempotency_key) BETWEEN 1 AND 160
      AND idempotency_key !~ '[[:cntrl:]]'
    ),
    CHECK (
      from_state IS NULL
      OR from_state IN ('ineligible', 'eligible', 'stale', 'unavailable', 'error')
    ),
    CHECK (
      to_state IS NULL
      OR to_state IN ('ineligible', 'eligible', 'stale', 'unavailable', 'error')
    ),
    CHECK (
      observation_hash IS NULL
      OR observation_hash ~ '^[0-9a-f]{64}$'
    ),
    CHECK (
      jsonb_typeof(evidence) = 'object'
      AND octet_length(convert_to(evidence::text, 'UTF8')) <= 32768
    ),
    CHECK (
      event_type <> 'triggered'
      OR (
        to_state = 'eligible'
        AND notification_requested
      )
    ),
    CHECK (created_at >= occurred_at)
  );
  CREATE INDEX alert_rule_events_owner_recent_index
    ON alert_rule_events (owner_user_id, occurred_at DESC, id DESC);
  CREATE INDEX alert_rule_events_rule_recent_index
    ON alert_rule_events (
      owner_user_id,
      alert_rule_id,
      occurred_at DESC,
      id DESC
    );
  CREATE INDEX alert_rule_events_retention_index
    ON alert_rule_events (created_at ASC, owner_user_id, id);

${ALERT_EVENT_SEQUENCE_MIGRATION_SQL}

  CREATE TABLE notification_bindings (
    id UUID PRIMARY KEY,
    owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    channel VARCHAR(16) NOT NULL CHECK (channel = 'telegram'),
    status VARCHAR(16) NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'active', 'revoked')),
    revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
    recipient_fingerprint VARCHAR(64) NOT NULL
      CHECK (recipient_fingerprint ~ '^[0-9a-f]{64}$'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    activated_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    UNIQUE (owner_user_id, id),
    UNIQUE (owner_user_id, id, revision),
    CHECK (
      (
        status = 'pending'
        AND activated_at IS NULL
        AND revoked_at IS NULL
      )
      OR (
        status = 'active'
        AND activated_at IS NOT NULL
        AND revoked_at IS NULL
      )
      OR (
        status = 'revoked'
        AND revoked_at IS NOT NULL
      )
    ),
    CHECK (
      updated_at >= created_at
      AND (activated_at IS NULL OR activated_at >= created_at)
      AND (revoked_at IS NULL OR revoked_at >= created_at)
    )
  );
  CREATE UNIQUE INDEX notification_bindings_active_recipient_unique
    ON notification_bindings (
      owner_user_id,
      channel,
      recipient_fingerprint
    )
    WHERE status = 'active';
  CREATE INDEX notification_bindings_owner_status_index
    ON notification_bindings (
      owner_user_id,
      status,
      updated_at DESC,
      id DESC
    );

  CREATE TABLE notification_outbox (
    id UUID PRIMARY KEY,
    owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    alert_event_id UUID NOT NULL,
    alert_rule_id UUID NOT NULL,
    rule_revision BIGINT NOT NULL CHECK (rule_revision > 0),
    authorization_revision BIGINT NOT NULL
      CHECK (authorization_revision > 0),
    deduplication_key VARCHAR(160) NOT NULL,
    schema_version VARCHAR(40) NOT NULL
      CHECK (schema_version = 'notification-envelope-v1'),
    payload JSONB NOT NULL,
    payload_hash VARCHAR(64) NOT NULL
      CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
    research_only BOOLEAN NOT NULL DEFAULT TRUE
      CHECK (research_only),
    execution_permission BOOLEAN NOT NULL DEFAULT FALSE
      CHECK (NOT execution_permission),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (owner_user_id, id),
    UNIQUE (owner_user_id, deduplication_key),
    FOREIGN KEY (owner_user_id, alert_event_id)
      REFERENCES alert_rule_events(owner_user_id, id) ON DELETE CASCADE,
    FOREIGN KEY (owner_user_id, alert_rule_id, rule_revision)
      REFERENCES alert_rule_revisions(
        owner_user_id,
        alert_rule_id,
        revision
      ) ON DELETE CASCADE,
    CHECK (
      deduplication_key = btrim(deduplication_key)
      AND char_length(deduplication_key) BETWEEN 1 AND 160
      AND deduplication_key !~ '[[:cntrl:]]'
    ),
    CHECK (
      jsonb_typeof(payload) = 'object'
      AND octet_length(convert_to(payload::text, 'UTF8')) <= 16384
    )
  );
  CREATE INDEX notification_outbox_owner_recent_index
    ON notification_outbox (owner_user_id, created_at DESC, id DESC);
  CREATE INDEX notification_outbox_retention_index
    ON notification_outbox (created_at ASC, owner_user_id, id);
  CREATE INDEX notification_outbox_event_lookup_index
    ON notification_outbox (owner_user_id, alert_event_id);

  CREATE TABLE notification_deliveries (
    id UUID PRIMARY KEY,
    owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    outbox_id UUID NOT NULL,
    channel VARCHAR(16) NOT NULL
      CHECK (channel IN ('in-app', 'telegram')),
    binding_id UUID,
    binding_revision BIGINT,
    deduplication_key VARCHAR(160) NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'queued'
      CHECK (status IN (
        'queued',
        'sending',
        'retrying',
        'delivered',
        'dead_letter',
        'cancelled',
        'held'
      )),
    attempt SMALLINT NOT NULL DEFAULT 0 CHECK (attempt BETWEEN 0 AND 20),
    max_attempts SMALLINT NOT NULL DEFAULT 6 CHECK (max_attempts BETWEEN 1 AND 20),
    run_after TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
    lease_generation BIGINT NOT NULL DEFAULT 0 CHECK (lease_generation >= 0),
    lease_owner VARCHAR(128),
    lease_token UUID,
    lease_acquired_at TIMESTAMPTZ,
    lease_expires_at TIMESTAMPTZ,
    provider_receipt VARCHAR(256),
    error_code VARCHAR(96),
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
    terminal_at TIMESTAMPTZ,
    delivered_at TIMESTAMPTZ,
    UNIQUE (owner_user_id, id),
    UNIQUE (owner_user_id, channel, deduplication_key),
    FOREIGN KEY (owner_user_id, outbox_id)
      REFERENCES notification_outbox(owner_user_id, id) ON DELETE CASCADE,
    FOREIGN KEY (owner_user_id, binding_id, binding_revision)
      REFERENCES notification_bindings(owner_user_id, id, revision),
    CHECK (
      deduplication_key = btrim(deduplication_key)
      AND char_length(deduplication_key) BETWEEN 1 AND 160
      AND deduplication_key !~ '[[:cntrl:]]'
    ),
    CHECK (
      (channel = 'in-app' AND binding_id IS NULL AND binding_revision IS NULL)
      OR (
        channel = 'telegram'
        AND binding_id IS NOT NULL
        AND binding_revision IS NOT NULL
      )
    ),
    CHECK (attempt <= max_attempts),
    CHECK (lease_generation = attempt),
    CHECK (
      (lease_owner IS NULL) = (lease_token IS NULL)
      AND (lease_owner IS NULL) = (lease_acquired_at IS NULL)
      AND (lease_owner IS NULL) = (lease_expires_at IS NULL)
    ),
    CHECK (
      (status = 'sending') = (lease_owner IS NOT NULL)
      AND (
        lease_owner IS NULL
        OR (
          lease_owner = btrim(lease_owner)
          AND char_length(lease_owner) BETWEEN 1 AND 128
          AND lease_owner !~ '[[:cntrl:]]'
          AND lease_expires_at > lease_acquired_at
        )
      )
    ),
    CHECK (
      (status IN ('delivered', 'dead_letter', 'cancelled'))
      = (terminal_at IS NOT NULL)
    ),
    CHECK ((status = 'delivered') = (delivered_at IS NOT NULL)),
    CHECK (
      error_code IS NULL
      OR error_code ~ '^[a-z][a-z0-9._-]{0,95}$'
    ),
    CHECK (
      error_message IS NULL
      OR char_length(error_message) BETWEEN 1 AND 2048
    ),
    CHECK (
      updated_at >= created_at
      AND run_after >= created_at
      AND (terminal_at IS NULL OR terminal_at >= created_at)
      AND (delivered_at IS NULL OR delivered_at = terminal_at)
    )
  );

  CREATE INDEX notification_deliveries_due_index
    ON notification_deliveries (run_after ASC, created_at ASC, id ASC)
    WHERE status IN ('queued', 'retrying');
  CREATE INDEX notification_deliveries_expired_lease_index
    ON notification_deliveries (lease_expires_at ASC, id ASC)
    WHERE status = 'sending';
  CREATE UNIQUE INDEX notification_deliveries_one_sending_per_owner
    ON notification_deliveries (owner_user_id)
    WHERE status = 'sending';
  CREATE INDEX notification_deliveries_owner_status_recent_index
    ON notification_deliveries (
      owner_user_id,
      status,
      created_at DESC,
      id DESC
    );
  CREATE INDEX notification_deliveries_terminal_retention_index
    ON notification_deliveries (terminal_at ASC, owner_user_id, id)
    WHERE status IN ('delivered', 'dead_letter', 'cancelled');
  CREATE INDEX notification_deliveries_outbox_lookup_index
    ON notification_deliveries (owner_user_id, outbox_id);

  CREATE TABLE alert_rule_import_receipts (
    owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source_kind VARCHAR(40) NOT NULL
      CHECK (source_kind IN (
        'browser-price-v1',
        'browser-basis-v1',
        'sqlite-basis-v1',
        'sqlite-basis-v2',
        'sqlite-research-v1'
      )),
    source_key VARCHAR(256) NOT NULL,
    source_hash VARCHAR(64) NOT NULL
      CHECK (source_hash ~ '^[0-9a-f]{64}$'),
    target_rule_id UUID,
    disposition VARCHAR(16) NOT NULL
      CHECK (disposition IN ('imported', 'noop', 'quarantined', 'conflict')),
    semantic_payload JSONB NOT NULL,
    imported_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    reconciled_at TIMESTAMPTZ,
    PRIMARY KEY (owner_user_id, source_kind, source_key),
    FOREIGN KEY (owner_user_id, target_rule_id)
      REFERENCES alert_rules(owner_user_id, id),
    CHECK (
      source_key = btrim(source_key)
      AND char_length(source_key) BETWEEN 1 AND 256
      AND source_key !~ '[[:cntrl:]]'
    ),
    CHECK (
      jsonb_typeof(semantic_payload) = 'object'
      AND octet_length(convert_to(semantic_payload::text, 'UTF8')) <= 32768
    ),
    CHECK (reconciled_at IS NULL OR reconciled_at >= imported_at)
  );

  CREATE INDEX alert_rule_import_receipts_owner_recent_index
    ON alert_rule_import_receipts (owner_user_id, imported_at DESC);
  CREATE INDEX alert_rule_import_receipts_target_lookup_index
    ON alert_rule_import_receipts (owner_user_id, target_rule_id)
    WHERE target_rule_id IS NOT NULL;

  CREATE FUNCTION reject_alert_immutable_update()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = pg_catalog, public
  AS $$
  BEGIN
    RAISE EXCEPTION '% rows are immutable', TG_TABLE_NAME;
  END;
  $$;

  CREATE TRIGGER alert_rule_revisions_immutable_update
    BEFORE UPDATE ON alert_rule_revisions
    FOR EACH ROW
    EXECUTE FUNCTION reject_alert_immutable_update();
  CREATE TRIGGER alert_evaluation_receipts_immutable_update
    BEFORE UPDATE ON alert_evaluation_receipts
    FOR EACH ROW
    EXECUTE FUNCTION reject_alert_immutable_update();
  CREATE TRIGGER alert_rule_events_immutable_update
    BEFORE UPDATE ON alert_rule_events
    FOR EACH ROW
    EXECUTE FUNCTION reject_alert_immutable_update();
  CREATE TRIGGER notification_outbox_immutable_update
    BEFORE UPDATE ON notification_outbox
    FOR EACH ROW
    EXECUTE FUNCTION reject_alert_immutable_update();

  ALTER TABLE runtime_component_heartbeats
    DROP CONSTRAINT runtime_component_heartbeats_component_check,
    ADD CONSTRAINT runtime_component_heartbeats_component_check
      CHECK (component IN ('research-worker', 'notification-worker'));
`;
