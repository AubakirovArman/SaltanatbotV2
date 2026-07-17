import type { RunningBot } from "./engineRuntime.js";
import { pauseRunningBot, persistRuntimeState } from "./engineState.js";

/** Serialize an operator pause behind already-queued market work and persist it. */
export async function pauseBotRuntime(
  bot: RunningBot,
  isCurrent: () => boolean,
  log: (message: string) => void,
  emit: () => void
): Promise<boolean> {
  let paused = bot.paused === true;
  bot.eventQueue = bot.eventQueue.then(() => {
    if (!isCurrent()) return;
    if (!bot.paused) {
      pauseRunningBot(bot, "Paused by operator");
      persistRuntimeState(bot);
      log("Trading paused by operator");
      emit();
    }
    paused = true;
  });
  await bot.eventQueue;
  return paused;
}
