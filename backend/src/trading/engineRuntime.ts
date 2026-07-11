import type { Candle, Instrument } from "../types.js";
import type { MarketSubscription } from "../providers/provider.js";
import type { PaperAdapter } from "./exchange/paper.js";
import type { BotConfig, ExchangeAdapter, PrivateOrderSubscription } from "./types.js";

export interface Managed {
  side: "long" | "short";
  entry: number;
  /** Filled base quantity — used for unrealized-PnL ctx reads. */
  qty: number;
  /** Bar time at entry — used for bars-in-position ctx reads. */
  entryTime: number;
  stop?: number;
  target?: number;
  trail?: { mode: "percent" | "atr"; value: number };
}

export interface BotStateSnapshot {
  vars: Record<string, number>;
  managed?: Managed;
  paused?: boolean;
  pauseReason?: string;
  /** Time of the last bar this bot evaluated — used for the resume staleness gate. */
  lastBarTime: number;
  savedAt: number;
}

export interface RunningBot {
  config: BotConfig;
  adapter: ExchangeAdapter;
  paper?: PaperAdapter;
  instrument: Instrument;
  buffer: Candle[];
  sub?: MarketSubscription;
  price: number;
  managed?: Managed;
  /** Persistent `setvar` store — survives across bars for backtest/live parity. */
  vars: Map<string, number>;
  /** Last known account equity (for the ctx equity read; carried on read failure). */
  lastEquity?: number;
  /**
   * True when the bot was auto-resumed with stale risky state (open position or
   * nonzero counters after a long downtime). It buffers data but does NOT trade
   * until an operator confirms via confirmResume() — see the resume staleness gate.
   */
  paused?: boolean;
  pauseReason?: string;
  /** Serializes market-event handling so one candle cannot race another. */
  eventQueue: Promise<void>;
  /** Last closed bar already evaluated by this runtime. */
  lastEvaluatedBarTime?: number;
  /** Exchange request in flight; prevents duplicate entry/exit calls. */
  orderInFlight?: boolean;
  /** Signed REST fallback while private order streams are not connected. */
  orderPollTimer?: ReturnType<typeof setInterval>;
  orderPollOffset?: number;
  privateOrderSubscription?: PrivateOrderSubscription;
}
