import type {
  BotConfig,
  ExchangeId,
  TradingAccount,
  TradingAccountCapabilityView,
  TradingAccountExchange
} from "./types.js";

const legacyIds: Record<TradingAccountExchange, string> = {
  binance: "binance:default",
  bybit: "bybit:default"
};

/** Deterministic identifiers retained only for migration of pre-v6 data. */
export function legacyTradingAccountId(exchange: TradingAccountExchange): string {
  return legacyIds[exchange];
}

export function paperTradingAccountId(botId: string): string {
  return `paper:${botId}`;
}

/** Resolve configs written before accountId existed. */
export function botTradingAccountId(config: Pick<BotConfig, "id" | "exchange" | "accountId">): string {
  if (config.accountId?.trim()) return config.accountId.trim();
  return config.exchange === "paper"
    ? paperTradingAccountId(config.id)
    : legacyTradingAccountId(config.exchange);
}

export function withResolvedBotAccountId<T extends BotConfig>(config: T): T & { accountId: string } {
  return { ...config, accountId: botTradingAccountId(config) };
}

export function isLegacyTradingAccount(account: Pick<TradingAccount, "id" | "exchange">): boolean {
  return account.id === legacyTradingAccountId(account.exchange);
}

export function describeTradingAccount(
  account: TradingAccount,
  credentialsConfigured: boolean,
  botIds: readonly string[] = []
): TradingAccountCapabilityView {
  const credentialStatus = credentialsConfigured ? "configured" : "missing";
  const status = !account.enabled
    ? "disabled"
    : credentialsConfigured
      ? "ready"
      : "credentials_missing";
  const { ownerUserId: _serverOnlyOwner, ...publicAccount } = account;
  return {
    ...publicAccount,
    status,
    credential: {
      mode: "account_isolated",
      status: credentialStatus,
      isolated: true
    },
    capabilities: {
      liveExecution: status === "ready",
      credentialIsolation: true,
      multipleCredentialAccounts: true
    },
    botIds: [...botIds]
  };
}

export interface TradingAccountBindingIssue {
  code:
    | "TRADING_ACCOUNT_NOT_FOUND"
    | "TRADING_ACCOUNT_EXCHANGE_MISMATCH"
    | "TRADING_ACCOUNT_DISABLED";
  message: string;
}

/**
 * Validate the part of a bot/account binding the current runtime can honestly
 * support. Credential presence is checked separately at adapter construction.
 */
export function tradingAccountBindingIssue(
  config: Pick<BotConfig, "id" | "exchange" | "accountId">,
  account: TradingAccount | undefined
): TradingAccountBindingIssue | undefined {
  if (config.exchange === "paper") return undefined;
  const accountId = botTradingAccountId(config);
  if (!account) {
    return { code: "TRADING_ACCOUNT_NOT_FOUND", message: `Trading account ${accountId} does not exist.` };
  }
  if (account.exchange !== config.exchange) {
    return {
      code: "TRADING_ACCOUNT_EXCHANGE_MISMATCH",
      message: `Trading account ${account.id} belongs to ${account.exchange}, not ${config.exchange}.`
    };
  }
  if (!account.enabled) {
    return { code: "TRADING_ACCOUNT_DISABLED", message: `Trading account ${account.id} is disabled.` };
  }
  return undefined;
}

export function isTradingAccountExchange(exchange: ExchangeId): exchange is TradingAccountExchange {
  return exchange === "binance" || exchange === "bybit";
}
