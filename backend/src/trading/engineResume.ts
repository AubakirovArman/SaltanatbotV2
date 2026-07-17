import { listBots } from "./store.js";
import { persistBotRuntimeStatus } from "./botRuntimePersistence.js";
import type { BotConfig } from "./types.js";
import { tradingOwnerForBot } from "./ownership.js";

export type ResumeAuthorization = (config: BotConfig) => boolean | Promise<boolean>;

interface ResumeDependencies {
  authorize: ResumeAuthorization;
  isRunning(id: string): boolean;
  start(config: BotConfig): Promise<void>;
  log(id: string, level: "info" | "warn" | "error", message: string): void;
}

/** Resume only persisted runtimes whose current owner permission still allows it. */
export async function resumePersistedBots(deps: ResumeDependencies): Promise<void> {
  for (const config of listBots()) {
    if (config.status !== "running" || deps.isRunning(config.id)) continue;
    try {
      if (!(await deps.authorize(config))) {
        persistBotRuntimeStatus(config, "stopped");
        deps.log(config.id, "warn", "Automatic resume blocked because the owner no longer has the required trading permission");
        continue;
      }
      await deps.start(config);
      deps.log(config.id, "info", "Resumed after restart");
    } catch (error) {
      deps.log(config.id, "error", `Resume failed: ${error instanceof Error ? error.message : error}`);
      persistBotRuntimeStatus(config, "stopped");
    }
  }
}
