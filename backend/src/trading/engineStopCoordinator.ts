import { notify } from "./notifications.js";
import { persistPaper, persistRuntimeState } from "./engineState.js";
import type { RunningBot } from "./engineRuntime.js";
import type { KeyedExclusiveLock } from "./keyedExclusiveLock.js";
import { upsertBotForOwner } from "./store.js";
import { botTradingAccountId } from "./tradingAccounts.js";
import { tradingOwnerForBot } from "./ownership.js";

interface StopDependencies {
  current(id: string): RunningBot | undefined;
  remove(id: string): void;
  log(id: string, message: string): void;
  emit(id: string): void;
}

/** Coordinates interactive stops with every in-process order producer. */
export class EngineStopCoordinator {
  private readonly stopping = new Set<string>();

  constructor(
    private readonly deps: StopDependencies,
    private readonly startLock: KeyedExclusiveLock,
    private readonly commandLock: KeyedExclusiveLock,
    private readonly orderLock: KeyedExclusiveLock
  ) {}

  isStopping(id: string): boolean {
    return this.stopping.has(id);
  }

  stopNow(id: string): void {
    const bot = this.deps.current(id);
    if (!bot) return;
    quiesce(bot);
    this.finalize(bot);
  }

  /** Drain commands, market events, and exchange critical sections before stop. */
  async stopSafely(id: string): Promise<void> {
    await this.startLock.run(id, async () => {
      const bot = this.deps.current(id);
      if (!bot) return;
      this.stopping.add(id);
      quiesce(bot);
      try {
        await this.commandLock.run(id, async () => {
          await bot.eventQueue.catch(() => undefined);
          await this.orderLock.run(engineOrderLockKey(bot), async () => undefined);
        });
        if (this.deps.current(id) === bot) this.finalize(bot);
      } finally {
        this.stopping.delete(id);
      }
    });
  }

  shutdown(bots: Iterable<RunningBot>): void {
    for (const bot of [...bots]) {
      quiesce(bot);
      if (bot.paper) persistPaper(bot);
      persistRuntimeState(bot);
      this.deps.remove(bot.config.id);
    }
  }

  private finalize(bot: RunningBot): void {
    const id = bot.config.id;
    if (bot.paper) persistPaper(bot);
    persistRuntimeState(bot);
    this.deps.remove(id);
    bot.config.status = "stopped";
    bot.config.updatedAt = Date.now();
    upsertBotForOwner(tradingOwnerForBot(bot.config), bot.config);
    this.deps.log(id, "Bot stopped");
    this.deps.emit(id);
    void notify({ ownerUserId: tradingOwnerForBot(bot.config), event: "stop", bot: bot.config.name, symbol: bot.config.symbol, text: "Stopped" });
  }
}

export function engineOrderLockKey(bot: RunningBot): string {
  return `${tradingOwnerForBot(bot.config)}:${botTradingAccountId(bot.config)}:${bot.config.market}:${bot.config.symbol}`;
}

function quiesce(bot: RunningBot): void {
  bot.sub?.close();
  bot.sub = undefined;
  if (bot.orderPollTimer) clearInterval(bot.orderPollTimer);
  bot.orderPollTimer = undefined;
  bot.privateOrderSubscription?.close();
  bot.privateOrderSubscription = undefined;
}
