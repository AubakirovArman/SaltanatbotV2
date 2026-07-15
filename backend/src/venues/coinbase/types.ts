export interface CoinbaseProductRow {
  id?: unknown;
  base_currency?: unknown;
  quote_currency?: unknown;
  quote_increment?: unknown;
  base_increment?: unknown;
  min_market_funds?: unknown;
  status?: unknown;
  trading_disabled?: unknown;
  cancel_only?: unknown;
  post_only?: unknown;
  limit_only?: unknown;
  fx_stablecoin?: unknown;
  auction_mode?: unknown;
}

export interface CoinbaseBookRow {
  sequence?: unknown;
  bids?: unknown;
  asks?: unknown;
  time?: unknown;
  auction_mode?: unknown;
  auction?: unknown;
}

export interface CoinbaseErrorEnvelope {
  message?: unknown;
}
