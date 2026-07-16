import { roleAllows } from "../auth.js";
import { roleForBot } from "../trading/botRouteIdentity.js";
import type { ResumeAuthorization } from "../trading/engineResume.js";
import { tradingOwnerForBot } from "../trading/ownership.js";
import type { IdentityRuntime } from "./runtime.js";
import { getRuntimePolicy, type RuntimePolicy } from "../runtimeProfile.js";

/** Fail-closed boot policy: database users must still be active and authorized. */
export function createTradingResumeAuthorization(runtime: IdentityRuntime, policy: RuntimePolicy = getRuntimePolicy()): ResumeAuthorization {
  const service = runtime.service;
  return async (config) => {
    if (config.exchange !== "paper" && !policy.liveBotConfigsAllowed) return false;
    if (!service) return true;
    return roleAllows(
      await service.tradingRoleForUser(tradingOwnerForBot(config)),
      roleForBot(config)
    );
  };
}
