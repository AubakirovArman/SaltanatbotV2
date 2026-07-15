import { EmergencyStopCoordinator } from "./emergencyStop.js";
import type { TradeEvent } from "./engineEvents.js";
import type { RunningBot } from "./engineRuntime.js";
import { KeyedExclusiveLock } from "./keyedExclusiveLock.js";
import { botBelongsToOwner, tenantSettingKey, tradingOwnerForBot } from "./ownership.js";
import { deleteSetting, getSetting, setSetting } from "./store.js";
import type { BotConfig, ExchangeAdapter, ExchangeId } from "./types.js";
import { assertRunningBotCapacity, DEFAULT_TRADING_RESOURCE_LIMITS, type TradingResourceLimits } from "./resourceQuotas.js";

interface OwnerStartLease {
  ownerUserId: string;
  botId: string;
  assertCurrent(): void;
}

/** Tenant partition for the otherwise shared in-process engine scheduler. */
export class EngineTenantRuntime {
  private readonly knownBotOwners = new Map<string, string>();
  private readonly emergencies = new Map<string, EmergencyStopCoordinator>();
  private readonly ownerStartLock = new KeyedExclusiveLock();
  private readonly botLifecycleLock = new KeyedExclusiveLock();
  private readonly accountLifecycleLock = new KeyedExclusiveLock();
  private readonly startEpochs = new Map<string, number>();
  private readonly suspendedOwners = new Set<string>();
  private readonly blockedBotStarts = new Set<string>();

  constructor(
    private readonly current: (botId: string) => RunningBot | undefined,
    private readonly running: () => Iterable<RunningBot>,
    private readonly stop: (botId: string) => void,
    private readonly publish: (event: TradeEvent) => void,
    private readonly emergencyAdapters: (ownerUserId: string) => Iterable<ExchangeAdapter>,
    private readonly resourceLimits: TradingResourceLimits = DEFAULT_TRADING_RESOURCE_LIMITS
  ) {}

  remember(config: BotConfig): string {
    const ownerUserId = tradingOwnerForBot(config);
    this.knownBotOwners.set(config.id, ownerUserId);
    return ownerUserId;
  }

  owned(ownerUserId: string, id: string): RunningBot | undefined {
    const bot = this.current(id);
    return bot && botBelongsToOwner(bot.config, ownerUserId) ? bot : undefined;
  }

  knows(ownerUserId: string, id: string): boolean {
    return this.owned(ownerUserId, id) !== undefined || this.knownBotOwners.get(id) === ownerUserId;
  }

  beginStart(ownerUserId: string, botId: string): OwnerStartLease {
    const epoch = this.startEpochs.get(ownerUserId) ?? 0;
    const assertCurrent = () => {
      if (this.suspendedOwners.has(ownerUserId) || this.blockedBotStarts.has(botKey(ownerUserId, botId)) || (this.startEpochs.get(ownerUserId) ?? 0) !== epoch) {
        throw new Error("Trading access changed while the bot was starting.");
      }
    };
    assertCurrent();
    return { ownerUserId, botId, assertCurrent };
  }

  runStart<T>(lease: OwnerStartLease, accountId: string | undefined, exchange: ExchangeId, operation: () => Promise<T>, validateCurrent?: () => void): Promise<T> {
    return this.withBotLifecycleLock(lease.ownerUserId, lease.botId, () => {
      validateCurrent?.();
      return this.ownerStartLock.run(lease.ownerUserId, async () => {
        lease.assertCurrent();
        if (!this.owned(lease.ownerUserId, lease.botId)) {
          assertRunningBotCapacity(
            [...this.running()].map((bot) => bot.config).filter((bot) => botBelongsToOwner(bot, lease.ownerUserId)),
            { exchange },
            this.resourceLimits
          );
        }
        const run = async () => {
          lease.assertCurrent();
          const result = await operation();
          lease.assertCurrent();
          return result;
        };
        return accountId ? this.withAccountLifecycleLock(lease.ownerUserId, accountId, run) : run();
      });
    });
  }

  withBotLifecycleLock<T>(ownerUserId: string, botId: string, operation: () => Promise<T>): Promise<T> {
    return this.botLifecycleLock.run(botKey(ownerUserId, botId), operation);
  }

  withAccountLifecycleLock<T>(ownerUserId: string, accountId: string, operation: () => Promise<T>): Promise<T> {
    return this.accountLifecycleLock.run(`${ownerUserId}:${accountId}`, operation);
  }

  suspendOwnerStarts(ownerUserId: string): void {
    this.bumpStartEpoch(ownerUserId);
    this.suspendedOwners.add(ownerUserId);
  }

  resumeOwnerStarts(ownerUserId: string): void {
    this.suspendedOwners.delete(ownerUserId);
  }

  invalidateOwnerStarts(ownerUserId: string): void {
    this.bumpStartEpoch(ownerUserId);
  }

  async drainOwner(ownerUserId: string, stopSafely: (botId: string) => Promise<void>, suspend = false): Promise<number> {
    if (suspend) this.suspendOwnerStarts(ownerUserId);
    const stopped = new Set<string>();
    await this.stopOwned(ownerUserId, stopSafely, stopped);
    await this.ownerStartLock.run(ownerUserId, () => this.stopOwned(ownerUserId, stopSafely, stopped));
    return stopped.size;
  }

  async deleteBot<T>(ownerUserId: string, botId: string, stopSafely: () => Promise<void>, remove: () => T | Promise<T>): Promise<T> {
    const key = botKey(ownerUserId, botId);
    this.blockedBotStarts.add(key);
    try {
      return await this.withBotLifecycleLock(ownerUserId, botId, async () => {
        await stopSafely();
        return remove();
      });
    } finally {
      this.blockedBotStarts.delete(key);
    }
  }

  broadcast(event: TradeEvent): void {
    const ownerUserId = event.ownerUserId ?? this.current(event.botId)?.config.ownerUserId ?? this.knownBotOwners.get(event.botId);
    if (ownerUserId) this.publish({ ...event, ownerUserId });
  }

  emergency(ownerUserId: string): EmergencyStopCoordinator {
    const existing = this.emergencies.get(ownerUserId);
    if (existing) return existing;
    const key = tenantSettingKey(ownerUserId, "tradingEmergencyStop");
    const legacyOwnerUserId = tradingOwnerForBot({});
    const legacyKey = "tradingEmergencyStop";
    const coordinator = new EmergencyStopCoordinator({
      running: () => [...this.running()].filter((bot) => botBelongsToOwner(bot.config, ownerUserId)),
      stop: (id) => {
        if (this.owned(ownerUserId, id)) this.stop(id);
      },
      additionalAdapters: () => this.emergencyAdapters(ownerUserId),
      load: () => getSetting(key) ?? (ownerUserId === legacyOwnerUserId ? getSetting(legacyKey) : undefined),
      save: (result) => setSetting(key, result),
      clear: () => {
        deleteSetting(key);
        if (ownerUserId === legacyOwnerUserId) deleteSetting(legacyKey);
      }
    });
    this.emergencies.set(ownerUserId, coordinator);
    return coordinator;
  }

  private bumpStartEpoch(ownerUserId: string): void {
    this.startEpochs.set(ownerUserId, (this.startEpochs.get(ownerUserId) ?? 0) + 1);
  }

  private async stopOwned(ownerUserId: string, stopSafely: (botId: string) => Promise<void>, stopped: Set<string>): Promise<void> {
    const ids = [...this.running()].filter((bot) => botBelongsToOwner(bot.config, ownerUserId)).map((bot) => bot.config.id);
    for (const id of ids) {
      try {
        await stopSafely(id);
      } catch {
        this.stop(id);
      }
      stopped.add(id);
    }
  }
}

function botKey(ownerUserId: string, botId: string): string {
  return JSON.stringify([ownerUserId, botId]);
}
