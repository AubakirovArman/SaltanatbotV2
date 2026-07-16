import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { IdentityControlPlaneService } from "./identityControlPlaneService.js";
import {
  IdentityRuntimeAuthorizationService,
  type ExecutionAuthorizationSnapshot
} from "./identityRuntimeAuthorization.js";
import type {
  AdminLifecycleMutationInput,
  AdminUserMutationOutcome,
  PublicPage,
  RequestMetadata,
  SessionRevocationHandler,
  SessionRevocationOutcome,
  TradingAccessChangeHandler
} from "./identityServiceTypes.js";
import {
  IdentityError,
  normalizeLogin,
  validateLogin
} from "./identityValidation.js";
import { hashPassword, passwordPolicyError, verifyPassword } from "./password.js";
import type { IdentityRepository, PageRequest } from "./repository.js";
import {
  effectiveTradingRole,
  publicIdentityUser,
  type AppRole,
  type IdentityPrincipal,
  type IdentityUser,
  type PublicIdentityAuditEvent,
  type PublicIdentitySession,
  type PublicIdentityUser,
  type SessionCredentials,
  type TradingRole,
  type UserStatus
} from "./types.js";

export { IdentityError, normalizeLogin };
export type {
  AdminLifecycleMutationInput,
  AdminUserMutationOutcome,
  PublicPage,
  PublicSessionPage,
  RequestMetadata,
  SessionRevocationHandler,
  SessionRevocationNotice,
  SessionRevocationOutcome,
  SessionRevocationReason,
  TradingAccessChangeAction,
  TradingAccessChangeHandler
} from "./identityServiceTypes.js";
export type { ExecutionAuthorizationSnapshot } from "./identityRuntimeAuthorization.js";

export interface IdentityServiceOptions {
  sessionTtlMs?: number;
  wsTicketTtlMs?: number;
  allowRegistration?: boolean;
  allowNonAdminTrading?: boolean;
  now?: () => Date;
}

export class IdentityService {
  readonly allowRegistration: boolean;
  readonly allowNonAdminTrading: boolean;
  readonly recoverAdminPassword: IdentityControlPlaneService["recoverAdminPassword"];
  readonly listUsers: IdentityControlPlaneService["listUsers"];
  readonly listUsersPage: IdentityControlPlaneService["listUsersPage"];
  readonly activateUser: IdentityControlPlaneService["activateUser"];
  readonly reactivateUser: IdentityControlPlaneService["reactivateUser"];
  readonly disableUser: IdentityControlPlaneService["disableUser"];
  readonly updatePermissions: IdentityControlPlaneService["updatePermissions"];
  readonly listOwnSessions: IdentityControlPlaneService["listOwnSessions"];
  readonly listAdminSessions: IdentityControlPlaneService["listAdminSessions"];
  readonly revokeOwnSession: IdentityControlPlaneService["revokeOwnSession"];
  readonly revokeOtherSessions: IdentityControlPlaneService["revokeOtherSessions"];
  readonly revokeAllOwnSessions: IdentityControlPlaneService["revokeAllOwnSessions"];
  readonly revokeAdminSession: IdentityControlPlaneService["revokeAdminSession"];
  readonly revokeAllUserSessionsAdmin: IdentityControlPlaneService["revokeAllUserSessionsAdmin"];
  readonly listAuditEvents: IdentityControlPlaneService["listAuditEvents"];
  readonly issueWsTicket: IdentityRuntimeAuthorizationService["issueWsTicket"];
  readonly consumeWsTicket: IdentityRuntimeAuthorizationService["consumeWsTicket"];
  readonly tradingRoleForUser: IdentityRuntimeAuthorizationService["tradingRoleForUser"];
  readonly executionAuthorizationSnapshot: IdentityRuntimeAuthorizationService["executionAuthorizationSnapshot"];
  readonly isExecutionAuthorizationCurrent: IdentityRuntimeAuthorizationService["isExecutionAuthorizationCurrent"];
  readonly cleanup: IdentityRuntimeAuthorizationService["cleanup"];
  private readonly sessionTtlMs: number;
  private readonly wsTicketTtlMs: number;
  private readonly now: () => Date;
  private readonly fallbackPasswordHash = hashPassword(
    "saltanatbotv2-invalid-account-timing-sentinel"
  );
  private readonly authorizationEpochs = new Map<string, number>();
  private readonly authorizationTransitions = new Map<string, number>();
  private readonly controlPlane: IdentityControlPlaneService;
  private readonly runtimeAuthorization: IdentityRuntimeAuthorizationService;
  private tradingAccessChangeHandler?: TradingAccessChangeHandler;
  private sessionRevocationHandler?: SessionRevocationHandler;

  constructor(
    readonly repository: IdentityRepository,
    options: IdentityServiceOptions = {}
  ) {
    this.sessionTtlMs = boundedPositive(
      options.sessionTtlMs,
      12 * 60 * 60_000,
      15 * 60_000,
      30 * 24 * 60 * 60_000
    );
    this.wsTicketTtlMs = boundedPositive(
      options.wsTicketTtlMs,
      30_000,
      5_000,
      120_000
    );
    this.allowRegistration = options.allowRegistration ?? true;
    this.allowNonAdminTrading = options.allowNonAdminTrading ?? true;
    this.now = options.now ?? (() => new Date());
    this.controlPlane = new IdentityControlPlaneService(repository, {
      allowNonAdminTrading: this.allowNonAdminTrading,
      now: () => this.now(),
      beginAuthorizationTransition: (userId) =>
        this.beginAuthorizationTransition(userId),
      notifySessionRevocation: async (notice) => {
        await this.sessionRevocationHandler?.(notice);
      },
      changeTradingAccess: async (userId, action) => {
        await this.tradingAccessChangeHandler?.(userId, action);
      },
      userHasTradingAccess: (user) => this.userHasTradingAccess(user)
    });
    this.runtimeAuthorization = new IdentityRuntimeAuthorizationService(
      repository,
      {
        wsTicketTtlMs: this.wsTicketTtlMs,
        now: () => this.now(),
        roleForUser: (user) => this.roleForUser(user),
        authorizationTransitionPending: (userId) =>
          this.authorizationTransitionPending(userId),
        authorizationEpoch: (userId) => this.authorizationEpoch(userId)
      }
    );
    this.recoverAdminPassword =
      this.controlPlane.recoverAdminPassword.bind(this.controlPlane);
    this.listUsers = this.controlPlane.listUsers.bind(this.controlPlane);
    this.listUsersPage = this.controlPlane.listUsersPage.bind(this.controlPlane);
    this.activateUser = this.controlPlane.activateUser.bind(this.controlPlane);
    this.reactivateUser =
      this.controlPlane.reactivateUser.bind(this.controlPlane);
    this.disableUser = this.controlPlane.disableUser.bind(this.controlPlane);
    this.updatePermissions =
      this.controlPlane.updatePermissions.bind(this.controlPlane);
    this.listOwnSessions =
      this.controlPlane.listOwnSessions.bind(this.controlPlane);
    this.listAdminSessions =
      this.controlPlane.listAdminSessions.bind(this.controlPlane);
    this.revokeOwnSession =
      this.controlPlane.revokeOwnSession.bind(this.controlPlane);
    this.revokeOtherSessions =
      this.controlPlane.revokeOtherSessions.bind(this.controlPlane);
    this.revokeAllOwnSessions =
      this.controlPlane.revokeAllOwnSessions.bind(this.controlPlane);
    this.revokeAdminSession =
      this.controlPlane.revokeAdminSession.bind(this.controlPlane);
    this.revokeAllUserSessionsAdmin =
      this.controlPlane.revokeAllUserSessionsAdmin.bind(this.controlPlane);
    this.listAuditEvents =
      this.controlPlane.listAuditEvents.bind(this.controlPlane);
    this.issueWsTicket =
      this.runtimeAuthorization.issueWsTicket.bind(this.runtimeAuthorization);
    this.consumeWsTicket =
      this.runtimeAuthorization.consumeWsTicket.bind(this.runtimeAuthorization);
    this.tradingRoleForUser =
      this.runtimeAuthorization.tradingRoleForUser.bind(
        this.runtimeAuthorization
      );
    this.executionAuthorizationSnapshot =
      this.runtimeAuthorization.executionAuthorizationSnapshot.bind(
        this.runtimeAuthorization
      );
    this.isExecutionAuthorizationCurrent =
      this.runtimeAuthorization.isExecutionAuthorizationCurrent.bind(
        this.runtimeAuthorization
      );
    this.cleanup = this.runtimeAuthorization.cleanup.bind(
      this.runtimeAuthorization
    );
  }

  setTradingAccessChangeHandler(
    handler: TradingAccessChangeHandler | undefined
  ): void {
    this.tradingAccessChangeHandler = handler;
  }

  setSessionRevocationHandler(
    handler: SessionRevocationHandler | undefined
  ): void {
    this.sessionRevocationHandler = handler;
  }

  async register(
    login: string,
    password: string,
    metadata: RequestMetadata = {}
  ): Promise<PublicIdentityUser> {
    if (!this.allowRegistration) {
      throw new IdentityError(
        403,
        "registration_disabled",
        "Registration is disabled by the administrator."
      );
    }
    const validated = validateLogin(login);
    const passwordError = passwordPolicyError(password, validated.login);
    if (passwordError) {
      throw new IdentityError(400, "password_policy", passwordError);
    }
    const now = this.now();
    const user: IdentityUser = {
      id: randomUUID(),
      login: validated.login,
      loginNormalized: validated.normalized,
      passwordHash: await hashPassword(password),
      status: "pending",
      appRole: "user",
      tradingRole: "none",
      mustChangePassword: false,
      authorizationRevision: 1,
      createdAt: now,
      updatedAt: now
    };
    if (!(await this.repository.createUser(user))) {
      throw new IdentityError(
        409,
        "login_exists",
        "This login is already registered."
      );
    }
    await this.audit("user.registered", metadata, undefined, user.id);
    return publicIdentityUser(user);
  }

  async bootstrapAdmin(
    login: string,
    password: string
  ): Promise<PublicIdentityUser> {
    const validated = validateLogin(login);
    const passwordError = passwordPolicyError(password, validated.login);
    if (passwordError) {
      throw new IdentityError(400, "password_policy", passwordError);
    }
    const now = this.now();
    const user: IdentityUser = {
      id: randomUUID(),
      login: validated.login,
      loginNormalized: validated.normalized,
      passwordHash: await hashPassword(password),
      status: "active",
      appRole: "admin",
      tradingRole: "none",
      mustChangePassword: true,
      authorizationRevision: 1,
      approvedAt: now,
      createdAt: now,
      updatedAt: now
    };
    const created = await this.repository.createFirstAdmin(user);
    if (created === "admin_exists") {
      throw new IdentityError(
        409,
        "admin_exists",
        "An administrator already exists."
      );
    }
    if (created === "login_exists") {
      throw new IdentityError(
        409,
        "login_exists",
        "This login is already registered."
      );
    }
    await this.audit("admin.bootstrapped", {}, user.id, user.id);
    return publicIdentityUser(user);
  }

  async login(
    login: string,
    password: string,
    metadata: RequestMetadata = {}
  ): Promise<SessionCredentials> {
    const normalized = normalizeLogin(login);
    const user = normalized
      ? await this.repository.findUserByLogin(normalized)
      : undefined;
    const passwordMatches = await verifyPassword(
      password,
      user?.passwordHash ?? (await this.fallbackPasswordHash)
    );
    if (!user || !passwordMatches) {
      await this.audit("login.failed", metadata, undefined, user?.id, {
        loginNormalized: normalized || "invalid"
      });
      throw new IdentityError(
        401,
        "invalid_credentials",
        "Invalid login or password."
      );
    }
    if (user.status === "pending") {
      throw new IdentityError(
        403,
        "pending_approval",
        "The account is waiting for administrator approval."
      );
    }
    if (user.status !== "active") {
      throw new IdentityError(
        403,
        "account_disabled",
        "The account is disabled."
      );
    }
    const now = this.now();
    const current =
      (await this.repository.updateUser(user.id, {
        lastLoginAt: now,
        updatedAt: now
      })) ?? user;
    const credentials = await this.createSession(current, metadata);
    await this.audit("login.succeeded", metadata, user.id, user.id);
    return credentials;
  }

  async authenticate(
    sessionToken: string | undefined
  ): Promise<IdentityPrincipal | undefined> {
    if (!sessionToken) return undefined;
    return this.principalForSessionHash(secretHash(sessionToken));
  }

  async revalidatePrincipal(
    principal: IdentityPrincipal
  ): Promise<IdentityPrincipal | undefined> {
    const current = await this.principalForSessionHash(
      principal.sessionIdHash
    );
    return current?.user.id === principal.user.id ? current : undefined;
  }

  isAuthorizationCurrent(principal: IdentityPrincipal): boolean {
    return (
      !this.authorizationTransitionPending(principal.user.id) &&
      principal.authorizationEpoch ===
        this.authorizationEpoch(principal.user.id) &&
      principal.expiresAt > this.now()
    );
  }

  private async principalForSessionHash(
    idHash: string
  ): Promise<IdentityPrincipal | undefined> {
    const found = await this.repository.findSession(idHash);
    const now = this.now();
    if (
      !found ||
      found.session.revokedAt ||
      found.session.expiresAt <= now ||
      found.user.status !== "active" ||
      this.authorizationTransitionPending(found.user.id)
    ) {
      return undefined;
    }
    if (now.getTime() - found.session.lastSeenAt.getTime() >= 5 * 60_000) {
      void this.repository.touchSession(idHash, now);
    }
    return {
      user: publicIdentityUser(found.user),
      sessionIdHash: idHash,
      csrfHash: found.session.csrfHash,
      expiresAt: found.session.expiresAt,
      authorizationEpoch: this.authorizationEpoch(found.user.id),
      effectiveTradingRole: this.roleForUser(found.user)
    };
  }

  async rotateCsrf(principal: IdentityPrincipal): Promise<string> {
    const token = opaqueSecret();
    await this.repository.updateSessionCsrf(
      principal.sessionIdHash,
      secretHash(token),
      this.now()
    );
    return token;
  }

  verifyCsrf(
    principal: IdentityPrincipal,
    candidate: string | undefined
  ): boolean {
    return !!candidate && constantTimeEqual(secretHash(candidate), principal.csrfHash);
  }

  async logout(
    principal: IdentityPrincipal | undefined,
    metadata: RequestMetadata = {}
  ): Promise<void> {
    if (!principal) return;
    const finishTransition = this.beginAuthorizationTransition(
      principal.user.id
    );
    try {
      await this.repository.revokeSession(
        principal.sessionIdHash,
        this.now()
      );
      await this.sessionRevocationHandler?.({
        userId: principal.user.id,
        sessionIdHash: principal.sessionIdHash,
        reason: "logout"
      });
      await this.audit(
        "logout",
        metadata,
        principal.user.id,
        principal.user.id
      );
    } finally {
      finishTransition();
    }
  }

  async changePassword(
    principal: IdentityPrincipal,
    currentPassword: string,
    newPassword: string,
    metadata: RequestMetadata = {}
  ): Promise<void> {
    const user = await this.repository.findUserById(principal.user.id);
    if (!user || !(await verifyPassword(currentPassword, user.passwordHash))) {
      throw new IdentityError(
        401,
        "invalid_current_password",
        "The current password is incorrect."
      );
    }
    const passwordError = passwordPolicyError(newPassword, user.login);
    if (passwordError) {
      throw new IdentityError(400, "password_policy", passwordError);
    }
    if (await verifyPassword(newPassword, user.passwordHash)) {
      throw new IdentityError(
        400,
        "password_reused",
        "Choose a different password."
      );
    }
    const now = this.now();
    const finishTransition = this.beginAuthorizationTransition(user.id);
    try {
      const updated = await this.repository.updateUser(user.id, {
        passwordHash: await hashPassword(newPassword),
        mustChangePassword: false,
        updatedAt: now
      });
      await this.repository.revokeUserSessions(user.id, now);
      await this.sessionRevocationHandler?.({
        userId: user.id,
        reason: "password_changed"
      });
      await this.tradingAccessChangeHandler?.(user.id, "revoke");
      if (updated && this.userHasTradingAccess(updated)) {
        await this.tradingAccessChangeHandler?.(user.id, "restore");
      }
      await this.audit("password.changed", metadata, user.id, user.id);
    } finally {
      finishTransition();
    }
  }

  private async createSession(
    user: IdentityUser,
    metadata: RequestMetadata
  ): Promise<SessionCredentials> {
    const sessionToken = opaqueSecret();
    const csrfToken = opaqueSecret();
    const now = this.now();
    const expiresAt = new Date(now.getTime() + this.sessionTtlMs);
    await this.repository.createSession({
      publicId: randomUUID(),
      idHash: secretHash(sessionToken),
      userId: user.id,
      csrfHash: secretHash(csrfToken),
      expiresAt,
      lastSeenAt: now,
      createdAt: now,
      userAgent: metadata.userAgent,
      ipAddress: metadata.ipAddress
    });
    return {
      sessionToken,
      csrfToken,
      expiresAt,
      user: publicIdentityUser(user)
    };
  }

  private roleForUser(
    user: IdentityUser
  ): ReturnType<typeof effectiveTradingRole> {
    if (user.appRole === "admin") return "admin";
    return this.allowNonAdminTrading ? effectiveTradingRole(user) : undefined;
  }

  private userHasTradingAccess(user: IdentityUser): boolean {
    if (user.status !== "active" || user.mustChangePassword) return false;
    const role = this.roleForUser(user);
    return (
      role === "paper-trade" || role === "live-trade" || role === "admin"
    );
  }

  private authorizationEpoch(userId: string): number {
    return this.authorizationEpochs.get(userId) ?? 0;
  }

  private bumpAuthorizationEpoch(userId: string): void {
    this.authorizationEpochs.set(userId, this.authorizationEpoch(userId) + 1);
  }

  private beginAuthorizationTransition(userId: string): () => void {
    this.bumpAuthorizationEpoch(userId);
    this.authorizationTransitions.set(
      userId,
      (this.authorizationTransitions.get(userId) ?? 0) + 1
    );
    let finished = false;
    return () => {
      if (finished) return;
      finished = true;
      const remaining = (this.authorizationTransitions.get(userId) ?? 1) - 1;
      if (remaining > 0) this.authorizationTransitions.set(userId, remaining);
      else this.authorizationTransitions.delete(userId);
    };
  }

  private authorizationTransitionPending(userId: string): boolean {
    return (this.authorizationTransitions.get(userId) ?? 0) > 0;
  }

  private async audit(
    eventType: string,
    metadata: RequestMetadata,
    actorUserId?: string,
    subjectUserId?: string,
    details?: Record<string, unknown>
  ): Promise<void> {
    await this.repository.appendAuditEvent({
      eventType,
      actorUserId,
      subjectUserId,
      requestId: metadata.requestId,
      ipAddress: metadata.ipAddress,
      userAgent: metadata.userAgent,
      metadata: details,
      createdAt: this.now()
    });
  }
}

function opaqueSecret(): string {
  return randomBytes(32).toString("base64url");
}

export function secretHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function boundedPositive(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  return Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, Math.floor(value!)))
    : fallback;
}
