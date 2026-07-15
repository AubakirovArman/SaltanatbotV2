import type { BotConfig } from "./types.js";

export interface TradingResourceLimits {
  maxAccountsPerOwner: number;
  maxBotsPerOwner: number;
  maxRunningPaperBotsPerOwner: number;
  maxRunningLiveBotsPerOwner: number;
}

/**
 * Conservative single-process defaults for an initial deployment of roughly
 * one hundred users. They bound private exchange connections and in-process
 * strategy work without preventing an operator from raising the limits after
 * measuring the host.
 */
export const DEFAULT_TRADING_RESOURCE_LIMITS: Readonly<TradingResourceLimits> = Object.freeze({
  maxAccountsPerOwner: 8,
  maxBotsPerOwner: 24,
  maxRunningPaperBotsPerOwner: 4,
  maxRunningLiveBotsPerOwner: 2
});

export type TradingResourceQuotaCode = "TRADING_ACCOUNT_QUOTA_EXCEEDED" | "BOT_QUOTA_EXCEEDED" | "PAPER_BOT_RUNNING_QUOTA_EXCEEDED" | "LIVE_BOT_RUNNING_QUOTA_EXCEEDED";

export class TradingResourceQuotaError extends Error {
  readonly status = 429;

  constructor(
    readonly code: TradingResourceQuotaCode,
    readonly limit: number,
    message: string
  ) {
    super(message);
    this.name = "TradingResourceQuotaError";
  }
}

export function loadTradingResourceLimits(env: NodeJS.ProcessEnv = process.env): TradingResourceLimits {
  return {
    maxAccountsPerOwner: positiveIntegerEnv(env, "TRADING_MAX_ACCOUNTS_PER_USER", DEFAULT_TRADING_RESOURCE_LIMITS.maxAccountsPerOwner, 1_000),
    maxBotsPerOwner: positiveIntegerEnv(env, "TRADING_MAX_BOTS_PER_USER", DEFAULT_TRADING_RESOURCE_LIMITS.maxBotsPerOwner, 10_000),
    maxRunningPaperBotsPerOwner: positiveIntegerEnv(env, "TRADING_MAX_RUNNING_PAPER_BOTS_PER_USER", DEFAULT_TRADING_RESOURCE_LIMITS.maxRunningPaperBotsPerOwner, 1_000),
    maxRunningLiveBotsPerOwner: positiveIntegerEnv(env, "TRADING_MAX_RUNNING_LIVE_BOTS_PER_USER", DEFAULT_TRADING_RESOURCE_LIMITS.maxRunningLiveBotsPerOwner, 1_000)
  };
}

export function assertTradingAccountCapacity(currentCount: number, limit: number): void {
  assertCount(currentCount);
  assertLimit(limit);
  if (currentCount >= limit) {
    throw new TradingResourceQuotaError("TRADING_ACCOUNT_QUOTA_EXCEEDED", limit, `Trading account limit reached (${limit} per user).`);
  }
}

export function assertBotCapacity(currentCount: number, limit: number): void {
  assertCount(currentCount);
  assertLimit(limit);
  if (currentCount >= limit) {
    throw new TradingResourceQuotaError("BOT_QUOTA_EXCEEDED", limit, `Robot limit reached (${limit} per user).`);
  }
}

export function assertRunningBotCapacity(runningForOwner: readonly BotConfig[], candidate: Pick<BotConfig, "exchange">, limits: Pick<TradingResourceLimits, "maxRunningPaperBotsPerOwner" | "maxRunningLiveBotsPerOwner">): void {
  const paper = candidate.exchange === "paper";
  const currentCount = runningForOwner.filter((bot) => (bot.exchange === "paper") === paper).length;
  const limit = paper ? limits.maxRunningPaperBotsPerOwner : limits.maxRunningLiveBotsPerOwner;
  assertCount(currentCount);
  assertLimit(limit);
  if (currentCount >= limit) {
    throw new TradingResourceQuotaError(paper ? "PAPER_BOT_RUNNING_QUOTA_EXCEEDED" : "LIVE_BOT_RUNNING_QUOTA_EXCEEDED", limit, `${paper ? "Paper" : "Live"} running robot limit reached (${limit} per user).`);
  }
}

export function isTradingResourceQuotaError(error: unknown): error is TradingResourceQuotaError {
  if (error instanceof TradingResourceQuotaError) return true;
  if (!error || typeof error !== "object") return false;
  const candidate = error as Partial<TradingResourceQuotaError>;
  return candidate.name === "TradingResourceQuotaError" && candidate.status === 429 && typeof candidate.limit === "number" && typeof candidate.code === "string";
}

function positiveIntegerEnv(env: NodeJS.ProcessEnv, name: string, fallback: number, maximum: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer from 1 through ${maximum}`);
  }
  return value;
}

function assertCount(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Resource count is invalid; refusing the mutation.");
}

function assertLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error("Resource quota is invalid; refusing the mutation.");
}
