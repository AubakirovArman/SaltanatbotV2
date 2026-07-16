import type {
  AppRole,
  IdentityAuditEvent,
  IdentitySession,
  IdentityUser,
  TradingRole,
  UserStatus
} from "./types.js";

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
  requestId?: string;
  ipAddress?: string;
  userAgent?: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

export interface PageRequest {
  page: number;
  pageSize: number;
}

export interface PageResult<T> {
  items: T[];
  total: number;
}

export interface SessionListRequest extends PageRequest {
  now: Date;
}

export interface SessionPageResult extends PageResult<IdentitySession> {
  revocableSessionCount: number;
}

export interface UserListRequest extends PageRequest {
  status?: UserStatus;
  appRole?: AppRole;
  tradingRole?: TradingRole;
  query?: string;
}

export interface AuditListRequest extends PageRequest {
  subjectUserId?: string;
  eventType?: string;
}

export type AdminUserMutationAction = "activate" | "reactivate" | "disable" | "permissions";

export interface AdminUserMutation {
  action: AdminUserMutationAction;
  expectedAuthorizationRevision: number;
  reason: string;
  appRole?: AppRole;
  tradingRole?: TradingRole;
  metadata: Omit<AuditEventInput, "actorUserId" | "subjectUserId" | "eventType" | "metadata" | "createdAt">;
  now: Date;
}

export interface AdminUserMutationSuccess {
  status: "updated";
  user: IdentityUser;
  revokedSessionIdHashes: string[];
  cancelledJobCount: number;
}

export type AdminUserMutationResult =
  | AdminUserMutationSuccess
  | { status: "subject_not_found" }
  | { status: "last_active_admin" }
  | { status: "live_role_forbidden" }
  | { status: "self_disable" | "self_demote" }
  | { status: "revision_conflict"; current: IdentityUser }
  | { status: "invalid_transition"; current: IdentityUser }
  | { status: "actor_not_found" | "actor_inactive" | "actor_not_admin" | "actor_password_change_required" };

export interface SessionRevocationInput {
  actorUserId: string;
  subjectUserId: string;
  reason: string;
  mode: "one" | "others" | "all";
  publicId?: string;
  exceptIdHash?: string;
  requireAdmin: boolean;
  eventType: string;
  metadata: Omit<AuditEventInput, "actorUserId" | "subjectUserId" | "eventType" | "metadata" | "createdAt">;
  now: Date;
}

export type SessionRevocationResult =
  | { status: "revoked"; revokedSessionIdHashes: string[] }
  | { status: "session_not_found" | "subject_not_found" }
  | { status: "actor_not_found" | "actor_inactive" | "actor_not_admin" | "actor_password_change_required" };

export interface AdminPasswordRecoveryInput {
  loginNormalized: string;
  passwordHash: string;
  reason: string;
  metadata: Omit<AuditEventInput, "actorUserId" | "subjectUserId" | "eventType" | "metadata" | "createdAt">;
  now: Date;
}

export type AdminPasswordRecoveryResult =
  | { status: "updated"; user: IdentityUser; revokedSessionIdHashes: string[] }
  | { status: "user_not_found" | "user_not_admin" | "user_inactive" };

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
  listUsersPage(request: UserListRequest): Promise<PageResult<IdentityUser>>;
  countAdmins(): Promise<number>;
  updateUser(id: string, update: UserUpdate): Promise<IdentityUser | undefined>;
  /** Revalidates the administrator and mutates the subject under one guard/transaction. */
  updateUserAsAdmin(actorUserId: string, subjectUserId: string, update: UserUpdate): Promise<AdminGuardedUserUpdateResult>;
  mutateUserAsAdmin(actorUserId: string, subjectUserId: string, mutation: AdminUserMutation): Promise<AdminUserMutationResult>;
  recoverAdminPassword(input: AdminPasswordRecoveryInput): Promise<AdminPasswordRecoveryResult>;

  createSession(session: IdentitySession): Promise<void>;
  findSession(idHash: string): Promise<{ session: IdentitySession; user: IdentityUser } | undefined>;
  listSessions(userId: string, request: SessionListRequest): Promise<SessionPageResult>;
  touchSession(idHash: string, now: Date): Promise<void>;
  updateSessionCsrf(idHash: string, csrfHash: string, now: Date): Promise<void>;
  revokeSession(idHash: string, now: Date): Promise<void>;
  revokeUserSessions(userId: string, now: Date, exceptIdHash?: string): Promise<void>;
  revokeSessions(input: SessionRevocationInput): Promise<SessionRevocationResult>;
  deleteExpiredSessions(now: Date, limit?: number): Promise<number>;

  createWsTicket(ticket: WsTicketRecord): Promise<void>;
  consumeWsTicket(ticketHash: string, now: Date): Promise<{ user: IdentityUser; session: IdentitySession } | undefined>;
  deleteExpiredWsTickets(now: Date, limit?: number): Promise<number>;

  appendAuditEvent(event: AuditEventInput): Promise<void>;
  listAuditEvents(request: AuditListRequest): Promise<PageResult<IdentityAuditEvent>>;
  close?(): Promise<void>;
}
