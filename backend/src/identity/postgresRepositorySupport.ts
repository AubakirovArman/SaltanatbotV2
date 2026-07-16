import type { Pool, PoolClient } from "pg";
import type {
  AuditEventDatabaseRow,
  AuthSessionDatabaseRow,
  UserDatabaseRow
} from "../database/types.js";
import type {
  AdminUserMutation,
  AuditEventInput,
  PageRequest,
  UserUpdate
} from "./repository.js";
import type {
  IdentityAuditEvent,
  IdentitySession,
  IdentityUser
} from "./types.js";
import { canonicalUuid } from "./identityValidation.js";

const IDENTITY_ADMIN_GUARD_LOCK = 1_824_664_913;

export interface SessionJoinRow extends UserDatabaseRow {
  session_public_id: string;
  session_id_hash: string;
  session_user_id: string;
  session_csrf_hash: string;
  session_expires_at: Date;
  session_last_seen_at: Date;
  session_revoked_at: Date | null;
  session_revoke_reason: string | null;
  session_user_agent: string | null;
  session_ip_address: string | null;
  session_created_at: Date;
}

export interface CountRow {
  count: string;
}

export async function withIdentityAdminGuard<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [
      IDENTITY_ADMIN_GUARD_LOCK
    ]);
    const result = await operation(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export function userInsertValues(user: IdentityUser): unknown[] {
  return [
    canonicalUuid(user.id),
    user.login,
    user.loginNormalized,
    user.passwordHash,
    user.status,
    user.appRole,
    user.tradingRole,
    user.mustChangePassword,
    user.approvedBy ? canonicalUuid(user.approvedBy) : null,
    user.approvedAt ?? null,
    user.lastLoginAt ?? null,
    user.createdAt,
    user.updatedAt
  ];
}

export function userUpdateStatement(
  id: string,
  update: UserUpdate
): { text: string; values: unknown[] } {
  const values: unknown[] = [];
  const assignments: string[] = [];
  const authorizationMutation =
    update.status !== undefined ||
    update.appRole !== undefined ||
    update.tradingRole !== undefined ||
    update.mustChangePassword !== undefined ||
    update.passwordHash !== undefined;
  const add = (column: string, value: unknown) => {
    values.push(value);
    assignments.push(`${column} = $${values.length}`);
  };
  if (update.status !== undefined) add("status", update.status);
  if (update.appRole !== undefined) add("app_role", update.appRole);
  if (update.tradingRole !== undefined) add("trading_role", update.tradingRole);
  if (update.mustChangePassword !== undefined) {
    add("must_change_password", update.mustChangePassword);
  }
  if (update.passwordHash !== undefined) {
    add("password_hash", update.passwordHash);
    add("password_changed_at", update.updatedAt);
  }
  if (update.approvedBy !== undefined) add("approved_by", update.approvedBy);
  if (update.approvedAt !== undefined) add("approved_at", update.approvedAt);
  if (update.lastLoginAt !== undefined) add("last_login_at", update.lastLoginAt);
  if (authorizationMutation) {
    assignments.push("authorization_revision = authorization_revision + 1");
  }
  add("updated_at", update.updatedAt);
  values.push(id);
  return {
    text: `UPDATE users SET ${assignments.join(", ")} WHERE id = $${values.length} RETURNING *`,
    values
  };
}

export function isActiveAdminRow(row: UserDatabaseRow): boolean {
  return row.status === "active" && row.app_role === "admin";
}

export function isActiveAdmin(
  user: Pick<IdentityUser, "status" | "appRole">
): boolean {
  return user.status === "active" && user.appRole === "admin";
}

export async function activeAdminReplacementExists(
  client: PoolClient,
  subjectUserId: string
): Promise<boolean> {
  const replacement = await client.query(
    `SELECT 1
     FROM users
     WHERE id <> $1
       AND status = 'active'
       AND app_role = 'admin'
     LIMIT 1`,
    [subjectUserId]
  );
  return (replacement.rowCount ?? 0) > 0;
}

export function validateAdminActorRow(
  row: UserDatabaseRow | undefined
):
  | "actor_not_found"
  | "actor_inactive"
  | "actor_not_admin"
  | "actor_password_change_required"
  | undefined {
  if (!row) return "actor_not_found";
  if (row.status !== "active") return "actor_inactive";
  if (row.app_role !== "admin") return "actor_not_admin";
  if (row.must_change_password) return "actor_password_change_required";
  return undefined;
}

export function validateSessionActorRow(
  row: UserDatabaseRow | undefined,
  requireAdmin: boolean
):
  | "actor_not_found"
  | "actor_inactive"
  | "actor_not_admin"
  | "actor_password_change_required"
  | undefined {
  if (!row) return "actor_not_found";
  if (row.status !== "active") return "actor_inactive";
  if (!requireAdmin) return undefined;
  if (row.app_role !== "admin") return "actor_not_admin";
  if (row.must_change_password) return "actor_password_change_required";
  return undefined;
}

export function validTransition(
  user: IdentityUser,
  action: AdminUserMutation["action"]
): boolean {
  if (action === "activate") return user.status === "pending";
  if (action === "reactivate") return user.status === "disabled";
  if (action === "disable") return user.status === "active";
  return true;
}

export function lifecycleSessionReason(
  action: AdminUserMutation["action"]
): string {
  if (action === "activate") return "user_activated";
  if (action === "reactivate") return "user_reactivated";
  if (action === "disable") return "user_disabled";
  return "permissions_changed";
}

export function lifecycleEventType(
  action: AdminUserMutation["action"]
): string {
  if (action === "activate") return "user.activated";
  if (action === "reactivate") return "user.reactivated";
  if (action === "disable") return "user.disabled";
  return "user.permissions_changed";
}

export function sessionReason(eventType: string): string {
  return eventType.replaceAll(".", "_").slice(0, 160);
}

export function safeUserSnapshot(
  user: IdentityUser
): Record<string, unknown> {
  return {
    id: user.id,
    login: user.login,
    status: user.status,
    appRole: user.appRole,
    tradingRole: user.tradingRole,
    mustChangePassword: user.mustChangePassword,
    authorizationRevision: user.authorizationRevision,
    approvedBy: user.approvedBy,
    approvedAt: user.approvedAt?.toISOString(),
    lastLoginAt: user.lastLoginAt?.toISOString(),
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString()
  };
}

export function sessionJoinSql(joinOrWhere: string): string {
  return `SELECT
      u.*,
      s.public_id::text AS session_public_id,
      s.id_hash AS session_id_hash,
      s.user_id AS session_user_id,
      s.csrf_hash AS session_csrf_hash,
      s.expires_at AS session_expires_at,
      s.last_seen_at AS session_last_seen_at,
      s.revoked_at AS session_revoked_at,
      s.revoke_reason AS session_revoke_reason,
      s.user_agent AS session_user_agent,
      s.ip_address::text AS session_ip_address,
      s.created_at AS session_created_at
    FROM auth_sessions s
    JOIN users u ON u.id = s.user_id
    ${joinOrWhere}`;
}

export function mapUser(row: UserDatabaseRow): IdentityUser {
  return {
    id: row.id,
    login: row.login,
    loginNormalized: row.login_normalized,
    passwordHash: row.password_hash,
    status: row.status,
    appRole: row.app_role,
    tradingRole: row.trading_role,
    mustChangePassword: row.must_change_password,
    authorizationRevision: safeRevision(row.authorization_revision),
    approvedBy: row.approved_by ?? undefined,
    approvedAt: row.approved_at ?? undefined,
    lastLoginAt: row.last_login_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function safeRevision(value: string): number {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new Error("Invalid user authorization revision");
  }
  return revision;
}

export function mapSession(row: AuthSessionDatabaseRow): IdentitySession {
  return {
    publicId: row.public_id,
    idHash: row.id_hash,
    userId: row.user_id,
    csrfHash: row.csrf_hash,
    expiresAt: row.expires_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at ?? undefined,
    revokeReason: row.revoke_reason ?? undefined,
    userAgent: row.user_agent ?? undefined,
    ipAddress: row.ip_address ?? undefined,
    createdAt: row.created_at
  };
}

export function mapSessionJoin(
  row: SessionJoinRow
): { user: IdentityUser; session: IdentitySession } {
  return {
    user: mapUser(row),
    session: {
      publicId: row.session_public_id,
      idHash: row.session_id_hash,
      userId: row.session_user_id,
      csrfHash: row.session_csrf_hash,
      expiresAt: row.session_expires_at,
      lastSeenAt: row.session_last_seen_at,
      revokedAt: row.session_revoked_at ?? undefined,
      revokeReason: row.session_revoke_reason ?? undefined,
      userAgent: row.session_user_agent ?? undefined,
      ipAddress: row.session_ip_address ?? undefined,
      createdAt: row.session_created_at
    }
  };
}

export function mapAuditEvent(
  row: AuditEventDatabaseRow
): IdentityAuditEvent {
  return {
    id: row.id,
    eventType: row.event_type,
    actorUserId: row.actor_user_id ?? undefined,
    actorLogin: row.actor_login ?? undefined,
    subjectUserId: row.subject_user_id ?? undefined,
    subjectLogin: row.subject_login ?? undefined,
    requestId: row.request_id ?? undefined,
    ipAddress: row.ip_address ?? undefined,
    userAgent: row.user_agent ?? undefined,
    metadata: objectMetadata(row.metadata),
    occurredAt: row.occurred_at
  };
}

function objectMetadata(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export async function insertAuditEvent(
  client: Pick<Pool, "query"> | Pick<PoolClient, "query">,
  event: AuditEventInput
): Promise<void> {
  await client.query(
    `INSERT INTO audit_events (
       event_type, actor_user_id, subject_user_id, request_id,
       ip_address, user_agent, metadata, occurred_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
    [
      event.eventType,
      event.actorUserId ?? null,
      event.subjectUserId ?? null,
      event.requestId ?? null,
      event.ipAddress ?? null,
      event.userAgent ?? null,
      JSON.stringify(event.metadata ?? {}),
      event.createdAt
    ]
  );
}

export function pageOffset(request: PageRequest): number {
  return (request.page - 1) * request.pageSize;
}

export function boundedCleanupLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 1_000;
  return Math.min(10_000, Math.max(1, Math.trunc(limit)));
}
