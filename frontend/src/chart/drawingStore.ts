import type { DrawingObject } from "./drawings";

const keyFor = (symbol: string) => `mf:drawings:${symbol}`;

/** Drawings are keyed by symbol and visible across all timeframes (TV semantics). */
export function loadDrawings(symbol: string): DrawingObject[] {
  try {
    const raw = window.localStorage.getItem(keyFor(symbol));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as DrawingObject[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveDrawings(symbol: string, drawings: DrawingObject[]) {
  try {
    if (drawings.length === 0) window.localStorage.removeItem(keyFor(symbol));
    else window.localStorage.setItem(keyFor(symbol), JSON.stringify(drawings));
  } catch {
    // Non-fatal: private mode etc.
  }
}
