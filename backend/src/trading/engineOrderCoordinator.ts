import { fillFromExchangeExecution, isTerminalUnaccountedExecution } from "./executionAccounting.js";
import { commitExecutionFill } from "./executionCommit.js";
import { ingestExchangeOrderEvent } from "./orderEventIngest.js";
import { orderLifecycle } from "./orderLifecycle.js";
import { pollOrderUpdates } from "./orderPolling.js";
import { reconcileLiveRuntime } from "./reconciliation.js";
import { reconcileStartupOrders } from "./startupOrderReconciliation.js";
import { listExecutionReconciliationJournal, listOrderJournal } from "./store.js";
import { getSpotInventory } from "./spotInventory.js";
import { isTerminalUnaccountedRisk, loadLiveRiskJournal } from "./liveRiskReservations.js";
import { reconcileAuthenticatedReduceOnlyExecution } from "./managedExecution.js";
import type { Managed, RunningBot } from "./engineRuntime.js";
import type { ExchangeOrderSnapshot, OrderJournalRecord } from "./types.js";
import type { TradeEvent } from "./engineEvents.js";

const MAX_RECONCILIATION_ORDERS = 1_000;

interface ReconciliationResult {
  safe: boolean;
  messages: string[];
}

export class EngineOrderCoordinator {
  constructor(
    private readonly currentBot: (id: string) => RunningBot | undefined,
    private readonly log: (botId: string, level: "info" | "warn" | "error", message: string) => void,
    private readonly broadcast: (event: TradeEvent) => void,
    private readonly pauseBot: (bot: RunningBot, reason: string) => void,
    private readonly persistBot: (bot: RunningBot) => void
  ) {}

  startOrderPolling(bot: RunningBot) {
    if (!bot.adapter.orderStatus) return;
    const enqueue = () => this.enqueue(bot, "Order polling failed", () => this.pollOrders(bot));
    bot.orderPollTimer = setInterval(enqueue, 30_000);
    bot.orderPollTimer.unref?.();
    enqueue();
  }

  startPrivateOrderStream(bot: RunningBot) {
    if (!bot.adapter.subscribeOrderUpdates) return;
    bot.privateOrderStreamAbort?.abort();
    bot.privateOrderSubscription?.close();
    bot.privateOrderSubscription = undefined;
    const controller = new AbortController();
    bot.privateOrderStreamAbort = controller;
    void bot.adapter
      .subscribeOrderUpdates(
        (snapshot) => this.enqueue(bot, "Private order update failed", () => this.ingestOrderEvent(bot, snapshot, false)),
        (connected, message) => {
          this.enqueue(bot, "Order reconnect reconciliation failed", async () => {
            this.log(bot.config.id, connected ? "info" : "warn", message);
            await this.pollOrders(bot, true);
          });
        },
        controller.signal
      )
      .then((subscription) => {
        if (this.currentBot(bot.config.id) === bot && bot.privateOrderStreamAbort === controller && !controller.signal.aborted) {
          bot.privateOrderSubscription = subscription;
        } else {
          subscription.close();
        }
      })
      .catch((error) => {
        if (bot.privateOrderStreamAbort === controller) bot.privateOrderStreamAbort = undefined;
        if (controller.signal.aborted) return;
        this.log(bot.config.id, "warn", `Private order stream unavailable: ${messageOf(error)}; REST polling fallback active.`);
      });
  }

  private enqueue(bot: RunningBot, label: string, operation: () => void | Promise<void>) {
    bot.eventQueue = bot.eventQueue
      .then(async () => {
        if (this.currentBot(bot.config.id) !== bot) return;
        await operation();
      })
      .catch((error) => this.failClosed(bot, `${label}: ${messageOf(error)}`));
  }

  private failClosed(bot: RunningBot, reason: string) {
    if (this.currentBot(bot.config.id) !== bot) return;
    try {
      this.pauseBot(bot, `${reason}; trading is paused pending reconciliation.`);
    } catch (persistError) {
      bot.paused = true;
      bot.pauseReason = `${reason}; trading is paused and persistence failed: ${messageOf(persistError)}`;
    }
    try {
      this.log(bot.config.id, "error", bot.pauseReason ?? reason);
    } catch {
      // The in-memory pause must survive even when log persistence is unavailable.
    }
  }

  private async pollOrders(bot: RunningBot, force = false) {
    if (this.currentBot(bot.config.id) !== bot) return;
    if (!force && bot.privateOrderSubscription?.connected()) return;
    const result = await pollOrderUpdates(
      listOrderJournal(bot.config.id, 1_000),
      bot.adapter,
      (_record, snapshot) => this.ingestOrderEvent(bot, snapshot),
      10,
      bot.orderPollOffset ?? 0
    );
    bot.orderPollOffset = result.nextOffset;
    for (const failure of result.failures) {
      this.log(bot.config.id, "warn", `Order ${failure.record.id} status poll failed: ${messageOf(failure.error)}`);
    }
    if (result.failures.length > 0) throw new Error(`${result.failures.length} signed order status query failure(s)`);
    const terminalUnaccounted = reconciliationJournal(bot.config.id).find(terminalUnaccountedExecutionOrRisk);
    if (terminalUnaccounted) {
      throw new Error(`Order ${terminalUnaccounted.id} reached ${terminalUnaccounted.status} without authenticated execution accounting`);
    }
  }

  private async ingestOrderEvent(bot: RunningBot, snapshot: ExchangeOrderSnapshot, warnUnmatched = true) {
    const result = ingestExchangeOrderEvent(listOrderJournal(bot.config.id, 1_000), snapshot, orderLifecycle);
    if (result.kind === "unmatched") {
      if (snapshot.execution) throw new Error(`Authenticated execution ${snapshot.execution.id} could not be matched to a durable order`);
      if (warnUnmatched) this.log(bot.config.id, "warn", `Ignored unmatched exchange order event ${snapshot.id}.`);
      return;
    }
    if (result.kind === "ignored" && result.reason === "identity_conflict") {
      if (snapshot.execution) throw new Error(`Authenticated execution ${snapshot.execution.id} conflicts with durable order identity`);
      this.log(bot.config.id, "warn", `Ignored exchange order event ${snapshot.id} with conflicting client identity.`);
      return;
    }

    let observedRecord = result.record;
    if (snapshot.execution) {
      const fill = fillFromExchangeExecution(observedRecord, snapshot);
      if (!fill) return;
      const committed = commitExecutionFill(observedRecord, fill);
      observedRecord = committed.record;
      if (committed.inserted) {
        this.broadcast({ type: "fill", botId: bot.config.id, fill });
        this.log(bot.config.id, "info", `Venue execution ${fill.qty} @ ${fill.price} · fee ${fill.fee} ${fill.feeAsset ?? "unknown"} · PnL ${fill.realizedPnl}`);
        const managed = await reconcileAuthenticatedReduceOnlyExecution(bot, observedRecord);
        if (managed.changed) this.persistBot(bot);
        if (managed.pauseReason) {
          this.pauseBot(bot, managed.pauseReason);
          this.log(bot.config.id, "warn", managed.pauseReason);
        }
      }
    }
    if (terminalUnaccountedExecutionOrRisk(observedRecord)) {
      throw new Error(`Order ${observedRecord.id} reached ${observedRecord.status} without authenticated execution accounting`);
    }
  }

  async reconcileOnResume(bot: RunningBot, savedManaged?: Managed): Promise<boolean> {
    const result = await this.inspectLiveState(bot, savedManaged, false).catch((error) => ({
      safe: false,
      messages: [`Resume reconciliation failed: ${messageOf(error)}`]
    }));
    if (!result.safe) this.pauseBot(bot, `${result.messages.join(" ")} Trading is paused.`);
    for (const message of result.messages) this.log(bot.config.id, result.safe ? "info" : "warn", `Reconcile: ${message}`);
    return true;
  }

  async confirmResume(bot: RunningBot, validateCurrent?: () => boolean): Promise<boolean> {
    const result = await this.inspectLiveState(bot, bot.managed, true).catch((error) => ({
      safe: false,
      messages: [`Fresh resume confirmation failed: ${messageOf(error)}`]
    }));
    if (!result.safe) {
      const reason = `${result.messages.join(" ")} Trading remains paused.`;
      try { this.pauseBot(bot, reason); } catch { bot.paused = true; bot.pauseReason = reason; }
      for (const message of result.messages) {
        try { this.log(bot.config.id, "warn", `Confirm resume: ${message}`); } catch { /* Pause is already held in memory. */ }
      }
      return false;
    }
    if (validateCurrent && !validateCurrent()) return false;
    const previousReason = bot.pauseReason;
    bot.paused = false;
    bot.pauseReason = undefined;
    try {
      this.persistBot(bot);
    } catch (error) {
      bot.paused = true;
      bot.pauseReason = `Resume confirmation could not be persisted: ${messageOf(error)}`;
      try { this.persistBot(bot); } catch { /* Keep the in-memory fail-closed pause. */ }
      try { this.log(bot.config.id, "error", `${bot.pauseReason} Previous pause: ${previousReason ?? "unspecified"}.`); } catch { /* Preserve pause. */ }
      return false;
    }
    for (const message of result.messages) this.log(bot.config.id, "info", `Confirm resume: ${message}`);
    return true;
  }

  private async inspectLiveState(bot: RunningBot, savedManaged: Managed | undefined, confirmation: boolean): Promise<ReconciliationResult> {
    const orders = reconciliationJournal(bot.config.id);
    if (!bot.adapter.orders) throw new Error("Exchange adapter cannot provide fresh open orders");
    const openOrders = await bot.adapter.orders(bot.config.symbol);
    const orderReconciliation = await reconcileStartupOrders(orders, openOrders, bot.adapter, orderLifecycle);
    const messages: string[] = [];
    if (orderReconciliation.unresolved.length > 0) {
      messages.push(`${orderReconciliation.unresolved.length} order execution outcome(s) remain unaccounted.`);
    }
    const pendingImmediateExits = orders.filter((record) => (
      (record.status === "intent" || record.status === "accepted" || record.status === "partially_filled" || record.status === "unknown")
      && (record.action === "close" || record.action === "flatten")
      && record.type === "market"
    ));
    if (pendingImmediateExits.length > 0) messages.push(`${pendingImmediateExits.length} immediate reduce-only exit(s) remain in flight.`);

    const exchangePosition = await bot.adapter.position(bot.config.symbol);
    if (bot.config.market === "spot") {
      const inventory = getSpotInventory(bot.config.id, bot.config.symbol);
      if (inventory?.remainingQty) {
        bot.managed = { side: "long", entry: inventory.avgPrice, qty: inventory.remainingQty, entryTime: inventory.updatedAt };
        if (!confirmation) messages.push("Spot inventory restored; verify exchange balance before confirming resume.");
      } else if (savedManaged) {
        bot.managed = savedManaged;
        messages.push("Legacy spot position has no attributed inventory; automatic close remains disabled.");
      } else {
        bot.managed = undefined;
      }
      if (exchangePosition) messages.push("Spot adapter unexpectedly reported a derivative-style position.");
      return { safe: messages.length === 0, messages: messages.length ? messages : ["Spot inventory, open orders, and journal are reconciled."] };
    }

    const runtime = reconcileLiveRuntime({ config: bot.config, savedManaged, exchangePosition, openOrders, now: Date.now() });
    bot.managed = runtime.managed;
    messages.push(...runtime.messages);
    const safe = orderReconciliation.unresolved.length === 0 && pendingImmediateExits.length === 0 && !runtime.pause;
    return { safe, messages: messages.length ? messages : ["Journal, open orders, and venue position are reconciled."] };
  }
}

function reconciliationJournal(botId: string): OrderJournalRecord[] {
  const execution = listExecutionReconciliationJournal(botId, MAX_RECONCILIATION_ORDERS + 1);
  if (execution.length > MAX_RECONCILIATION_ORDERS) {
    throw new Error(`Execution reconciliation journal exceeds the ${MAX_RECONCILIATION_ORDERS}-order safety bound`);
  }
  const merged = new Map(loadLiveRiskJournal(botId).map((record) => [record.id, record]));
  for (const record of execution) merged.set(record.id, record);
  return [...merged.values()];
}

function terminalUnaccountedExecutionOrRisk(record: OrderJournalRecord) {
  return isTerminalUnaccountedExecution(record) || isTerminalUnaccountedRisk(record);
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
