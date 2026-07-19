import { parsePriceThresholdAlertDefinitionV1, type Candle, type DataExchange, type Instrument, type PriceThresholdAlertDefinitionV1 } from "@saltanatbotv2/contracts";
import { timeframeMs } from "../market/timeframes.js";
import { BinanceProvider } from "../providers/binance.js";
import { BybitProvider } from "../providers/bybit.js";
import { HyperliquidProvider } from "../providers/hyperliquid.js";
import type { CandleRange, MarketProvider } from "../providers/provider.js";
import { candleHasFiniteMarketShape, priceThresholdAlertScopeKey, validateClosedCandleWindow, type ClosedCandleWindowUnavailableReason } from "./priceEvaluator.js";

export type PublicClosedCandleProvider = Pick<MarketProvider, "getCandles">;

export interface PublicClosedCandleReaderDependencies {
  binance?: PublicClosedCandleProvider;
  bybit?: PublicClosedCandleProvider;
  hyperliquid?: PublicClosedCandleProvider;
  now?: () => number;
  requestTimeoutMs?: number;
}

export interface PublicClosedCandleReadOptions {
  /** Recent public bars requested from the venue, including its forming bar. */
  limit?: number;
  /** Final candle open time durably consumed by this rule revision. */
  afterBarTime?: number;
  /** Exact first open time for an uninitialized rule's armed-at candle. */
  startAtBarTime?: number;
}

export type PublicClosedCandleReadResult =
  | {
      status: "ready";
      scopeKey: string;
      observedAt: number;
      exchange: DataExchange;
      candles: readonly Candle[];
    }
  | {
      status: "unavailable";
      reason:
        | "invalid-definition"
        | "invalid-clock"
        | "invalid-limit"
        | "invalid-after-bar-time"
        | "invalid-start-bar-time"
        | "no-new-closed-candle"
        | "upstream-unavailable"
        | "oversized-candle-window"
        | "candle-range-conflict"
        | "forming-candle-order"
        | "candle-finality-conflict"
        | ClosedCandleWindowUnavailableReason;
      scopeKey?: string;
      observedAt: number;
    };

const DEFAULT_LIMIT = 3;
const MAX_LIMIT = 1_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

/**
 * Public REST-only reader for browser-independent alert evaluation. It selects a
 * concrete Binance/Bybit provider directly: no ProviderRouter, persistent candle
 * cache, synthetic fallback, credentials, subscriptions or delivery side effects.
 */
export class PublicClosedCandleReader {
  private readonly binance: PublicClosedCandleProvider;
  private readonly bybit: PublicClosedCandleProvider;
  private readonly hyperliquid: PublicClosedCandleProvider;
  private readonly now: () => number;
  private readonly requestTimeoutMs: number;

  constructor(dependencies: PublicClosedCandleReaderDependencies = {}) {
    this.binance = dependencies.binance ?? new BinanceProvider();
    this.bybit = dependencies.bybit ?? new BybitProvider();
    this.hyperliquid = dependencies.hyperliquid ?? new HyperliquidProvider();
    this.now = dependencies.now ?? Date.now;
    this.requestTimeoutMs = boundedRequestTimeout(dependencies.requestTimeoutMs);
  }

  async read(input: PriceThresholdAlertDefinitionV1, options: PublicClosedCandleReadOptions = {}): Promise<PublicClosedCandleReadResult> {
    const requestedAt = this.now();
    let observedAt = requestedAt;
    if (!Number.isSafeInteger(requestedAt) || requestedAt < 0) {
      return { status: "unavailable", reason: "invalid-clock", observedAt: requestedAt };
    }

    let definition: PriceThresholdAlertDefinitionV1;
    try {
      definition = parsePriceThresholdAlertDefinitionV1(input);
    } catch {
      return {
        status: "unavailable",
        reason: "invalid-definition",
        observedAt
      };
    }
    const scopeKey = priceThresholdAlertScopeKey(definition);
    const limit = options.limit ?? DEFAULT_LIMIT;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      return {
        status: "unavailable",
        reason: "invalid-limit",
        scopeKey,
        observedAt
      };
    }

    const intervalMs = timeframeMs[definition.timeframe];
    const range = candleRange(options.afterBarTime, options.startAtBarTime, intervalMs, observedAt, limit);
    if (!range.ok) {
      return {
        status: "unavailable",
        reason: range.reason,
        scopeKey,
        observedAt
      };
    }

    const provider = definition.exchange === "binance" ? this.binance : definition.exchange === "bybit" ? this.bybit : this.hyperliquid;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    timeout.unref?.();
    let raw: unknown;
    try {
      raw = await provider.getCandles(publicInstrument(definition), definition.timeframe, range.value, { marketType: definition.marketType, priceType: "last", signal: controller.signal });
    } catch {
      return {
        status: "unavailable",
        reason: "upstream-unavailable",
        scopeKey,
        observedAt
      };
    } finally {
      clearTimeout(timeout);
    }
    observedAt = this.now();
    if (!Number.isSafeInteger(observedAt) || observedAt < requestedAt) {
      return {
        status: "unavailable",
        reason: "invalid-clock",
        scopeKey,
        observedAt
      };
    }
    if (!Array.isArray(raw)) {
      return {
        status: "unavailable",
        reason: "malformed-candle",
        scopeKey,
        observedAt
      };
    }
    if (raw.length > limit) {
      return {
        status: "unavailable",
        reason: "oversized-candle-window",
        scopeKey,
        observedAt
      };
    }

    const closed: Candle[] = [];
    let previousTime: number | undefined;
    let formingSeen = false;
    for (let index = 0; index < raw.length; index += 1) {
      const candle = raw[index] as Candle;
      if (!candleHasFiniteMarketShape(candle) || typeof candle.final !== "boolean") {
        return {
          status: "unavailable",
          reason: "malformed-candle",
          scopeKey,
          observedAt
        };
      }
      if (previousTime !== undefined) {
        const delta = candle.time - previousTime;
        if (delta <= 0 || delta < intervalMs || delta % intervalMs !== 0) {
          return {
            status: "unavailable",
            reason: "malformed-candle-sequence",
            scopeKey,
            observedAt
          };
        }
        if (delta !== intervalMs) {
          return {
            status: "unavailable",
            reason: "candle-gap",
            scopeKey,
            observedAt
          };
        }
      }
      previousTime = candle.time;

      if ((range.value.startTime !== undefined && candle.time < range.value.startTime) || (range.value.endTime !== undefined && candle.time > range.value.endTime)) {
        return {
          status: "unavailable",
          reason: "candle-range-conflict",
          scopeKey,
          observedAt
        };
      }

      const serverClosed = candle.time + intervalMs <= observedAt;
      if (candle.final !== serverClosed) {
        return {
          status: "unavailable",
          reason: "candle-finality-conflict",
          scopeKey,
          observedAt
        };
      }
      if (!candle.final) {
        if (formingSeen || index !== raw.length - 1) {
          return {
            status: "unavailable",
            reason: "forming-candle-order",
            scopeKey,
            observedAt
          };
        }
        formingSeen = true;
        continue;
      }
      if (formingSeen) {
        return {
          status: "unavailable",
          reason: "forming-candle-order",
          scopeKey,
          observedAt
        };
      }
      closed.push({ ...candle, final: true });
    }

    if (range.value.startTime !== undefined && closed[0]?.time !== range.value.startTime) {
      return {
        status: "unavailable",
        reason: closed.length === 0 ? "empty-candle-window" : "candle-range-conflict",
        scopeKey,
        observedAt
      };
    }

    const validated = validateClosedCandleWindow(closed, definition.timeframe, observedAt, {
      allowHistoricalTip: options.afterBarTime !== undefined || options.startAtBarTime !== undefined
    });
    if (!validated.ok) {
      return {
        status: "unavailable",
        reason: validated.reason,
        scopeKey,
        observedAt
      };
    }
    return {
      status: "ready",
      scopeKey,
      observedAt,
      exchange: definition.exchange,
      candles: validated.candles.map((candle) => ({ ...candle, final: true }))
    };
  }
}

type CandleRangeResult = { ok: true; value: CandleRange } | { ok: false; reason: "invalid-after-bar-time" | "invalid-start-bar-time" | "no-new-closed-candle" };

function candleRange(afterBarTime: number | undefined, startAtBarTime: number | undefined, intervalMs: number, observedAt: number, limit: number): CandleRangeResult {
  if (afterBarTime !== undefined && startAtBarTime !== undefined) return { ok: false, reason: "invalid-start-bar-time" };
  if (startAtBarTime !== undefined) {
    if (!Number.isSafeInteger(startAtBarTime) || startAtBarTime < 0) return { ok: false, reason: "invalid-start-bar-time" };
    const latestClosedOpenBound = observedAt - intervalMs;
    if (startAtBarTime > latestClosedOpenBound) return { ok: false, reason: "no-new-closed-candle" };
    const requestedEndTime = startAtBarTime + (limit - 1) * intervalMs;
    if (!Number.isSafeInteger(requestedEndTime)) return { ok: false, reason: "invalid-start-bar-time" };
    return { ok: true, value: { limit, startTime: startAtBarTime, endTime: Math.min(latestClosedOpenBound, requestedEndTime) } };
  }
  if (afterBarTime === undefined) return { ok: true, value: { limit } };
  if (!Number.isSafeInteger(afterBarTime) || afterBarTime < 0) {
    return { ok: false, reason: "invalid-after-bar-time" };
  }
  const startTime = afterBarTime + intervalMs;
  const latestClosedOpenBound = observedAt - intervalMs;
  if (!Number.isSafeInteger(startTime) || !Number.isSafeInteger(latestClosedOpenBound) || afterBarTime > latestClosedOpenBound) {
    return { ok: false, reason: "invalid-after-bar-time" };
  }
  if (startTime > latestClosedOpenBound) {
    return { ok: false, reason: "no-new-closed-candle" };
  }
  const requestedEndTime = startTime + (limit - 1) * intervalMs;
  if (!Number.isSafeInteger(requestedEndTime)) {
    return { ok: false, reason: "invalid-after-bar-time" };
  }
  return {
    ok: true,
    value: {
      limit,
      startTime,
      endTime: Math.min(latestClosedOpenBound, requestedEndTime)
    }
  };
}

function publicInstrument(definition: PriceThresholdAlertDefinitionV1): Instrument {
  return {
    symbol: definition.symbol,
    displayName: definition.symbol,
    assetClass: "crypto",
    exchange: definition.exchange === "binance" ? "Binance" : definition.exchange === "bybit" ? "Bybit" : "Hyperliquid",
    currency: "USDT",
    provider: "binance",
    basePrice: 1,
    decimals: 8
  };
}

function boundedRequestTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || value < 10 || value > 60_000) {
    throw new Error("Public candle request timeout must be an integer between 10 and 60000 milliseconds.");
  }
  return value;
}
