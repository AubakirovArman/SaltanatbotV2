import { PAPER_FILL_MODEL_V1 } from "@saltanatbotv2/execution-core";
import type { DataMarketType } from "../providers/provider.js";
import { BinanceAdapter, type ExchangeKeys } from "./exchange/binance.js";
import { BybitAdapter } from "./exchange/bybit.js";
import { PaperAdapter, type PaperFillBehavior } from "./exchange/paper.js";
import { DENY_SIGNED_REQUEST_AUTHORIZER } from "./exchange/signedRequestGate.js";
import { getTradingAccountCredentialsForOwner, getTradingAccountForOwner, listTradingAccountsForOwner } from "./store.js";
import type { BotConfig, ExchangeAdapter } from "./types.js";
import { botTradingAccountId, tradingAccountBindingIssue } from "./tradingAccounts.js";
import { assertLiveExecutionAllowed, assertPrivateExchangeAccess, getRuntimePolicy, type RuntimePolicy } from "../runtimeProfile.js";

export function buildEngineAdapter(config: BotConfig, getPrice: () => number, policy: RuntimePolicy = getRuntimePolicy()): ExchangeAdapter {
  if (config.exchange === "binance" || config.exchange === "bybit") {
    assertLiveExecutionAllowed("live bot adapter construction", policy);
    assertPrivateExchangeAccess("live bot credential access", "read", policy);
    const ownerUserId = config.ownerUserId?.trim();
    if (!ownerUserId) throw new Error("Live bot owner is missing; refusing to load trading credentials.");
    const accountId = botTradingAccountId(config);
    const issue = tradingAccountBindingIssue(config, getTradingAccountForOwner(ownerUserId, accountId));
    if (issue) throw new Error(`${issue.code}: ${issue.message}`);
    const keys = getTradingAccountCredentialsForOwner<ExchangeKeys>(ownerUserId, accountId) ?? { apiKey: "", apiSecret: "" };
    if (!keys.apiKey || !keys.apiSecret) throw new Error(`Credentials are not configured for trading account ${accountId}.`);
    return config.exchange === "binance"
      ? new BinanceAdapter(config.id, keys, config.market, DENY_SIGNED_REQUEST_AUTHORIZER, accountId)
      : new BybitAdapter(config.id, keys, config.market, DENY_SIGNED_REQUEST_AUTHORIZER, accountId);
  }
  return new PaperAdapter({
    botId: config.id,
    ledgerEpoch: paperLedgerEpoch(config),
    accountId: botTradingAccountId(config),
    market: config.market,
    startBalance: paperStartBalance(config),
    feePct: PAPER_FILL_MODEL_V1.feePct,
    slipPct: PAPER_FILL_MODEL_V1.slipPct,
    fillBehavior: paperFillBehavior(config),
    getPrice
  });
}

/** Same-side fill semantics stamped per bot: DCA safety orders and grid buy
 * levels both accumulate inventory, so both kinds average adds. */
export function paperFillBehavior(config: BotConfig): PaperFillBehavior {
  return config.kind === "dca" || config.kind === "grid" ? "averaging-v1" : "single-position-v1";
}

function paperLedgerEpoch(config: BotConfig): number {
  const value = config.paperLedgerEpoch ?? 1;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Paper bot ${config.id} has an invalid ledger epoch`);
  }
  return value;
}

/** Start balance backing a paper robot: its reserved allocation when bound. */
export function paperStartBalance(config: BotConfig): number {
  if (config.paperAllocationMicros !== undefined) {
    if (
      !Number.isSafeInteger(config.paperAllocationMicros)
      || config.paperAllocationMicros <= 0
      || config.paperAllocationMicros > 1_000_000_000_000_000
    ) {
      throw new Error(`Paper bot ${config.id} has an invalid capital reservation`);
    }
    return config.paperAllocationMicros / 1_000_000;
  }
  return config.sizeMode === "quote" ? Math.max(config.sizeValue * 10, 10_000) : 10_000;
}

/** Signed account adapters for one owner, including accounts with no running bot. */
export function buildEmergencyAdapters(ownerUserId: string, policy: RuntimePolicy = getRuntimePolicy()): ExchangeAdapter[] {
  if (!policy.privateExchangeMutationsAllowed) return [];
  assertPrivateExchangeAccess("emergency exchange adapter construction", "mutation", policy);
  const adapters: ExchangeAdapter[] = [];
  for (const account of listTradingAccountsForOwner(ownerUserId)) {
    const keys = getTradingAccountCredentialsForOwner<ExchangeKeys>(ownerUserId, account.id);
    if (!keys?.apiKey || !keys.apiSecret) continue;
    // Emergency cancellation/flattening remains available even when account
    // metadata is disabled: old venue exposure may still exist.
    for (const market of ["spot", "futures"] as const) {
      adapters.push(account.exchange === "binance"
        ? new BinanceAdapter(`emergency-${market}`, keys, market, DENY_SIGNED_REQUEST_AUTHORIZER, account.id)
        : new BybitAdapter(`emergency-${market}`, keys, market, DENY_SIGNED_REQUEST_AUTHORIZER, account.id));
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
