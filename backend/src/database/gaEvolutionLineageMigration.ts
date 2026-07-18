/** PostgreSQL schema v17: server GA evolution runs with checkpointed lineage. */
export const GA_EVOLUTION_LINEAGE_MIGRATION_SQL = `
  CREATE TABLE ga_runs (
    id UUID PRIMARY KEY,
    owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    job_id UUID REFERENCES compute_jobs(id) ON DELETE SET NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'running'
      CHECK (status IN ('running', 'checkpointed', 'completed', 'failed', 'cancelled')),
    config JSONB NOT NULL,
    seed BIGINT NOT NULL
      CHECK (seed BETWEEN 0 AND 4294967295),
    dataset_fingerprint VARCHAR(64)
      CHECK (dataset_fingerprint IS NULL OR dataset_fingerprint ~ '^[0-9a-f]{64}$'),
    engine_version VARCHAR(32) NOT NULL
      CHECK (engine_version ~ '^[a-z0-9][a-z0-9._-]{0,31}$'),
    generator_version VARCHAR(32) NOT NULL
      CHECK (generator_version ~ '^[a-z0-9][a-z0-9._-]{0,31}$'),
    current_generation INTEGER NOT NULL DEFAULT 0
      CHECK (current_generation BETWEEN 0 AND 16),
    checkpoint JSONB,
    pareto JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (owner_user_id, id),
    CHECK (
      jsonb_typeof(config) = 'object'
      AND octet_length(convert_to(config::text, 'UTF8')) <= 16384
    ),
    CHECK (
      checkpoint IS NULL
      OR (
        jsonb_typeof(checkpoint) = 'object'
        AND octet_length(convert_to(checkpoint::text, 'UTF8')) <= 524288
      )
    ),
    CHECK (
      pareto IS NULL
      OR (
        jsonb_typeof(pareto) = 'object'
        AND octet_length(convert_to(pareto::text, 'UTF8')) <= 262144
      )
    ),
    CHECK (updated_at >= created_at)
  );

  CREATE INDEX ga_runs_owner_recent_index
    ON ga_runs (owner_user_id, created_at DESC);
  CREATE UNIQUE INDEX ga_runs_one_active_per_owner
    ON ga_runs (owner_user_id)
    WHERE status = 'running';

  CREATE TABLE ga_candidates (
    run_id UUID NOT NULL REFERENCES ga_runs(id) ON DELETE CASCADE,
    fingerprint VARCHAR(96) NOT NULL,
    generation INTEGER NOT NULL
      CHECK (generation BETWEEN 0 AND 16),
    parent_fingerprints JSONB NOT NULL DEFAULT '[]'::jsonb,
    mutation_log JSONB NOT NULL DEFAULT '[]'::jsonb,
    ir JSONB NOT NULL,
    metrics JSONB NOT NULL,
    objectives JSONB NOT NULL,
    pareto_rank INTEGER
      CHECK (pareto_rank IS NULL OR pareto_rank >= 0),
    oos_report JSONB,
    promoted_at BIGINT
      CHECK (promoted_at IS NULL OR promoted_at > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (run_id, fingerprint),
    CHECK (
      fingerprint = btrim(fingerprint)
      AND char_length(fingerprint) BETWEEN 1 AND 96
      AND fingerprint !~ '[[:cntrl:]]'
    ),
    CHECK (
      jsonb_typeof(parent_fingerprints) = 'array'
      AND octet_length(convert_to(parent_fingerprints::text, 'UTF8')) <= 2048
    ),
    CHECK (
      jsonb_typeof(mutation_log) = 'array'
      AND octet_length(convert_to(mutation_log::text, 'UTF8')) <= 8192
    ),
    CHECK (
      jsonb_typeof(ir) = 'object'
      AND octet_length(convert_to(ir::text, 'UTF8')) <= 32768
    ),
    CHECK (
      jsonb_typeof(metrics) = 'object'
      AND octet_length(convert_to(metrics::text, 'UTF8')) <= 16384
    ),
    CHECK (
      jsonb_typeof(objectives) = 'object'
      AND octet_length(convert_to(objectives::text, 'UTF8')) <= 2048
    ),
    CHECK (
      oos_report IS NULL
      OR (
        jsonb_typeof(oos_report) = 'object'
        AND octet_length(convert_to(oos_report::text, 'UTF8')) <= 8192
      )
    ),
    CHECK (promoted_at IS NULL OR oos_report IS NOT NULL)
  );

  CREATE INDEX ga_candidates_run_generation_index
    ON ga_candidates (run_id, generation ASC, fingerprint ASC);
`;
