import type {
  AdminUserMutationAction,
  AdminUserMutationResult,
  PageRequest,
  SessionRevocationResult
} from "./repository.js";
import type {
  AdminLifecycleMutationInput,
  PublicPage,
  SessionRevocationReason
} from "./identityServiceTypes.js";
import {
  IdentityError,
  isUuid,
  validateReason
} from "./identityValidation.js";
import type {
  IdentityAuditEvent,
  IdentityPrincipal,
  IdentitySession,
  PageInfo,
  PublicIdentityAuditEvent,
  PublicIdentitySession
} from "./types.js";

export function requireAdmin(principal: IdentityPrincipal): void {
  if (principal.user.appRole !== "admin") {
    throw new IdentityError(
      403,
      "admin_required",
      "Administrator access is required."
    );
  }
}

export function adminMutationUser(
  result: AdminUserMutationResult
): Extract<AdminUserMutationResult, { status: "updated" }> {
  if (result.status === "subject_not_found") {
    throw new IdentityError(404, "user_not_found", "User not found.");
  }
  if (result.status === "last_active_admin") {
    throw new IdentityError(
      409,
      "last_active_admin",
      "At least one active administrator account is required."
    );
  }
  if (result.status === "live_role_forbidden") {
    throw new IdentityError(
      409,
      "live_trading_role_forbidden",
      "A non-administrator account cannot retain live-trading access."
    );
  }
  if (result.status === "self_disable") {
    throw new IdentityError(
      409,
      "self_disable",
      "You cannot disable your own account."
    );
  }
  if (result.status === "self_demote") {
    throw new IdentityError(
      409,
      "self_demote",
      "You cannot remove your own administrator role."
    );
  }
  if (result.status === "revision_conflict") {
    throw new IdentityError(
      409,
      "authorization_conflict",
      "The user was changed by another administrator. Refresh and try again."
    );
  }
  if (result.status === "invalid_transition") {
    throw new IdentityError(
      409,
      "invalid_user_transition",
      "The requested account status transition is no longer valid."
    );
  }
  if (result.status === "actor_password_change_required") {
    throw new IdentityError(
      403,
      "password_change_required",
      "Change the temporary password before using administrator functions."
    );
  }
  if (result.status !== "updated") {
    throw new IdentityError(
      403,
      "admin_required",
      "Administrator access is required."
    );
  }
  return result;
}

export function sessionRevocation(
  result: SessionRevocationResult
): Extract<SessionRevocationResult, { status: "revoked" }> {
  if (result.status === "session_not_found") {
    throw new IdentityError(404, "session_not_found", "Session not found.");
  }
  if (result.status === "subject_not_found") {
    throw new IdentityError(404, "user_not_found", "User not found.");
  }
  if (result.status === "actor_password_change_required") {
    throw new IdentityError(
      403,
      "password_change_required",
      "Change the temporary password before using administrator functions."
    );
  }
  if (result.status !== "revoked") {
    throw new IdentityError(
      403,
      "admin_required",
      "Administrator access is required."
    );
  }
  return result;
}

export function validateAdminMutationInput(
  input: AdminLifecycleMutationInput
): AdminLifecycleMutationInput {
  if (
    !Number.isSafeInteger(input.expectedAuthorizationRevision) ||
    input.expectedAuthorizationRevision < 1
  ) {
    throw new IdentityError(
      400,
      "invalid_authorization_revision",
      "A valid expected authorization revision is required."
    );
  }
  return { ...input, reason: validateReason(input.reason) };
}

export function normalizedPage(request: Partial<PageRequest>): PageRequest {
  const page =
    Number.isSafeInteger(request.page) && (request.page ?? 0) > 0
      ? request.page!
      : 1;
  const pageSize =
    Number.isSafeInteger(request.pageSize) && (request.pageSize ?? 0) > 0
      ? Math.min(100, request.pageSize!)
      : 25;
  return { page, pageSize };
}

export function publicPage<T>(
  items: T[],
  total: number,
  request: PageRequest
): PublicPage<T> {
  const pagination: PageInfo = {
    page: request.page,
    pageSize: request.pageSize,
    total,
    totalPages: total === 0 ? 0 : Math.ceil(total / request.pageSize)
  };
  return { items, ...pagination, pagination };
}

export function publicSession(
  session: IdentitySession,
  currentIdHash?: string
): PublicIdentitySession {
  return {
    publicId: session.publicId,
    current: session.idHash === currentIdHash,
    expiresAt: session.expiresAt.toISOString(),
    lastSeenAt: session.lastSeenAt.toISOString(),
    createdAt: session.createdAt.toISOString(),
    revokedAt: session.revokedAt?.toISOString(),
    revokeReason: session.revokeReason,
    userAgent: session.userAgent,
    ipAddress: session.ipAddress
  };
}

export function publicAuditEvent(
  event: IdentityAuditEvent
): PublicIdentityAuditEvent {
  const metadata = structuredClone(event.metadata);
  return {
    id: event.id,
    eventType: event.eventType,
    actorUserId: event.actorUserId,
    actorLogin: event.actorLogin,
    subjectUserId: event.subjectUserId,
    subjectLogin: event.subjectLogin,
    requestId: event.requestId,
    ipAddress: event.ipAddress,
    userAgent: event.userAgent,
    reason:
      typeof metadata.reason === "string" ? metadata.reason : undefined,
    before: recordValue(metadata.before),
    after: recordValue(metadata.after),
    metadata,
    occurredAt: event.occurredAt.toISOString()
  };
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function lifecycleNoticeReason(
  action: AdminUserMutationAction
): SessionRevocationReason {
  if (action === "activate") return "user_activated";
  if (action === "reactivate") return "user_reactivated";
  if (action === "disable") return "user_disabled";
  return "permissions_changed";
}

export { isUuid, validateReason };
