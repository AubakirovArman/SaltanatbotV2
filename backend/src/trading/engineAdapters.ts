import type { DataMarketType } from "../providers/provider.js";
import { BinanceAdapter, type ExchangeKeys } from "./exchange/binance.js";
import { BybitAdapter } from "./exchange/bybit.js";
import { PaperAdapter } from "./exchange/paper.js";
import { getSetting, getTradingAccount } from "./store.js";
import type { BotConfig, ExchangeAdapter } from "./types.js";
import { botTradingAccountId, legacyTradingAccountId, tradingAccountBindingIssue } from "./tradingAccounts.js";

export function buildEngineAdapter(config: BotConfig, getPrice: () => number): ExchangeAdapter {
  if (config.exchange === "binance" || config.exchange === "bybit") {
    const accountId = botTradingAccountId(config);
    const issue = tradingAccountBindingIssue(config, getTradingAccount(accountId));
    if (issue) throw new Error(`${issue.code}: ${issue.message}`);
    const keys = getSetting<ExchangeKeys>(`keys:${config.exchange}`) ?? { apiKey: "", apiSecret: "" };
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

/** Signed account adapters used by the global emergency stop even if no bot is running. */
export function buildEmergencyAdapters(): ExchangeAdapter[] {
  const adapters: ExchangeAdapter[] = [];
  for (const exchange of ["binance", "bybit"] as const) {
    const keys = getSetting<ExchangeKeys>(`keys:${exchange}`);
    if (!keys?.apiKey || !keys.apiSecret) continue;
    const accountId = legacyTradingAccountId(exchange);
    // Emergency cancellation/flattening remains available even when account
    // metadata is disabled: old venue exposure may still exist.
    for (const market of ["spot", "futures"] as const) {
      adapters.push(exchange === "binance"
        ? new BinanceAdapter(`emergency-${market}`, keys, market, accountId)
        : new BybitAdapter(`emergency-${market}`, keys, market, accountId));
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
