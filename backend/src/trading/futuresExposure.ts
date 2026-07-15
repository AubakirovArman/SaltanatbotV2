import { getSetting, setSetting } from "./store.js";
import type { FillRecord } from "./types.js";

export const FUTURES_EXPOSURE_LEDGER_VERSION = 1;

export interface FuturesExposureLedger {
  version: typeof FUTURES_EXPOSURE_LEDGER_VERSION;
  botId: string;
  symbol: string;
  grossQty: number;
  lastFillId: string;
  updatedAt: number;
}

export function futuresExposureKey(botId: string, symbol: string): string {
  return `futures-exposure:${botId}:${symbol}`;
}

export function getFuturesExposure(botId: string, symbol: string): FuturesExposureLedger | undefined {
  const state = getSetting<FuturesExposureLedger>(futuresExposureKey(botId, symbol));
  return state?.version === FUTURES_EXPOSURE_LEDGER_VERSION ? state : undefined;
}

/** Advance the conservative local exposure boundary after a deduplicated fill. */
export function applyFuturesExposure(
  current: FuturesExposureLedger | undefined,
  fill: FillRecord
): FuturesExposureLedger {
  const prior = current?.grossQty ?? 0;
  const grossQty = fill.kind === "open" ? prior + Math.abs(fill.qty) : Math.max(0, prior - Math.abs(fill.qty));
  return {
    version: FUTURES_EXPOSURE_LEDGER_VERSION,
    botId: fill.botId,
    symbol: fill.symbol,
    grossQty,
    lastFillId: fill.id,
    updatedAt: fill.ts
  };
}

export function recordFuturesExposure(fill: FillRecord): void {
  setSetting(
    futuresExposureKey(fill.botId, fill.symbol),
    applyFuturesExposure(getFuturesExposure(fill.botId, fill.symbol), fill)
  );
}
