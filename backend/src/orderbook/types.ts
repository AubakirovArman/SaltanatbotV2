import type { DataExchange, OrderBookSnapshotMessage, OrderBookStatus } from "../types.js";

export interface OrderBookConnectorCallbacks {
  onSnapshot(snapshot: OrderBookSnapshotMessage): void;
  onStatus(status: OrderBookStatus, message: string): void;
}

export interface OrderBookSubscription {
  close(): void;
}

export type OrderBookConnector = (
  exchange: DataExchange,
  symbol: string,
  callbacks: OrderBookConnectorCallbacks
) => OrderBookSubscription;

export function parseRawLevels(value: unknown): Array<[number, number]> | undefined {
  if (!Array.isArray(value)) return undefined;
  const levels: Array<[number, number]> = [];
  for (const raw of value) {
    if (!Array.isArray(raw) || raw.length < 2) return undefined;
    const price = Number(raw[0]);
    const size = Number(raw[1]);
    if (!Number.isFinite(price) || !Number.isFinite(size) || price <= 0 || size < 0) return undefined;
    levels.push([price, size]);
  }
  return levels;
}

export function positiveLevels(levels: Array<[number, number]>, limit = 20) {
  return levels.filter(([, size]) => size > 0).slice(0, limit);
}
