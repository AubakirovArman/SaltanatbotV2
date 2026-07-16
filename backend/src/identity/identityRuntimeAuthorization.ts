import { createHash, randomBytes } from "node:crypto";
import type { IdentityRepository } from "./repository.js";
import { IdentityError } from "./identityValidation.js";
import {
  effectiveTradingRole,
  publicIdentityUser,
  type IdentityPrincipal,
  type IdentityUser
} from "./types.js";

export interface ExecutionAuthorizationSnapshot {
  ownerUserId: string;
  authorizationRevision: number;
  authorizationEpoch: number;
  role: Exclude<ReturnType<typeof effectiveTradingRole>, undefined>;
}

export interface IdentityRuntimeAuthorizationHooks {
  wsTicketTtlMs: number;
  now(): Date;
  roleForUser(user: IdentityUser): ReturnType<typeof effectiveTradingRole>;
  authorizationTransitionPending(userId: string): boolean;
  authorizationEpoch(userId: string): number;
}

export class IdentityRuntimeAuthorizationService {
  constructor(
    private readonly repository: IdentityRepository,
    private readonly hooks: IdentityRuntimeAuthorizationHooks
  ) {}

  async issueWsTicket(
    principal: IdentityPrincipal
  ): Promise<{ ticket: string; expiresAt: Date }> {
    if (!principal.effectiveTradingRole) {
      throw new IdentityError(
        403,
        "trading_not_allowed",
        "Trading access has not been granted."
      );
    }
    const ticket = randomBytes(32).toString("base64url");
    const createdAt = this.hooks.now();
    const expiresAt = new Date(
      createdAt.getTime() + this.hooks.wsTicketTtlMs
    );
    await this.repository.createWsTicket({
      ticketHash: hashSecret(ticket),
      sessionIdHash: principal.sessionIdHash,
      userId: principal.user.id,
      expiresAt,
      createdAt
    });
    return { ticket, expiresAt };
  }

  async consumeWsTicket(
    ticket: string
  ): Promise<IdentityPrincipal | undefined> {
    const found = await this.repository.consumeWsTicket(
      hashSecret(ticket),
      this.hooks.now()
    );
    if (
      !found ||
      found.user.status !== "active" ||
      found.session.revokedAt ||
      found.session.expiresAt <= this.hooks.now() ||
      this.hooks.authorizationTransitionPending(found.user.id)
    ) {
      return undefined;
    }
    const role = this.hooks.roleForUser(found.user);
    if (!role) return undefined;
    return {
      user: publicIdentityUser(found.user),
      sessionIdHash: found.session.idHash,
      csrfHash: found.session.csrfHash,
      expiresAt: found.session.expiresAt,
      authorizationEpoch: this.hooks.authorizationEpoch(found.user.id),
      effectiveTradingRole: role
    };
  }

  async tradingRoleForUser(
    userId: string
  ): Promise<ReturnType<typeof effectiveTradingRole>> {
    const user = await this.repository.findUserById(userId);
    if (!user || user.status !== "active" || user.mustChangePassword) {
      return undefined;
    }
    return this.hooks.roleForUser(user);
  }

  async executionAuthorizationSnapshot(
    userId: string
  ): Promise<ExecutionAuthorizationSnapshot | undefined> {
    const user = await this.repository.findUserById(userId);
    if (
      !user ||
      user.status !== "active" ||
      user.mustChangePassword ||
      this.hooks.authorizationTransitionPending(userId)
    ) {
      return undefined;
    }
    const role = this.hooks.roleForUser(user);
    if (!role) return undefined;
    return {
      ownerUserId: user.id,
      authorizationRevision: user.authorizationRevision,
      authorizationEpoch: this.hooks.authorizationEpoch(user.id),
      role
    };
  }

  isExecutionAuthorizationCurrent(
    snapshot: ExecutionAuthorizationSnapshot
  ): boolean {
    return (
      !this.hooks.authorizationTransitionPending(snapshot.ownerUserId) &&
      this.hooks.authorizationEpoch(snapshot.ownerUserId) ===
        snapshot.authorizationEpoch
    );
  }

  async cleanup(
    limit = 1_000
  ): Promise<{ sessionsDeleted: number; wsTicketsDeleted: number }> {
    const now = this.hooks.now();
    const [sessionsDeleted, wsTicketsDeleted] = await Promise.all([
      this.repository.deleteExpiredSessions(now, limit),
      this.repository.deleteExpiredWsTickets(now, limit)
    ]);
    return { sessionsDeleted, wsTicketsDeleted };
  }
}

function hashSecret(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
