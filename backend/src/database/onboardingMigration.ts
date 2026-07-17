export const ONBOARDING_AND_RUNTIME_HEARTBEATS_MIGRATION_SQL = `
  CREATE TABLE user_onboarding (
    owner_user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    schema_version SMALLINT NOT NULL DEFAULT 1
      CHECK (schema_version = 1),
    revision BIGINT NOT NULL DEFAULT 1
      CHECK (revision > 0),
    goal VARCHAR(24)
      CHECK (
        goal IN (
          'monitoring',
          'price-alert',
          'backtest',
          'paper-robot'
        )
      ),
    goal_selected_at TIMESTAMPTZ,
    first_chart_at TIMESTAMPTZ,
    first_alert_at TIMESTAMPTZ,
    first_backtest_at TIMESTAMPTZ,
    first_paper_robot_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    dismissed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT statement_timestamp(),
    CONSTRAINT user_onboarding_goal_selection_shape
      CHECK ((goal IS NULL) = (goal_selected_at IS NULL)),
    CONSTRAINT user_onboarding_terminal_state_exclusive
      CHECK (completed_at IS NULL OR dismissed_at IS NULL),
    CONSTRAINT user_onboarding_completion_requires_goal_milestone
      CHECK (
        completed_at IS NULL
        OR (
          goal IS NOT NULL
          AND (
            (goal = 'monitoring' AND first_chart_at IS NOT NULL)
            OR (goal = 'price-alert' AND first_alert_at IS NOT NULL)
            OR (goal = 'backtest' AND first_backtest_at IS NOT NULL)
            OR (goal = 'paper-robot' AND first_paper_robot_at IS NOT NULL)
          )
        )
      ),
    CONSTRAINT user_onboarding_timestamps_ordered
      CHECK (
        updated_at >= created_at
        AND (goal_selected_at IS NULL OR goal_selected_at >= created_at)
        AND (first_chart_at IS NULL OR first_chart_at >= created_at)
        AND (first_alert_at IS NULL OR first_alert_at >= created_at)
        AND (first_backtest_at IS NULL OR first_backtest_at >= created_at)
        AND (
          first_paper_robot_at IS NULL
          OR first_paper_robot_at >= created_at
        )
        AND (completed_at IS NULL OR completed_at >= created_at)
        AND (dismissed_at IS NULL OR dismissed_at >= created_at)
      )
  );

  WITH existing_users AS (
    SELECT id, statement_timestamp() AS suppressed_at
    FROM users
  )
  INSERT INTO user_onboarding (
    owner_user_id,
    dismissed_at,
    created_at,
    updated_at
  )
  SELECT
    id,
    suppressed_at,
    suppressed_at,
    suppressed_at
  FROM existing_users;

  CREATE TABLE runtime_component_heartbeats (
    component VARCHAR(32) PRIMARY KEY
      CHECK (component = 'research-worker'),
    generation_id UUID NOT NULL,
    status VARCHAR(16) NOT NULL
      CHECK (
        status IN ('starting', 'ready', 'draining', 'stopped', 'failed')
      ),
    started_at TIMESTAMPTZ NOT NULL,
    heartbeat_at TIMESTAMPTZ NOT NULL,
    release_commit VARCHAR(64)
      CHECK (
        release_commit IS NULL
        OR release_commit ~ '^[0-9a-f]{7,64}$'
      ),
    database_schema_version INTEGER NOT NULL
      CHECK (database_schema_version > 0),
    CHECK (heartbeat_at >= started_at)
  );
`;
