import type { Pool } from "pg";
import type { AuthSessionDatabaseRow, UserDatabaseRow } from "../database/types.js";
import type {
  AdminGuardedUserUpdateResult,
  AdminPasswordRecoveryInput,
  AdminPasswordRecoveryResult,
  AdminUserMutation,
  AdminUserMutationResult,
  AuditEventInput,
  AuditListRequest,
  FirstAdminCreateResult,
  IdentityRepository,
  PageResult,
  SessionListRequest,
  SessionPageResult,
  SessionRevocationInput,
  SessionRevocationResult,
  UserListRequest,
  UserUpdate,
  WsTicketRecord
} from "./repository.js";
import type {
  IdentityAuditEvent,
  IdentitySession,
  IdentityUser,
  UserStatus
} from "./types.js";
import {
  listAuditEvents as listPostgresAuditEvents,
  mutateUserAsAdmin as mutatePostgresUserAsAdmin,
  recoverAdminPassword as recoverPostgresAdminPassword,
  revokeSessions as revokePostgresSessions
} from "./postgresAdminOperations.js";
import {
  activeAdminReplacementExists,
  boundedCleanupLimit,
  insertAuditEvent,
  isActiveAdminRow,
  mapSession,
  mapSessionJoin,
  mapUser,
  pageOffset,
  sessionJoinSql,
  userInsertValues,
  userUpdateStatement,
  validateAdminActorRow,
  withIdentityAdminGuard,
  type CountRow,
  type SessionJoinRow
} from "./postgresRepositorySupport.js";
import { canonicalUuid } from "./identityValidation.js";

interface SessionCountRow {
  total: string;
  revocable_count: string;
}

export class PostgresIdentityRepository implements IdentityRepository {
  constructor(private readonly pool: Pool) {}

  async createUser(user: IdentityUser): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO users (
         id, login, login_normalized, password_hash, status, app_role, trading_role,
         must_change_password, approved_by, approved_at, last_login_at, created_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (login_normalized) DO NOTHING`,
      userInsertValues(user)
    );
    return result.rowCount === 1;
  }

  async createFirstAdmin(user: IdentityUser): Promise<FirstAdminCreateResult> {
    if (user.appRole !== "admin" || user.status !== "active") {
      throw new Error("First administrator must be active.");
    }
    return withIdentityAdminGuard(this.pool, async (client) => {
      const admin = await client.query(
        "SELECT 1 FROM users WHERE app_role = 'admin' LIMIT 1"
      );
      if ((admin.rowCount ?? 0) > 0) return "admin_exists";
      const inserted = await client.query(
        `INSERT INTO users (
           id, login, login_normalized, password_hash, status, app_role, trading_role,
           must_change_password, approved_by, approved_at, last_login_at, created_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (login_normalized) DO NOTHING`,
        userInsertValues(user)
      );
      return inserted.rowCount === 1 ? "created" : "login_exists";
    });
  }

  async findUserByLogin(
    loginNormalized: string
  ): Promise<IdentityUser | undefined> {
    const result = await this.pool.query<UserDatabaseRow>(
      "SELECT * FROM users WHERE login_normalized = $1",
      [loginNormalized]
    );
    return result.rows[0] && mapUser(result.rows[0]);
  }

  async findUserById(id: string): Promise<IdentityUser | undefined> {
    const result = await this.pool.query<UserDatabaseRow>(
      "SELECT * FROM users WHERE id = $1",
      [canonicalUuid(id)]
    );
    return result.rows[0] && mapUser(result.rows[0]);
  }

  async listUsers(status?: UserStatus): Promise<IdentityUser[]> {
    const result = status
      ? await this.pool.query<UserDatabaseRow>(
          "SELECT * FROM users WHERE status = $1 ORDER BY created_at DESC, id DESC",
          [status]
        )
      : await this.pool.query<UserDatabaseRow>(
          "SELECT * FROM users ORDER BY created_at DESC, id DESC"
        );
    return result.rows.map(mapUser);
  }

  async listUsersPage(
    request: UserListRequest
  ): Promise<PageResult<IdentityUser>> {
    const values: unknown[] = [];
    const where: string[] = [];
    if (request.status) {
      values.push(request.status);
      where.push(`status = $${values.length}`);
    }
    if (request.appRole) {
      values.push(request.appRole);
      where.push(`app_role = $${values.length}`);
    }
    if (request.tradingRole) {
      values.push(request.tradingRole);
      where.push(`trading_role = $${values.length}`);
    }
    if (request.query) {
      values.push(`%${request.query}%`);
      where.push(`login_normalized LIKE $${values.length}`);
    }
    const filter = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const count = await this.pool.query<CountRow>(
      `SELECT count(*)::text AS count FROM users ${filter}`,
      values
    );
    const rows = await this.pool.query<UserDatabaseRow>(
      `SELECT * FROM users
       ${filter}
       ORDER BY created_at DESC, id DESC
       LIMIT $${values.length + 1}
       OFFSET $${values.length + 2}`,
      [...values, request.pageSize, pageOffset(request)]
    );
    return {
      items: rows.rows.map(mapUser),
      total: Number(count.rows[0]?.count ?? 0)
    };
  }

  async countAdmins(): Promise<number> {
    const result = await this.pool.query<CountRow>(
      "SELECT count(*)::text AS count FROM users WHERE app_role = 'admin'"
    );
    return Number(result.rows[0]?.count ?? 0);
  }

  async updateUser(
    id: string,
    update: UserUpdate
  ): Promise<IdentityUser | undefined> {
    const statement = userUpdateStatement(canonicalUuid(id), update);
    const result = await this.pool.query<UserDatabaseRow>(
      statement.text,
      statement.values
    );
    return result.rows[0] && mapUser(result.rows[0]);
  }

  async updateUserAsAdmin(
    actorUserId: string,
    subjectUserId: string,
    update: UserUpdate
  ): Promise<AdminGuardedUserUpdateResult> {
    const canonicalActorId = canonicalUuid(actorUserId);
    const canonicalSubjectId = canonicalUuid(subjectUserId);
    return withIdentityAdminGuard(this.pool, async (client) => {
      const actorResult = await client.query<UserDatabaseRow>(
        "SELECT * FROM users WHERE id = $1 FOR UPDATE",
        [canonicalActorId]
      );
      const actorRow = actorResult.rows[0];
      const actorFailure = validateAdminActorRow(actorRow);
      if (actorFailure) return { status: actorFailure };
      const currentRow =
        canonicalActorId === canonicalSubjectId
          ? actorRow
          : (
              await client.query<UserDatabaseRow>(
                "SELECT * FROM users WHERE id = $1 FOR UPDATE",
                [canonicalSubjectId]
              )
            ).rows[0];
      if (!currentRow) return { status: "subject_not_found" };
      const nextStatus = update.status ?? currentRow.status;
      const nextRole = update.appRole ?? currentRow.app_role;
      if (
        isActiveAdminRow(currentRow) &&
        (nextStatus !== "active" || nextRole !== "admin") &&
        !(await activeAdminReplacementExists(client, canonicalSubjectId))
      ) {
        return { status: "last_active_admin" };
      }
      const statement = userUpdateStatement(canonicalSubjectId, update);
      const result = await client.query<UserDatabaseRow>(
        statement.text,
        statement.values
      );
      const row = result.rows[0];
      return row
        ? { status: "updated", user: mapUser(row) }
        : { status: "subject_not_found" };
    });
  }

  async mutateUserAsAdmin(
    actorUserId: string,
    subjectUserId: string,
    mutation: AdminUserMutation
  ): Promise<AdminUserMutationResult> {
    return mutatePostgresUserAsAdmin(
      this.pool,
      actorUserId,
      subjectUserId,
      mutation
    );
  }

  async recoverAdminPassword(
    input: AdminPasswordRecoveryInput
  ): Promise<AdminPasswordRecoveryResult> {
    return recoverPostgresAdminPassword(this.pool, input);
  }

  async createSession(session: IdentitySession): Promise<void> {
    await this.pool.query(
      `INSERT INTO auth_sessions (
         public_id, id_hash, user_id, csrf_hash, expires_at, last_seen_at,
         revoked_at, revoke_reason, user_agent, ip_address, created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        canonicalUuid(session.publicId),
        session.idHash,
        canonicalUuid(session.userId),
        session.csrfHash,
        session.expiresAt,
        session.lastSeenAt,
        session.revokedAt ?? null,
        session.revokeReason ?? null,
        session.userAgent ?? null,
        session.ipAddress ?? null,
        session.createdAt
      ]
    );
  }

  async findSession(
    idHash: string
  ): Promise<{ session: IdentitySession; user: IdentityUser } | undefined> {
    const result = await this.pool.query<SessionJoinRow>(
      sessionJoinSql("WHERE s.id_hash = $1"),
      [idHash]
    );
    return result.rows[0] && mapSessionJoin(result.rows[0]);
  }

  async listSessions(
    userId: string,
    request: SessionListRequest
  ): Promise<SessionPageResult> {
    const count = await this.pool.query<SessionCountRow>(
      `SELECT
         count(*)::text AS total,
         count(*) FILTER (
           WHERE revoked_at IS NULL AND expires_at > $2
         )::text AS revocable_count
       FROM auth_sessions
       WHERE user_id = $1`,
      [canonicalUuid(userId), request.now]
    );
    const rows = await this.pool.query<AuthSessionDatabaseRow>(
      `SELECT public_id, id_hash, user_id, csrf_hash, expires_at, last_seen_at,
              revoked_at, revoke_reason, user_agent, ip_address::text AS ip_address, created_at
       FROM auth_sessions
       WHERE user_id = $1
       ORDER BY created_at DESC, public_id DESC
       LIMIT $2 OFFSET $3`,
      [canonicalUuid(userId), request.pageSize, pageOffset(request)]
    );
    return {
      items: rows.rows.map(mapSession),
      total: Number(count.rows[0]?.total ?? 0),
      revocableSessionCount: Number(
        count.rows[0]?.revocable_count ?? 0
      )
    };
  }

  async touchSession(idHash: string, now: Date): Promise<void> {
    await this.pool.query(
      "UPDATE auth_sessions SET last_seen_at = $2 WHERE id_hash = $1 AND revoked_at IS NULL",
      [idHash, now]
    );
  }

  async updateSessionCsrf(
    idHash: string,
    csrfHash: string,
    now: Date
  ): Promise<void> {
    await this.pool.query(
      `UPDATE auth_sessions
       SET csrf_hash = $2, last_seen_at = $3
       WHERE id_hash = $1 AND revoked_at IS NULL`,
      [idHash, csrfHash, now]
    );
  }

  async revokeSession(idHash: string, now: Date): Promise<void> {
    await this.pool.query(
      `UPDATE auth_sessions
       SET revoked_at = COALESCE(revoked_at, $2),
           revoke_reason = COALESCE(revoke_reason, 'logout')
       WHERE id_hash = $1`,
      [idHash, now]
    );
  }

  async revokeUserSessions(
    userId: string,
    now: Date,
    exceptIdHash?: string
  ): Promise<void> {
    await this.pool.query(
      `UPDATE auth_sessions
       SET revoked_at = COALESCE(revoked_at, $2),
           revoke_reason = COALESCE(revoke_reason, 'account_changed')
       WHERE user_id = $1
         AND ($3::text IS NULL OR id_hash <> $3)`,
      [canonicalUuid(userId), now, exceptIdHash ?? null]
    );
  }

  async revokeSessions(
    input: SessionRevocationInput
  ): Promise<SessionRevocationResult> {
    return revokePostgresSessions(this.pool, input);
  }

  async deleteExpiredSessions(now: Date, limit = 1_000): Promise<number> {
    const result = await this.pool.query(
      `WITH doomed AS (
         SELECT id_hash
         FROM auth_sessions
         WHERE expires_at < $1
            OR revoked_at < $1 - interval '7 days'
         ORDER BY COALESCE(revoked_at, expires_at) ASC, id_hash ASC
         LIMIT $2
       )
       DELETE FROM auth_sessions AS session
       USING doomed
       WHERE session.id_hash = doomed.id_hash`,
      [now, boundedCleanupLimit(limit)]
    );
    return result.rowCount ?? 0;
  }

  async createWsTicket(ticket: WsTicketRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO auth_ws_tickets (
         ticket_hash, session_id_hash, user_id, expires_at, created_at
       ) VALUES ($1,$2,$3,$4,$5)`,
      [
        ticket.ticketHash,
        ticket.sessionIdHash,
        canonicalUuid(ticket.userId),
        ticket.expiresAt,
        ticket.createdAt
      ]
    );
  }

  async consumeWsTicket(
    ticketHash: string,
    now: Date
  ): Promise<{ user: IdentityUser; session: IdentitySession } | undefined> {
    const result = await this.pool.query<SessionJoinRow>(
      `WITH consumed AS (
         DELETE FROM auth_ws_tickets
         WHERE ticket_hash = $1
           AND consumed_at IS NULL
           AND expires_at > $2
         RETURNING session_id_hash, user_id
       )
       ${sessionJoinSql(`JOIN consumed c
           ON c.session_id_hash = s.id_hash
          AND c.user_id = s.user_id
         WHERE s.revoked_at IS NULL
           AND s.expires_at > $2`)}`,
      [ticketHash, now]
    );
    return result.rows[0] && mapSessionJoin(result.rows[0]);
  }

  async deleteExpiredWsTickets(now: Date, limit = 1_000): Promise<number> {
    const result = await this.pool.query(
      `WITH doomed AS (
         SELECT ticket_hash
         FROM auth_ws_tickets
         WHERE expires_at < $1
            OR consumed_at IS NOT NULL
         ORDER BY expires_at ASC, ticket_hash ASC
         LIMIT $2
       )
       DELETE FROM auth_ws_tickets AS ticket
       USING doomed
       WHERE ticket.ticket_hash = doomed.ticket_hash`,
      [now, boundedCleanupLimit(limit)]
    );
    return result.rowCount ?? 0;
  }

  async appendAuditEvent(event: AuditEventInput): Promise<void> {
    await insertAuditEvent(this.pool, event);
  }

  async listAuditEvents(
    request: AuditListRequest
  ): Promise<PageResult<IdentityAuditEvent>> {
    return listPostgresAuditEvents(this.pool, request);
  }
}
