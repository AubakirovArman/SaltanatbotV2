import { commitExecutionFill } from "./executionCommit.js";
import type { RunningBot } from "./engineRuntime.js";
import { persistPaper, roundTradingValue as round } from "./engineState.js";
import { notify } from "./notifications.js";
import { recordConfirmedFill } from "./spotInventory.js";
import { listOrderJournal, withStoreTransaction } from "./store.js";
import type { FillRecord } from "./types.js";

interface PriceFillCallbacks {
  log: (message: string) => void;
  broadcast: (fill: FillRecord) => void;
}

export function applyPriceTriggeredFills(bot: RunningBot, price: number, callbacks: PriceFillCallbacks): void {
  const fills = bot.adapter.onPrice?.(bot.config.symbol, price) ?? [];
  for (const fill of fills) {
    const record = fill.orderId || fill.clientId ? listOrderJournal(bot.config.id, 500).find((candidate) => (fill.orderId !== undefined && candidate.exchangeOrderId === fill.orderId) || (fill.clientId !== undefined && candidate.clientId === fill.clientId)) : undefined;
    const recorded = record ? commitExecutionFill(record, fill).inserted : withStoreTransaction(() => recordConfirmedFill(fill, bot.config.market));
    if (!recorded) continue;
    callbacks.log(`Order ${fill.kind} ${fill.qty} @ ${fill.price}${fill.kind === "close" ? ` · PnL ${round(fill.realizedPnl)}` : ""}`);
    callbacks.broadcast(fill);
    if (fill.kind === "close") {
      void notify({ event: "close", bot: bot.config.name, symbol: bot.config.symbol, text: `Order fill · PnL ${round(fill.realizedPnl)}` });
    }
  }
  if (fills.length && bot.paper) persistPaper(bot);
}
