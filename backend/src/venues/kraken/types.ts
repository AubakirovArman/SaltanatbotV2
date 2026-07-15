export interface KrakenSpotInstrumentRow {
  altname?: unknown;
  wsname?: unknown;
  base?: unknown;
  quote?: unknown;
  lot?: unknown;
  pair_decimals?: unknown;
  lot_decimals?: unknown;
  lot_multiplier?: unknown;
  ordermin?: unknown;
  costmin?: unknown;
  tick_size?: unknown;
  status?: unknown;
}

export interface KrakenSpotTickerRow {
  a?: unknown;
  b?: unknown;
  c?: unknown;
  v?: unknown;
}

export interface KrakenSpotDepthRow {
  asks?: unknown;
  bids?: unknown;
}

export type KrakenDerivativeType = "futures_inverse" | "futures_vanilla" | "flexible_futures";

export interface KrakenFuturesInstrumentRow {
  symbol?: unknown;
  pair?: unknown;
  base?: unknown;
  quote?: unknown;
  type?: unknown;
  underlying?: unknown;
  lastTradingTime?: unknown;
  tickSize?: unknown;
  contractSize?: unknown;
  tradeable?: unknown;
  contractValueTradePrecision?: unknown;
  postOnly?: unknown;
  isExpired?: unknown;
}

export interface KrakenFuturesTickerRow {
  tag?: unknown;
  pair?: unknown;
  symbol?: unknown;
  bid?: unknown;
  bidSize?: unknown;
  ask?: unknown;
  askSize?: unknown;
  vol24h?: unknown;
  volumeQuote?: unknown;
  indexPrice?: unknown;
  last?: unknown;
  lastSize?: unknown;
  lastTime?: unknown;
  suspended?: unknown;
  postOnly?: unknown;
  fundingRate?: unknown;
  fundingRatePrediction?: unknown;
}

export interface KrakenFundingRateRow {
  timestamp?: unknown;
  fundingRate?: unknown;
  relativeFundingRate?: unknown;
}

export interface KrakenFuturesOrderBookRow {
  bids?: unknown;
  asks?: unknown;
}
