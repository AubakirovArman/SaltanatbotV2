import type { ScreenerDefinitionV1 } from "@saltanatbotv2/contracts";
import { validateClosedCandleWindow } from "../alerts/priceEvaluator.js";
import { readBoundedText } from "../http/boundedResponse.js";
import { initCatalog, instruments as catalogInstruments } from "../market/catalog.js";
import { fetchWithRetry } from "../providers/http.js";
import { ProviderRouter } from "../providers/router.js";
import type { Candle, Instrument } from "../types.js";
import type { ScreenerEngineUniverseRowV1 } from "./engine.js";

/**
 * Bounded, fail-closed market-data acquisition for one screener run: a snapshot
 * of the Binance spot USDT universe from the shared catalog, ONE 24h ticker
 * request, and per-symbol closed-candle windows fetched through the strict
 * provider route (no synthetic fallback). Failures degrade per symbol into
 * unavailable reasons; only an unusable ticker or empty universe fails the run.
 */

const BINANCE_TICKER_24H_URL = "https://api.binance.com/api/v3/ticker/24hr";
const MAX_TICKER_PAYLOAD_BYTES = 16 * 1024 * 1024;
const TICKER_SYMBOL = /^[A-Z0-9]{2,20}USDT$/;
const TICKER_TIMEOUT_MS = 15_000;
const MIN_CANDLE_REQUEST_LIMIT = 50;
const MAX_CANDLE_REQUEST_LIMIT = 600;

export const SCREENER_CANDLE_CONCURRENCY = 6;
export const SCREENER_RUN_BUDGET_MS = 90_000;

interface BinanceTicker24hRow {
  symbol?: unknown;
  lastPrice?: unknown;
  priceChangePercent?: unknown;
  quoteVolume?: unknown;
}

export interface ScreenerTickerEntryV1 {
  symbol: string;
  lastPrice: number;
  priceChangePercent: number;
  quoteVolume: number;
  observedAt: number;
}

export interface ScreenerMarketDataSnapshotV1 {
  observedAt: number;
  universe: ScreenerEngineUniverseRowV1[];
  candlesBySymbol: Map<string, Candle[]>;
  unavailableReasonBySymbol: Map<string, string>;
}

export interface ScreenerMarketDataDependencies {
  fetch?: typeof fetch;
  candleSource?: Pick<ProviderRouter, "getCandles">;
  /** Instrument snapshot override for tests; defaults to the shared live catalog. */
  instruments?: () => Promise<readonly Instrument[]>;
  now?: () => number;
  concurrency?: number;
  runBudgetMs?: number;
  signal?: AbortSignal;
}

export class ScreenerMarketDataError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "ScreenerMarketDataError";
  }
}

class ScreenerBudgetExhaustedError extends Error {}

/** Warm-up bars needed by the definition's indicator filters, plus cross history. */
export function screenerCandleRequestLimit(definition: ScreenerDefinitionV1): number {
  let warmup = 2;
  for (const filter of definition.filters) {
    if (filter.kind === "rsi" || filter.kind === "atr-percent") warmup = Math.max(warmup, filter.period);
    else if (filter.kind === "ma-cross") warmup = Math.max(warmup, filter.slowPeriod);
    else if (filter.kind === "macd") warmup = Math.max(warmup, filter.slow + filter.signal);
  }
  return Math.max(MIN_CANDLE_REQUEST_LIMIT, Math.min(MAX_CANDLE_REQUEST_LIMIT, warmup + 3));
}

export async function loadScreenerMarketData(
  definition: ScreenerDefinitionV1,
  dependencies: ScreenerMarketDataDependencies = {}
): Promise<ScreenerMarketDataSnapshotV1> {
  const now = dependencies.now ?? Date.now;
  const universeInstruments = await snapshotUniverse(definition, dependencies);
  const ticker = await fetchTickerSnapshot(dependencies.fetch, now, dependencies.signal);
  const observedAt = now();
  const candlesBySymbol = new Map<string, Candle[]>();
  const unavailableReasonBySymbol = new Map<string, string>();
  const universe: ScreenerEngineUniverseRowV1[] = [];
  const pending: Instrument[] = [];
  for (const instrument of universeInstruments) {
    const tickerEntry = ticker.get(instrument.symbol);
    if (!tickerEntry) {
      // A catalog symbol absent from the whole-market ticker is delisted or
      // unreadable right now; fail it closed instead of screening blind.
      universe.push({ symbol: instrument.symbol });
      unavailableReasonBySymbol.set(instrument.symbol, "ticker-unavailable");
      continue;
    }
    universe.push({
      symbol: instrument.symbol,
      lastClose: tickerEntry.lastPrice,
      quoteVolume24h: tickerEntry.quoteVolume,
      change24hPercent: tickerEntry.priceChangePercent
    });
    pending.push(instrument);
  }
  await fetchCandleWindows(definition, pending, candlesBySymbol, unavailableReasonBySymbol, dependencies, now);
  return { observedAt, universe, candlesBySymbol, unavailableReasonBySymbol };
}

async function snapshotUniverse(definition: ScreenerDefinitionV1, dependencies: ScreenerMarketDataDependencies): Promise<Instrument[]> {
  const listInstruments =
    dependencies.instruments ??
    (async () => {
      await initCatalog();
      return catalogInstruments;
    });
  const all = await listInstruments();
  const seen = new Set<string>();
  const selected: Instrument[] = [];
  const sorted = [...all].sort((left, right) => compareSymbols(left.symbol, right.symbol));
  for (const instrument of sorted) {
    if (instrument.assetClass !== "crypto" || instrument.provider !== "binance") continue;
    if (seen.has(instrument.symbol)) continue;
    seen.add(instrument.symbol);
    selected.push({ ...instrument });
    if (selected.length >= definition.universeLimit) break;
  }
  if (selected.length === 0) {
    throw new ScreenerMarketDataError("screener_universe_unavailable", "No Binance spot instruments are available for screening.");
  }
  return selected;
}

async function fetchTickerSnapshot(fetcher: typeof fetch | undefined, now: () => number, signal?: AbortSignal): Promise<Map<string, ScreenerTickerEntryV1>> {
  const controller = new AbortController();
  const abortUpstream = () => controller.abort();
  signal?.addEventListener("abort", abortUpstream, { once: true });
  const timeout = setTimeout(abortUpstream, TICKER_TIMEOUT_MS);
  timeout.unref?.();
  let body: string;
  try {
    const request = { signal: controller.signal, headers: { Accept: "application/json" } };
    // Injected fetch doubles stay hermetic; the live path keeps 429/418 backoff.
    const response = await (fetcher ? fetcher(BINANCE_TICKER_24H_URL, request) : fetchWithRetry(BINANCE_TICKER_24H_URL, request));
    if (!response.ok) {
      throw new ScreenerMarketDataError("screener_ticker_unavailable", `Binance 24h ticker request failed with HTTP ${response.status}.`);
    }
    body = await readBoundedText(response, MAX_TICKER_PAYLOAD_BYTES, () => new ScreenerMarketDataError("screener_ticker_unavailable", "Binance 24h ticker response is too large."));
  } catch (error) {
    if (error instanceof ScreenerMarketDataError) throw error;
    throw new ScreenerMarketDataError("screener_ticker_unavailable", `Binance 24h ticker request failed: ${message(error)}`);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abortUpstream);
  }
  return parseTickerSnapshot(body, now());
}

function parseTickerSnapshot(body: string, observedAt: number): Map<string, ScreenerTickerEntryV1> {
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new ScreenerMarketDataError("screener_ticker_unavailable", "Binance 24h ticker response is not valid JSON.");
  }
  if (!Array.isArray(payload)) {
    throw new ScreenerMarketDataError("screener_ticker_unavailable", "Binance 24h ticker response has an unexpected shape.");
  }
  const entries = new Map<string, ScreenerTickerEntryV1>();
  for (const row of payload as BinanceTicker24hRow[]) {
    const symbol = typeof row?.symbol === "string" ? row.symbol : "";
    if (!TICKER_SYMBOL.test(symbol)) continue;
    const lastPrice = finiteNumber(row.lastPrice);
    const priceChangePercent = finiteNumber(row.priceChangePercent);
    const quoteVolume = finiteNumber(row.quoteVolume);
    if (lastPrice === undefined || lastPrice <= 0 || priceChangePercent === undefined || quoteVolume === undefined || quoteVolume < 0) continue;
    entries.set(symbol, { symbol, lastPrice, priceChangePercent, quoteVolume, observedAt });
  }
  return entries;
}

async function fetchCandleWindows(
  definition: ScreenerDefinitionV1,
  pending: readonly Instrument[],
  candlesBySymbol: Map<string, Candle[]>,
  unavailableReasonBySymbol: Map<string, string>,
  dependencies: ScreenerMarketDataDependencies,
  now: () => number
): Promise<void> {
  const candleSource = dependencies.candleSource ?? new ProviderRouter();
  const limit = screenerCandleRequestLimit(definition);
  const concurrency = Math.max(1, Math.min(dependencies.concurrency ?? SCREENER_CANDLE_CONCURRENCY, pending.length || 1));
  const deadlineAt = now() + (dependencies.runBudgetMs ?? SCREENER_RUN_BUDGET_MS);
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (cursor < pending.length) {
      const instrument = pending[cursor]!;
      cursor += 1;
      const remainingMs = deadlineAt - now();
      if (dependencies.signal?.aborted || remainingMs <= 0) {
        unavailableReasonBySymbol.set(instrument.symbol, "run-budget-exhausted");
        continue;
      }
      try {
        const raw = await withDeadline(
          candleSource.getCandles(instrument, definition.timeframe, { limit }, {
            exchange: definition.exchange,
            marketType: definition.marketType,
            priceType: definition.priceType,
            strict: true
          }),
          remainingMs
        );
        const closed = dropFormingTip(raw);
        const validated = validateClosedCandleWindow(closed, definition.timeframe, now(), { allowHistoricalTip: true });
        if (!validated.ok) {
          unavailableReasonBySymbol.set(instrument.symbol, validated.reason);
          continue;
        }
        candlesBySymbol.set(instrument.symbol, validated.candles.map((candle) => ({ ...candle, final: true })));
      } catch (error) {
        unavailableReasonBySymbol.set(
          instrument.symbol,
          error instanceof ScreenerBudgetExhaustedError ? "run-budget-exhausted" : "upstream-unavailable"
        );
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
}

/** Binance returns the forming bar as the tip; only fully closed bars may be evaluated. */
function dropFormingTip(candles: readonly Candle[]): Candle[] {
  const closed = [...candles];
  while (closed.length > 0 && closed[closed.length - 1]!.final !== true) closed.pop();
  return closed;
}

function withDeadline<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ScreenerBudgetExhaustedError("Screener run budget exhausted.")), timeoutMs);
    timer.unref?.();
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  if (typeof value === "string" && value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function compareSymbols(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function message(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "upstream error";
}
