import { hashPassword, passwordPolicyError } from "./password.js";
import type {
  AdminUserMutationAction,
  IdentityRepository,
  PageRequest
} from "./repository.js";
import {
  adminMutationUser,
  isUuid,
  lifecycleNoticeReason,
  normalizedPage,
  publicAuditEvent,
  publicPage,
  publicSession,
  requireAdmin,
  sessionRevocation,
  validateAdminMutationInput,
  validateReason
} from "./identityControlPlaneSupport.js";
import type {
  AdminLifecycleMutationInput,
  AdminUserMutationOutcome,
  PublicPage,
  PublicSessionPage,
  RequestMetadata,
  SessionRevocationNotice,
  SessionRevocationOutcome,
  SessionRevocationReason,
  TradingAccessChangeAction
} from "./identityServiceTypes.js";
import {
  canonicalUuid,
  IdentityError,
  normalizeLogin,
  validateLogin
} from "./identityValidation.js";
import {
  publicIdentityUser,
  type AppRole,
  type IdentityPrincipal,
  type IdentityUser,
  type PublicIdentityAuditEvent,
  type PublicIdentitySession,
  type PublicIdentityUser,
  type TradingRole,
  type UserStatus
} from "./types.js";

export interface IdentityControlPlaneHooks {
  allowNonAdminTrading: boolean;
  now(): Date;
  beginAuthorizationTransition(userId: string): () => void;
  notifySessionRevocation(notice: SessionRevocationNotice): Promise<void>;
  changeTradingAccess(
    userId: string,
    action: TradingAccessChangeAction
  ): Promise<void>;
  userHasTradingAccess(user: IdentityUser): boolean;
}

export class IdentityControlPlaneService {
  constructor(
    private readonly repository: IdentityRepository,
    private readonly hooks: IdentityControlPlaneHooks
  ) {}

  async recoverAdminPassword(
    login: string,
    newPassword: string,
    reason: string,
    metadata: RequestMetadata = {}
  ): Promise<PublicIdentityUser> {
    const validated = validateLogin(login);
    const passwordError = passwordPolicyError(newPassword, validated.login);
    if (passwordError) {
      throw new IdentityError(400, "password_policy", passwordError);
    }
    const known = await this.repository.findUserByLogin(validated.normalized);
    const finishTransition = known
      ? this.hooks.beginAuthorizationTransition(known.id)
      : () => undefined;
    try {
      const result = await this.repository.recoverAdminPassword({
        loginNormalized: validated.normalized,
        passwordHash: await hashPassword(newPassword),
        reason: validateReason(reason),
        metadata,
        now: this.hooks.now()
      });
      if (result.status === "user_not_found") {
        throw new IdentityError(404, "user_not_found", "User not found.");
      }
      if (result.status === "user_not_admin") {
        throw new IdentityError(
          409,
          "user_not_admin",
          "The selected account is not an administrator."
        );
      }
      if (result.status === "user_inactive") {
        throw new IdentityError(
          409,
          "user_inactive",
          "The selected administrator account is not active."
        );
      }
      if (result.status !== "updated") {
        throw new IdentityError(
          409,
          "admin_recovery_failed",
          "Administrator recovery failed."
        );
      }
      await this.hooks.notifySessionRevocation({
        userId: result.user.id,
        reason: "admin_password_recovered"
      });
      await this.hooks.changeTradingAccess(result.user.id, "revoke");
      return publicIdentityUser(result.user);
    } finally {
      finishTransition();
    }
  }

  async listUsers(
    actor: IdentityPrincipal,
    status?: UserStatus
  ): Promise<PublicIdentityUser[]> {
    requireAdmin(actor);
    return (await this.repository.listUsers(status)).map(publicIdentityUser);
  }

  async listUsersPage(
    actor: IdentityPrincipal,
    request: Partial<PageRequest> & {
      status?: UserStatus;
      appRole?: AppRole;
      tradingRole?: TradingRole;
      query?: string;
    }
  ): Promise<PublicPage<PublicIdentityUser>> {
    requireAdmin(actor);
    const page = normalizedPage(request);
    const result = await this.repository.listUsersPage({
      ...page,
      status: request.status,
      appRole: request.appRole,
      tradingRole: request.tradingRole,
      query: request.query ? normalizeLogin(request.query) : undefined
    });
    return publicPage(result.items.map(publicIdentityUser), result.total, page);
  }

  activateUser(
    actor: IdentityPrincipal,
    subjectId: string,
    input: AdminLifecycleMutationInput,
    metadata: RequestMetadata = {}
  ): Promise<AdminUserMutationOutcome> {
    return this.mutateUser(actor, subjectId, "activate", input, metadata);
  }

  reactivateUser(
    actor: IdentityPrincipal,
    subjectId: string,
    input: AdminLifecycleMutationInput,
    metadata: RequestMetadata = {}
  ): Promise<AdminUserMutationOutcome> {
    return this.mutateUser(actor, subjectId, "reactivate", input, metadata);
  }

  disableUser(
    actor: IdentityPrincipal,
    subjectId: string,
    input: AdminLifecycleMutationInput,
    metadata: RequestMetadata = {}
  ): Promise<AdminUserMutationOutcome> {
    return this.mutateUser(actor, subjectId, "disable", input, metadata);
  }

  updatePermissions(
    actor: IdentityPrincipal,
    subjectId: string,
    input: AdminLifecycleMutationInput,
    metadata: RequestMetadata = {}
  ): Promise<AdminUserMutationOutcome> {
    if (input.appRole === undefined && input.tradingRole === undefined) {
      throw new IdentityError(
        400,
        "permissions_required",
        "At least one permission must be supplied."
      );
    }
    return this.mutateUser(actor, subjectId, "permissions", input, metadata);
  }

  async listOwnSessions(
    principal: IdentityPrincipal,
    request: Partial<PageRequest> = {}
  ): Promise<PublicSessionPage> {
    const page = normalizedPage(request);
    const result = await this.repository.listSessions(
      canonicalUuid(principal.user.id),
      {
        ...page,
        now: this.hooks.now()
      }
    );
    return {
      ...publicPage(
        result.items.map((session) =>
          publicSession(session, principal.sessionIdHash)
        ),
        result.total,
        page
      ),
      revocableSessionCount: result.revocableSessionCount
    };
  }

  async listAdminSessions(
    actor: IdentityPrincipal,
    subjectId: string,
    request: Partial<PageRequest> = {}
  ): Promise<PublicSessionPage> {
    requireAdmin(actor);
    const canonicalSubjectId = canonicalUuid(subjectId);
    if (!(await this.repository.findUserById(canonicalSubjectId))) {
      throw new IdentityError(404, "user_not_found", "User not found.");
    }
    const page = normalizedPage(request);
    const result = await this.repository.listSessions(canonicalSubjectId, {
      ...page,
      now: this.hooks.now()
    });
    const currentIdHash =
      canonicalSubjectId === canonicalUuid(actor.user.id)
        ? actor.sessionIdHash
        : undefined;
    return {
      ...publicPage(
        result.items.map((session) =>
          publicSession(session, currentIdHash)
        ),
        result.total,
        page
      ),
      revocableSessionCount: result.revocableSessionCount
    };
  }

  revokeOwnSession(
    principal: IdentityPrincipal,
    publicId: string,
    reason: string,
    metadata: RequestMetadata = {}
  ): Promise<SessionRevocationOutcome> {
    return this.revokeSessions(
      principal,
      principal.user.id,
      {
        mode: "one",
        publicId,
        reason,
        requireAdmin: false,
        eventType: "session.revoked",
        noticeReason: "session_revoked"
      },
      metadata
    );
  }

  revokeOtherSessions(
    principal: IdentityPrincipal,
    reason: string,
    metadata: RequestMetadata = {}
  ): Promise<SessionRevocationOutcome> {
    return this.revokeSessions(
      principal,
      principal.user.id,
      {
        mode: "others",
        reason,
        requireAdmin: false,
        eventType: "sessions.others_revoked",
        noticeReason: "other_sessions_revoked"
      },
      metadata
    );
  }

  revokeAllOwnSessions(
    principal: IdentityPrincipal,
    reason: string,
    metadata: RequestMetadata = {}
  ): Promise<SessionRevocationOutcome> {
    return this.revokeSessions(
      principal,
      principal.user.id,
      {
        mode: "all",
        reason,
        requireAdmin: false,
        eventType: "sessions.all_revoked",
        noticeReason: "all_sessions_revoked"
      },
      metadata
    );
  }

  revokeAdminSession(
    actor: IdentityPrincipal,
    subjectId: string,
    publicId: string,
    reason: string,
    metadata: RequestMetadata = {}
  ): Promise<SessionRevocationOutcome> {
    return this.revokeSessions(
      actor,
      subjectId,
      {
        mode: "one",
        publicId,
        reason,
        requireAdmin: true,
        eventType: "admin.session_revoked",
        noticeReason: "admin_session_revoked"
      },
      metadata
    );
  }

  revokeAllUserSessionsAdmin(
    actor: IdentityPrincipal,
    subjectId: string,
    reason: string,
    metadata: RequestMetadata = {}
  ): Promise<SessionRevocationOutcome> {
    return this.revokeSessions(
      actor,
      subjectId,
      {
        mode: "all",
        reason,
        requireAdmin: true,
        eventType: "admin.sessions_revoked",
        noticeReason: "admin_sessions_revoked"
      },
      metadata
    );
  }

  async listAuditEvents(
    actor: IdentityPrincipal,
    request: Partial<PageRequest> & {
      subjectUserId?: string;
      eventType?: string;
    }
  ): Promise<PublicPage<PublicIdentityAuditEvent>> {
    requireAdmin(actor);
    const page = normalizedPage(request);
    const result = await this.repository.listAuditEvents({
      ...page,
      subjectUserId: request.subjectUserId
        ? canonicalUuid(request.subjectUserId)
        : undefined,
      eventType: request.eventType
    });
    return publicPage(result.items.map(publicAuditEvent), result.total, page);
  }

  private async mutateUser(
    actor: IdentityPrincipal,
    subjectId: string,
    action: AdminUserMutationAction,
    input: AdminLifecycleMutationInput,
    metadata: RequestMetadata
  ): Promise<AdminUserMutationOutcome> {
    requireAdmin(actor);
    const canonicalActorId = canonicalUuid(actor.user.id);
    const canonicalSubjectId = canonicalUuid(subjectId);
    const validated = validateAdminMutationInput(input);
    if (validated.tradingRole === "live-trade") {
      throw new IdentityError(
        409,
        "live_trading_role_forbidden",
        "Live-trading access cannot be granted before HTTPS rollout."
      );
    }
    if (
      validated.tradingRole &&
      validated.tradingRole !== "none" &&
      !this.hooks.allowNonAdminTrading
    ) {
      throw new IdentityError(
        409,
        "trading_ownership_pending",
        "Per-user trading is disabled until account and robot ownership migration is complete."
      );
    }
    const finishTransition =
      this.hooks.beginAuthorizationTransition(canonicalSubjectId);
    try {
      const result = await this.repository.mutateUserAsAdmin(
        canonicalActorId,
        canonicalSubjectId,
        {
          action,
          expectedAuthorizationRevision:
            validated.expectedAuthorizationRevision,
          reason: validated.reason,
          appRole: validated.appRole,
          tradingRole: validated.tradingRole,
          metadata,
          now: this.hooks.now()
        }
      );
      const updated = adminMutationUser(result);
      await this.hooks.notifySessionRevocation({
        userId: canonicalSubjectId,
        reason: lifecycleNoticeReason(action)
      });
      if (action === "disable") {
        await this.hooks.changeTradingAccess(canonicalSubjectId, "revoke");
      } else if (action === "permissions") {
        await this.hooks.changeTradingAccess(canonicalSubjectId, "revoke");
        if (this.hooks.userHasTradingAccess(updated.user)) {
          await this.hooks.changeTradingAccess(canonicalSubjectId, "restore");
        }
      } else if (this.hooks.userHasTradingAccess(updated.user)) {
        await this.hooks.changeTradingAccess(canonicalSubjectId, "restore");
      }
      const user = publicIdentityUser(updated.user);
      return {
        ...user,
        user,
        revokedSessionCount: updated.revokedSessionIdHashes.length,
        revokedCurrentSession:
          updated.revokedSessionIdHashes.includes(actor.sessionIdHash),
        cancelledJobCount: updated.cancelledJobCount
      };
    } finally {
      finishTransition();
    }
  }

  private async revokeSessions(
    actor: IdentityPrincipal,
    subjectId: string,
    input: {
      mode: "one" | "others" | "all";
      publicId?: string;
      reason: string;
      requireAdmin: boolean;
      eventType: string;
      noticeReason: SessionRevocationReason;
    },
    metadata: RequestMetadata
  ): Promise<SessionRevocationOutcome> {
    if (input.requireAdmin) requireAdmin(actor);
    if (input.mode === "one" && !isUuid(input.publicId)) {
      throw new IdentityError(404, "session_not_found", "Session not found.");
    }
    const canonicalActorId = canonicalUuid(actor.user.id);
    const canonicalSubjectId = canonicalUuid(subjectId);
    const finishTransition =
      this.hooks.beginAuthorizationTransition(canonicalSubjectId);
    try {
      const result = await this.repository.revokeSessions({
        actorUserId: canonicalActorId,
        subjectUserId: canonicalSubjectId,
        reason: validateReason(input.reason),
        mode: input.mode,
        publicId: input.publicId
          ? canonicalUuid(input.publicId)
          : undefined,
        exceptIdHash:
          input.mode === "others" ? actor.sessionIdHash : undefined,
        requireAdmin: input.requireAdmin,
        eventType: input.eventType,
        metadata,
        now: this.hooks.now()
      });
      const revoked = sessionRevocation(result);
      for (const sessionIdHash of revoked.revokedSessionIdHashes) {
        await this.hooks.notifySessionRevocation({
          userId: canonicalSubjectId,
          sessionIdHash,
          reason: input.noticeReason
        });
      }
      return {
        revokedSessionCount: revoked.revokedSessionIdHashes.length,
        revokedCurrentSession: revoked.revokedSessionIdHashes.includes(
          actor.sessionIdHash
        )
      };
    } finally {
      finishTransition();
    }
  }
}
