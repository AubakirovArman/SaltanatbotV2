import { roleAllows } from "../auth.js";
import { roleForBot } from "../trading/botRouteIdentity.js";
import type { ResumeAuthorization } from "../trading/engineResume.js";
import { tradingOwnerForBot } from "../trading/ownership.js";
import type { IdentityRuntime } from "./runtime.js";

/** Fail-closed boot policy: database users must still be active and authorized. */
export function createTradingResumeAuthorization(runtime: IdentityRuntime): ResumeAuthorization {
  const service = runtime.service;
  if (!service) return () => true;
  return async (config) => roleAllows(
    await service.tradingRoleForUser(tradingOwnerForBot(config)),
    roleForBot(config)
  );
}
