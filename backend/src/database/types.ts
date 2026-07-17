export const USER_STATUSES = ["pending", "active", "disabled"] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const APP_ROLES = ["user", "admin"] as const;
export type AppRole = (typeof APP_ROLES)[number];

export const TRADING_ROLES = ["none", "read-only", "paper-trade", "live-trade"] as const;
export type TradingRole = (typeof TRADING_ROLES)[number];

export const COMPUTE_JOB_STATUSES = ["queued", "running", "completed", "failed", "cancelled"] as const;
export type ComputeJobStatus = (typeof COMPUTE_JOB_STATUSES)[number];

export interface UserDatabaseRow {
  id: string;
  login: string;
  login_normalized: string;
  password_hash: string;
  status: UserStatus;
  app_role: AppRole;
  trading_role: TradingRole;
  must_change_password: boolean;
  approved_at: Date | null;
  approved_by: string | null;
  last_login_at: Date | null;
  password_changed_at: Date | null;
  authorization_revision: string;
  created_at: Date;
  updated_at: Date;
}

export interface AuthSessionDatabaseRow {
  public_id: string;
  id_hash: string;
  user_id: string;
  csrf_hash: string;
  expires_at: Date;
  last_seen_at: Date;
  revoked_at: Date | null;
  revoke_reason: string | null;
  user_agent: string | null;
  ip_address: string | null;
  created_at: Date;
}

export interface AuditEventDatabaseRow {
  id: string;
  event_type: string;
  actor_user_id: string | null;
  actor_login: string | null;
  subject_user_id: string | null;
  subject_login: string | null;
  request_id: string | null;
  ip_address: string | null;
  user_agent: string | null;
  metadata: unknown;
  occurred_at: Date;
}

export interface WorkspaceDatabaseRow {
  id: string;
  client_id: string;
  owner_user_id: string;
  name: string;
  schema_version: number;
  payload: unknown | null;
  revision: string;
  content_hash: string | null;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface UserOnboardingDatabaseRow {
  owner_user_id: string;
  schema_version: number;
  revision: string;
  goal: "monitoring" | "price-alert" | "backtest" | "paper-robot" | null;
  goal_selected_at: Date | null;
  first_chart_at: Date | null;
  first_alert_at: Date | null;
  first_backtest_at: Date | null;
  first_paper_robot_at: Date | null;
  completed_at: Date | null;
  dismissed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface ComputeJobDatabaseRow {
  id: string;
  owner_user_id: string;
  job_type: string;
  status: ComputeJobStatus;
  payload: unknown;
  result: unknown | null;
  result_ref: string | null;
  artifact_size_bytes: string;
  artifacts_pruned_at: Date | null;
  error_code: string | null;
  error_message: string | null;
  progress: number;
  estimated_cost: string;
  priority: number;
  client_request_id: string | null;
  dedupe_key: string | null;
  attempt: number;
  max_attempts: number;
  run_after: Date;
  lease_owner: string | null;
  lease_token: string | null;
  lease_expires_at: Date | null;
  cancel_requested_at: Date | null;
  started_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}
