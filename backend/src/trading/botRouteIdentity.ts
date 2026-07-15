import type { AuthRole, BotConfig, ExchangeId } from "./types.js";

interface RuntimeConfigLookup {
  runtimeConfig(id: string): BotConfig | undefined;
}

export function resolveBotRouteIdentity(engine: RuntimeConfigLookup, persisted: readonly BotConfig[], id: string): BotConfig | undefined {
  return engine.runtimeConfig(id) ?? persisted.find((bot) => bot.id === id);
}

export function mutationAuthority(engine: RuntimeConfigLookup, existing: BotConfig | undefined, id: string | undefined, requestedExchange: ExchangeId): { runtime?: BotConfig; role: AuthRole; secureOrigin: boolean } {
  const runtime = id ? engine.runtimeConfig(id) : undefined;
  const secureOrigin = requestedExchange !== "paper" || (existing !== undefined && existing.exchange !== "paper") || (runtime !== undefined && runtime.exchange !== "paper");
  return { runtime, role: secureOrigin ? "live-trade" : "paper-trade", secureOrigin };
}

export function roleForBot(bot: BotConfig): AuthRole {
  return bot.exchange === "paper" ? "paper-trade" : "live-trade";
}
