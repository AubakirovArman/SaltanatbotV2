import { createHash } from "node:crypto";
import { ALERT_CONTROL_PLANE_MIGRATION_SQL } from "./alertControlPlaneMigration.js";
import { COMPUTE_JOB_ARTIFACT_RETENTION_MIGRATION_SQL } from "./computeJobArtifactRetentionMigration.js";
import { EXECUTOR_COMMANDS_MIGRATION_SQL } from "./executorCommandsMigration.js";
import { GA_EVOLUTION_LINEAGE_MIGRATION_SQL } from "./gaEvolutionLineageMigration.js";
import { IDENTITY_CONTROL_PLANE_MIGRATION_SQL } from "./identityControlPlaneMigration.js";
import { ONBOARDING_AND_RUNTIME_HEARTBEATS_MIGRATION_SQL } from "./onboardingMigration.js";
import { SCREENER_PRESETS_MIGRATION_SQL } from "./screenerPresetsMigration.js";
import { TELEGRAM_COMMAND_BRIDGE_MIGRATION_SQL } from "./telegramCommandBridgeMigration.js";
import { TELEGRAM_NOTIFICATION_INGRESS_MIGRATION_SQL } from "./telegramIngressMigration.js";
import { WORKSPACE_WORKFLOW_MIGRATION_SQL } from "./workspaceWorkflowMigration.js";

export interface DatabaseMigration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
}

const migrationDefinitions = [
  {
    version: 1,
    name: "identity_sessions_and_audit",
    sql: `
      CREATE TABLE users (
        id UUID PRIMARY KEY,
        login VARCHAR(64) NOT NULL,
        login_normalized VARCHAR(64) NOT NULL,
        password_hash TEXT NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'active', 'disabled')),
        app_role VARCHAR(16) NOT NULL DEFAULT 'user'
          CHECK (app_role IN ('user', 'admin')),
        trading_role VARCHAR(24) NOT NULL DEFAULT 'none'
          CHECK (trading_role IN ('none', 'read-only', 'paper-trade', 'live-trade')),
        must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
        approved_at TIMESTAMPTZ,
        approved_by UUID REFERENCES users(id) ON DELETE SET NULL,
        last_login_at TIMESTAMPTZ,
        password_changed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        CHECK (login = btrim(login)),
        CHECK (char_length(login) BETWEEN 3 AND 64),
        CHECK (char_length(login_normalized) BETWEEN 3 AND 64),
        CHECK (char_length(password_hash) BETWEEN 20 AND 1024)
      );

      CREATE UNIQUE INDEX users_login_normalized_unique
        ON users (login_normalized);
      CREATE INDEX users_status_created_at_index
        ON users (status, created_at DESC);

      CREATE TABLE auth_sessions (
        id_hash VARCHAR(64) PRIMARY KEY
          CHECK (id_hash ~ '^[0-9a-f]{64}$'),
        user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        csrf_hash VARCHAR(64) NOT NULL
          CHECK (csrf_hash ~ '^[0-9a-f]{64}$'),
        expires_at TIMESTAMPTZ NOT NULL,
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        revoked_at TIMESTAMPTZ,
        revoke_reason VARCHAR(160),
        user_agent VARCHAR(512),
        ip_address INET,
        created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        UNIQUE (id_hash, user_id),
        CHECK (expires_at > created_at),
        CHECK (revoke_reason IS NULL OR revoked_at IS NOT NULL)
      );

      CREATE INDEX auth_sessions_user_active_index
        ON auth_sessions (user_id, expires_at DESC)
        WHERE revoked_at IS NULL;
      CREATE INDEX auth_sessions_expiry_index
        ON auth_sessions (expires_at);

      CREATE TABLE auth_ws_tickets (
        ticket_hash VARCHAR(64) PRIMARY KEY
          CHECK (ticket_hash ~ '^[0-9a-f]{64}$'),
        session_id_hash VARCHAR(64) NOT NULL,
        user_id UUID NOT NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        consumed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        FOREIGN KEY (session_id_hash, user_id)
          REFERENCES auth_sessions(id_hash, user_id) ON DELETE CASCADE,
        CHECK (expires_at > created_at)
      );

      CREATE INDEX auth_ws_tickets_expiry_index
        ON auth_ws_tickets (expires_at);
      CREATE INDEX auth_ws_tickets_session_index
        ON auth_ws_tickets (session_id_hash, created_at DESC);

      CREATE TABLE audit_events (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        event_type VARCHAR(96) NOT NULL,
        actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        subject_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        request_id VARCHAR(128),
        ip_address INET,
        user_agent VARCHAR(512),
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        CHECK (event_type ~ '^[a-z][a-z0-9._-]{1,95}$'),
        CHECK (jsonb_typeof(metadata) = 'object')
      );

      CREATE INDEX audit_events_occurred_at_index
        ON audit_events (occurred_at DESC);
      CREATE INDEX audit_events_actor_index
        ON audit_events (actor_user_id, occurred_at DESC)
        WHERE actor_user_id IS NOT NULL;
      CREATE INDEX audit_events_subject_index
        ON audit_events (subject_user_id, occurred_at DESC)
        WHERE subject_user_id IS NOT NULL;
    `
  },
  {
    version: 2,
    name: "durable_user_workspaces",
    sql: `
      CREATE TABLE workspaces (
        id UUID PRIMARY KEY,
        owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name VARCHAR(120) NOT NULL,
        schema_version INTEGER NOT NULL,
        payload JSONB NOT NULL,
        revision BIGINT NOT NULL DEFAULT 1,
        content_hash VARCHAR(64),
        deleted_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        UNIQUE (owner_user_id, id),
        CHECK (name = btrim(name)),
        CHECK (char_length(name) BETWEEN 1 AND 120),
        CHECK (schema_version > 0),
        CHECK (revision > 0),
        CHECK (jsonb_typeof(payload) = 'object'),
        CHECK (content_hash IS NULL OR content_hash ~ '^[0-9a-f]{64}$')
      );

      CREATE INDEX workspaces_owner_updated_index
        ON workspaces (owner_user_id, updated_at DESC)
        WHERE deleted_at IS NULL;
      CREATE INDEX workspaces_deleted_index
        ON workspaces (owner_user_id, deleted_at)
        WHERE deleted_at IS NOT NULL;

      CREATE TABLE workspace_revisions (
        workspace_id UUID NOT NULL,
        owner_user_id UUID NOT NULL,
        revision BIGINT NOT NULL,
        name VARCHAR(120) NOT NULL,
        schema_version INTEGER NOT NULL,
        payload JSONB NOT NULL,
        content_hash VARCHAR(64),
        created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        PRIMARY KEY (workspace_id, revision),
        FOREIGN KEY (owner_user_id, workspace_id)
          REFERENCES workspaces(owner_user_id, id) ON DELETE CASCADE,
        CHECK (revision > 0),
        CHECK (schema_version > 0),
        CHECK (jsonb_typeof(payload) = 'object'),
        CHECK (content_hash IS NULL OR content_hash ~ '^[0-9a-f]{64}$')
      );

      CREATE INDEX workspace_revisions_owner_created_index
        ON workspace_revisions (owner_user_id, created_at DESC);
    `
  },
  {
    version: 3,
    name: "durable_compute_jobs",
    sql: `
      CREATE TABLE compute_jobs (
        id UUID PRIMARY KEY,
        owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        job_type VARCHAR(64) NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'queued'
          CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
        payload JSONB NOT NULL,
        result JSONB,
        result_ref TEXT,
        error_code VARCHAR(96),
        error_message TEXT,
        progress DOUBLE PRECISION NOT NULL DEFAULT 0,
        estimated_cost BIGINT NOT NULL DEFAULT 0,
        priority SMALLINT NOT NULL DEFAULT 0,
        client_request_id VARCHAR(128),
        dedupe_key VARCHAR(128),
        attempt INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 1,
        run_after TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        lease_owner VARCHAR(128),
        lease_token UUID,
        lease_expires_at TIMESTAMPTZ,
        cancel_requested_at TIMESTAMPTZ,
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        CHECK (job_type ~ '^[a-z][a-z0-9._-]{1,63}$'),
        CHECK (jsonb_typeof(payload) = 'object'),
        CHECK (result IS NULL OR jsonb_typeof(result) = 'object'),
        CHECK (progress >= 0 AND progress <= 1),
        CHECK (estimated_cost >= 0),
        CHECK (priority BETWEEN -100 AND 100),
        CHECK (attempt >= 0),
        CHECK (max_attempts BETWEEN 1 AND 100),
        CHECK (attempt <= max_attempts),
        CHECK ((lease_owner IS NULL) = (lease_token IS NULL)),
        CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL)),
        CHECK (completed_at IS NULL OR status IN ('completed', 'failed', 'cancelled'))
      );

      CREATE UNIQUE INDEX compute_jobs_owner_request_unique
        ON compute_jobs (owner_user_id, client_request_id)
        WHERE client_request_id IS NOT NULL;
      CREATE INDEX compute_jobs_queue_claim_index
        ON compute_jobs (priority DESC, run_after ASC, created_at ASC)
        WHERE status = 'queued' AND cancel_requested_at IS NULL;
      CREATE INDEX compute_jobs_owner_status_index
        ON compute_jobs (owner_user_id, status, created_at DESC);
      CREATE INDEX compute_jobs_active_lease_index
        ON compute_jobs (lease_expires_at)
        WHERE status = 'running';
      CREATE INDEX compute_jobs_dedupe_index
        ON compute_jobs (owner_user_id, job_type, dedupe_key, created_at DESC)
        WHERE dedupe_key IS NOT NULL;
    `
  },
  {
    version: 4,
    name: "workspace_client_identifiers",
    sql: `
      ALTER TABLE workspaces
        ADD COLUMN client_id VARCHAR(160);

      UPDATE workspaces
        SET client_id = id::text
        WHERE client_id IS NULL;

      ALTER TABLE workspaces
        ALTER COLUMN client_id SET NOT NULL;

      ALTER TABLE workspaces
        ADD CONSTRAINT workspaces_client_id_format
        CHECK (client_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$');

      CREATE UNIQUE INDEX workspaces_owner_client_id_active_unique
        ON workspaces (owner_user_id, client_id)
        WHERE deleted_at IS NULL;
    `
  },
  {
    version: 5,
    name: "persistent_authorization_revision",
    sql: `
      ALTER TABLE users
        ADD COLUMN authorization_revision BIGINT NOT NULL DEFAULT 1;

      ALTER TABLE users
        ADD CONSTRAINT users_authorization_revision_positive
        CHECK (authorization_revision > 0);
    `
  },
  {
    version: 6,
    name: "bounded_compute_job_metrics",
    sql: `
      CREATE INDEX compute_jobs_terminal_completed_index
        ON compute_jobs (completed_at DESC)
        WHERE status IN ('completed', 'failed', 'cancelled');

      CREATE INDEX compute_jobs_owner_terminal_completed_index
        ON compute_jobs (owner_user_id, completed_at DESC)
        WHERE status IN ('completed', 'failed', 'cancelled');
    `
  },
  {
    version: 7,
    name: "durable_execution_step_ledger",
    sql: `
      CREATE TABLE execution_step_ledger (
        owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        intent_id VARCHAR(160) NOT NULL,
        intent_digest VARCHAR(64) NOT NULL
          CHECK (intent_digest ~ '^[0-9a-f]{64}$'),
        signed_request_digest VARCHAR(64) NOT NULL
          CHECK (signed_request_digest ~ '^[0-9a-f]{64}$'),
        binding_digest VARCHAR(64) NOT NULL
          CHECK (binding_digest ~ '^[0-9a-f]{64}$'),
        created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        PRIMARY KEY (owner_user_id, intent_id),
        UNIQUE (owner_user_id, binding_digest),
        CHECK (intent_id = btrim(intent_id)),
        CHECK (char_length(intent_id) BETWEEN 1 AND 160),
        CHECK (intent_id !~ '[[:cntrl:]]')
      );

      CREATE TABLE execution_step_ledger_owner_usage (
        owner_user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        durable_key_count BIGINT NOT NULL DEFAULT 0
          CHECK (durable_key_count BETWEEN 0 AND 250000)
      );

      CREATE TABLE execution_step_reservations (
        owner_user_id UUID NOT NULL,
        intent_id VARCHAR(160) NOT NULL,
        account_id VARCHAR(160) NOT NULL,
        operation_kind VARCHAR(24) NOT NULL
          CHECK (operation_kind IN ('bot', 'manual', 'emergency', 'reconciliation')),
        operation_id VARCHAR(160) NOT NULL,
        account_revision BIGINT NOT NULL CHECK (account_revision > 0),
        credential_revision BIGINT NOT NULL CHECK (credential_revision > 0),
        authorization_revision BIGINT NOT NULL CHECK (authorization_revision > 0),
        authorization_epoch BIGINT NOT NULL CHECK (authorization_epoch >= 0),
        live_arm_epoch BIGINT NOT NULL CHECK (live_arm_epoch > 0),
        status VARCHAR(16) NOT NULL DEFAULT 'reserved'
          CHECK (status IN ('reserved', 'consumed', 'expired')),
        reservation_id UUID NOT NULL UNIQUE,
        reserved_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        reservation_expires_at TIMESTAMPTZ NOT NULL,
        consumed_at TIMESTAMPTZ,
        terminal_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        PRIMARY KEY (owner_user_id, intent_id),
        FOREIGN KEY (owner_user_id, intent_id)
          REFERENCES execution_step_ledger(owner_user_id, intent_id) ON DELETE CASCADE,
        CHECK (account_id = btrim(account_id)),
        CHECK (char_length(account_id) BETWEEN 1 AND 160),
        CHECK (account_id !~ '[[:cntrl:]]'),
        CHECK (operation_id = btrim(operation_id)),
        CHECK (char_length(operation_id) BETWEEN 1 AND 160),
        CHECK (operation_id !~ '[[:cntrl:]]'),
        CHECK (reservation_expires_at > reserved_at),
        CHECK (
          (status = 'reserved' AND consumed_at IS NULL AND terminal_at IS NULL)
          OR (
            status = 'consumed'
            AND consumed_at IS NOT NULL
            AND terminal_at IS NOT NULL
            AND consumed_at >= reserved_at
            AND terminal_at >= consumed_at
          )
          OR (
            status = 'expired'
            AND consumed_at IS NULL
            AND terminal_at IS NOT NULL
            AND terminal_at >= reservation_expires_at
          )
        )
      );

      CREATE INDEX execution_step_reservations_owner_status_index
        ON execution_step_reservations (owner_user_id, status, created_at DESC);
      CREATE INDEX execution_step_reservations_owner_operation_index
        ON execution_step_reservations (owner_user_id, operation_kind, operation_id, created_at DESC);
      CREATE INDEX execution_step_reservations_expiry_index
        ON execution_step_reservations (reservation_expires_at ASC)
        WHERE status = 'reserved';
      CREATE INDEX execution_step_reservations_terminal_retention_index
        ON execution_step_reservations (terminal_at ASC)
        WHERE status IN ('consumed', 'expired');
      CREATE INDEX execution_step_reservations_owner_terminal_retention_index
        ON execution_step_reservations (owner_user_id, terminal_at DESC, intent_id DESC)
        WHERE status IN ('consumed', 'expired');
    `
  },
  {
    version: 8,
    name: "bounded_compute_job_artifact_retention",
    sql: COMPUTE_JOB_ARTIFACT_RETENTION_MIGRATION_SQL
  },
  {
    version: 9,
    name: "identity_admin_control_plane",
    sql: IDENTITY_CONTROL_PLANE_MIGRATION_SQL
  },
  {
    version: 10,
    name: "versioned_workspace_workflow",
    sql: WORKSPACE_WORKFLOW_MIGRATION_SQL
  },
  {
    version: 11,
    name: "owner_onboarding_and_runtime_heartbeats",
    sql: ONBOARDING_AND_RUNTIME_HEARTBEATS_MIGRATION_SQL
  },
  {
    version: 12,
    name: "durable_executor_command_queue",
    sql: EXECUTOR_COMMANDS_MIGRATION_SQL
  },
  {
    version: 13,
    name: "durable_owner_alerts_and_notification_outbox",
    sql: ALERT_CONTROL_PLANE_MIGRATION_SQL
  },
  {
    version: 14,
    name: "owner_screener_presets",
    sql: SCREENER_PRESETS_MIGRATION_SQL
  },
  {
    version: 15,
    name: "telegram_notification_ingress",
    sql: TELEGRAM_NOTIFICATION_INGRESS_MIGRATION_SQL
  },
  {
    version: 16,
    name: "telegram_command_bridge",
    sql: TELEGRAM_COMMAND_BRIDGE_MIGRATION_SQL
  },
  {
    version: 17,
    name: "ga_evolution_lineage",
    sql: GA_EVOLUTION_LINEAGE_MIGRATION_SQL
  }
] as const;

function checksum(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

export const DATABASE_MIGRATIONS: readonly DatabaseMigration[] = migrationDefinitions.map((migration) => ({
  ...migration,
  checksum: checksum(migration.sql)
}));

export const LATEST_DATABASE_SCHEMA_VERSION = DATABASE_MIGRATIONS.at(-1)?.version ?? 0;

export const SCHEMA_MIGRATIONS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY CHECK (version > 0),
    name VARCHAR(160) NOT NULL UNIQUE,
    checksum VARCHAR(64) NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
    applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
  )
`;
