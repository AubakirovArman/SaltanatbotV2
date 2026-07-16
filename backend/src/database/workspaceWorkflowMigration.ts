import { WORKSPACE_DATABASE_PAYLOAD_BYTE_LIMIT } from "../workspaces/workspaceLimits.js";

export const WORKSPACE_WORKFLOW_MIGRATION_SQL = `
  ALTER TABLE workspaces
    ADD COLUMN archived_at TIMESTAMPTZ,
    ADD COLUMN payload_bytes BIGINT NOT NULL DEFAULT 0
      CHECK (payload_bytes >= 0);

  ALTER TABLE workspace_revisions
    ADD COLUMN payload_bytes BIGINT NOT NULL DEFAULT 0
      CHECK (payload_bytes >= 0);

  UPDATE workspaces
    SET payload_bytes = octet_length(convert_to(payload::text, 'UTF8'));

  UPDATE workspace_revisions
    SET payload_bytes = octet_length(convert_to(payload::text, 'UTF8'));

  DO $$
  BEGIN
    IF EXISTS (
      SELECT 1 FROM workspaces
      WHERE payload_bytes > ${WORKSPACE_DATABASE_PAYLOAD_BYTE_LIMIT}
    ) OR EXISTS (
      SELECT 1 FROM workspace_revisions
      WHERE payload_bytes > ${WORKSPACE_DATABASE_PAYLOAD_BYTE_LIMIT}
    ) THEN
      RAISE EXCEPTION
        'Workspace schema v10 preflight failed: a persisted jsonb payload exceeds the bounded response payload limit of ${WORKSPACE_DATABASE_PAYLOAD_BYTE_LIMIT} bytes.'
        USING ERRCODE = 'check_violation';
    END IF;
  END;
  $$;

  ALTER TABLE workspaces
    ADD CONSTRAINT workspaces_payload_bytes_response_bound
    CHECK (payload_bytes <= ${WORKSPACE_DATABASE_PAYLOAD_BYTE_LIMIT});

  ALTER TABLE workspace_revisions
    ADD CONSTRAINT workspace_revisions_payload_bytes_response_bound
    CHECK (payload_bytes <= ${WORKSPACE_DATABASE_PAYLOAD_BYTE_LIMIT});

  CREATE FUNCTION maintain_workspace_payload_bytes()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = pg_catalog, public
  AS $$
  BEGIN
    NEW.payload_bytes := octet_length(convert_to(NEW.payload::text, 'UTF8'));
    RETURN NEW;
  END;
  $$;

  CREATE TRIGGER workspaces_payload_bytes_trigger
  BEFORE INSERT OR UPDATE OF payload ON workspaces
  FOR EACH ROW
  EXECUTE FUNCTION maintain_workspace_payload_bytes();

  CREATE TRIGGER workspace_revisions_payload_bytes_trigger
  BEFORE INSERT OR UPDATE OF payload ON workspace_revisions
  FOR EACH ROW
  EXECUTE FUNCTION maintain_workspace_payload_bytes();

  CREATE INDEX workspaces_owner_archive_updated_index
    ON workspaces (owner_user_id, archived_at, updated_at DESC)
    WHERE deleted_at IS NULL;

  CREATE INDEX workspace_revisions_owner_workspace_recent_index
    ON workspace_revisions (owner_user_id, workspace_id, revision DESC);
`;
