import { fillFromExchangeExecution, hasRecordedExecution } from "./executionAccounting.js";
import { ingestExchangeOrderEvent } from "./orderEventIngest.js";
import { orderLifecycle } from "./orderLifecycle.js";
import { pollOrderUpdates } from "./orderPolling.js";
import { reconcileLiveRuntime } from "./reconciliation.js";
import { reconcileStartupOrders } from "./startupOrderReconciliation.js";
import { listOrderEvents, listOrderJournal, withStoreTransaction } from "./store.js";
import { getSpotInventory, recordConfirmedFill } from "./spotInventory.js";
import type { Managed, RunningBot } from "./engineRuntime.js";
import type { ExchangeOrderSnapshot } from "./types.js";
import type { TradeEvent } from "./engine.js";

export class EngineOrderCoordinator {
  constructor(
    private readonly currentBot: (id: string) => RunningBot | undefined,
    private readonly log: (botId: string, level: "info" | "warn" | "error", message: string) => void,
    private readonly broadcast: (event: TradeEvent) => void,
    private readonly pauseBot: (bot: RunningBot, reason: string) => void
  ) {}

  startOrderPolling(bot: RunningBot) {
    if (!bot.adapter.orderStatus) return;
    const enqueue = () => {
      bot.eventQueue = bot.eventQueue.then(() => this.pollOrders(bot)).catch((error) => this.log(bot.config.id, "warn", `Order polling failed: ${error instanceof Error ? error.message : error}`));
    };
    bot.orderPollTimer = setInterval(enqueue, 30_000);
    bot.orderPollTimer.unref?.();
    enqueue();
  }

  startPrivateOrderStream(bot: RunningBot) {
    if (!bot.adapter.subscribeOrderUpdates) return;
    void bot.adapter
      .subscribeOrderUpdates(
        (snapshot) => this.ingestOrderEvent(bot, snapshot, false),
        (connected, message) => {
          if (this.currentBot(bot.config.id) !== bot) return;
          this.log(bot.config.id, connected ? "info" : "warn", message);
          bot.eventQueue = bot.eventQueue.then(() => this.pollOrders(bot, true)).catch((error) => this.log(bot.config.id, "warn", `Order reconnect reconciliation failed: ${error instanceof Error ? error.message : error}`));
        }
      )
      .then((subscription) => {
        if (this.currentBot(bot.config.id) === bot) bot.privateOrderSubscription = subscription;
        else subscription.close();
      })
      .catch((error) => {
        this.log(bot.config.id, "warn", `Private order stream unavailable: ${error instanceof Error ? error.message : error}; REST polling fallback active.`);
      });
  }

  private async pollOrders(bot: RunningBot, force = false) {
    if (this.currentBot(bot.config.id) !== bot) return;
    if (!force && bot.privateOrderSubscription?.connected()) return;
    const result = await pollOrderUpdates(listOrderJournal(bot.config.id, 500), bot.adapter, (_record, snapshot) => this.ingestOrderEvent(bot, snapshot), 10, bot.orderPollOffset ?? 0);
    bot.orderPollOffset = result.nextOffset;
    for (const failure of result.failures) {
      this.log(bot.config.id, "warn", `Order ${failure.record.id} status poll failed: ${failure.error instanceof Error ? failure.error.message : failure.error}`);
    }
  }

  private ingestOrderEvent(bot: RunningBot, snapshot: ExchangeOrderSnapshot, warnUnmatched = true) {
    const result = ingestExchangeOrderEvent(listOrderJournal(bot.config.id, 500), snapshot, orderLifecycle);
    if (result.kind === "unmatched" && warnUnmatched) {
      this.log(bot.config.id, "warn", `Ignored unmatched exchange order event ${snapshot.id}.`);
    } else if (result.kind === "ignored" && result.reason === "identity_conflict") {
      this.log(bot.config.id, "warn", `Ignored exchange order event ${snapshot.id} with conflicting client identity.`);
    }
    if (result.kind !== "unmatched" && snapshot.execution && !(result.kind === "ignored" && result.reason === "identity_conflict")) {
      const fill = fillFromExchangeExecution(result.record, snapshot);
      if (!fill) return result;
      const recorded = withStoreTransaction(() => {
        if (hasRecordedExecution(listOrderEvents(result.record.id, 1_000), snapshot.execution?.id ?? "")) return false;
        const inserted = recordConfirmedFill(fill, result.record.market);
        if (!inserted) return false;
        orderLifecycle.recordFill(result.record, fill);
        return true;
      });
      if (recorded) {
        this.broadcast({ type: "fill", botId: bot.config.id, fill });
        this.log(bot.config.id, "info", `Venue execution ${fill.qty} @ ${fill.price} · fee ${fill.fee} ${fill.feeAsset ?? "unknown"} · PnL ${fill.realizedPnl}`);
      }
    }
    return result;
  }

  async reconcileOnResume(bot: RunningBot, savedManaged?: Managed): Promise<boolean> {
    try {
      if (bot.config.market === "spot") {
        const inventory = getSpotInventory(bot.config.id, bot.config.symbol);
        if (inventory?.remainingQty) {
          bot.managed = { side: "long", entry: inventory.avgPrice, qty: inventory.remainingQty, entryTime: inventory.updatedAt };
          this.pauseBot(bot, "Spot inventory restored after restart; verify exchange balance before confirming resume.");
        } else if (savedManaged) {
          bot.managed = savedManaged;
          this.pauseBot(bot, "Legacy spot position has no attributed inventory; automatic close is disabled pending operator review.");
        } else {
          bot.managed = undefined;
        }
        this.log(bot.config.id, bot.paused ? "warn" : "info", bot.pauseReason ?? "Spot inventory is flat after reconciliation.");
        return true;
      }
      const exchangePosition = await bot.adapter.position(bot.config.symbol);
      const openOrders = bot.adapter.orders ? await bot.adapter.orders(bot.config.symbol).catch(() => []) : [];
      const orderReconciliation = await reconcileStartupOrders(listOrderJournal(bot.config.id, 500), openOrders, bot.adapter, orderLifecycle);
      const result = reconcileLiveRuntime({
        config: bot.config,
        savedManaged,
        exchangePosition,
        openOrders,
        now: Date.now()
      });
      bot.managed = result.managed;
      if (orderReconciliation.unresolved.length > 0) {
        result.pause = true;
        result.messages.push(`${orderReconciliation.unresolved.length} in-flight exchange order outcome(s) remain unproven after restart; trading is paused for operator review.`);
      }
      if (result.pause) this.pauseBot(bot, result.messages.join(" "));
      for (const message of result.messages) this.log(bot.config.id, result.pause ? "warn" : "info", `Reconcile: ${message}`);
      return true;
    } catch (error) {
      this.pauseBot(bot, `Resume reconciliation failed — trading paused: ${error instanceof Error ? error.message : error}`);
      this.log(bot.config.id, "warn", bot.pauseReason ?? "Resume reconciliation failed — trading paused.");
      return true;
    }
  }
}
