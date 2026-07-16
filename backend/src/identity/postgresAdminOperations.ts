import type { Pool } from "pg";
import type {
  AuditEventDatabaseRow,
  UserDatabaseRow
} from "../database/types.js";
import type {
  AdminPasswordRecoveryInput,
  AdminPasswordRecoveryResult,
  AdminUserMutation,
  AdminUserMutationResult,
  AuditListRequest,
  PageResult,
  SessionRevocationInput,
  SessionRevocationResult
} from "./repository.js";
import type { IdentityAuditEvent } from "./types.js";
import { canonicalUuid } from "./identityValidation.js";
import {
  activeAdminReplacementExists,
  insertAuditEvent,
  isActiveAdmin,
  lifecycleEventType,
  lifecycleSessionReason,
  mapAuditEvent,
  mapUser,
  pageOffset,
  safeUserSnapshot,
  sessionReason,
  validateAdminActorRow,
  validateSessionActorRow,
  validTransition,
  withIdentityAdminGuard,
  type CountRow
} from "./postgresRepositorySupport.js";

export async function mutateUserAsAdmin(
  pool: Pool,
  rawActorUserId: string,
  rawSubjectUserId: string,
  mutation: AdminUserMutation
): Promise<AdminUserMutationResult> {
  const actorUserId = canonicalUuid(rawActorUserId);
  const subjectUserId = canonicalUuid(rawSubjectUserId);
  return withIdentityAdminGuard(pool, async (client) => {
    const actorResult = await client.query<UserDatabaseRow>(
      "SELECT * FROM users WHERE id = $1 FOR UPDATE",
      [actorUserId]
    );
    const actorRow = actorResult.rows[0];
    const actorFailure = validateAdminActorRow(actorRow);
    if (actorFailure) return { status: actorFailure };

    const currentRow =
      actorUserId === subjectUserId
        ? actorRow
        : (
            await client.query<UserDatabaseRow>(
              "SELECT * FROM users WHERE id = $1 FOR UPDATE",
              [subjectUserId]
            )
          ).rows[0];
    if (!currentRow) return { status: "subject_not_found" };
    const current = mapUser(currentRow);
    if (current.authorizationRevision !== mutation.expectedAuthorizationRevision) {
      return { status: "revision_conflict", current };
    }
    if (!validTransition(current, mutation.action)) {
      return { status: "invalid_transition", current };
    }

    const nextStatus =
      mutation.action === "activate" || mutation.action === "reactivate"
        ? "active"
        : mutation.action === "disable"
          ? "disabled"
          : current.status;
    const nextAppRole = mutation.appRole ?? current.appRole;
    const nextTradingRole = mutation.tradingRole ?? current.tradingRole;
    if (nextAppRole !== "admin" && nextTradingRole === "live-trade") {
      return { status: "live_role_forbidden" };
    }
    if (actorUserId === subjectUserId && nextStatus === "disabled") {
      return { status: "self_disable" };
    }
    if (actorUserId === subjectUserId && nextAppRole !== "admin") {
      return { status: "self_demote" };
    }
    if (
      isActiveAdmin(current) &&
      (nextStatus !== "active" || nextAppRole !== "admin") &&
      !(await activeAdminReplacementExists(client, subjectUserId))
    ) {
      return { status: "last_active_admin" };
    }

    const approvalChanged =
      mutation.action === "activate" || mutation.action === "reactivate";
    const updated = await client.query<UserDatabaseRow>(
      `UPDATE users
       SET status = $2,
           app_role = $3,
           trading_role = $4,
           approved_by = $5,
           approved_at = $6,
           authorization_revision = authorization_revision + 1,
           updated_at = $7
       WHERE id = $1
       RETURNING *`,
      [
        subjectUserId,
        nextStatus,
        nextAppRole,
        nextTradingRole,
        approvalChanged ? actorUserId : (current.approvedBy ?? null),
        approvalChanged ? mutation.now : (current.approvedAt ?? null),
        mutation.now
      ]
    );
    const updatedRow = updated.rows[0];
    if (!updatedRow) return { status: "subject_not_found" };
    const user = mapUser(updatedRow);

    const revoked = await client.query<{ id_hash: string }>(
      `UPDATE auth_sessions
       SET revoked_at = $2,
           revoke_reason = $3
       WHERE user_id = $1
         AND revoked_at IS NULL
       RETURNING id_hash`,
      [subjectUserId, mutation.now, lifecycleSessionReason(mutation.action)]
    );
    await client.query("DELETE FROM auth_ws_tickets WHERE user_id = $1", [
      subjectUserId
    ]);

    let cancelledJobCount = 0;
    if (mutation.action === "disable") {
      const queued = await client.query(
        `UPDATE compute_jobs
         SET status = 'cancelled',
             cancel_requested_at = COALESCE(cancel_requested_at, $2),
             completed_at = COALESCE(completed_at, $2),
             updated_at = $2
         WHERE owner_user_id = $1
           AND status = 'queued'`,
        [subjectUserId, mutation.now]
      );
      const running = await client.query(
        `UPDATE compute_jobs
         SET cancel_requested_at = COALESCE(cancel_requested_at, $2),
             updated_at = $2
         WHERE owner_user_id = $1
           AND status = 'running'
           AND cancel_requested_at IS NULL`,
        [subjectUserId, mutation.now]
      );
      cancelledJobCount = (queued.rowCount ?? 0) + (running.rowCount ?? 0);
    }

    await insertAuditEvent(client, {
      eventType: lifecycleEventType(mutation.action),
      actorUserId,
      subjectUserId,
      requestId: mutation.metadata.requestId,
      ipAddress: mutation.metadata.ipAddress,
      userAgent: mutation.metadata.userAgent,
      metadata: {
        reason: mutation.reason,
        before: safeUserSnapshot(current),
        after: safeUserSnapshot(user),
        revokedSessionCount: revoked.rowCount ?? 0,
        cancelledJobCount
      },
      createdAt: mutation.now
    });

    return {
      status: "updated",
      user,
      revokedSessionIdHashes: revoked.rows.map((row) => row.id_hash),
      cancelledJobCount
    };
  });
}

export async function recoverAdminPassword(
  pool: Pool,
  input: AdminPasswordRecoveryInput
): Promise<AdminPasswordRecoveryResult> {
  return withIdentityAdminGuard(pool, async (client) => {
    const result = await client.query<UserDatabaseRow>(
      "SELECT * FROM users WHERE login_normalized = $1 FOR UPDATE",
      [input.loginNormalized]
    );
    const row = result.rows[0];
    if (!row) return { status: "user_not_found" };
    if (row.app_role !== "admin") return { status: "user_not_admin" };
    if (row.status !== "active") return { status: "user_inactive" };
    const before = mapUser(row);
    const updated = await client.query<UserDatabaseRow>(
      `UPDATE users
       SET password_hash = $2,
           must_change_password = TRUE,
           password_changed_at = $3,
           authorization_revision = authorization_revision + 1,
           updated_at = $3
       WHERE id = $1
       RETURNING *`,
      [before.id, input.passwordHash, input.now]
    );
    const user = mapUser(updated.rows[0]!);
    const revoked = await client.query<{ id_hash: string }>(
      `UPDATE auth_sessions
       SET revoked_at = $2,
           revoke_reason = 'admin_password_recovered'
       WHERE user_id = $1
         AND revoked_at IS NULL
       RETURNING id_hash`,
      [user.id, input.now]
    );
    await client.query("DELETE FROM auth_ws_tickets WHERE user_id = $1", [
      user.id
    ]);
    await insertAuditEvent(client, {
      eventType: "admin.password_recovered",
      actorUserId: user.id,
      subjectUserId: user.id,
      requestId: input.metadata.requestId,
      ipAddress: input.metadata.ipAddress,
      userAgent: input.metadata.userAgent,
      metadata: {
        reason: input.reason,
        before: safeUserSnapshot(before),
        after: safeUserSnapshot(user),
        revokedSessionCount: revoked.rowCount ?? 0
      },
      createdAt: input.now
    });
    return {
      status: "updated",
      user,
      revokedSessionIdHashes: revoked.rows.map((session) => session.id_hash)
    };
  });
}

export async function revokeSessions(
  pool: Pool,
  rawInput: SessionRevocationInput
): Promise<SessionRevocationResult> {
  const input: SessionRevocationInput = {
    ...rawInput,
    actorUserId: canonicalUuid(rawInput.actorUserId),
    subjectUserId: canonicalUuid(rawInput.subjectUserId),
    publicId: rawInput.publicId
      ? canonicalUuid(rawInput.publicId)
      : undefined
  };
  return withIdentityAdminGuard(pool, async (client) => {
    const actorResult = await client.query<UserDatabaseRow>(
      "SELECT * FROM users WHERE id = $1 FOR UPDATE",
      [input.actorUserId]
    );
    const actor = actorResult.rows[0];
    const actorFailure = validateSessionActorRow(actor, input.requireAdmin);
    if (actorFailure) return { status: actorFailure };
    if (!input.requireAdmin && input.actorUserId !== input.subjectUserId) {
      return { status: "actor_not_admin" };
    }
    const subject =
      input.actorUserId === input.subjectUserId
        ? actor
        : (
            await client.query<UserDatabaseRow>(
              "SELECT * FROM users WHERE id = $1 FOR UPDATE",
              [input.subjectUserId]
            )
          ).rows[0];
    if (!subject) return { status: "subject_not_found" };

    const values: unknown[] = [
      input.subjectUserId,
      input.now,
      sessionReason(input.eventType)
    ];
    const conditions = ["user_id = $1", "revoked_at IS NULL"];
    if (input.mode === "one") {
      values.push(input.publicId);
      conditions.push(`public_id = $${values.length}::uuid`);
    } else if (input.mode === "others") {
      values.push(input.exceptIdHash);
      conditions.push(`id_hash <> $${values.length}`);
    }
    const revoked = await client.query<{ id_hash: string }>(
      `UPDATE auth_sessions
       SET revoked_at = $2,
           revoke_reason = $3
       WHERE ${conditions.join(" AND ")}
       RETURNING id_hash`,
      values
    );
    if (input.mode === "one" && (revoked.rowCount ?? 0) === 0) {
      return { status: "session_not_found" };
    }
    if (revoked.rows.length > 0) {
      await client.query(
        "DELETE FROM auth_ws_tickets WHERE session_id_hash = ANY($1::text[])",
        [revoked.rows.map((row) => row.id_hash)]
      );
    }
    await insertAuditEvent(client, {
      eventType: input.eventType,
      actorUserId: input.actorUserId,
      subjectUserId: input.subjectUserId,
      requestId: input.metadata.requestId,
      ipAddress: input.metadata.ipAddress,
      userAgent: input.metadata.userAgent,
      metadata: {
        reason: input.reason,
        mode: input.mode,
        publicId: input.mode === "one" ? input.publicId : undefined,
        revokedSessionCount: revoked.rowCount ?? 0
      },
      createdAt: input.now
    });
    return {
      status: "revoked",
      revokedSessionIdHashes: revoked.rows.map((row) => row.id_hash)
    };
  });
}

export async function listAuditEvents(
  pool: Pool,
  request: AuditListRequest
): Promise<PageResult<IdentityAuditEvent>> {
  const values: unknown[] = [];
  const where: string[] = [];
  if (request.subjectUserId) {
    values.push(canonicalUuid(request.subjectUserId));
    where.push(`event.subject_user_id = $${values.length}`);
  }
  if (request.eventType) {
    values.push(request.eventType);
    where.push(`event.event_type = $${values.length}`);
  }
  const filter = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const count = await pool.query<CountRow>(
    `SELECT count(*)::text AS count
     FROM audit_events AS event
     ${filter}`,
    values
  );
  const rows = await pool.query<AuditEventDatabaseRow>(
    `SELECT
       event.id::text,
       event.event_type,
       event.actor_user_id,
       actor.login AS actor_login,
       event.subject_user_id,
       subject.login AS subject_login,
       event.request_id,
       event.ip_address::text AS ip_address,
       event.user_agent,
       event.metadata,
       event.occurred_at
     FROM audit_events AS event
     LEFT JOIN users AS actor ON actor.id = event.actor_user_id
     LEFT JOIN users AS subject ON subject.id = event.subject_user_id
     ${filter}
     ORDER BY event.occurred_at DESC, event.id DESC
     LIMIT $${values.length + 1}
     OFFSET $${values.length + 2}`,
    [...values, request.pageSize, pageOffset(request)]
  );
  return {
    items: rows.rows.map(mapAuditEvent),
    total: Number(count.rows[0]?.count ?? 0)
  };
}
