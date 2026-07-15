import type { AdminGuardedUserUpdateResult, AuditEventInput, FirstAdminCreateResult, IdentityRepository, UserUpdate, WsTicketRecord } from "./repository.js";
import type { IdentitySession, IdentityUser, UserStatus } from "./types.js";

export class MemoryIdentityRepository implements IdentityRepository {
  readonly auditEvents: AuditEventInput[] = [];
  private readonly users = new Map<string, IdentityUser>();
  private readonly sessions = new Map<string, IdentitySession>();
  private readonly tickets = new Map<string, WsTicketRecord>();

  async createUser(user: IdentityUser): Promise<boolean> {
    if ([...this.users.values()].some((item) => item.loginNormalized === user.loginNormalized)) return false;
    this.users.set(user.id, cloneUser(user));
    return true;
  }

  async createFirstAdmin(user: IdentityUser): Promise<FirstAdminCreateResult> {
    if (user.appRole !== "admin" || user.status !== "active") throw new Error("First administrator must be active.");
    if ([...this.users.values()].some((item) => item.appRole === "admin")) return "admin_exists";
    if ([...this.users.values()].some((item) => item.loginNormalized === user.loginNormalized)) return "login_exists";
    this.users.set(user.id, cloneUser(user));
    return "created";
  }

  async findUserByLogin(loginNormalized: string): Promise<IdentityUser | undefined> {
    const user = [...this.users.values()].find((item) => item.loginNormalized === loginNormalized);
    return user && cloneUser(user);
  }

  async findUserById(id: string): Promise<IdentityUser | undefined> {
    const user = this.users.get(id);
    return user && cloneUser(user);
  }

  async listUsers(status?: UserStatus): Promise<IdentityUser[]> {
    return [...this.users.values()]
      .filter((user) => !status || user.status === status)
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
      .map(cloneUser);
  }

  async countAdmins(): Promise<number> {
    return [...this.users.values()].filter((user) => user.appRole === "admin").length;
  }

  async updateUser(id: string, update: UserUpdate): Promise<IdentityUser | undefined> {
    const current = this.users.get(id);
    if (!current) return undefined;
    const next = cloneUser({ ...current, ...update });
    this.users.set(id, next);
    return cloneUser(next);
  }

  async updateUserAsAdmin(actorUserId: string, subjectUserId: string, update: UserUpdate): Promise<AdminGuardedUserUpdateResult> {
    const actor = this.users.get(actorUserId);
    const actorFailure = validateAdminActor(actor);
    if (actorFailure) return { status: actorFailure };
    const current = this.users.get(subjectUserId);
    if (!current) return { status: "subject_not_found" };
    const next = cloneUser({ ...current, ...update });
    if (isActiveAdmin(current) && !isActiveAdmin(next)) {
      const replacementExists = [...this.users.values()].some((user) => user.id !== subjectUserId && isActiveAdmin(user));
      if (!replacementExists) return { status: "last_active_admin" };
    }
    this.users.set(subjectUserId, next);
    return { status: "updated", user: cloneUser(next) };
  }

  async createSession(session: IdentitySession): Promise<void> {
    this.sessions.set(session.idHash, cloneSession(session));
  }

  async findSession(idHash: string): Promise<{ session: IdentitySession; user: IdentityUser } | undefined> {
    const session = this.sessions.get(idHash);
    if (!session) return undefined;
    const user = this.users.get(session.userId);
    return user ? { session: cloneSession(session), user: cloneUser(user) } : undefined;
  }

  async touchSession(idHash: string, now: Date): Promise<void> {
    const session = this.sessions.get(idHash);
    if (session) session.lastSeenAt = new Date(now);
  }

  async updateSessionCsrf(idHash: string, csrfHash: string, now: Date): Promise<void> {
    const session = this.sessions.get(idHash);
    if (session) {
      session.csrfHash = csrfHash;
      session.lastSeenAt = new Date(now);
    }
  }

  async revokeSession(idHash: string, now: Date): Promise<void> {
    const session = this.sessions.get(idHash);
    if (session) session.revokedAt = new Date(now);
  }

  async revokeUserSessions(userId: string, now: Date, exceptIdHash?: string): Promise<void> {
    for (const session of this.sessions.values()) {
      if (session.userId === userId && session.idHash !== exceptIdHash) session.revokedAt = new Date(now);
    }
  }

  async deleteExpiredSessions(now: Date): Promise<void> {
    for (const [id, session] of this.sessions) if (session.expiresAt <= now) this.sessions.delete(id);
  }

  async createWsTicket(ticket: WsTicketRecord): Promise<void> {
    this.tickets.set(ticket.ticketHash, { ...ticket, expiresAt: new Date(ticket.expiresAt), createdAt: new Date(ticket.createdAt) });
  }

  async consumeWsTicket(ticketHash: string, now: Date): Promise<{ user: IdentityUser; session: IdentitySession } | undefined> {
    const ticket = this.tickets.get(ticketHash);
    this.tickets.delete(ticketHash);
    if (!ticket || ticket.expiresAt <= now) return undefined;
    const found = await this.findSession(ticket.sessionIdHash);
    if (!found || found.user.id !== ticket.userId) return undefined;
    return found;
  }

  async deleteExpiredWsTickets(now: Date): Promise<void> {
    for (const [id, ticket] of this.tickets) if (ticket.expiresAt <= now) this.tickets.delete(id);
  }

  async appendAuditEvent(event: AuditEventInput): Promise<void> {
    this.auditEvents.unshift({ ...event, createdAt: new Date(event.createdAt), metadata: event.metadata && structuredClone(event.metadata) });
  }
}

function cloneUser(user: IdentityUser): IdentityUser {
  return {
    ...user,
    createdAt: new Date(user.createdAt),
    updatedAt: new Date(user.updatedAt),
    approvedAt: user.approvedAt && new Date(user.approvedAt),
    lastLoginAt: user.lastLoginAt && new Date(user.lastLoginAt)
  };
}

function cloneSession(session: IdentitySession): IdentitySession {
  return {
    ...session,
    expiresAt: new Date(session.expiresAt),
    lastSeenAt: new Date(session.lastSeenAt),
    createdAt: new Date(session.createdAt),
    revokedAt: session.revokedAt && new Date(session.revokedAt)
  };
}

function isActiveAdmin(user: Pick<IdentityUser, "status" | "appRole">): boolean {
  return user.status === "active" && user.appRole === "admin";
}

function validateAdminActor(user: IdentityUser | undefined): "actor_not_found" | "actor_inactive" | "actor_not_admin" | "actor_password_change_required" | undefined {
  if (!user) return "actor_not_found";
  if (user.status !== "active") return "actor_inactive";
  if (user.appRole !== "admin") return "actor_not_admin";
  if (user.mustChangePassword) return "actor_password_change_required";
  return undefined;
}
