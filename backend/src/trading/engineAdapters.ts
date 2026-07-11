import type { DataMarketType } from "../providers/provider.js";
import { BinanceAdapter, type ExchangeKeys } from "./exchange/binance.js";
import { BybitAdapter } from "./exchange/bybit.js";
import { PaperAdapter } from "./exchange/paper.js";
import { getSetting } from "./store.js";
import type { BotConfig, ExchangeAdapter } from "./types.js";

export function buildEngineAdapter(config: BotConfig, getPrice: () => number): ExchangeAdapter {
  if (config.exchange === "binance" || config.exchange === "bybit") {
    const keys = getSetting<ExchangeKeys>(`keys:${config.exchange}`) ?? { apiKey: "", apiSecret: "" };
    return config.exchange === "binance" ? new BinanceAdapter(config.id, keys, config.market) : new BybitAdapter(config.id, keys, config.market);
  }
  return new PaperAdapter({
    botId: config.id,
    market: config.market,
    startBalance: config.sizeMode === "quote" ? Math.max(config.sizeValue * 10, 10_000) : 10_000,
    feePct: 0.05,
    slipPct: 0.02,
    getPrice
  });
}

export function engineMarketRoute(config: BotConfig): { exchange: "binance" | "bybit"; marketType: DataMarketType; priceType: "last" } {
  return {
    exchange: config.exchange === "bybit" ? "bybit" : "binance",
    marketType: config.market === "futures" ? "linear" : "spot",
    priceType: "last"
  };
}
