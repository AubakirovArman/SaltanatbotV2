export type KucoinMarketType = "spot" | "perpetual";
export type KucoinDomain = "spot" | "futures";

export interface KucoinEnvelope {
  code?: unknown;
  data?: unknown;
  msg?: unknown;
  message?: unknown;
}

export interface KucoinSpotInstrumentRow {
  symbol?: unknown;
  baseCurrency?: unknown;
  quoteCurrency?: unknown;
  baseMinSize?: unknown;
  baseIncrement?: unknown;
  priceIncrement?: unknown;
  minFunds?: unknown;
  enableTrading?: unknown;
  callauctionIsEnabled?: unknown;
}

export interface KucoinPerpetualInstrumentRow {
  symbol?: unknown;
  baseCurrency?: unknown;
  quoteCurrency?: unknown;
  settleCurrency?: unknown;
  expireDate?: unknown;
  lotSize?: unknown;
  tickSize?: unknown;
  multiplier?: unknown;
  isInverse?: unknown;
  status?: unknown;
  currentFundingRateGranularity?: unknown;
}

export interface KucoinSpotTickerRow {
  symbol?: unknown;
  bestBid?: unknown;
  bestBidSize?: unknown;
  bestAsk?: unknown;
  bestAskSize?: unknown;
  buy?: unknown;
  sell?: unknown;
  price?: unknown;
  size?: unknown;
  last?: unknown;
  vol?: unknown;
  volValue?: unknown;
  time?: unknown;
}

export interface KucoinPerpetualTickerRow {
  symbol?: unknown;
  bestBidPrice?: unknown;
  bestBidSize?: unknown;
  bestAskPrice?: unknown;
  bestAskSize?: unknown;
  price?: unknown;
  size?: unknown;
  ts?: unknown;
}

export interface KucoinDepthRow {
  sequence?: unknown;
  symbol?: unknown;
  bids?: unknown;
  asks?: unknown;
  time?: unknown;
  ts?: unknown;
}

export interface KucoinCurrentFundingRow {
  symbol?: unknown;
  granularity?: unknown;
  timePoint?: unknown;
  value?: unknown;
  predictedValue?: unknown;
  fundingRateCap?: unknown;
  fundingRateFloor?: unknown;
  fundingTime?: unknown;
}

export interface KucoinFundingHistoryRow {
  symbol?: unknown;
  fundingRate?: unknown;
  timepoint?: unknown;
}

export interface KucoinObuMessage {
  T?: unknown;
  dp?: unknown;
  t?: unknown;
  P?: unknown;
  d?: unknown;
}
