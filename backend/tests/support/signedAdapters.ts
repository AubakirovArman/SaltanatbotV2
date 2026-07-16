import { BinanceAdapter as ProductionBinanceAdapter, type ExchangeKeys } from "../../src/trading/exchange/binance.js";
import { BybitAdapter as ProductionBybitAdapter } from "../../src/trading/exchange/bybit.js";
import type { MarketType } from "../../src/trading/types.js";
import { runtimePolicyFromConfig } from "../../src/runtimeProfile.js";
import { signedRequestAuthorizerForTests } from "./signedRequestAuthorizer.js";

const FUTURE_LIVE_POLICY = runtimePolicyFromConfig({ runtimeProfile: "private-live" });

/** Test-only adapters keep production constructors mandatory and fail-closed. */
export class BinanceAdapter extends ProductionBinanceAdapter {
  constructor(botId: string, keys: ExchangeKeys, market: MarketType, accountId?: string) {
    super(botId, keys, market, signedRequestAuthorizerForTests(), accountId, { runtimePolicy: FUTURE_LIVE_POLICY });
  }
}

export class BybitAdapter extends ProductionBybitAdapter {
  constructor(botId: string, keys: ExchangeKeys, market: MarketType, accountId?: string) {
    super(botId, keys, market, signedRequestAuthorizerForTests(), accountId, { runtimePolicy: FUTURE_LIVE_POLICY });
  }
}
