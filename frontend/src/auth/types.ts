export type AppRole = "user" | "admin";
export type TradingRole = "none" | "read-only" | "paper-trade" | "live-trade";
export type UserStatus = "pending" | "active" | "disabled";

export interface AuthConfig {
  mode: string;
  authRequired: boolean;
  registrationEnabled: boolean;
  tradingRoleAssignmentsEnabled: boolean;
}

export interface AuthUser {
  id: string;
  login: string;
  status: UserStatus;
  appRole: AppRole;
  tradingRole: TradingRole;
  mustChangePassword: boolean;
  approvedBy?: string;
  approvedAt?: string;
  lastLoginAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface AuthSession {
  user: AuthUser;
  csrfToken?: string;
  expiresAt?: string;
  tradingAvailable: boolean;
}

export interface RegistrationResult {
  login: string;
  status: "pending";
}

export interface PermissionUpdate {
  appRole: AppRole;
  tradingRole: TradingRole;
}
