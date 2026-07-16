import type { Pool, PoolClient } from "pg";
import type { UserDatabaseRow } from "../database/index.js";
import type { AdminGuardedUserUpdateResult, AuditEventInput, FirstAdminCreateResult, IdentityRepository, UserUpdate, WsTicketRecord } from "./repository.js";
import type { IdentitySession, IdentityUser, UserStatus } from "./types.js";

const IDENTITY_ADMIN_GUARD_LOCK = 1_824_664_913;

interface SessionJoinRow extends UserDatabaseRow {
  session_id_hash: string;
  session_user_id: string;
  session_csrf_hash: string;
  session_expires_at: Date;
  session_last_seen_at: Date;
  session_revoked_at: Date | null;
  session_user_agent: string | null;
  session_ip_address: string | null;
  session_created_at: Date;
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
      [user.id, user.login, user.loginNormalized, user.passwordHash, user.status, user.appRole, user.tradingRole, user.mustChangePassword, user.approvedBy ?? null, user.approvedAt ?? null, user.lastLoginAt ?? null, user.createdAt, user.updatedAt]
    );
    return result.rowCount === 1;
  }

  async createFirstAdmin(user: IdentityUser): Promise<FirstAdminCreateResult> {
    if (user.appRole !== "admin" || user.status !== "active") throw new Error("First administrator must be active.");
    return this.withAdminGuard(async (client) => {
      const admin = await client.query("SELECT 1 FROM users WHERE app_role = 'admin' LIMIT 1");
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

  async findUserByLogin(loginNormalized: string): Promise<IdentityUser | undefined> {
    const result = await this.pool.query<UserDatabaseRow>("SELECT * FROM users WHERE login_normalized = $1", [loginNormalized]);
    return result.rows[0] && mapUser(result.rows[0]);
  }

  async findUserById(id: string): Promise<IdentityUser | undefined> {
    const result = await this.pool.query<UserDatabaseRow>("SELECT * FROM users WHERE id = $1", [id]);
    return result.rows[0] && mapUser(result.rows[0]);
  }

  async listUsers(status?: UserStatus): Promise<IdentityUser[]> {
    const result = status ? await this.pool.query<UserDatabaseRow>("SELECT * FROM users WHERE status = $1 ORDER BY created_at DESC", [status]) : await this.pool.query<UserDatabaseRow>("SELECT * FROM users ORDER BY created_at DESC");
    return result.rows.map(mapUser);
  }

  async countAdmins(): Promise<number> {
    const result = await this.pool.query<{ count: string }>("SELECT count(*)::text AS count FROM users WHERE app_role = 'admin'");
    return Number(result.rows[0]?.count ?? 0);
  }

  async updateUser(id: string, update: UserUpdate): Promise<IdentityUser | undefined> {
    const statement = userUpdateStatement(id, update);
    const result = await this.pool.query<UserDatabaseRow>(statement.text, statement.values);
    return result.rows[0] && mapUser(result.rows[0]);
  }

  async updateUserAsAdmin(actorUserId: string, subjectUserId: string, update: UserUpdate): Promise<AdminGuardedUserUpdateResult> {
    return this.withAdminGuard(async (client) => {
      const actorResult = await client.query<UserDatabaseRow>("SELECT * FROM users WHERE id = $1 FOR UPDATE", [actorUserId]);
      const actorRow = actorResult.rows[0];
      const actorFailure = validateAdminActorRow(actorRow);
      if (actorFailure) return { status: actorFailure };

      const currentRow =
        actorUserId === subjectUserId
          ? actorRow
          : (await client.query<UserDatabaseRow>("SELECT * FROM users WHERE id = $1 FOR UPDATE", [subjectUserId])).rows[0];
      if (!currentRow) return { status: "subject_not_found" };
      const nextStatus = update.status ?? currentRow.status;
      const nextRole = update.appRole ?? currentRow.app_role;
      if (isActiveAdminRow(currentRow) && (nextStatus !== "active" || nextRole !== "admin")) {
        const replacement = await client.query("SELECT 1 FROM users WHERE id <> $1 AND status = 'active' AND app_role = 'admin' LIMIT 1", [subjectUserId]);
        if ((replacement.rowCount ?? 0) === 0) return { status: "last_active_admin" };
      }
      const statement = userUpdateStatement(subjectUserId, update);
      const result = await client.query<UserDatabaseRow>(statement.text, statement.values);
      const row = result.rows[0];
      return row ? { status: "updated", user: mapUser(row) } : { status: "subject_not_found" };
    });
  }

  async createSession(session: IdentitySession): Promise<void> {
    await this.pool.query(
      `INSERT INTO auth_sessions (
         id_hash, user_id, csrf_hash, expires_at, last_seen_at, revoked_at,
         user_agent, ip_address, created_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [session.idHash, session.userId, session.csrfHash, session.expiresAt, session.lastSeenAt, session.revokedAt ?? null, session.userAgent ?? null, session.ipAddress ?? null, session.createdAt]
    );
  }

  async findSession(idHash: string): Promise<{ session: IdentitySession; user: IdentityUser } | undefined> {
    const result = await this.pool.query<SessionJoinRow>(sessionJoinSql("WHERE s.id_hash = $1"), [idHash]);
    return result.rows[0] && mapSessionJoin(result.rows[0]);
  }

  async touchSession(idHash: string, now: Date): Promise<void> {
    await this.pool.query("UPDATE auth_sessions SET last_seen_at = $2 WHERE id_hash = $1 AND revoked_at IS NULL", [idHash, now]);
  }

  async updateSessionCsrf(idHash: string, csrfHash: string, now: Date): Promise<void> {
    await this.pool.query("UPDATE auth_sessions SET csrf_hash = $2, last_seen_at = $3 WHERE id_hash = $1 AND revoked_at IS NULL", [idHash, csrfHash, now]);
  }

  async revokeSession(idHash: string, now: Date): Promise<void> {
    await this.pool.query("UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, $2), revoke_reason = COALESCE(revoke_reason, 'logout') WHERE id_hash = $1", [idHash, now]);
  }

  async revokeUserSessions(userId: string, now: Date, exceptIdHash?: string): Promise<void> {
    await this.pool.query(
      `UPDATE auth_sessions
       SET revoked_at = COALESCE(revoked_at, $2), revoke_reason = COALESCE(revoke_reason, 'account_changed')
       WHERE user_id = $1 AND ($3::text IS NULL OR id_hash <> $3)`,
      [userId, now, exceptIdHash ?? null]
    );
  }

  async deleteExpiredSessions(now: Date): Promise<void> {
    await this.pool.query("DELETE FROM auth_sessions WHERE expires_at < $1 OR revoked_at < $1 - interval '7 days'", [now]);
  }

  async createWsTicket(ticket: WsTicketRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO auth_ws_tickets (ticket_hash, session_id_hash, user_id, expires_at, created_at)
       VALUES ($1,$2,$3,$4,$5)`,
      [ticket.ticketHash, ticket.sessionIdHash, ticket.userId, ticket.expiresAt, ticket.createdAt]
    );
  }

  async consumeWsTicket(ticketHash: string, now: Date): Promise<{ user: IdentityUser; session: IdentitySession } | undefined> {
    const result = await this.pool.query<SessionJoinRow>(
      `WITH consumed AS (
         DELETE FROM auth_ws_tickets
         WHERE ticket_hash = $1 AND consumed_at IS NULL AND expires_at > $2
         RETURNING session_id_hash, user_id
       )
       ${sessionJoinSql(`JOIN consumed c ON c.session_id_hash = s.id_hash AND c.user_id = s.user_id
         WHERE s.revoked_at IS NULL AND s.expires_at > $2`)}`,
      [ticketHash, now]
    );
    return result.rows[0] && mapSessionJoin(result.rows[0]);
  }

  async deleteExpiredWsTickets(now: Date): Promise<void> {
    await this.pool.query("DELETE FROM auth_ws_tickets WHERE expires_at < $1 OR consumed_at IS NOT NULL", [now]);
  }

  async appendAuditEvent(event: AuditEventInput): Promise<void> {
    await this.pool.query(
      `INSERT INTO audit_events (event_type, actor_user_id, subject_user_id, ip_address, metadata, occurred_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6)`,
      [event.eventType, event.actorUserId ?? null, event.subjectUserId ?? null, event.ipAddress ?? null, JSON.stringify(event.metadata ?? {}), event.createdAt]
    );
  }

  private async withAdminGuard<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1)", [IDENTITY_ADMIN_GUARD_LOCK]);
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
}

function userInsertValues(user: IdentityUser): unknown[] {
  return [user.id, user.login, user.loginNormalized, user.passwordHash, user.status, user.appRole, user.tradingRole, user.mustChangePassword, user.approvedBy ?? null, user.approvedAt ?? null, user.lastLoginAt ?? null, user.createdAt, user.updatedAt];
}

function userUpdateStatement(id: string, update: UserUpdate): { text: string; values: unknown[] } {
  const values: unknown[] = [];
  const assignments: string[] = [];
  const authorizationMutation = update.status !== undefined
    || update.appRole !== undefined
    || update.tradingRole !== undefined
    || update.mustChangePassword !== undefined
    || update.passwordHash !== undefined;
  const add = (column: string, value: unknown) => {
    values.push(value);
    assignments.push(`${column} = $${values.length}`);
  };
  if (update.status !== undefined) add("status", update.status);
  if (update.appRole !== undefined) add("app_role", update.appRole);
  if (update.tradingRole !== undefined) add("trading_role", update.tradingRole);
  if (update.mustChangePassword !== undefined) add("must_change_password", update.mustChangePassword);
  if (update.passwordHash !== undefined) {
    add("password_hash", update.passwordHash);
    add("password_changed_at", update.updatedAt);
  }
  if (update.approvedBy !== undefined) add("approved_by", update.approvedBy);
  if (update.approvedAt !== undefined) add("approved_at", update.approvedAt);
  if (update.lastLoginAt !== undefined) add("last_login_at", update.lastLoginAt);
  if (authorizationMutation) assignments.push("authorization_revision = authorization_revision + 1");
  add("updated_at", update.updatedAt);
  values.push(id);
  return {
    text: `UPDATE users SET ${assignments.join(", ")} WHERE id = $${values.length} RETURNING *`,
    values
  };
}

function isActiveAdminRow(row: UserDatabaseRow): boolean {
  return row.status === "active" && row.app_role === "admin";
}

function validateAdminActorRow(row: UserDatabaseRow | undefined): "actor_not_found" | "actor_inactive" | "actor_not_admin" | "actor_password_change_required" | undefined {
  if (!row) return "actor_not_found";
  if (row.status !== "active") return "actor_inactive";
  if (row.app_role !== "admin") return "actor_not_admin";
  if (row.must_change_password) return "actor_password_change_required";
  return undefined;
}

function sessionJoinSql(joinOrWhere: string): string {
  return `SELECT
      u.*,
      s.id_hash AS session_id_hash,
      s.user_id AS session_user_id,
      s.csrf_hash AS session_csrf_hash,
      s.expires_at AS session_expires_at,
      s.last_seen_at AS session_last_seen_at,
      s.revoked_at AS session_revoked_at,
      s.user_agent AS session_user_agent,
      s.ip_address::text AS session_ip_address,
      s.created_at AS session_created_at
    FROM auth_sessions s
    JOIN users u ON u.id = s.user_id
    ${joinOrWhere}`;
}

function mapUser(row: UserDatabaseRow): IdentityUser {
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
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("Invalid user authorization revision");
  return revision;
}

function mapSessionJoin(row: SessionJoinRow): { user: IdentityUser; session: IdentitySession } {
  return {
    user: mapUser(row),
    session: {
      idHash: row.session_id_hash,
      userId: row.session_user_id,
      csrfHash: row.session_csrf_hash,
      expiresAt: row.session_expires_at,
      lastSeenAt: row.session_last_seen_at,
      revokedAt: row.session_revoked_at ?? undefined,
      userAgent: row.session_user_agent ?? undefined,
      ipAddress: row.session_ip_address ?? undefined,
      createdAt: row.session_created_at
    }
  };
}
