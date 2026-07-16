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
import {
  boundedCleanupLimit,
  canonicalUserRecord,
  changesAuthorization,
  cloneAuditEvent,
  cloneSession,
  cloneUser,
  compareSessions,
  compareUsers,
  isActiveAdmin,
  lifecycleEventType,
  lifecycleSessionReason,
  pageOffset,
  safeUserSnapshot,
  sessionReason,
  validateAdminActor,
  validateSessionActor,
  validTransition
} from "./memoryRepositorySupport.js";
import type {
  IdentityAuditEvent,
  IdentitySession,
  IdentityUser,
  UserStatus
} from "./types.js";
import { canonicalUuid } from "./identityValidation.js";

export class MemoryIdentityRepository implements IdentityRepository {
  readonly auditEvents: AuditEventInput[] = [];
  private readonly users = new Map<string, IdentityUser>();
  private readonly sessions = new Map<string, IdentitySession>();
  private readonly tickets = new Map<string, WsTicketRecord>();
  private readonly storedAuditEvents: IdentityAuditEvent[] = [];
  private nextAuditId = 1;

  async createUser(user: IdentityUser): Promise<boolean> {
    if (
      [...this.users.values()].some(
        (item) => item.loginNormalized === user.loginNormalized
      )
    ) {
      return false;
    }
    const canonicalUser = canonicalUserRecord(user);
    this.users.set(canonicalUser.id, canonicalUser);
    return true;
  }

  async createFirstAdmin(user: IdentityUser): Promise<FirstAdminCreateResult> {
    if (user.appRole !== "admin" || user.status !== "active") {
      throw new Error("First administrator must be active.");
    }
    if ([...this.users.values()].some((item) => item.appRole === "admin")) {
      return "admin_exists";
    }
    if (
      [...this.users.values()].some(
        (item) => item.loginNormalized === user.loginNormalized
      )
    ) {
      return "login_exists";
    }
    const canonicalUser = canonicalUserRecord(user);
    this.users.set(canonicalUser.id, canonicalUser);
    return "created";
  }

  async findUserByLogin(loginNormalized: string): Promise<IdentityUser | undefined> {
    const user = [...this.users.values()].find(
      (item) => item.loginNormalized === loginNormalized
    );
    return user && cloneUser(user);
  }

  async findUserById(id: string): Promise<IdentityUser | undefined> {
    const user = this.users.get(canonicalUuid(id));
    return user && cloneUser(user);
  }

  async listUsers(status?: UserStatus): Promise<IdentityUser[]> {
    return [...this.users.values()]
      .filter((user) => !status || user.status === status)
      .sort(compareUsers)
      .map(cloneUser);
  }

  async listUsersPage(request: UserListRequest): Promise<PageResult<IdentityUser>> {
    const filtered = [...this.users.values()]
      .filter((user) => !request.status || user.status === request.status)
      .filter((user) => !request.appRole || user.appRole === request.appRole)
      .filter(
        (user) =>
          !request.tradingRole || user.tradingRole === request.tradingRole
      )
      .filter(
        (user) =>
          !request.query || user.loginNormalized.includes(request.query)
      )
      .sort(compareUsers);
    return {
      items: filtered
        .slice(pageOffset(request), pageOffset(request) + request.pageSize)
        .map(cloneUser),
      total: filtered.length
    };
  }

  async countAdmins(): Promise<number> {
    return [...this.users.values()].filter((user) => user.appRole === "admin")
      .length;
  }

  async updateUser(
    id: string,
    update: UserUpdate
  ): Promise<IdentityUser | undefined> {
    const canonicalId = canonicalUuid(id);
    const current = this.users.get(canonicalId);
    if (!current) return undefined;
    const next = cloneUser({
      ...current,
      ...update,
      authorizationRevision:
        current.authorizationRevision + (changesAuthorization(update) ? 1 : 0)
    });
    this.users.set(canonicalId, next);
    return cloneUser(next);
  }

  async updateUserAsAdmin(
    actorUserId: string,
    subjectUserId: string,
    update: UserUpdate
  ): Promise<AdminGuardedUserUpdateResult> {
    const canonicalActorId = canonicalUuid(actorUserId);
    const canonicalSubjectId = canonicalUuid(subjectUserId);
    const actor = this.users.get(canonicalActorId);
    const actorFailure = validateAdminActor(actor);
    if (actorFailure) return { status: actorFailure };
    const current = this.users.get(canonicalSubjectId);
    if (!current) return { status: "subject_not_found" };
    const next = cloneUser({
      ...current,
      ...update,
      authorizationRevision:
        current.authorizationRevision + (changesAuthorization(update) ? 1 : 0)
    });
    if (isActiveAdmin(current) && !isActiveAdmin(next)) {
      const replacementExists = [...this.users.values()].some(
        (user) => user.id !== canonicalSubjectId && isActiveAdmin(user)
      );
      if (!replacementExists) return { status: "last_active_admin" };
    }
    this.users.set(canonicalSubjectId, next);
    return { status: "updated", user: cloneUser(next) };
  }

  async mutateUserAsAdmin(
    actorUserId: string,
    subjectUserId: string,
    mutation: AdminUserMutation
  ): Promise<AdminUserMutationResult> {
    const canonicalActorId = canonicalUuid(actorUserId);
    const canonicalSubjectId = canonicalUuid(subjectUserId);
    const actor = this.users.get(canonicalActorId);
    const actorFailure = validateAdminActor(actor);
    if (actorFailure) return { status: actorFailure };
    const current = this.users.get(canonicalSubjectId);
    if (!current) return { status: "subject_not_found" };
    if (current.authorizationRevision !== mutation.expectedAuthorizationRevision) {
      return { status: "revision_conflict", current: cloneUser(current) };
    }
    if (!validTransition(current, mutation.action)) {
      return { status: "invalid_transition", current: cloneUser(current) };
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
    if (canonicalActorId === canonicalSubjectId && nextStatus === "disabled") {
      return { status: "self_disable" };
    }
    if (canonicalActorId === canonicalSubjectId && nextAppRole !== "admin") {
      return { status: "self_demote" };
    }
    const next = cloneUser({
      ...current,
      status: nextStatus,
      appRole: nextAppRole,
      tradingRole: nextTradingRole,
      approvedBy:
        mutation.action === "activate" || mutation.action === "reactivate"
          ? canonicalActorId
          : current.approvedBy,
      approvedAt:
        mutation.action === "activate" || mutation.action === "reactivate"
          ? mutation.now
          : current.approvedAt,
      authorizationRevision: current.authorizationRevision + 1,
      updatedAt: mutation.now
    });
    if (isActiveAdmin(current) && !isActiveAdmin(next)) {
      const replacementExists = [...this.users.values()].some(
        (user) => user.id !== canonicalSubjectId && isActiveAdmin(user)
      );
      if (!replacementExists) return { status: "last_active_admin" };
    }
    this.users.set(canonicalSubjectId, next);
    const revokedSessionIdHashes = this.revokeUserSessionRecords(
      canonicalSubjectId,
      mutation.now,
      lifecycleSessionReason(mutation.action)
    );
    this.deleteTicketsForUser(canonicalSubjectId);
    this.recordAudit({
      eventType: lifecycleEventType(mutation.action),
      actorUserId: canonicalActorId,
      subjectUserId: canonicalSubjectId,
      requestId: mutation.metadata.requestId,
      ipAddress: mutation.metadata.ipAddress,
      userAgent: mutation.metadata.userAgent,
      metadata: {
        reason: mutation.reason,
        before: safeUserSnapshot(current),
        after: safeUserSnapshot(next),
        revokedSessionCount: revokedSessionIdHashes.length,
        cancelledJobCount: 0
      },
      createdAt: mutation.now
    });
    return {
      status: "updated",
      user: cloneUser(next),
      revokedSessionIdHashes,
      cancelledJobCount: 0
    };
  }

  async recoverAdminPassword(
    input: AdminPasswordRecoveryInput
  ): Promise<AdminPasswordRecoveryResult> {
    const current = [...this.users.values()].find(
      (user) => user.loginNormalized === input.loginNormalized
    );
    if (!current) return { status: "user_not_found" };
    if (current.appRole !== "admin") return { status: "user_not_admin" };
    if (current.status !== "active") return { status: "user_inactive" };
    const next = cloneUser({
      ...current,
      passwordHash: input.passwordHash,
      mustChangePassword: true,
      authorizationRevision: current.authorizationRevision + 1,
      updatedAt: input.now
    });
    this.users.set(next.id, next);
    const revokedSessionIdHashes = this.revokeUserSessionRecords(
      next.id,
      input.now,
      "admin_password_recovered"
    );
    this.deleteTicketsForUser(next.id);
    this.recordAudit({
      eventType: "admin.password_recovered",
      actorUserId: next.id,
      subjectUserId: next.id,
      requestId: input.metadata.requestId,
      ipAddress: input.metadata.ipAddress,
      userAgent: input.metadata.userAgent,
      metadata: {
        reason: input.reason,
        before: safeUserSnapshot(current),
        after: safeUserSnapshot(next),
        revokedSessionCount: revokedSessionIdHashes.length
      },
      createdAt: input.now
    });
    return {
      status: "updated",
      user: cloneUser(next),
      revokedSessionIdHashes
    };
  }

  async createSession(session: IdentitySession): Promise<void> {
    this.sessions.set(
      session.idHash,
      cloneSession({
        ...session,
        publicId: canonicalUuid(session.publicId),
        userId: canonicalUuid(session.userId)
      })
    );
  }

  async findSession(
    idHash: string
  ): Promise<{ session: IdentitySession; user: IdentityUser } | undefined> {
    const session = this.sessions.get(idHash);
    if (!session) return undefined;
    const user = this.users.get(session.userId);
    return user
      ? { session: cloneSession(session), user: cloneUser(user) }
      : undefined;
  }

  async listSessions(
    userId: string,
    request: SessionListRequest
  ): Promise<SessionPageResult> {
    const canonicalUserId = canonicalUuid(userId);
    const sessions = [...this.sessions.values()]
      .filter((session) => session.userId === canonicalUserId)
      .sort(compareSessions);
    return {
      items: sessions
        .slice(pageOffset(request), pageOffset(request) + request.pageSize)
        .map(cloneSession),
      total: sessions.length,
      revocableSessionCount: sessions.filter(
        (session) => !session.revokedAt && session.expiresAt > request.now
      ).length
    };
  }

  async touchSession(idHash: string, now: Date): Promise<void> {
    const session = this.sessions.get(idHash);
    if (session) session.lastSeenAt = new Date(now);
  }

  async updateSessionCsrf(
    idHash: string,
    csrfHash: string,
    now: Date
  ): Promise<void> {
    const session = this.sessions.get(idHash);
    if (session) {
      session.csrfHash = csrfHash;
      session.lastSeenAt = new Date(now);
    }
  }

  async revokeSession(idHash: string, now: Date): Promise<void> {
    const session = this.sessions.get(idHash);
    if (session) {
      session.revokedAt ??= new Date(now);
      session.revokeReason ??= "logout";
    }
  }

  async revokeUserSessions(
    userId: string,
    now: Date,
    exceptIdHash?: string
  ): Promise<void> {
    const canonicalUserId = canonicalUuid(userId);
    for (const session of this.sessions.values()) {
      if (
        session.userId === canonicalUserId &&
        session.idHash !== exceptIdHash &&
        !session.revokedAt
      ) {
        session.revokedAt = new Date(now);
        session.revokeReason = "account_changed";
      }
    }
  }

  async revokeSessions(
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
    const actor = this.users.get(input.actorUserId);
    const actorFailure = validateSessionActor(actor, input.requireAdmin);
    if (actorFailure) return { status: actorFailure };
    if (!input.requireAdmin && input.actorUserId !== input.subjectUserId) {
      return { status: "actor_not_admin" };
    }
    if (!this.users.has(input.subjectUserId)) {
      return { status: "subject_not_found" };
    }
    const revokedSessionIdHashes: string[] = [];
    for (const session of this.sessions.values()) {
      if (session.userId !== input.subjectUserId || session.revokedAt) continue;
      if (input.mode === "one" && session.publicId !== input.publicId) continue;
      if (input.mode === "others" && session.idHash === input.exceptIdHash) continue;
      session.revokedAt = new Date(input.now);
      session.revokeReason = sessionReason(input.eventType);
      revokedSessionIdHashes.push(session.idHash);
    }
    if (input.mode === "one" && revokedSessionIdHashes.length === 0) {
      return { status: "session_not_found" };
    }
    const revokedSet = new Set(revokedSessionIdHashes);
    for (const [ticketHash, ticket] of this.tickets) {
      if (revokedSet.has(ticket.sessionIdHash)) this.tickets.delete(ticketHash);
    }
    this.recordAudit({
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
        revokedSessionCount: revokedSessionIdHashes.length
      },
      createdAt: input.now
    });
    return { status: "revoked", revokedSessionIdHashes };
  }

  async deleteExpiredSessions(now: Date, limit = 1_000): Promise<number> {
    const threshold = now.getTime() - 7 * 24 * 60 * 60_000;
    const doomed = [...this.sessions.values()]
      .filter(
        (session) =>
          session.expiresAt < now ||
          (session.revokedAt?.getTime() ?? Number.POSITIVE_INFINITY) < threshold
      )
      .sort(
        (left, right) =>
          (left.revokedAt ?? left.expiresAt).getTime() -
            (right.revokedAt ?? right.expiresAt).getTime() ||
          left.idHash.localeCompare(right.idHash)
      )
      .slice(0, boundedCleanupLimit(limit));
    for (const session of doomed) this.sessions.delete(session.idHash);
    return doomed.length;
  }

  async createWsTicket(ticket: WsTicketRecord): Promise<void> {
    this.tickets.set(ticket.ticketHash, {
      ...ticket,
      userId: canonicalUuid(ticket.userId),
      expiresAt: new Date(ticket.expiresAt),
      createdAt: new Date(ticket.createdAt)
    });
  }

  async consumeWsTicket(
    ticketHash: string,
    now: Date
  ): Promise<{ user: IdentityUser; session: IdentitySession } | undefined> {
    const ticket = this.tickets.get(ticketHash);
    this.tickets.delete(ticketHash);
    if (!ticket || ticket.expiresAt <= now) return undefined;
    const found = await this.findSession(ticket.sessionIdHash);
    if (!found || found.user.id !== ticket.userId) return undefined;
    return found;
  }

  async deleteExpiredWsTickets(now: Date, limit = 1_000): Promise<number> {
    const doomed = [...this.tickets.values()]
      .filter((ticket) => ticket.expiresAt < now)
      .sort(
        (left, right) =>
          left.expiresAt.getTime() - right.expiresAt.getTime() ||
          left.ticketHash.localeCompare(right.ticketHash)
      )
      .slice(0, boundedCleanupLimit(limit));
    for (const ticket of doomed) this.tickets.delete(ticket.ticketHash);
    return doomed.length;
  }

  async appendAuditEvent(event: AuditEventInput): Promise<void> {
    this.recordAudit(event);
  }

  async listAuditEvents(
    request: AuditListRequest
  ): Promise<PageResult<IdentityAuditEvent>> {
    const filtered = this.storedAuditEvents.filter(
      (event) =>
        (!request.subjectUserId ||
          event.subjectUserId === canonicalUuid(request.subjectUserId)) &&
        (!request.eventType || event.eventType === request.eventType)
    );
    return {
      items: filtered
        .slice(pageOffset(request), pageOffset(request) + request.pageSize)
        .map(cloneAuditEvent),
      total: filtered.length
    };
  }

  private revokeUserSessionRecords(
    userId: string,
    now: Date,
    reason: string
  ): string[] {
    const revoked: string[] = [];
    for (const session of this.sessions.values()) {
      if (session.userId !== userId || session.revokedAt) continue;
      session.revokedAt = new Date(now);
      session.revokeReason = reason;
      revoked.push(session.idHash);
    }
    return revoked;
  }

  private deleteTicketsForUser(userId: string): void {
    for (const [ticketHash, ticket] of this.tickets) {
      if (ticket.userId === userId) this.tickets.delete(ticketHash);
    }
  }

  private recordAudit(event: AuditEventInput): void {
    const copy: AuditEventInput = {
      ...event,
      createdAt: new Date(event.createdAt),
      metadata: event.metadata && structuredClone(event.metadata)
    };
    this.auditEvents.unshift(copy);
    this.storedAuditEvents.unshift({
      id: String(this.nextAuditId++),
      eventType: event.eventType,
      actorUserId: event.actorUserId,
      actorLogin:
        event.actorUserId && this.users.get(event.actorUserId)?.login,
      subjectUserId: event.subjectUserId,
      subjectLogin:
        event.subjectUserId && this.users.get(event.subjectUserId)?.login,
      requestId: event.requestId,
      ipAddress: event.ipAddress,
      userAgent: event.userAgent,
      metadata: structuredClone(event.metadata ?? {}),
      occurredAt: new Date(event.createdAt)
    });
  }
}
