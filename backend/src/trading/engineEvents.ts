import type { AccountState, BotConfig, FillRecord, PositionState } from "./types.js";

export interface TradeEvent {
  type: "bot" | "fill" | "log" | "signal";
  botId: string;
  bot?: BotConfig;
  fill?: FillRecord;
  log?: { level: string; message: string; ts: number };
  signal?: { dir: "up" | "down"; label: string; price: number; ts: number };
  account?: AccountState;
  position?: PositionState | null;
}
