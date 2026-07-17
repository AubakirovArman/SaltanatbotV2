/** PostgreSQL schema v8: bounded compute-job artifact retention. Byte-frozen: its checksum is already recorded by deployed databases. */
export const COMPUTE_JOB_ARTIFACT_RETENTION_MIGRATION_SQL = `
      ALTER TABLE compute_jobs
        ALTER COLUMN payload DROP NOT NULL,
        ADD COLUMN artifact_size_bytes BIGINT,
        ADD COLUMN artifacts_pruned_at TIMESTAMPTZ;

      UPDATE compute_jobs
        SET artifact_size_bytes =
          COALESCE(octet_length(payload::text), 0)::bigint
          + COALESCE(octet_length(result::text), 0)::bigint;

      UPDATE compute_jobs
        SET completed_at = COALESCE(completed_at, updated_at, created_at)
        WHERE status IN ('completed', 'failed', 'cancelled')
          AND completed_at IS NULL;

      ALTER TABLE compute_jobs
        ALTER COLUMN artifact_size_bytes SET NOT NULL,
        ADD CONSTRAINT compute_jobs_artifact_size_nonnegative
          CHECK (artifact_size_bytes >= 0),
        ADD CONSTRAINT compute_jobs_terminal_completed_at
          CHECK (
            status NOT IN ('completed', 'failed', 'cancelled')
            OR completed_at IS NOT NULL
          ),
        ADD CONSTRAINT compute_jobs_active_payload_retained
          CHECK (
            status NOT IN ('queued', 'running')
            OR (
              payload IS NOT NULL
              AND artifacts_pruned_at IS NULL
            )
          ),
        ADD CONSTRAINT compute_jobs_tombstone_shape
          CHECK (
            artifacts_pruned_at IS NULL
            OR (
              status IN ('completed', 'failed', 'cancelled')
              AND completed_at IS NOT NULL
              AND artifacts_pruned_at >= completed_at
              AND payload IS NULL
              AND result IS NULL
              AND result_ref IS NULL
              AND error_message IS NULL
              AND artifact_size_bytes = 0
            )
          ),
        ADD CONSTRAINT compute_jobs_null_payload_is_tombstone
          CHECK (payload IS NOT NULL OR artifacts_pruned_at IS NOT NULL);

      CREATE TABLE compute_job_retention_usage (
        owner_user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        terminal_artifact_count BIGINT NOT NULL DEFAULT 0
          CHECK (terminal_artifact_count >= 0),
        terminal_artifact_bytes BIGINT NOT NULL DEFAULT 0
          CHECK (terminal_artifact_bytes >= 0),
        tombstone_count BIGINT NOT NULL DEFAULT 0
          CHECK (tombstone_count >= 0),
        last_retention_at TIMESTAMPTZ
      );

      INSERT INTO compute_job_retention_usage (
        owner_user_id,
        terminal_artifact_count,
        terminal_artifact_bytes,
        tombstone_count
      )
      SELECT
        owner_user_id,
        count(*) FILTER (
          WHERE status IN ('completed', 'failed', 'cancelled')
            AND artifacts_pruned_at IS NULL
        )::bigint,
        COALESCE(sum(artifact_size_bytes) FILTER (
          WHERE status IN ('completed', 'failed', 'cancelled')
            AND artifacts_pruned_at IS NULL
        ), 0)::bigint,
        count(*) FILTER (WHERE artifacts_pruned_at IS NOT NULL)::bigint
      FROM compute_jobs
      GROUP BY owner_user_id
      HAVING count(*) FILTER (
        WHERE status IN ('completed', 'failed', 'cancelled')
      ) > 0;

      CREATE FUNCTION maintain_compute_job_retention_usage()
      RETURNS trigger
      LANGUAGE plpgsql
      SECURITY INVOKER
      SET search_path = pg_catalog, public
      AS $$
      DECLARE
        usage_owner UUID;
        artifact_count_delta BIGINT := 0;
        artifact_bytes_delta BIGINT := 0;
        tombstone_count_delta BIGINT := 0;
      BEGIN
        IF TG_OP = 'UPDATE' AND OLD.owner_user_id <> NEW.owner_user_id THEN
          RAISE EXCEPTION 'compute job owner cannot change';
        END IF;

        IF TG_OP <> 'INSERT' THEN
          usage_owner := OLD.owner_user_id;
          IF OLD.artifacts_pruned_at IS NOT NULL THEN
            tombstone_count_delta := tombstone_count_delta - 1;
          ELSIF OLD.status IN ('completed', 'failed', 'cancelled') THEN
            artifact_count_delta := artifact_count_delta - 1;
            artifact_bytes_delta := artifact_bytes_delta - OLD.artifact_size_bytes;
          END IF;
        END IF;

        IF TG_OP <> 'DELETE' THEN
          usage_owner := NEW.owner_user_id;
          IF NEW.artifacts_pruned_at IS NOT NULL THEN
            tombstone_count_delta := tombstone_count_delta + 1;
          ELSIF NEW.status IN ('completed', 'failed', 'cancelled') THEN
            artifact_count_delta := artifact_count_delta + 1;
            artifact_bytes_delta := artifact_bytes_delta + NEW.artifact_size_bytes;
          END IF;
        END IF;

        IF artifact_count_delta <> 0
          OR artifact_bytes_delta <> 0
          OR tombstone_count_delta <> 0 THEN
          UPDATE compute_job_retention_usage SET
            terminal_artifact_count =
              terminal_artifact_count + artifact_count_delta,
            terminal_artifact_bytes =
              terminal_artifact_bytes + artifact_bytes_delta,
            tombstone_count =
              tombstone_count + tombstone_count_delta
          WHERE owner_user_id = usage_owner;
        END IF;

        IF NOT FOUND
          AND (artifact_count_delta > 0 OR tombstone_count_delta > 0) THEN
          INSERT INTO compute_job_retention_usage (
            owner_user_id,
            terminal_artifact_count,
            terminal_artifact_bytes,
            tombstone_count
          ) VALUES (
            usage_owner,
            artifact_count_delta,
            artifact_bytes_delta,
            tombstone_count_delta
          )
          ON CONFLICT (owner_user_id) DO UPDATE SET
            terminal_artifact_count =
              compute_job_retention_usage.terminal_artifact_count
              + EXCLUDED.terminal_artifact_count,
            terminal_artifact_bytes =
              compute_job_retention_usage.terminal_artifact_bytes
              + EXCLUDED.terminal_artifact_bytes,
            tombstone_count =
              compute_job_retention_usage.tombstone_count
              + EXCLUDED.tombstone_count;
        END IF;

        IF TG_OP = 'DELETE' THEN
          RETURN OLD;
        END IF;
        RETURN NEW;
      END;
      $$;

      CREATE TRIGGER compute_jobs_retention_usage_trigger
      AFTER INSERT OR UPDATE OR DELETE ON compute_jobs
      FOR EACH ROW
      EXECUTE FUNCTION maintain_compute_job_retention_usage();

      CREATE INDEX compute_jobs_full_artifact_retention_index
        ON compute_jobs (owner_user_id, completed_at ASC, id ASC)
        WHERE status IN ('completed', 'failed', 'cancelled')
          AND artifacts_pruned_at IS NULL;
      CREATE INDEX compute_jobs_tombstone_retention_index
        ON compute_jobs (owner_user_id, artifacts_pruned_at ASC, id ASC)
        WHERE artifacts_pruned_at IS NOT NULL;
    `;
