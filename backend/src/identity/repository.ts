import type { AppRole, IdentitySession, IdentityUser, TradingRole, UserStatus } from "./types.js";

export interface WsTicketRecord {
  ticketHash: string;
  sessionIdHash: string;
  userId: string;
  expiresAt: Date;
  createdAt: Date;
}

export interface AuditEventInput {
  actorUserId?: string;
  subjectUserId?: string;
  eventType: string;
  ipAddress?: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

export interface UserUpdate {
  status?: UserStatus;
  appRole?: AppRole;
  tradingRole?: TradingRole;
  mustChangePassword?: boolean;
  passwordHash?: string;
  approvedBy?: string;
  approvedAt?: Date;
  lastLoginAt?: Date;
  updatedAt: Date;
}

export type FirstAdminCreateResult = "created" | "admin_exists" | "login_exists";

export type AdminGuardedUserUpdateResult =
  | { status: "updated"; user: IdentityUser }
  | { status: "subject_not_found" }
  | { status: "last_active_admin" }
  | { status: "actor_not_found" | "actor_inactive" | "actor_not_admin" | "actor_password_change_required" };

export interface IdentityRepository {
  createUser(user: IdentityUser): Promise<boolean>;
  /** Atomically creates the only initial administrator. */
  createFirstAdmin(user: IdentityUser): Promise<FirstAdminCreateResult>;
  findUserByLogin(loginNormalized: string): Promise<IdentityUser | undefined>;
  findUserById(id: string): Promise<IdentityUser | undefined>;
  listUsers(status?: UserStatus): Promise<IdentityUser[]>;
  countAdmins(): Promise<number>;
  updateUser(id: string, update: UserUpdate): Promise<IdentityUser | undefined>;
  /** Revalidates the administrator and mutates the subject under one guard/transaction. */
  updateUserAsAdmin(actorUserId: string, subjectUserId: string, update: UserUpdate): Promise<AdminGuardedUserUpdateResult>;

  createSession(session: IdentitySession): Promise<void>;
  findSession(idHash: string): Promise<{ session: IdentitySession; user: IdentityUser } | undefined>;
  touchSession(idHash: string, now: Date): Promise<void>;
  updateSessionCsrf(idHash: string, csrfHash: string, now: Date): Promise<void>;
  revokeSession(idHash: string, now: Date): Promise<void>;
  revokeUserSessions(userId: string, now: Date, exceptIdHash?: string): Promise<void>;
  deleteExpiredSessions(now: Date): Promise<void>;

  createWsTicket(ticket: WsTicketRecord): Promise<void>;
  consumeWsTicket(ticketHash: string, now: Date): Promise<{ user: IdentityUser; session: IdentitySession } | undefined>;
  deleteExpiredWsTickets(now: Date): Promise<void>;

  appendAuditEvent(event: AuditEventInput): Promise<void>;
  close?(): Promise<void>;
}
