import { updateBotRuntimeStatusForOwner, upsertBotForOwner } from "./store.js";
import { tradingOwnerForBot } from "./ownership.js";
import type { BotConfig, BotStatus } from "./types.js";

/** Runtime status is mutable and must not create a new immutable config revision. */
export function persistBotRuntimeStatus(
  config: BotConfig,
  status: BotStatus,
  updatedAt = Date.now()
): BotConfig {
  const persisted = config.revision
    ? updateBotRuntimeStatusForOwner(tradingOwnerForBot(config), {
        botId: config.id,
        expectedRevision: config.revision,
        status,
        updatedAt
      })
    : upsertBotForOwner(tradingOwnerForBot(config), { ...config, status, updatedAt });
  Object.assign(config, persisted);
  return config;
}
