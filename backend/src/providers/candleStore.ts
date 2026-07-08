import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Candle, Timeframe } from "../types.js";

/**
 * Persistent OHLCV store for deep backtest history.
 *
 * Candles cached only in memory (see cache.ts) are lost on restart, which caps
 * how far a backtest can page into the past before re-hammering the exchange
 * REST API. This SQLite-backed store keeps every fetched closed bar keyed by
 * (source, symbol, timeframe, time) so repeated deep backtests are instant and
 * survive restarts.
 *
 * It lives in a SEPARATE database file (`backend/data/candles.db`) and has
 * nothing to do with the trading DB — the two never share a connection or
 * schema. Every operation is guarded so a store failure can never break a
 * market-data request; callers treat the store as best-effort.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(__dirname, "../../data");
const dbPath = path.join(dataDir, "candles.db");

let db: DatabaseSync | undefined;

/** Lazily open (and create) the candle DB. Returns undefined if it can't open. */
function getDb(): DatabaseSync | undefined {
  if (db) return db;
  try {
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    const handle = new DatabaseSync(dbPath);
    handle.exec(`
      CREATE TABLE IF NOT EXISTS candles (
        source TEXT NOT NULL,
        symbol TEXT NOT NULL,
        timeframe TEXT NOT NULL,
        time INTEGER NOT NULL,
        open REAL NOT NULL,
        high REAL NOT NULL,
        low REAL NOT NULL,
        close REAL NOT NULL,
        volume REAL NOT NULL,
        PRIMARY KEY (source, symbol, timeframe, time)
      );
    `);
    db = handle;
    return db;
  } catch {
    // A store that won't open must not break requests — degrade to no-op.
    return undefined;
  }
}

interface CandleRow {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * Persist candles for a series. Fire-and-forget from the caller's perspective:
 * swallows every error and returns silently. Only real exchange bars should be
 * stored — the caller is responsible for filtering out synthetic/fallback data.
 */
export function saveCandles(source: string, symbol: string, timeframe: Timeframe, candles: Candle[]): void {
  if (candles.length === 0) return;
  const handle = getDb();
  if (!handle) return;
  try {
    const stmt = handle.prepare(`
      INSERT INTO candles (source, symbol, timeframe, time, open, high, low, close, volume)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source, symbol, timeframe, time) DO UPDATE SET
        open = excluded.open,
        high = excluded.high,
        low = excluded.low,
        close = excluded.close,
        volume = excluded.volume
    `);
    handle.exec("BEGIN");
    try {
      for (const c of candles) {
        // Only persist closed bars — a still-forming bar would poison history.
        if (c.final === false) continue;
        stmt.run(source, symbol, timeframe, c.time, c.open, c.high, c.low, c.close, c.volume);
      }
      handle.exec("COMMIT");
    } catch (error) {
      handle.exec("ROLLBACK");
      throw error;
    }
  } catch {
    // Best-effort persistence — never propagate.
  }
}

/**
 * Read stored candles for a series in ascending time order. When `startTime`
 * and/or `endTime` are given they bound the window inclusively. `limit` caps
 * the number of most-recent-within-window bars returned (still ascending).
 * Returns [] on any failure.
 */
export function readCandles(
  source: string,
  symbol: string,
  timeframe: Timeframe,
  opts: { startTime?: number; endTime?: number; limit?: number } = {}
): Candle[] {
  const handle = getDb();
  if (!handle) return [];
  try {
    const clauses = ["source = ?", "symbol = ?", "timeframe = ?"];
    const params: Array<string | number> = [source, symbol, timeframe];
    if (opts.startTime !== undefined) {
      clauses.push("time >= ?");
      params.push(opts.startTime);
    }
    if (opts.endTime !== undefined) {
      clauses.push("time <= ?");
      params.push(opts.endTime);
    }
    // To honour `limit` as "most recent bars in window", select DESC + limit
    // then reverse to ascending. Without a limit, select ascending directly.
    const where = clauses.join(" AND ");
    let rows: unknown[];
    if (opts.limit !== undefined) {
      rows = handle
        .prepare(`SELECT time, open, high, low, close, volume FROM candles WHERE ${where} ORDER BY time DESC LIMIT ?`)
        .all(...params, opts.limit);
      rows.reverse();
    } else {
      rows = handle
        .prepare(`SELECT time, open, high, low, close, volume FROM candles WHERE ${where} ORDER BY time ASC`)
        .all(...params);
    }
    return (rows as CandleRow[]).map((row) => ({
      time: row.time,
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      volume: row.volume,
      final: true,
      source
    }));
  } catch {
    return [];
  }
}

/** Min/max stored open time for a series, or undefined if none / on failure. */
export function storedRange(
  source: string,
  symbol: string,
  timeframe: Timeframe
): { min: number; max: number } | undefined {
  const handle = getDb();
  if (!handle) return undefined;
  try {
    const row = handle
      .prepare("SELECT MIN(time) AS min, MAX(time) AS max FROM candles WHERE source = ? AND symbol = ? AND timeframe = ?")
      .get(source, symbol, timeframe) as { min: number | null; max: number | null } | undefined;
    if (!row || row.min === null || row.max === null) return undefined;
    return { min: row.min, max: row.max };
  } catch {
    return undefined;
  }
}

/** How many bars are stored for a series (0 on failure). Handy for tests/diagnostics. */
export function countCandles(source: string, symbol: string, timeframe: Timeframe): number {
  const handle = getDb();
  if (!handle) return 0;
  try {
    const row = handle
      .prepare("SELECT COUNT(*) AS n FROM candles WHERE source = ? AND symbol = ? AND timeframe = ?")
      .get(source, symbol, timeframe) as { n: number } | undefined;
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}
