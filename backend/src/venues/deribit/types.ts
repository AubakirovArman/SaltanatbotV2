import type { RegistryInstrument, VenueMarketType, VenueQuantityUnit } from "@saltanatbotv2/contracts";
import type { PublicDepthSnapshot, PublicFundingPoint, PublicFundingSchedule, PublicTopBook } from "../publicTypes.js";

export type DeribitEnvironment = "production" | "test";
export type DeribitKind = "future" | "option";
export type DeribitInstrumentType = "linear" | "reversed";
export type DeribitMarketType = Extract<VenueMarketType, "perpetual" | "future" | "option">;

export type DeribitPublicMethod =
  | "public/get_instrument"
  | "public/get_instruments"
  | "public/get_order_book"
  | "public/get_funding_rate_history"
  | "public/ticker";

export interface DeribitInstrumentRow {
  instrument_id?: unknown;
  instrument_name?: unknown;
  kind?: unknown;
  base_currency?: unknown;
  quote_currency?: unknown;
  counter_currency?: unknown;
  settlement_currency?: unknown;
  settlement_period?: unknown;
  instrument_type?: unknown;
  contract_size?: unknown;
  min_trade_amount?: unknown;
  qty_tick_size?: unknown;
  tick_size?: unknown;
  tick_size_steps?: unknown;
  price_index?: unknown;
  creation_timestamp?: unknown;
  expiration_timestamp?: unknown;
  strike?: unknown;
  option_type?: unknown;
  maker_commission?: unknown;
  taker_commission?: unknown;
  is_active?: unknown;
  state?: unknown;
  underlying_type?: unknown;
}

export interface DeribitTickerRow {
  instrument_name?: unknown;
  timestamp?: unknown;
  state?: unknown;
  best_bid_price?: unknown;
  best_bid_amount?: unknown;
  best_ask_price?: unknown;
  best_ask_amount?: unknown;
  last_price?: unknown;
  mark_price?: unknown;
  index_price?: unknown;
  current_funding?: unknown;
  funding_8h?: unknown;
  stats?: unknown;
}

export interface DeribitOrderBookRow extends DeribitTickerRow {
  bids?: unknown;
  asks?: unknown;
  change_id?: unknown;
}

export interface DeribitFundingHistoryRow {
  timestamp?: unknown;
  index_price?: unknown;
  prev_index_price?: unknown;
  interest_1h?: unknown;
  interest_8h?: unknown;
}

export interface DeribitTickSizeStep {
  abovePrice: number;
  tickSize: number;
}

/** Normalized metadata keeps Deribit's native amount unit separate from contract size. */
export interface DeribitInstrument extends RegistryInstrument {
  venue: "deribit";
  marketType: DeribitMarketType;
  quantityUnit: VenueQuantityUnit;
  deribitInstrumentId: number;
  instrumentType: DeribitInstrumentType;
  settlementPeriod: string;
  priceIndex: string;
  creationTime: number;
  contractSize: number;
  contractSizeCurrency: string;
  nativeAmountUnit: VenueQuantityUnit;
  quantityStepSource: "qty_tick_size" | "min_trade_amount";
  minimumNotionalPublished: false;
  tickSizeSchedule: DeribitTickSizeStep[];
  makerCommissionRate: number;
  takerCommissionRate: number;
  settlementMode: "cash-economic-equivalent";
  settlementProcess: "cash" | "future-then-immediate-cash";
  premiumAsset?: string;
  exerciseStyle?: "european";
  automaticExercise?: true;
  underlyingType?: "crypto" | "commodity" | "equity";
}

export interface DeribitTopBook extends PublicTopBook {
  venue: "deribit";
  marketType: DeribitMarketType;
  source: "public/ticker";
  executable: true;
  priceUnit: string;
  amountUnit: VenueQuantityUnit;
  markPrice: number;
  indexPrice: number;
}

export interface DeribitDepthSnapshot extends PublicDepthSnapshot {
  venue: "deribit";
  marketType: DeribitMarketType;
  source: "public/get_order_book";
  executable: true;
  priceUnit: string;
  amountUnit: VenueQuantityUnit;
  markPrice: number;
  indexPrice: number;
}

export interface DeribitFundingPoint extends PublicFundingPoint {
  interest1h: number;
  indexPrice: number;
  previousIndexPrice: number;
  formulaType: "deribit-interest";
  method: "hourly-observation-of-8h-rate";
}

export interface DeribitFundingSchedule extends Omit<PublicFundingSchedule, "history"> {
  currentFunding: number;
  referenceHorizonMinutes: 480;
  accrual: "continuous";
  history: DeribitFundingPoint[];
}
