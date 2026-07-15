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
  approvedBy?: string;
  approvedAt?: string;
  lastLoginAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface IdentitySession {
  idHash: string;
  userId: string;
  csrfHash: string;
  expiresAt: Date;
  lastSeenAt: Date;
  createdAt: Date;
  revokedAt?: Date;
  userAgent?: string;
  ipAddress?: string;
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
    approvedBy: user.approvedBy,
    approvedAt: user.approvedAt?.toISOString(),
    lastLoginAt: user.lastLoginAt?.toISOString(),
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString()
  };
}
