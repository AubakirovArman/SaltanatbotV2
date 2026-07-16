import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateDatabase } from "../src/database/migrations.js";
import { DATABASE_MIGRATIONS } from "../src/database/schema.js";
import { PostgresIdentityRepository } from "../src/identity/postgresRepository.js";
import type { AdminUserMutation } from "../src/identity/repository.js";
import { IdentityService } from "../src/identity/service.js";
import { effectiveTradingRole, publicIdentityUser, type IdentityPrincipal, type IdentitySession, type IdentityUser } from "../src/identity/types.js";
import { ComputeJobRepository } from "../src/jobs/repository.js";
import { assertIsolatedTestDatabase } from "./support/postgresTestDatabase.js";

const connectionString = process.env.IDENTITY_TEST_DATABASE_URL;
const describePostgres = connectionString ? describe : describe.skip;
const PASSWORD_HASH = "integration-password-hash-placeholder";
const BAD_AUDIT_REQUEST_ID = "x".repeat(129);

let pool: Pool;
let repository: PostgresIdentityRepository;
let mutationSequence = 0;

describePostgres("identity lifecycle against isolated PostgreSQL", () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString, max: 4 });
    await assertIsolatedTestDatabase(pool, "IDENTITY_TEST_DATABASE_URL");
    await migrateDatabase(pool);
    repository = new PostgresIdentityRepository(pool);
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE users RESTART IDENTITY CASCADE");
    repository = new PostgresIdentityRepository(pool);
    mutationSequence = 0;
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("commits activate, permissions, and disable with revisions, session fencing, and reasoned before/after audit", async () => {
    const admin = await seedUser({ login: "lifecycle-admin", status: "active", appRole: "admin" });
    const subject = await seedUser({ login: "lifecycle-user", status: "pending" });
    const pendingSession = await seedSession(subject.id, "pending-session");
    await seedWsTicket(subject.id, pendingSession.idHash, "pending-ticket");

    const activated = await repository.mutateUserAsAdmin(admin.id, subject.id, mutation("activate", subject.authorizationRevision, "approve first research account"));
    expect(activated).toMatchObject({
      status: "updated",
      user: {
        id: subject.id,
        status: "active",
        appRole: "user",
        tradingRole: "none",
        authorizationRevision: 2,
        approvedBy: admin.id
      },
      revokedSessionIdHashes: [pendingSession.idHash],
      cancelledJobCount: 0
    });
    expect(await sessionState(pendingSession.idHash)).toMatchObject({
      revoked: true,
      revokeReason: "user_activated"
    });
    await expect(ticketCount(subject.id)).resolves.toBe(0);

    const activeSession = await seedSession(subject.id, "active-session");
    await seedWsTicket(subject.id, activeSession.idHash, "active-ticket");
    const permissions = await repository.mutateUserAsAdmin(admin.id, subject.id, mutation("permissions", updatedUser(activated).authorizationRevision, "grant isolated paper account access", { tradingRole: "paper-trade" }));
    expect(permissions).toMatchObject({
      status: "updated",
      user: {
        status: "active",
        tradingRole: "paper-trade",
        authorizationRevision: 3
      },
      revokedSessionIdHashes: [activeSession.idHash],
      cancelledJobCount: 0
    });
    expect(await sessionState(activeSession.idHash)).toMatchObject({
      revoked: true,
      revokeReason: "permissions_changed"
    });
    await expect(ticketCount(subject.id)).resolves.toBe(0);

    const paperSession = await seedSession(subject.id, "paper-session");
    await seedWsTicket(subject.id, paperSession.idHash, "paper-ticket");
    const disabled = await repository.mutateUserAsAdmin(admin.id, subject.id, mutation("disable", updatedUser(permissions).authorizationRevision, "customer requested account suspension"));
    expect(disabled).toMatchObject({
      status: "updated",
      user: {
        status: "disabled",
        tradingRole: "paper-trade",
        authorizationRevision: 4
      },
      revokedSessionIdHashes: [paperSession.idHash],
      cancelledJobCount: 0
    });
    expect(await sessionState(paperSession.idHash)).toMatchObject({
      revoked: true,
      revokeReason: "user_disabled"
    });
    await expect(ticketCount(subject.id)).resolves.toBe(0);

    const audit = await repository.listAuditEvents({
      subjectUserId: subject.id,
      page: 1,
      pageSize: 10
    });
    expect(audit.total).toBe(3);
    const byType = new Map(audit.items.map((event) => [event.eventType, event]));
    expect(byType.get("user.activated")).toMatchObject({
      actorUserId: admin.id,
      actorLogin: admin.login,
      subjectUserId: subject.id,
      subjectLogin: subject.login,
      metadata: {
        reason: "approve first research account",
        before: { status: "pending", tradingRole: "none", authorizationRevision: 1 },
        after: { status: "active", tradingRole: "none", authorizationRevision: 2 },
        revokedSessionCount: 1,
        cancelledJobCount: 0
      }
    });
    expect(byType.get("user.permissions_changed")).toMatchObject({
      metadata: {
        reason: "grant isolated paper account access",
        before: { status: "active", tradingRole: "none", authorizationRevision: 2 },
        after: { status: "active", tradingRole: "paper-trade", authorizationRevision: 3 },
        revokedSessionCount: 1,
        cancelledJobCount: 0
      }
    });
    expect(byType.get("user.disabled")).toMatchObject({
      metadata: {
        reason: "customer requested account suspension",
        before: { status: "active", tradingRole: "paper-trade", authorizationRevision: 3 },
        after: { status: "disabled", tradingRole: "paper-trade", authorizationRevision: 4 },
        revokedSessionCount: 1,
        cancelledJobCount: 0
      }
    });
  });

  it("rolls back activate, permissions, and disable when the audit write fails", async () => {
    const admin = await seedUser({ login: "rollback-admin", status: "active", appRole: "admin" });
    const pending = await seedUser({ login: "rollback-pending", status: "pending" });
    const active = await seedUser({
      login: "rollback-permissions",
      status: "active",
      tradingRole: "read-only"
    });
    const disableTarget = await seedUser({
      login: "rollback-disable",
      status: "active",
      tradingRole: "paper-trade"
    });
    const pendingSession = await seedSession(pending.id, "rollback-pending-session");
    const activeSession = await seedSession(active.id, "rollback-active-session");
    const disableSession = await seedSession(disableTarget.id, "rollback-disable-session");
    const jobs = new ComputeJobRepository(pool);
    const queued = await jobs.enqueue({
      ownerUserId: disableTarget.id,
      jobType: "backtest",
      payload: { scenario: "must-survive-rollback" },
      estimatedCost: 1,
      clientRequestId: "rollback-disable-job"
    });

    for (const attempt of [
      {
        subject: pending,
        action: "activate" as const,
        options: {},
        session: pendingSession
      },
      {
        subject: active,
        action: "permissions" as const,
        options: { tradingRole: "paper-trade" as const },
        session: activeSession
      },
      {
        subject: disableTarget,
        action: "disable" as const,
        options: {},
        session: disableSession
      }
    ]) {
      await expect(repository.mutateUserAsAdmin(admin.id, attempt.subject.id, mutation(attempt.action, attempt.subject.authorizationRevision, "force transaction rollback after every side effect", attempt.options, { requestId: BAD_AUDIT_REQUEST_ID }))).rejects.toThrow();
      expect(await repository.findUserById(attempt.subject.id)).toMatchObject({
        status: attempt.subject.status,
        appRole: attempt.subject.appRole,
        tradingRole: attempt.subject.tradingRole,
        authorizationRevision: attempt.subject.authorizationRevision
      });
      expect(await sessionState(attempt.session.idHash)).toMatchObject({
        revoked: false,
        revokeReason: null
      });
    }

    expect(await jobs.get(disableTarget.id, queued.id)).toMatchObject({
      status: "queued",
      cancelRequestedAt: undefined
    });
    await expect(repository.listAuditEvents({ page: 1, pageSize: 10 })).resolves.toMatchObject({ total: 0, items: [] });
  });

  it("serializes concurrent authorization revisions so one stale admin update conflicts", async () => {
    const admin = await seedUser({ login: "revision-admin", status: "active", appRole: "admin" });
    const subject = await seedUser({ login: "revision-user", status: "active" });

    const outcomes = await Promise.all([
      repository.mutateUserAsAdmin(
        admin.id,
        subject.id,
        mutation("permissions", subject.authorizationRevision, "grant read-only access", {
          tradingRole: "read-only"
        })
      ),
      repository.mutateUserAsAdmin(
        admin.id,
        subject.id,
        mutation("permissions", subject.authorizationRevision, "grant paper access", {
          tradingRole: "paper-trade"
        })
      )
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "updated")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "revision_conflict")).toHaveLength(1);
    const current = await repository.findUserById(subject.id);
    expect(current).toMatchObject({
      authorizationRevision: 2,
      tradingRole: expect.stringMatching(/^(read-only|paper-trade)$/)
    });
    const audit = await repository.listAuditEvents({
      subjectUserId: subject.id,
      eventType: "user.permissions_changed",
      page: 1,
      pageSize: 10
    });
    expect(audit.total).toBe(1);
    expect(audit.items[0]?.metadata).toMatchObject({
      before: { authorizationRevision: 1 },
      after: { authorizationRevision: 2 }
    });
  });

  it("preserves self guards and one active administrator under concurrent cross-disable", async () => {
    const first = await seedUser({ login: "guard-admin-a", status: "active", appRole: "admin" });

    await expect(repository.mutateUserAsAdmin(first.id, first.id.toUpperCase(), mutation("disable", first.authorizationRevision, "uppercase self disable must fail"))).resolves.toEqual({ status: "self_disable" });
    await expect(
      repository.mutateUserAsAdmin(
        first.id.toUpperCase(),
        first.id,
        mutation("permissions", first.authorizationRevision, "uppercase self demotion must fail", {
          appRole: "user"
        })
      )
    ).resolves.toEqual({ status: "self_demote" });
    await expect(
      repository.updateUserAsAdmin(first.id, first.id, {
        status: "disabled",
        updatedAt: nextTime()
      })
    ).resolves.toEqual({ status: "last_active_admin" });
    expect(await repository.findUserById(first.id)).toMatchObject({
      status: "active",
      appRole: "admin",
      authorizationRevision: 1
    });

    const second = await seedUser({ login: "guard-admin-b", status: "active", appRole: "admin" });
    const outcomes = await Promise.all([repository.mutateUserAsAdmin(first.id, second.id, mutation("disable", second.authorizationRevision, "concurrent admin removal a")), repository.mutateUserAsAdmin(second.id, first.id, mutation("disable", first.authorizationRevision, "concurrent admin removal b"))]);
    expect(outcomes.filter((outcome) => outcome.status === "updated")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "actor_inactive" || outcome.status === "last_active_admin")).toHaveLength(1);
    const activeAdmins = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM users WHERE status = 'active' AND app_role = 'admin'");
    expect(activeAdmins.rows[0]?.count).toBe("1");
  });

  it("reports and fences the current session for uppercase self-permission mutations", async () => {
    const admin = await seedUser({
      login: "uppercase-session-admin",
      status: "active",
      appRole: "admin"
    });
    const session = await seedSession(admin.id, "uppercase-session-current");
    const service = new IdentityService(repository);

    await expect(
      service.updatePermissions(
        principal(admin, session),
        admin.id.toUpperCase(),
        {
          reason: "uppercase self permission mutation",
          expectedAuthorizationRevision: admin.authorizationRevision,
          tradingRole: "read-only"
        }
      )
    ).resolves.toMatchObject({
      user: {
        id: admin.id,
        appRole: "admin",
        tradingRole: "read-only"
      },
      revokedSessionCount: 1,
      revokedCurrentSession: true
    });
    expect(await sessionState(session.idHash)).toMatchObject({
      revoked: true,
      revokeReason: "permissions_changed"
    });
  });

  it("exposes only public session IDs and scopes list/revoke operations against IDOR", async () => {
    const admin = await seedUser({ login: "session-admin", status: "active", appRole: "admin" });
    const ownerA = await seedUser({ login: "session-owner-a", status: "active" });
    const ownerB = await seedUser({ login: "session-owner-b", status: "active" });
    const adminSession = await seedSession(admin.id, "session-admin-current");
    const ownerACurrent = await seedSession(ownerA.id, "session-owner-a-current");
    const ownerAOther = await seedSession(ownerA.id, "session-owner-a-other");
    const ownerBSession = await seedSession(ownerB.id, "session-owner-b");
    await seedWsTicket(ownerA.id, ownerAOther.idHash, "session-owner-a-ticket");
    await seedWsTicket(ownerB.id, ownerBSession.idHash, "session-owner-b-ticket");
    const service = new IdentityService(repository);
    const ownerAPrincipal = principal(ownerA, ownerACurrent);
    const adminPrincipal = principal(admin, adminSession);

    const firstPage = await service.listOwnSessions(ownerAPrincipal, {
      page: 1,
      pageSize: 1
    });
    expect(firstPage).toMatchObject({
      total: 2,
      revocableSessionCount: 2
    });
    expect(firstPage.items).toHaveLength(1);

    const ownSessions = await service.listOwnSessions(ownerAPrincipal, {
      page: 1,
      pageSize: 10
    });
    expect(ownSessions.total).toBe(2);
    expect(ownSessions.revocableSessionCount).toBe(2);
    expect(new Set(ownSessions.items.map((session) => session.publicId))).toEqual(new Set([ownerACurrent.publicId, ownerAOther.publicId]));
    expect(ownSessions.items.find((session) => session.publicId === ownerACurrent.publicId)).toMatchObject({
      current: true
    });
    for (const session of ownSessions.items) {
      expect(session).not.toHaveProperty("idHash");
      expect(session).not.toHaveProperty("csrfHash");
      expect(session).not.toHaveProperty("userId");
      expect(session.publicId).not.toBe(ownerACurrent.idHash);
    }
    expect(JSON.stringify(ownSessions)).not.toContain(ownerACurrent.idHash);
    expect(JSON.stringify(ownSessions)).not.toContain(ownerAOther.idHash);

    await expect(
      service.listAdminSessions(adminPrincipal, admin.id.toUpperCase(), {
        page: 1,
        pageSize: 10
      })
    ).resolves.toMatchObject({
      revocableSessionCount: 1,
      items: [{ publicId: adminSession.publicId, current: true }]
    });

    await expect(service.revokeOwnSession(ownerAPrincipal, ownerBSession.publicId, "foreign public id must not be revocable")).rejects.toMatchObject({ status: 404, code: "session_not_found" });
    expect(await sessionState(ownerBSession.idHash)).toMatchObject({ revoked: false });

    await expect(service.revokeOwnSession(ownerAPrincipal, ownerAOther.publicId, "close an older owner session")).resolves.toEqual({
      revokedSessionCount: 1,
      revokedCurrentSession: false
    });
    expect(await sessionState(ownerAOther.idHash)).toMatchObject({
      revoked: true,
      revokeReason: "session_revoked"
    });
    expect(await sessionState(ownerACurrent.idHash)).toMatchObject({ revoked: false });
    expect(await ticketCount(ownerA.id)).toBe(0);
    expect(await ticketCount(ownerB.id)).toBe(1);
    await expect(
      service.listOwnSessions(ownerAPrincipal, { page: 1, pageSize: 1 })
    ).resolves.toMatchObject({
      total: 2,
      revocableSessionCount: 1
    });

    await expect(service.revokeAdminSession(adminPrincipal, ownerA.id, ownerBSession.publicId, "wrong subject scope must fail")).rejects.toMatchObject({ status: 404, code: "session_not_found" });
    expect(await sessionState(ownerBSession.idHash)).toMatchObject({ revoked: false });

    await expect(service.revokeAdminSession(adminPrincipal, ownerB.id, ownerBSession.publicId, "administrator revoked the selected owner session")).resolves.toEqual({
      revokedSessionCount: 1,
      revokedCurrentSession: false
    });
    expect(await sessionState(ownerBSession.idHash)).toMatchObject({
      revoked: true,
      revokeReason: "admin_session_revoked"
    });
    expect(await ticketCount(ownerB.id)).toBe(0);
  });

  it("rejects new live roles and refuses to demote an administrator while a legacy live role survives", async () => {
    const admin = await seedUser({ login: "live-guard-admin", status: "active", appRole: "admin" });
    const subject = await seedUser({ login: "live-guard-user", status: "active" });

    await expect(
      repository.mutateUserAsAdmin(
        admin.id,
        subject.id,
        mutation("permissions", subject.authorizationRevision, "live is forbidden before HTTPS", {
          tradingRole: "live-trade"
        })
      )
    ).resolves.toEqual({ status: "live_role_forbidden" });
    expect(await repository.findUserById(subject.id)).toMatchObject({
      appRole: "user",
      tradingRole: "none",
      authorizationRevision: 1
    });
    await expect(pool.query("UPDATE users SET trading_role = 'live-trade' WHERE id = $1", [subject.id])).rejects.toThrow();

    const legacyAdmin = await seedUser({
      login: "legacy-live-admin",
      status: "active",
      appRole: "admin",
      tradingRole: "live-trade"
    });
    await expect(repository.mutateUserAsAdmin(admin.id, legacyAdmin.id, mutation("permissions", legacyAdmin.authorizationRevision, "legacy live role cannot leak through demotion", { appRole: "user" }))).resolves.toEqual({ status: "live_role_forbidden" });
    expect(await repository.findUserById(legacyAdmin.id)).toMatchObject({
      appRole: "admin",
      tradingRole: "live-trade",
      authorizationRevision: 1
    });
    await expect(repository.listAuditEvents({ subjectUserId: subject.id, page: 1, pageSize: 10 })).resolves.toMatchObject({ total: 0, items: [] });
  });

  it("downgrades legacy non-admin live roles, revokes sessions, deletes tickets, and audits during migration v9", async () => {
    const legacySchema = await createSchemaPool(pool, "identity_legacy_v8");
    const legacyPool = legacySchema.pool;
    const ownerId = randomUUID();
    const sessionHash = digest("legacy-v8-session");
    const csrfHash = digest("legacy-v8-csrf");
    const ticketHash = digest("legacy-v8-ticket");
    const createdAt = new Date("2026-07-16T01:00:00.000Z");

    try {
      await migrateDatabase(legacyPool, {
        migrations: DATABASE_MIGRATIONS.slice(0, 8)
      });
      await legacyPool.query(
        `INSERT INTO users (
           id, login, login_normalized, password_hash, status, app_role,
           trading_role, must_change_password, created_at, updated_at
         ) VALUES ($1, 'legacy-live-user', 'legacy-live-user', $2, 'active',
                   'user', 'live-trade', FALSE, $3, $3)`,
        [ownerId, PASSWORD_HASH, createdAt]
      );
      await legacyPool.query(
        `INSERT INTO auth_sessions (
           id_hash, user_id, csrf_hash, expires_at, last_seen_at, created_at
         ) VALUES ($1, $2, $3, $4, $5, $5)`,
        [sessionHash, ownerId, csrfHash, new Date("2026-07-17T01:00:00.000Z"), createdAt]
      );
      await legacyPool.query(
        `INSERT INTO auth_ws_tickets (
           ticket_hash, session_id_hash, user_id, expires_at, created_at
         ) VALUES ($1, $2, $3, $4, $5)`,
        [ticketHash, sessionHash, ownerId, new Date("2026-07-16T02:00:00.000Z"), createdAt]
      );

      await expect(
        migrateDatabase(legacyPool, { migrations: DATABASE_MIGRATIONS.slice(0, 9) })
      ).resolves.toMatchObject({
        fromVersion: 8,
        toVersion: 9,
        applied: [{ version: 9, name: "identity_admin_control_plane" }]
      });

      const user = await legacyPool.query<{
        trading_role: string;
        authorization_revision: string;
      }>("SELECT trading_role, authorization_revision::text FROM users WHERE id = $1", [ownerId]);
      expect(user.rows[0]).toEqual({
        trading_role: "paper-trade",
        authorization_revision: "2"
      });
      const session = await legacyPool.query<{
        public_id: string;
        revoked_at: Date | null;
        revoke_reason: string | null;
      }>(
        `SELECT public_id::text, revoked_at, revoke_reason
         FROM auth_sessions WHERE id_hash = $1`,
        [sessionHash]
      );
      expect(session.rows[0]).toMatchObject({
        public_id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
        revoked_at: expect.any(Date),
        revoke_reason: "pre_https_live_role_downgrade"
      });
      expect(session.rows[0]?.public_id).not.toBe(sessionHash);
      const tickets = await legacyPool.query<{ count: string }>("SELECT count(*)::text AS count FROM auth_ws_tickets WHERE user_id = $1", [ownerId]);
      expect(tickets.rows[0]?.count).toBe("0");
      const audit = await legacyPool.query<{
        event_type: string;
        request_id: string;
        metadata: Record<string, unknown>;
      }>(
        `SELECT event_type, request_id, metadata
         FROM audit_events WHERE subject_user_id = $1`,
        [ownerId]
      );
      expect(audit.rows).toEqual([
        {
          event_type: "user.permissions_migrated",
          request_id: "migration:v9",
          metadata: {
            reason: "pre_https_live_role_downgrade",
            before: {
              status: "active",
              appRole: "user",
              tradingRole: "live-trade",
              authorizationRevision: 1
            },
            after: {
              status: "active",
              appRole: "user",
              tradingRole: "paper-trade",
              authorizationRevision: 2
            }
          }
        }
      ]);
      await expect(legacyPool.query("UPDATE users SET trading_role = 'live-trade' WHERE id = $1", [ownerId])).rejects.toThrow();
    } finally {
      await legacyPool.end();
      await pool.query(`DROP SCHEMA IF EXISTS "${legacySchema.schemaName}" CASCADE`);
    }
  });

  it("cancels queued jobs, requests cancellation for running jobs, and leaves other owners untouched on disable", async () => {
    const admin = await seedUser({ login: "job-disable-admin", status: "active", appRole: "admin" });
    const owner = await seedUser({
      login: "job-disable-owner",
      status: "active",
      tradingRole: "paper-trade"
    });
    const otherOwner = await seedUser({
      login: "job-disable-other",
      status: "active",
      tradingRole: "paper-trade"
    });
    const jobs = new ComputeJobRepository(pool);
    const first = await jobs.enqueue({
      ownerUserId: owner.id,
      jobType: "backtest",
      payload: { slot: "running" },
      estimatedCost: 1,
      clientRequestId: "disable-running"
    });
    const claimed = await jobs.claim("identity-disable-worker", 30_000);
    expect(claimed?.id).toBe(first.id);
    const queued = await jobs.enqueue({
      ownerUserId: owner.id,
      jobType: "optimizer",
      payload: { slot: "queued" },
      estimatedCost: 2,
      clientRequestId: "disable-queued"
    });
    const other = await jobs.enqueue({
      ownerUserId: otherOwner.id,
      jobType: "backtest",
      payload: { slot: "other-owner" },
      estimatedCost: 1,
      clientRequestId: "disable-other-owner"
    });
    const session = await seedSession(owner.id, "job-disable-session");
    await seedWsTicket(owner.id, session.idHash, "job-disable-ticket");

    const disabled = await repository.mutateUserAsAdmin(admin.id, owner.id, mutation("disable", owner.authorizationRevision, "disable owner and cancel compute"));
    expect(disabled).toMatchObject({
      status: "updated",
      user: { status: "disabled", authorizationRevision: 2 },
      revokedSessionIdHashes: [session.idHash],
      cancelledJobCount: 2
    });
    expect(await jobs.get(owner.id, first.id)).toMatchObject({
      status: "running",
      cancelRequestedAt: expect.any(String),
      completedAt: undefined
    });
    expect(await jobs.get(owner.id, queued.id)).toMatchObject({
      status: "cancelled",
      cancelRequestedAt: expect.any(String),
      completedAt: expect.any(String)
    });
    expect(await jobs.get(otherOwner.id, other.id)).toMatchObject({
      status: "queued",
      cancelRequestedAt: undefined
    });
    expect(await sessionState(session.idHash)).toMatchObject({
      revoked: true,
      revokeReason: "user_disabled"
    });
    await expect(ticketCount(owner.id)).resolves.toBe(0);
    const audit = await repository.listAuditEvents({
      subjectUserId: owner.id,
      eventType: "user.disabled",
      page: 1,
      pageSize: 10
    });
    expect(audit.items[0]?.metadata).toMatchObject({
      reason: "disable owner and cancel compute",
      before: { status: "active", authorizationRevision: 1 },
      after: { status: "disabled", authorizationRevision: 2 },
      revokedSessionCount: 1,
      cancelledJobCount: 2
    });
  });
});

async function createSchemaPool(ownerPool: Pool, prefix: string): Promise<{ schemaName: string; pool: Pool }> {
  const isolatedSchema = `${prefix}_${randomUUID().replaceAll("-", "")}`;
  await ownerPool.query(`CREATE SCHEMA "${isolatedSchema}" AUTHORIZATION CURRENT_USER`);
  return {
    schemaName: isolatedSchema,
    pool: new Pool({
      connectionString,
      max: 12,
      options: `-c search_path=${isolatedSchema}`
    })
  };
}

async function seedUser(overrides: Partial<IdentityUser> & Pick<IdentityUser, "login" | "status">): Promise<IdentityUser> {
  const now = overrides.createdAt ?? nextTime();
  const user: IdentityUser = {
    id: overrides.id ?? randomUUID(),
    login: overrides.login,
    loginNormalized: overrides.loginNormalized ?? overrides.login.toLocaleLowerCase("en-US"),
    passwordHash: overrides.passwordHash ?? PASSWORD_HASH,
    status: overrides.status,
    appRole: overrides.appRole ?? "user",
    tradingRole: overrides.tradingRole ?? "none",
    mustChangePassword: overrides.mustChangePassword ?? false,
    authorizationRevision: overrides.authorizationRevision ?? 1,
    approvedBy: overrides.approvedBy,
    approvedAt: overrides.approvedAt,
    lastLoginAt: overrides.lastLoginAt,
    createdAt: now,
    updatedAt: overrides.updatedAt ?? now
  };
  expect(await repository.createUser(user)).toBe(true);
  const stored = await repository.findUserById(user.id);
  if (!stored) throw new Error("Failed to seed identity user");
  return stored;
}

async function seedSession(userId: string, label: string): Promise<IdentitySession> {
  const createdAt = nextTime();
  const session: IdentitySession = {
    publicId: randomUUID(),
    idHash: digest(`session:${label}:${randomUUID()}`),
    userId,
    csrfHash: digest(`csrf:${label}:${randomUUID()}`),
    expiresAt: new Date(createdAt.getTime() + 24 * 60 * 60_000),
    lastSeenAt: createdAt,
    createdAt,
    userAgent: `integration/${label}`,
    ipAddress: "127.0.0.1"
  };
  await repository.createSession(session);
  return session;
}

async function seedWsTicket(userId: string, sessionIdHash: string, label: string): Promise<void> {
  const createdAt = nextTime();
  await repository.createWsTicket({
    ticketHash: digest(`ticket:${label}:${randomUUID()}`),
    sessionIdHash,
    userId,
    expiresAt: new Date(createdAt.getTime() + 60_000),
    createdAt
  });
}

function mutation(action: AdminUserMutation["action"], expectedAuthorizationRevision: number, reason: string, permissions: Pick<AdminUserMutation, "appRole" | "tradingRole"> = {}, metadata: AdminUserMutation["metadata"] = {}): AdminUserMutation {
  return {
    action,
    expectedAuthorizationRevision,
    reason,
    ...permissions,
    metadata: {
      requestId: metadata.requestId ?? `identity-integration-${mutationSequence + 1}`,
      ipAddress: metadata.ipAddress ?? "127.0.0.1",
      userAgent: metadata.userAgent ?? "identity-postgres-integration",
      ...metadata
    },
    now: nextTime()
  };
}

function updatedUser(result: Awaited<ReturnType<PostgresIdentityRepository["mutateUserAsAdmin"]>>): IdentityUser {
  if (result.status !== "updated") {
    throw new Error(`Expected updated identity mutation, received ${result.status}`);
  }
  return result.user;
}

function principal(user: IdentityUser, session: IdentitySession): IdentityPrincipal {
  return {
    user: publicIdentityUser(user),
    sessionIdHash: session.idHash,
    csrfHash: session.csrfHash,
    expiresAt: session.expiresAt,
    authorizationEpoch: 0,
    effectiveTradingRole: effectiveTradingRole(user)
  };
}

async function sessionState(idHash: string): Promise<{ revoked: boolean; revokeReason: string | null }> {
  const result = await pool.query<{
    revoked_at: Date | null;
    revoke_reason: string | null;
  }>("SELECT revoked_at, revoke_reason FROM auth_sessions WHERE id_hash = $1", [idHash]);
  const row = result.rows[0];
  if (!row) throw new Error("Session fixture not found");
  return {
    revoked: row.revoked_at !== null,
    revokeReason: row.revoke_reason
  };
}

async function ticketCount(userId: string): Promise<number> {
  const result = await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM auth_ws_tickets WHERE user_id = $1", [userId]);
  return Number(result.rows[0]?.count ?? 0);
}

function nextTime(): Date {
  mutationSequence += 1;
  return new Date(Date.parse("2026-07-16T00:00:00.000Z") + mutationSequence);
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
