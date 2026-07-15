export type MexcMarketType = "spot" | "perpetual";
export type MexcDomain = "spot" | "futures";

export interface MexcErrorEnvelope {
  success?: unknown;
  code?: unknown;
  message?: unknown;
  msg?: unknown;
  data?: unknown;
}

export interface MexcSpotInstrumentRow {
  symbol?: unknown;
  status?: unknown;
  baseAsset?: unknown;
  baseAssetPrecision?: unknown;
  quoteAsset?: unknown;
  quotePrecision?: unknown;
  isSpotTradingAllowed?: unknown;
  quoteAmountPrecision?: unknown;
  baseSizePrecision?: unknown;
  tradeSideType?: unknown;
}

export interface MexcPerpetualInstrumentRow {
  symbol?: unknown;
  baseCoin?: unknown;
  quoteCoin?: unknown;
  settleCoin?: unknown;
  contractSize?: unknown;
  priceUnit?: unknown;
  volUnit?: unknown;
  minVol?: unknown;
  state?: unknown;
  apiAllowed?: unknown;
}

export interface MexcSpotTickerRow {
  symbol?: unknown;
  bidPrice?: unknown;
  bidQty?: unknown;
  askPrice?: unknown;
  askQty?: unknown;
}

export interface MexcSpotDepthRow {
  lastUpdateId?: unknown;
  bids?: unknown;
  asks?: unknown;
}

export interface MexcPerpetualDepthRow {
  version?: unknown;
  timestamp?: unknown;
  bids?: unknown;
  asks?: unknown;
}

export interface MexcFundingRow {
  symbol?: unknown;
  fundingRate?: unknown;
  maxFundingRate?: unknown;
  minFundingRate?: unknown;
  collectCycle?: unknown;
  nextSettleTime?: unknown;
  timestamp?: unknown;
}

export interface MexcFundingHistoryRow {
  symbol?: unknown;
  fundingRate?: unknown;
  settleTime?: unknown;
}

export interface MexcSpotProtobufDepthEnvelope {
  channel?: unknown;
  symbol?: unknown;
  sendTime?: unknown;
  publicAggreDepths?: unknown;
}

export interface MexcFuturesDepthMessage {
  channel?: unknown;
  symbol?: unknown;
  ts?: unknown;
  data?: unknown;
}
