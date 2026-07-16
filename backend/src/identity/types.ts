import type { AuthRole } from "../trading/types.js";

export type AppRole = "user" | "admin";
export type TradingRole = "none" | Exclude<AuthRole, "admin">;
export type UserStatus = "pending" | "active" | "disabled";

export interface IdentityUser {
  id: string;
  login: string;
  loginNormalized: string;
  passwordHash: string;
  status: UserStatus;
  appRole: AppRole;
  tradingRole: TradingRole;
  mustChangePassword: boolean;
  /** Durable monotonic fence for every authorization-affecting mutation. */
  authorizationRevision: number;
  approvedBy?: string;
  approvedAt?: Date;
  lastLoginAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface PublicIdentityUser {
  id: string;
  login: string;
  status: UserStatus;
  appRole: AppRole;
  tradingRole: TradingRole;
  mustChangePassword: boolean;
  authorizationRevision: number;
  approvedBy?: string;
  approvedAt?: string;
  lastLoginAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface IdentitySession {
  publicId: string;
  idHash: string;
  userId: string;
  csrfHash: string;
  expiresAt: Date;
  lastSeenAt: Date;
  createdAt: Date;
  revokedAt?: Date;
  revokeReason?: string;
  userAgent?: string;
  ipAddress?: string;
}

export interface PublicIdentitySession {
  publicId: string;
  current: boolean;
  expiresAt: string;
  lastSeenAt: string;
  createdAt: string;
  revokedAt?: string;
  revokeReason?: string;
  userAgent?: string;
  ipAddress?: string;
}

export interface IdentityAuditEvent {
  id: string;
  eventType: string;
  actorUserId?: string;
  actorLogin?: string;
  subjectUserId?: string;
  subjectLogin?: string;
  requestId?: string;
  ipAddress?: string;
  userAgent?: string;
  metadata: Record<string, unknown>;
  occurredAt: Date;
}

export interface PublicIdentityAuditEvent {
  id: string;
  eventType: string;
  actorUserId?: string;
  actorLogin?: string;
  subjectUserId?: string;
  subjectLogin?: string;
  requestId?: string;
  ipAddress?: string;
  userAgent?: string;
  reason?: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  metadata: Record<string, unknown>;
  occurredAt: string;
}

export interface PageInfo {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface IdentityPrincipal {
  user: PublicIdentityUser;
  sessionIdHash: string;
  csrfHash: string;
  expiresAt: Date;
  /** In-process authorization generation used to invalidate queued mutations. */
  authorizationEpoch: number;
  effectiveTradingRole?: AuthRole;
}

export interface SessionCredentials {
  sessionToken: string;
  csrfToken: string;
  expiresAt: Date;
  user: PublicIdentityUser;
}

export function effectiveTradingRole(user: Pick<IdentityUser, "appRole" | "tradingRole">): AuthRole | undefined {
  if (user.appRole === "admin") return "admin";
  return user.tradingRole === "none" ? undefined : user.tradingRole;
}

export function publicIdentityUser(user: IdentityUser): PublicIdentityUser {
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
