import { isDatabaseAuthMode } from "../auth.js";
import { assertPaperBotActiveAllocationForOwner } from "./store.js";
import { tradingOwnerForBot } from "./ownership.js";
import type { BotConfig } from "./types.js";

/** Database-auth paper execution may only use an exact active R4 reservation. */
export function assertBotExecutionBinding(config: BotConfig): void {
  if (config.exchange === "paper" && isDatabaseAuthMode()) {
    assertPaperBotActiveAllocationForOwner(tradingOwnerForBot(config), config);
  }
}
