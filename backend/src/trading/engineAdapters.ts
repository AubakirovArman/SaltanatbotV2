import type { DataMarketType } from "../providers/provider.js";
import { BinanceAdapter, type ExchangeKeys } from "./exchange/binance.js";
import { BybitAdapter } from "./exchange/bybit.js";
import { PaperAdapter } from "./exchange/paper.js";
import { getTradingAccountCredentialsForOwner, getTradingAccountForOwner, listTradingAccountsForOwner } from "./store.js";
import type { BotConfig, ExchangeAdapter } from "./types.js";
import { botTradingAccountId, tradingAccountBindingIssue } from "./tradingAccounts.js";

export function buildEngineAdapter(config: BotConfig, getPrice: () => number): ExchangeAdapter {
  if (config.exchange === "binance" || config.exchange === "bybit") {
    const ownerUserId = config.ownerUserId?.trim();
    if (!ownerUserId) throw new Error("Live bot owner is missing; refusing to load trading credentials.");
    const accountId = botTradingAccountId(config);
    const issue = tradingAccountBindingIssue(config, getTradingAccountForOwner(ownerUserId, accountId));
    if (issue) throw new Error(`${issue.code}: ${issue.message}`);
    const keys = getTradingAccountCredentialsForOwner<ExchangeKeys>(ownerUserId, accountId) ?? { apiKey: "", apiSecret: "" };
    if (!keys.apiKey || !keys.apiSecret) throw new Error(`Credentials are not configured for trading account ${accountId}.`);
    return config.exchange === "binance"
      ? new BinanceAdapter(config.id, keys, config.market, accountId)
      : new BybitAdapter(config.id, keys, config.market, accountId);
  }
  return new PaperAdapter({
    botId: config.id,
    accountId: botTradingAccountId(config),
    market: config.market,
    startBalance: config.sizeMode === "quote" ? Math.max(config.sizeValue * 10, 10_000) : 10_000,
    feePct: 0.05,
    slipPct: 0.02,
    getPrice
  });
}

/** Signed account adapters for one owner, including accounts with no running bot. */
export function buildEmergencyAdapters(ownerUserId: string): ExchangeAdapter[] {
  const adapters: ExchangeAdapter[] = [];
  for (const account of listTradingAccountsForOwner(ownerUserId)) {
    const keys = getTradingAccountCredentialsForOwner<ExchangeKeys>(ownerUserId, account.id);
    if (!keys?.apiKey || !keys.apiSecret) continue;
    // Emergency cancellation/flattening remains available even when account
    // metadata is disabled: old venue exposure may still exist.
    for (const market of ["spot", "futures"] as const) {
      adapters.push(account.exchange === "binance"
        ? new BinanceAdapter(`emergency-${market}`, keys, market, account.id)
        : new BybitAdapter(`emergency-${market}`, keys, market, account.id));
    }
  }
  return adapters;
}

export function engineMarketRoute(config: BotConfig): { exchange: "binance" | "bybit"; marketType: DataMarketType; priceType: "last" } {
  return {
    exchange: config.exchange === "bybit" ? "bybit" : "binance",
    marketType: config.market === "futures" ? "linear" : "spot",
    priceType: "last"
  };
}
