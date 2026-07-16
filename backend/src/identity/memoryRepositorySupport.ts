import type {
  AdminUserMutation,
  PageRequest,
  UserUpdate
} from "./repository.js";
import type {
  IdentityAuditEvent,
  IdentitySession,
  IdentityUser
} from "./types.js";
import { canonicalUuid } from "./identityValidation.js";

export function changesAuthorization(update: UserUpdate): boolean {
  return (
    update.status !== undefined ||
    update.appRole !== undefined ||
    update.tradingRole !== undefined ||
    update.mustChangePassword !== undefined ||
    update.passwordHash !== undefined
  );
}

export function cloneUser(user: IdentityUser): IdentityUser {
  return {
    ...user,
    createdAt: new Date(user.createdAt),
    updatedAt: new Date(user.updatedAt),
    approvedAt: user.approvedAt && new Date(user.approvedAt),
    lastLoginAt: user.lastLoginAt && new Date(user.lastLoginAt)
  };
}

export function canonicalUserRecord(user: IdentityUser): IdentityUser {
  return cloneUser({
    ...user,
    id: canonicalUuid(user.id),
    approvedBy: user.approvedBy
      ? canonicalUuid(user.approvedBy)
      : undefined
  });
}

export function cloneSession(session: IdentitySession): IdentitySession {
  return {
    ...session,
    expiresAt: new Date(session.expiresAt),
    lastSeenAt: new Date(session.lastSeenAt),
    createdAt: new Date(session.createdAt),
    revokedAt: session.revokedAt && new Date(session.revokedAt)
  };
}

export function cloneAuditEvent(
  event: IdentityAuditEvent
): IdentityAuditEvent {
  return {
    ...event,
    metadata: structuredClone(event.metadata),
    occurredAt: new Date(event.occurredAt)
  };
}

export function compareUsers(left: IdentityUser, right: IdentityUser): number {
  return (
    right.createdAt.getTime() - left.createdAt.getTime() ||
    right.id.localeCompare(left.id)
  );
}

export function compareSessions(
  left: IdentitySession,
  right: IdentitySession
): number {
  return (
    right.createdAt.getTime() - left.createdAt.getTime() ||
    right.publicId.localeCompare(left.publicId)
  );
}

export function isActiveAdmin(
  user: Pick<IdentityUser, "status" | "appRole">
): boolean {
  return user.status === "active" && user.appRole === "admin";
}

export function validateAdminActor(
  user: IdentityUser | undefined
):
  | "actor_not_found"
  | "actor_inactive"
  | "actor_not_admin"
  | "actor_password_change_required"
  | undefined {
  if (!user) return "actor_not_found";
  if (user.status !== "active") return "actor_inactive";
  if (user.appRole !== "admin") return "actor_not_admin";
  if (user.mustChangePassword) return "actor_password_change_required";
  return undefined;
}

export function validateSessionActor(
  user: IdentityUser | undefined,
  requireAdmin: boolean
):
  | "actor_not_found"
  | "actor_inactive"
  | "actor_not_admin"
  | "actor_password_change_required"
  | undefined {
  if (!user) return "actor_not_found";
  if (user.status !== "active") return "actor_inactive";
  if (!requireAdmin) return undefined;
  if (user.appRole !== "admin") return "actor_not_admin";
  if (user.mustChangePassword) return "actor_password_change_required";
  return undefined;
}

export function validTransition(
  user: IdentityUser,
  action: AdminUserMutation["action"]
): boolean {
  if (action === "activate") return user.status === "pending";
  if (action === "reactivate") return user.status === "disabled";
  if (action === "disable") return user.status === "active";
  return true;
}

export function lifecycleSessionReason(
  action: AdminUserMutation["action"]
): string {
  if (action === "activate") return "user_activated";
  if (action === "reactivate") return "user_reactivated";
  if (action === "disable") return "user_disabled";
  return "permissions_changed";
}

export function lifecycleEventType(
  action: AdminUserMutation["action"]
): string {
  if (action === "activate") return "user.activated";
  if (action === "reactivate") return "user.reactivated";
  if (action === "disable") return "user.disabled";
  return "user.permissions_changed";
}

export function sessionReason(eventType: string): string {
  return eventType.replaceAll(".", "_").slice(0, 160);
}

export function safeUserSnapshot(
  user: IdentityUser
): Record<string, unknown> {
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

export function pageOffset(request: PageRequest): number {
  return (request.page - 1) * request.pageSize;
}

export function boundedCleanupLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 1_000;
  return Math.min(10_000, Math.max(1, Math.trunc(limit)));
}
