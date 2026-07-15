import { pauseRunningBot, persistRuntimeState } from "./engineState.js";
import type { RunningBot } from "./engineRuntime.js";
import { orderLifecycle } from "./orderLifecycle.js";
import type { ExecOrder, ExecResult } from "./types.js";
import { botTradingAccountId } from "./tradingAccounts.js";

/** Submit only through the durable lifecycle and fail closed on an ambiguous live outcome. */
export async function executeDurableEngineOrder(
  bot: RunningBot,
  order: ExecOrder,
  barTime: number | undefined,
  log: (message: string) => void
): Promise<ExecResult> {
  if (order.action === "get") return bot.adapter.execute(order);
  try {
    return await orderLifecycle.execute(
      { botId: bot.config.id, accountId: botTradingAccountId(bot.config), exchange: bot.config.exchange, market: bot.config.market, barTime },
      order,
      () => bot.adapter.execute(order)
    );
  } catch (error) {
    if (bot.config.exchange !== "paper") {
      const detail = error instanceof Error ? error.message : String(error);
      let reason = `Live order outcome is unknown after durable intent (${detail}); trading is paused pending signed reconciliation.`;
      pauseRunningBot(bot, reason);
      try {
        persistRuntimeState(bot);
      } catch (persistError) {
        reason = `${reason} Pause persistence failed: ${persistError instanceof Error ? persistError.message : String(persistError)}.`;
        bot.pauseReason = reason;
      }
      try { log(reason); } catch { /* Preserve the in-memory pause even if logging fails. */ }
    }
    throw error;
  }
}
