export type OkxInstrumentType = "SPOT" | "SWAP" | "FUTURES";

export interface OkxEnvelope<T> {
  code?: unknown;
  msg?: unknown;
  data?: unknown;
}

export interface OkxInstrumentRow {
  instType?: unknown;
  instId?: unknown;
  instFamily?: unknown;
  uly?: unknown;
  baseCcy?: unknown;
  quoteCcy?: unknown;
  settleCcy?: unknown;
  ctVal?: unknown;
  ctMult?: unknown;
  ctValCcy?: unknown;
  ctType?: unknown;
  tickSz?: unknown;
  lotSz?: unknown;
  minSz?: unknown;
  expTime?: unknown;
  state?: unknown;
}

export interface OkxTickerRow {
  instType?: unknown;
  instId?: unknown;
  last?: unknown;
  lastSz?: unknown;
  askPx?: unknown;
  askSz?: unknown;
  bidPx?: unknown;
  bidSz?: unknown;
  vol24h?: unknown;
  volCcy24h?: unknown;
  ts?: unknown;
}

export interface OkxDepthRow {
  asks?: unknown;
  bids?: unknown;
  ts?: unknown;
  seqId?: unknown;
}

export interface OkxFundingRow {
  instType?: unknown;
  instId?: unknown;
  fundingRate?: unknown;
  nextFundingRate?: unknown;
  fundingTime?: unknown;
  nextFundingTime?: unknown;
  settFundingRate?: unknown;
  minFundingRate?: unknown;
  maxFundingRate?: unknown;
  formulaType?: unknown;
  method?: unknown;
  ts?: unknown;
}

export interface OkxFundingHistoryRow {
  instType?: unknown;
  instId?: unknown;
  fundingRate?: unknown;
  realizedRate?: unknown;
  fundingTime?: unknown;
  formulaType?: unknown;
  method?: unknown;
}
