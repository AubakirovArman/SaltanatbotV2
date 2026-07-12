import type { DataExchange, TradeFlowStatus, TradeFlowTrade } from "../types.js";

export interface TradeFlowConnectorCallbacks {
  onTrades(trades: TradeFlowTrade[]): void;
  onStatus(status: TradeFlowStatus, message: string): void;
}

export interface TradeFlowSubscription {
  close(): void;
}

export type TradeFlowConnector = (
  exchange: DataExchange,
  symbol: string,
  callbacks: TradeFlowConnectorCallbacks
) => TradeFlowSubscription;

export function positiveNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

export function timestamp(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}
