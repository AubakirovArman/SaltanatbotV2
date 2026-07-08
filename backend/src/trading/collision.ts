import type { BotConfig } from "./types.js";

/**
 * Pure cross-bot collision check (no DB / network imports so it stays unit
 * testable in isolation).
 *
 * Two LIVE bots on the same exchange+symbol fight each other: one's close
 * flattens the shared position and its cancelAll cancels the other's resting
 * orders. Paper bots are isolated sims and never collide.
 *
 * Returns the first RUNNING live bot in `running` that shares `config`'s
 * exchange+symbol (and isn't `config` itself), or `undefined` when clear.
 */
export function findLiveCollision(config: BotConfig, running: BotConfig[]): BotConfig | undefined {
  if (config.exchange === "paper") return undefined;
  return running.find(
    (other) =>
      other.id !== config.id &&
      other.exchange !== "paper" &&
      other.exchange === config.exchange &&
      other.symbol === config.symbol
  );
}
