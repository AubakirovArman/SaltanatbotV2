import type { Response } from "express";
import { isDatabaseAuthMode } from "../auth.js";
import { LEGACY_TRADING_OWNER_ID } from "./store.js";
import type { BotConfig } from "./types.js";

/** Resolve the tenant at the authenticated HTTP boundary.
 *
 * Database authentication must always provide a concrete user id. The shared
 * sentinel exists only for the legacy single-operator token mode and for
 * migrating pre-tenant SQLite rows.
 */
export function tradingOwnerFromResponse(response: Response): string {
  const ownerUserId = response.locals.authUserId;
  if (typeof ownerUserId === "string" && ownerUserId.trim()) return ownerUserId.trim();
  if (!isDatabaseAuthMode()) return LEGACY_TRADING_OWNER_ID;
  throw new Error("Authenticated trading owner is missing from the request context.");
}

export function tradingOwnerForBot(bot: Pick<BotConfig, "ownerUserId">): string {
  return bot.ownerUserId?.trim() || LEGACY_TRADING_OWNER_ID;
}

export function botBelongsToOwner(bot: Pick<BotConfig, "ownerUserId">, ownerUserId: string): boolean {
  return tradingOwnerForBot(bot) === ownerUserId;
}

export function tenantSettingKey(ownerUserId: string, key: string): string {
  return `owner:${ownerUserId}:${key}`;
}
