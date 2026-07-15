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

/**
 * The current credential store has exactly one encrypted key pair per venue.
 * These deterministic ids expose that legacy binding without pretending that
 * separately-isolated credentials already exist.
 */
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
  const legacy = isLegacyTradingAccount(account);
  const credentialStatus = legacy ? (credentialsConfigured ? "configured" : "missing") : "unsupported";
  const status = !account.enabled
    ? "disabled"
    : !legacy
      ? "metadata_only"
      : credentialsConfigured
        ? "ready"
        : "credentials_missing";
  return {
    ...account,
    status,
    credential: {
      mode: legacy ? "legacy_exchange_shared" : "unsupported",
      status: credentialStatus,
      isolated: false
    },
    capabilities: {
      liveExecution: status === "ready",
      credentialIsolation: false,
      multipleCredentialAccounts: false
    },
    botIds: [...botIds]
  };
}

export interface TradingAccountBindingIssue {
  code:
    | "TRADING_ACCOUNT_NOT_FOUND"
    | "TRADING_ACCOUNT_EXCHANGE_MISMATCH"
    | "TRADING_ACCOUNT_DISABLED"
    | "MULTI_ACCOUNT_CREDENTIALS_UNSUPPORTED";
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
  if (!isLegacyTradingAccount(account)) {
    return {
      code: "MULTI_ACCOUNT_CREDENTIALS_UNSUPPORTED",
      message: `Trading account ${account.id} is metadata-only: this runtime currently supports one shared credential set per exchange.`
    };
  }
  return undefined;
}

export function isTradingAccountExchange(exchange: ExchangeId): exchange is TradingAccountExchange {
  return exchange === "binance" || exchange === "bybit";
}
