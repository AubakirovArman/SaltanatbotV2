import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { IdentityRepository } from "./repository.js";
import { hashPassword, passwordPolicyError, verifyPassword } from "./password.js";
import {
  effectiveTradingRole,
  publicIdentityUser,
  type AppRole,
  type IdentityPrincipal,
  type IdentityUser,
  type PublicIdentityUser,
  type SessionCredentials,
  type TradingRole,
  type UserStatus
} from "./types.js";

export interface IdentityServiceOptions {
  sessionTtlMs?: number;
  wsTicketTtlMs?: number;
  allowRegistration?: boolean;
  allowNonAdminTrading?: boolean;
  now?: () => Date;
}

export type TradingAccessChangeAction = "revoke" | "restore";
export type TradingAccessChangeHandler = (userId: string, action: TradingAccessChangeAction) => void | Promise<void>;

export type SessionRevocationReason =
  | "logout"
  | "password_changed"
  | "user_activated"
  | "user_disabled"
  | "permissions_changed";

export interface SessionRevocationNotice {
  userId: string;
  /** Present when only one session was revoked (normal logout). */
  sessionIdHash?: string;
  reason: SessionRevocationReason;
}

export type SessionRevocationHandler = (notice: SessionRevocationNotice) => void | Promise<void>;

export interface RequestMetadata {
  ipAddress?: string;
  userAgent?: string;
}

export class IdentityError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export class IdentityService {
  readonly allowRegistration: boolean;
  readonly allowNonAdminTrading: boolean;
  private readonly sessionTtlMs: number;
  private readonly wsTicketTtlMs: number;
  private readonly now: () => Date;
  private readonly fallbackPasswordHash = hashPassword("saltanatbotv2-invalid-account-timing-sentinel");
  private tradingAccessChangeHandler?: TradingAccessChangeHandler;
  private sessionRevocationHandler?: SessionRevocationHandler;

  constructor(readonly repository: IdentityRepository, options: IdentityServiceOptions = {}) {
    this.sessionTtlMs = boundedPositive(options.sessionTtlMs, 12 * 60 * 60_000, 15 * 60_000, 30 * 24 * 60 * 60_000);
    this.wsTicketTtlMs = boundedPositive(options.wsTicketTtlMs, 30_000, 5_000, 120_000);
    this.allowRegistration = options.allowRegistration ?? true;
    // Trading resources are owner-scoped. Deployments may still disable role
    // assignment explicitly during maintenance, but the safe default no longer
    // relies on the former shared-account escape hatch.
    this.allowNonAdminTrading = options.allowNonAdminTrading ?? true;
    this.now = options.now ?? (() => new Date());
  }

  setTradingAccessChangeHandler(handler: TradingAccessChangeHandler | undefined): void {
    this.tradingAccessChangeHandler = handler;
  }

  setSessionRevocationHandler(handler: SessionRevocationHandler | undefined): void {
    this.sessionRevocationHandler = handler;
  }

  async register(login: string, password: string, metadata: RequestMetadata = {}): Promise<PublicIdentityUser> {
    if (!this.allowRegistration) throw new IdentityError(403, "registration_disabled", "Registration is disabled by the administrator.");
    const validated = validateLogin(login);
    const passwordError = passwordPolicyError(password, validated.login);
    if (passwordError) throw new IdentityError(400, "password_policy", passwordError);
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
      createdAt: now,
      updatedAt: now
    };
    if (!(await this.repository.createUser(user))) throw new IdentityError(409, "login_exists", "This login is already registered.");
    await this.audit("user.registered", metadata, undefined, user.id);
    return publicIdentityUser(user);
  }

  async bootstrapAdmin(login: string, password: string): Promise<PublicIdentityUser> {
    if ((await this.repository.countAdmins()) > 0) throw new IdentityError(409, "admin_exists", "An administrator already exists.");
    const validated = validateLogin(login);
    const passwordError = passwordPolicyError(password, validated.login);
    if (passwordError) throw new IdentityError(400, "password_policy", passwordError);
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
      approvedAt: now,
      createdAt: now,
      updatedAt: now
    };
    if (!(await this.repository.createUser(user))) throw new IdentityError(409, "login_exists", "This login is already registered.");
    await this.audit("admin.bootstrapped", {}, user.id, user.id);
    return publicIdentityUser(user);
  }

  async login(login: string, password: string, metadata: RequestMetadata = {}): Promise<SessionCredentials> {
    const normalized = normalizeLogin(login);
    const user = normalized ? await this.repository.findUserByLogin(normalized) : undefined;
    const passwordMatches = await verifyPassword(password, user?.passwordHash ?? await this.fallbackPasswordHash);
    if (!user || !passwordMatches) {
      await this.audit("login.failed", metadata, undefined, user?.id, { loginNormalized: normalized || "invalid" });
      throw new IdentityError(401, "invalid_credentials", "Invalid login or password.");
    }
    if (user.status === "pending") throw new IdentityError(403, "pending_approval", "The account is waiting for administrator approval.");
    if (user.status !== "active") throw new IdentityError(403, "account_disabled", "The account is disabled.");
    const now = this.now();
    const current = (await this.repository.updateUser(user.id, { lastLoginAt: now, updatedAt: now })) ?? user;
    const credentials = await this.createSession(current, metadata);
    await this.audit("login.succeeded", metadata, user.id, user.id);
    return credentials;
  }

  async authenticate(sessionToken: string | undefined): Promise<IdentityPrincipal | undefined> {
    if (!sessionToken) return undefined;
    const idHash = secretHash(sessionToken);
    const found = await this.repository.findSession(idHash);
    const now = this.now();
    if (!found || found.session.revokedAt || found.session.expiresAt <= now || found.user.status !== "active") return undefined;
    if (now.getTime() - found.session.lastSeenAt.getTime() >= 5 * 60_000) void this.repository.touchSession(idHash, now);
    return {
      user: publicIdentityUser(found.user),
      sessionIdHash: idHash,
      csrfHash: found.session.csrfHash,
      expiresAt: found.session.expiresAt,
      effectiveTradingRole: this.roleForUser(found.user)
    };
  }

  async rotateCsrf(principal: IdentityPrincipal): Promise<string> {
    const token = opaqueSecret();
    await this.repository.updateSessionCsrf(principal.sessionIdHash, secretHash(token), this.now());
    return token;
  }

  verifyCsrf(principal: IdentityPrincipal, candidate: string | undefined): boolean {
    if (!candidate) return false;
    return constantTimeEqual(secretHash(candidate), principal.csrfHash);
  }

  async logout(principal: IdentityPrincipal | undefined, metadata: RequestMetadata = {}): Promise<void> {
    if (!principal) return;
    const now = this.now();
    await this.repository.revokeSession(principal.sessionIdHash, now);
    await this.sessionRevocationHandler?.({
      userId: principal.user.id,
      sessionIdHash: principal.sessionIdHash,
      reason: "logout"
    });
    await this.audit("logout", metadata, principal.user.id, principal.user.id);
  }

  async changePassword(principal: IdentityPrincipal, currentPassword: string, newPassword: string, metadata: RequestMetadata = {}): Promise<void> {
    const user = await this.repository.findUserById(principal.user.id);
    if (!user || !(await verifyPassword(currentPassword, user.passwordHash))) {
      throw new IdentityError(401, "invalid_current_password", "The current password is incorrect.");
    }
    const passwordError = passwordPolicyError(newPassword, user.login);
    if (passwordError) throw new IdentityError(400, "password_policy", passwordError);
    if (await verifyPassword(newPassword, user.passwordHash)) throw new IdentityError(400, "password_reused", "Choose a different password.");
    const now = this.now();
    const updated = await this.repository.updateUser(user.id, {
      passwordHash: await hashPassword(newPassword),
      mustChangePassword: false,
      updatedAt: now
    });
    await this.repository.revokeUserSessions(user.id, now);
    await this.sessionRevocationHandler?.({ userId: user.id, reason: "password_changed" });
    if (updated && this.userHasTradingAccess(updated)) await this.tradingAccessChangeHandler?.(user.id, "restore");
    await this.audit("password.changed", metadata, user.id, user.id);
  }

  async listUsers(actor: IdentityPrincipal, status?: UserStatus): Promise<PublicIdentityUser[]> {
    requireAdmin(actor);
    return (await this.repository.listUsers(status)).map(publicIdentityUser);
  }

  async activateUser(actor: IdentityPrincipal, subjectId: string, metadata: RequestMetadata = {}): Promise<PublicIdentityUser> {
    requireAdmin(actor);
    const now = this.now();
    const user = await this.repository.updateUser(subjectId, {
      status: "active",
      approvedBy: actor.user.id,
      approvedAt: now,
      updatedAt: now
    });
    if (!user) throw new IdentityError(404, "user_not_found", "User not found.");
    await this.repository.revokeUserSessions(subjectId, now);
    await this.sessionRevocationHandler?.({ userId: subjectId, reason: "user_activated" });
    if (this.userHasTradingAccess(user)) await this.tradingAccessChangeHandler?.(subjectId, "restore");
    await this.audit("user.activated", metadata, actor.user.id, subjectId);
    return publicIdentityUser(user);
  }

  async disableUser(actor: IdentityPrincipal, subjectId: string, metadata: RequestMetadata = {}): Promise<PublicIdentityUser> {
    requireAdmin(actor);
    if (actor.user.id === subjectId) throw new IdentityError(409, "self_disable", "You cannot disable your own account.");
    const now = this.now();
    const user = await this.repository.updateUser(subjectId, { status: "disabled", updatedAt: now });
    if (!user) throw new IdentityError(404, "user_not_found", "User not found.");
    await this.repository.revokeUserSessions(subjectId, now);
    await this.sessionRevocationHandler?.({ userId: subjectId, reason: "user_disabled" });
    await this.tradingAccessChangeHandler?.(subjectId, "revoke");
    await this.audit("user.disabled", metadata, actor.user.id, subjectId);
    return publicIdentityUser(user);
  }

  async updatePermissions(
    actor: IdentityPrincipal,
    subjectId: string,
    input: { appRole?: AppRole; tradingRole?: TradingRole },
    metadata: RequestMetadata = {}
  ): Promise<PublicIdentityUser> {
    requireAdmin(actor);
    if (input.tradingRole && input.tradingRole !== "none" && !this.allowNonAdminTrading) {
      throw new IdentityError(409, "trading_ownership_pending", "Per-user trading is disabled until account and robot ownership migration is complete.");
    }
    const existing = await this.repository.findUserById(subjectId);
    if (!existing) throw new IdentityError(404, "user_not_found", "User not found.");
    if (actor.user.id === subjectId && input.appRole === "user") throw new IdentityError(409, "self_demote", "You cannot remove your own administrator role.");
    const now = this.now();
    const user = await this.repository.updateUser(subjectId, { ...input, updatedAt: now });
    if (!user) throw new IdentityError(404, "user_not_found", "User not found.");
    await this.repository.revokeUserSessions(subjectId, now);
    await this.sessionRevocationHandler?.({ userId: subjectId, reason: "permissions_changed" });
    // Every permission mutation first stops/disarms the old authority. A grant
    // re-opens starts only after that revocation has completed.
    await this.tradingAccessChangeHandler?.(subjectId, "revoke");
    if (this.userHasTradingAccess(user)) await this.tradingAccessChangeHandler?.(subjectId, "restore");
    await this.audit("user.permissions_changed", metadata, actor.user.id, subjectId, input);
    return publicIdentityUser(user);
  }

  async issueWsTicket(principal: IdentityPrincipal): Promise<{ ticket: string; expiresAt: Date }> {
    if (!principal.effectiveTradingRole) throw new IdentityError(403, "trading_not_allowed", "Trading access has not been granted.");
    const ticket = opaqueSecret();
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + this.wsTicketTtlMs);
    await this.repository.createWsTicket({
      ticketHash: secretHash(ticket),
      sessionIdHash: principal.sessionIdHash,
      userId: principal.user.id,
      expiresAt,
      createdAt
    });
    return { ticket, expiresAt };
  }

  async consumeWsTicket(ticket: string): Promise<IdentityPrincipal | undefined> {
    const found = await this.repository.consumeWsTicket(secretHash(ticket), this.now());
    if (!found || found.user.status !== "active" || found.session.revokedAt || found.session.expiresAt <= this.now()) return undefined;
    const role = this.roleForUser(found.user);
    if (!role) return undefined;
    return {
      user: publicIdentityUser(found.user),
      sessionIdHash: found.session.idHash,
      csrfHash: found.session.csrfHash,
      expiresAt: found.session.expiresAt,
      effectiveTradingRole: role
    };
  }

  /** Current durable role used by crash-recovery before any browser session exists. */
  async tradingRoleForUser(userId: string): Promise<ReturnType<typeof effectiveTradingRole>> {
    const user = await this.repository.findUserById(userId);
    if (!user || user.status !== "active" || user.mustChangePassword) return undefined;
    return this.roleForUser(user);
  }

  async cleanup(): Promise<void> {
    const now = this.now();
    await Promise.all([this.repository.deleteExpiredSessions(now), this.repository.deleteExpiredWsTickets(now)]);
  }

  private async createSession(user: IdentityUser, metadata: RequestMetadata): Promise<SessionCredentials> {
    const sessionToken = opaqueSecret();
    const csrfToken = opaqueSecret();
    const now = this.now();
    const expiresAt = new Date(now.getTime() + this.sessionTtlMs);
    await this.repository.createSession({
      idHash: secretHash(sessionToken),
      userId: user.id,
      csrfHash: secretHash(csrfToken),
      expiresAt,
      lastSeenAt: now,
      createdAt: now,
      userAgent: metadata.userAgent,
      ipAddress: metadata.ipAddress
    });
    return { sessionToken, csrfToken, expiresAt, user: publicIdentityUser(user) };
  }

  private roleForUser(user: IdentityUser): ReturnType<typeof effectiveTradingRole> {
    if (user.appRole === "admin") return "admin";
    return this.allowNonAdminTrading ? effectiveTradingRole(user) : undefined;
  }

  private userHasTradingAccess(user: IdentityUser): boolean {
    if (user.status !== "active" || user.mustChangePassword) return false;
    const role = this.roleForUser(user);
    // Restoring engine starts is stronger than allowing read-only inspection.
    // Keep direct control planes (for example Telegram) suspended unless the
    // durable role may actually start at least a paper bot.
    return role === "paper-trade" || role === "live-trade" || role === "admin";
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
      ipAddress: metadata.ipAddress,
      metadata: details,
      createdAt: this.now()
    });
  }
}

export function normalizeLogin(value: string): string {
  return value.trim().normalize("NFKC").toLocaleLowerCase("en-US");
}

function validateLogin(value: string): { login: string; normalized: string } {
  const login = value.trim().normalize("NFKC");
  const normalized = normalizeLogin(login);
  if (login.length < 3 || login.length > 64 || !/^[\p{L}\p{N}_.@-]+$/u.test(login)) {
    throw new IdentityError(400, "invalid_login", "Login must contain 3–64 letters, digits, dots, dashes, underscores or @.");
  }
  return { login, normalized };
}

function requireAdmin(principal: IdentityPrincipal): void {
  if (principal.user.appRole !== "admin") throw new IdentityError(403, "admin_required", "Administrator access is required.");
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
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function boundedPositive(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, Math.floor(value!))) : fallback;
}
