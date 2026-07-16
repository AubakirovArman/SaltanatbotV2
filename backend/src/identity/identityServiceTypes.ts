import type {
  AppRole,
  PageInfo,
  PublicIdentitySession,
  PublicIdentityUser,
  TradingRole
} from "./types.js";

export type TradingAccessChangeAction = "revoke" | "restore";
export type TradingAccessChangeHandler = (
  userId: string,
  action: TradingAccessChangeAction
) => void | Promise<void>;

export type SessionRevocationReason =
  | "logout"
  | "password_changed"
  | "admin_password_recovered"
  | "user_activated"
  | "user_reactivated"
  | "user_disabled"
  | "permissions_changed"
  | "session_revoked"
  | "other_sessions_revoked"
  | "all_sessions_revoked"
  | "admin_session_revoked"
  | "admin_sessions_revoked";

export interface SessionRevocationNotice {
  userId: string;
  sessionIdHash?: string;
  reason: SessionRevocationReason;
}

export type SessionRevocationHandler = (
  notice: SessionRevocationNotice
) => void | Promise<void>;

export interface RequestMetadata {
  requestId?: string;
  ipAddress?: string;
  userAgent?: string;
}

export interface AdminLifecycleMutationInput {
  reason: string;
  expectedAuthorizationRevision: number;
  appRole?: AppRole;
  tradingRole?: TradingRole;
}

export interface AdminUserMutationOutcome extends PublicIdentityUser {
  user: PublicIdentityUser;
  revokedSessionCount: number;
  revokedCurrentSession: boolean;
  cancelledJobCount: number;
}

export interface PublicPage<T> extends PageInfo {
  items: T[];
  pagination: PageInfo;
}

export interface PublicRevocablePage<T> extends PublicPage<T> {
  revocableSessionCount: number;
}

export type PublicSessionPage =
  PublicRevocablePage<PublicIdentitySession>;

export interface SessionRevocationOutcome {
  revokedSessionCount: number;
  revokedCurrentSession: boolean;
}
