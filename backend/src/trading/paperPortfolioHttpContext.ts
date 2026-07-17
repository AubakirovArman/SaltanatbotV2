import { createHash } from "node:crypto";
import type { Request, Response } from "express";
import type { IdentityPrincipal } from "../identity/types.js";
import type { PaperPortfolioCommandPrincipal } from "./paperPortfolioGatewayTypes.js";
import { PaperPortfolioHttpError } from "./paperPortfolioGatewayTypes.js";

export function assertExpectedPaperOwner(request: Request, ownerUserId: string): void {
  const expected = request.header("X-SBV2-Expected-User")?.trim();
  if (!expected || expected !== ownerUserId) {
    throw new PaperPortfolioHttpError(
      409,
      "owner_context_mismatch",
      "The authenticated user context changed. Refresh before continuing."
    );
  }
}

export function paperIdempotencyKey(request: Request): string {
  const value = request.header("Idempotency-Key")?.trim();
  if (!value || value.length > 160 || hasControlCharacter(value)) {
    throw new PaperPortfolioHttpError(
      400,
      "idempotency_key_required",
      "A valid Idempotency-Key header is required."
    );
  }
  return value;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

export function paperCommandPrincipal(response: Response, ownerUserId: string): PaperPortfolioCommandPrincipal {
  const principal = response.locals.authPrincipal as IdentityPrincipal | undefined;
  if (principal) {
    return {
      ownerUserId,
      actorUserId: principal.user.id,
      sessionIdHash: principal.sessionIdHash,
      authorizationRevision: principal.user.authorizationRevision,
      authorizationEpoch: principal.authorizationEpoch
    };
  }
  return {
    ownerUserId,
    actorUserId: null,
    sessionIdHash: createHash("sha256").update(`legacy-paper-session\0${ownerUserId}`).digest("hex"),
    authorizationRevision: 1,
    authorizationEpoch: 1
  };
}
