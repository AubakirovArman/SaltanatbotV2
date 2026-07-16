export type AppRole = "user" | "admin";
export type TradingRole = "none" | "read-only" | "paper-trade" | "live-trade";
export type AssignableTradingRole = Exclude<TradingRole, "live-trade">;
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
  authorizationRevision: number;
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

export interface MutationBase {
  reason: string;
  expectedAuthorizationRevision: number;
}

export type DisableMutation = MutationBase & {
  appRole?: never;
  tradingRole?: never;
};

export type PermissionUpdate = MutationBase & (
  | { appRole: AppRole; tradingRole?: AssignableTradingRole }
  | { appRole?: AppRole; tradingRole: AssignableTradingRole }
);

export interface Pagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface AdminUserFilters {
  query?: string;
  status?: UserStatus;
  appRole?: AppRole;
  tradingRole?: TradingRole;
  page?: number;
  pageSize?: number;
}

export interface AdminUserPage {
  users: AuthUser[];
  pagination: Pagination;
}

export interface LifecycleMutation extends MutationBase {
  appRole?: AppRole;
  tradingRole?: AssignableTradingRole;
}

export interface AdminMutationResult {
  user: AuthUser;
  revokedSessionCount: number;
  cancelledJobCount: number;
  revokedCurrentSession: boolean;
}

export interface AuthSessionSummary {
  publicId: string;
  current: boolean;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  revokedAt?: string;
  revokeReason?: string;
  userAgent?: string;
  ipAddress?: string;
}

export interface AuthSessionPage {
  sessions: AuthSessionSummary[];
  pagination: Pagination;
  revocableSessionCount: number;
}

export interface SessionRevocationOutcome {
  revokedSessionCount: number;
  revokedCurrentSession: boolean;
}

export interface AdminAuditState {
  status?: UserStatus;
  appRole?: AppRole;
  tradingRole?: TradingRole;
  authorizationRevision?: number;
}

export interface AdminAuditEvent {
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
  before?: AdminAuditState;
  after?: AdminAuditState;
  metadata: Record<string, unknown>;
  occurredAt: string;
}

export interface AdminAuditFilters {
  subjectUserId?: string;
  eventType?: string;
  page?: number;
  pageSize?: number;
}

export interface AdminAuditPage {
  events: AdminAuditEvent[];
  pagination: Pagination;
}
