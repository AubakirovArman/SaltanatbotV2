export type GateMarketType = "spot" | "perpetual";

export interface GateErrorEnvelope {
  label?: unknown;
  message?: unknown;
  detail?: unknown;
}

export interface GateSpotInstrumentRow {
  id?: unknown;
  base?: unknown;
  quote?: unknown;
  min_base_amount?: unknown;
  min_quote_amount?: unknown;
  amount_precision?: unknown;
  precision?: unknown;
  trade_status?: unknown;
}

export interface GatePerpetualInstrumentRow {
  name?: unknown;
  type?: unknown;
  quanto_multiplier?: unknown;
  order_price_round?: unknown;
  order_size_min?: unknown;
  order_size_max?: unknown;
  enable_decimal?: unknown;
  settle_currency?: unknown;
  status?: unknown;
  in_delisting?: unknown;
  position_size?: unknown;
  funding_rate?: unknown;
  funding_rate_indicative?: unknown;
  funding_interval?: unknown;
  funding_next_apply?: unknown;
}

export interface GateSpotTickerRow {
  currency_pair?: unknown;
  last?: unknown;
  lowest_ask?: unknown;
  lowest_size?: unknown;
  highest_bid?: unknown;
  highest_size?: unknown;
  base_volume?: unknown;
  quote_volume?: unknown;
}

export interface GatePerpetualTickerRow {
  contract?: unknown;
  last?: unknown;
  lowest_ask?: unknown;
  lowest_size?: unknown;
  highest_bid?: unknown;
  highest_size?: unknown;
  volume_24h?: unknown;
  volume_24h_quote?: unknown;
}

export interface GateOrderBookRow {
  id?: unknown;
  current?: unknown;
  update?: unknown;
  asks?: unknown;
  bids?: unknown;
}

export interface GateFundingHistoryRow {
  t?: unknown;
  r?: unknown;
}
