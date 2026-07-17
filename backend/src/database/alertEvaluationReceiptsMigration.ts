/** Revision-scoped, immutable evidence receipts for schema v13 alert evaluation. */
export const ALERT_EVALUATION_RECEIPTS_MIGRATION_SQL = `
  CREATE TABLE alert_evaluation_receipts (
    owner_user_id UUID NOT NULL,
    producer VARCHAR(64) NOT NULL,
    alert_rule_id UUID NOT NULL,
    rule_revision BIGINT NOT NULL CHECK (rule_revision > 0),
    state_key VARCHAR(256) NOT NULL,
    observation_id VARCHAR(256) NOT NULL,
    observation_hash VARCHAR(64) NOT NULL
      CHECK (observation_hash ~ '^[0-9a-f]{64}$'),
    state_revision_before BIGINT NOT NULL CHECK (state_revision_before >= 0),
    state_revision_after BIGINT NOT NULL CHECK (state_revision_after > 0),
    outcome VARCHAR(16) NOT NULL CHECK (outcome IN ('armed', 'triggered')),
    transition_key VARCHAR(64),
    prior_state_hash VARCHAR(64) NOT NULL
      CHECK (prior_state_hash ~ '^[0-9a-f]{64}$'),
    committed_state_hash VARCHAR(64) NOT NULL
      CHECK (committed_state_hash ~ '^[0-9a-f]{64}$'),
    evaluated_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (
      owner_user_id,
      producer,
      alert_rule_id,
      rule_revision,
      observation_id
    ),
    FOREIGN KEY (owner_user_id, alert_rule_id, rule_revision)
      REFERENCES alert_rule_revisions(
        owner_user_id,
        alert_rule_id,
        revision
      ) ON DELETE CASCADE,
    CHECK (
      producer ~ '^[a-z][a-z0-9._-]{0,63}$'
      AND state_key = btrim(state_key)
      AND char_length(state_key) BETWEEN 1 AND 256
      AND state_key !~ '[[:cntrl:]]'
      AND observation_id = btrim(observation_id)
      AND char_length(observation_id) BETWEEN 1 AND 256
      AND observation_id !~ '[[:cntrl:]]'
      AND created_at >= evaluated_at
    ),
    CHECK (state_revision_after = state_revision_before + 1),
    CHECK (
      (outcome = 'triggered' AND transition_key ~ '^[0-9a-f]{64}$')
      OR (outcome = 'armed' AND transition_key IS NULL)
    )
  );

  CREATE INDEX alert_evaluation_receipts_owner_recent_index
    ON alert_evaluation_receipts (owner_user_id, evaluated_at DESC);
  CREATE INDEX alert_evaluation_receipts_rule_revision_index
    ON alert_evaluation_receipts (
      owner_user_id,
      alert_rule_id,
      rule_revision,
      evaluated_at DESC
    );
  CREATE INDEX alert_evaluation_receipts_retention_index
    ON alert_evaluation_receipts (created_at ASC, owner_user_id);
`;
