import type { Instrument } from "../types";

const MAJOR_MARKETS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "ADAUSDT"];

/** Prefer familiar cross-exchange majors, then fill from the live crypto catalog. */
export function pickDistinctMarketSymbols(primarySymbol: string, instruments: Instrument[], count = 4): string[] {
  const available = new Set(instruments.map(({ symbol }) => symbol));
  const crypto = instruments.filter(({ assetClass, provider }) => assetClass === "crypto" && provider === "binance").map(({ symbol }) => symbol);
  const candidates = [primarySymbol, ...MAJOR_MARKETS.filter((symbol) => available.has(symbol)), ...crypto, ...instruments.map(({ symbol }) => symbol)];
  return normalizeDistinctMarketSymbols(primarySymbol, candidates, count);
}

export function normalizeDistinctMarketSymbols(primarySymbol: string, candidates: unknown[], count = 4): string[] {
  const limit = Math.max(1, Math.min(8, Math.floor(count)));
  const selected: string[] = [];
  for (const symbol of [primarySymbol, ...candidates]) {
    if (!validSymbol(symbol) || selected.includes(symbol)) continue;
    selected.push(symbol);
    if (selected.length >= limit) break;
  }
  return selected;
}

function validSymbol(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 64 && !Array.from(value).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}
