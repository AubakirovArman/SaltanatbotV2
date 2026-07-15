import type { RequestHandler } from "express";
import { readBoundedText } from "../../http/boundedResponse.js";
import { abortError, linkedAbortSignal, SharedAbortableWork, throwIfAborted } from "../sharedAbortableWork.js";
import { applyVenueClockProbe, assessCrossVenueSkew, assessExchangeTimestamp, createVenueClockState, estimateVenueClock, resolveVenueClockPolicy } from "./clock.js";
import type { CrossVenueSkewAssessment, ExchangeTimestampAssessment, VenueClockEstimate, VenueClockPolicy, VenueClockProbe, VenueClockState } from "./types.js";

const MAX_TIME_RESPONSE_BYTES = 64 * 1024;

interface TimeEndpoint {
  sourceId: string;
  url: string;
  parse(value: unknown): { serverTime: number; serverResolutionMs: number };
}

export interface VenueClockHealthSource extends VenueClockEstimate {
  ok: boolean;
  endpoint: string;
  message?: string;
}

export interface VenueClockHealthSnapshot {
  schemaVersion: 1;
  updatedAt: number;
  stale: boolean;
  sources: VenueClockHealthSource[];
}

interface ServiceOptions {
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  cacheTtlMs?: number;
  refreshIntervalMs?: number;
  policy?: Partial<VenueClockPolicy>;
  endpoints?: readonly TimeEndpoint[];
}

const DEFAULT_TIME_ENDPOINTS: readonly TimeEndpoint[] = Object.freeze([
  {
    sourceId: "binance:public",
    url: "https://api.binance.com/api/v3/time",
    parse(value) {
      const row = object(value, "Binance time response");
      return { serverTime: safeTimestamp(row.serverTime, "Binance serverTime"), serverResolutionMs: 1 };
    }
  },
  {
    sourceId: "bybit:public",
    url: "https://api.bybit.com/v5/market/time",
    parse(value) {
      const envelope = object(value, "Bybit time response");
      if (envelope.retCode !== 0) throw new Error("Bybit time response was not successful");
      const result = object(envelope.result, "Bybit time result");
      const nanoseconds = decimalInteger(result.timeNano, "Bybit timeNano");
      const serverTime = Number(nanoseconds / 1_000_000n);
      return { serverTime: safeTimestamp(serverTime, "Bybit server time"), serverResolutionMs: 1 };
    }
  },
  {
    sourceId: "okx:public",
    url: "https://www.okx.com/api/v5/public/time",
    parse(value) {
      const envelope = object(value, "OKX time response");
      const data = Array.isArray(envelope.data) ? envelope.data : [];
      const row = object(data[0], "OKX time row");
      const serverTime = Number(decimalInteger(row.ts, "OKX ts"));
      return { serverTime: safeTimestamp(serverTime, "OKX server time"), serverResolutionMs: 1 };
    }
  },
  {
    sourceId: "deribit:public",
    url: "https://www.deribit.com/api/v2/public/get_time",
    parse(value) {
      const envelope = object(value, "Deribit time response");
      if (envelope.jsonrpc !== "2.0") throw new Error("Deribit time response has an invalid JSON-RPC version");
      return { serverTime: safeTimestamp(envelope.result, "Deribit result"), serverResolutionMs: 1 };
    }
  },
  {
    sourceId: "kraken:public",
    url: "https://api.kraken.com/0/public/Time",
    parse(value) {
      const envelope = object(value, "Kraken time response");
      if (!Array.isArray(envelope.error) || envelope.error.length > 0) throw new Error("Kraken time response was not successful");
      const result = object(envelope.result, "Kraken time result");
      return { serverTime: secondsTimestamp(result.unixtime, "Kraken unixtime"), serverResolutionMs: 1_000 };
    }
  },
  {
    sourceId: "coinbase:public",
    url: "https://api.coinbase.com/v2/time",
    parse(value) {
      const envelope = object(value, "Coinbase time response");
      const data = object(envelope.data, "Coinbase time data");
      return { serverTime: secondsTimestamp(data.epoch, "Coinbase epoch"), serverResolutionMs: 1_000 };
    }
  },
  {
    sourceId: "gate:public",
    url: "https://api.gateio.ws/api/v4/spot/time",
    parse(value) {
      const row = object(value, "Gate time response");
      return { serverTime: safeTimestamp(row.server_time, "Gate server_time"), serverResolutionMs: 1 };
    }
  },
  {
    sourceId: "kucoin:public",
    url: "https://api.kucoin.com/api/v1/timestamp",
    parse(value) {
      const envelope = object(value, "KuCoin time response");
      if (envelope.code !== "200000") throw new Error("KuCoin time response was not successful");
      return { serverTime: safeTimestamp(envelope.data, "KuCoin data"), serverResolutionMs: 1 };
    }
  },
  {
    sourceId: "mexc:public",
    url: "https://api.mexc.com/api/v3/time",
    parse(value) {
      const row = object(value, "MEXC time response");
      return { serverTime: safeTimestamp(row.serverTime, "MEXC serverTime"), serverResolutionMs: 1 };
    }
  }
]);

/** Periodically calibrates public venue clocks. It does not use credentials. */
export class VenueClockCalibrationService {
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly cacheTtlMs: number;
  private readonly refreshIntervalMs: number;
  private readonly policy: VenueClockPolicy;
  private readonly endpoints: readonly TimeEndpoint[];
  private readonly work = new SharedAbortableWork<string, VenueClockHealthSnapshot>(1);
  private state: VenueClockState = createVenueClockState();
  private cached?: VenueClockHealthSnapshot;
  private timer?: NodeJS.Timeout;

  constructor(options: ServiceOptions = {}) {
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.cacheTtlMs = options.cacheTtlMs ?? 10_000;
    this.refreshIntervalMs = options.refreshIntervalMs ?? 30_000;
    this.policy = resolveVenueClockPolicy(options.policy);
    this.endpoints = options.endpoints ?? DEFAULT_TIME_ENDPOINTS;
    if (this.endpoints.length < 1 || this.endpoints.length > 16 || new Set(this.endpoints.map(({ sourceId }) => sourceId)).size !== this.endpoints.length) throw new TypeError("Clock endpoints require one to sixteen unique sources");
  }

  start() {
    if (this.timer) return;
    void this.snapshot().catch(() => undefined);
    this.timer = setInterval(() => void this.refresh().catch(() => undefined), this.refreshIntervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async snapshot(signal?: AbortSignal): Promise<VenueClockHealthSnapshot> {
    throwIfAborted(signal);
    if (this.cached && this.now() - this.cached.updatedAt <= this.cacheTtlMs) return this.reassess(this.cached);
    return this.work.run("venue-clock-refresh", (sharedSignal) => this.refresh(sharedSignal), signal);
  }

  /**
   * Converts a venue timestamp to a bounded local-time interval using only
   * accepted calibration samples. This method performs no I/O and therefore
   * can be used on every quote update.
   */
  assessTimestamp(sourceId: string, exchangeTimestamp: number, evaluatedAt: number, limits: { maximumAgeMs: number; maximumFutureSkewMs: number }): ExchangeTimestampAssessment {
    return assessExchangeTimestamp(this.state, sourceId, exchangeTimestamp, evaluatedAt, limits, this.policy);
  }

  /** Conservatively bounds the distance between two corrected event-time intervals. */
  assessSkew(left: ExchangeTimestampAssessment, right: ExchangeTimestampAssessment, maximumSkewMs: number): CrossVenueSkewAssessment {
    return assessCrossVenueSkew(left, right, maximumSkewMs);
  }

  private async refresh(signal?: AbortSignal): Promise<VenueClockHealthSnapshot> {
    const results = await Promise.allSettled(this.endpoints.map((endpoint) => this.probe(endpoint, signal)));
    throwIfAborted(signal);
    const updatedAt = this.now();
    const sources: VenueClockHealthSource[] = [];
    for (const [index, endpoint] of this.endpoints.entries()) {
      const result = results[index]!;
      if (result.status === "fulfilled") {
        const applied = applyVenueClockProbe(this.state, result.value, this.policy);
        this.state = applied.state;
        sources.push({ ...estimateVenueClock(this.state, endpoint.sourceId, updatedAt, this.policy), endpoint: endpoint.url, ok: applied.accepted });
      } else {
        sources.push({
          ...estimateVenueClock(this.state, endpoint.sourceId, updatedAt, this.policy),
          endpoint: endpoint.url,
          ok: false,
          message: result.reason instanceof Error ? result.reason.message : "Clock probe failed"
        });
      }
    }
    const snapshot = { schemaVersion: 1 as const, updatedAt, stale: sources.some((source) => !source.ok || source.status !== "calibrated"), sources };
    this.cached = snapshot;
    return snapshot;
  }

  private reassess(snapshot: VenueClockHealthSnapshot): VenueClockHealthSnapshot {
    const updatedAt = this.now();
    const previous = new Map(snapshot.sources.map((source) => [source.sourceId, source]));
    const sources = this.endpoints.map((endpoint) => {
      const old = previous.get(endpoint.sourceId);
      return {
        ...estimateVenueClock(this.state, endpoint.sourceId, updatedAt, this.policy),
        endpoint: endpoint.url,
        ok: old?.ok ?? false,
        ...(old?.message ? { message: old.message } : {})
      };
    });
    return { schemaVersion: 1, updatedAt, stale: sources.some((source) => !source.ok || source.status !== "calibrated"), sources };
  }

  private async probe(endpoint: TimeEndpoint, signal?: AbortSignal): Promise<VenueClockProbe> {
    const linked = linkedAbortSignal(signal, this.timeoutMs, `${endpoint.sourceId} time request timed out`);
    const localSentAt = this.now();
    try {
      const response = await this.fetcher(endpoint.url, { signal: linked.signal, headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error(`${endpoint.sourceId} time request returned HTTP ${response.status}`);
      const body = await readBoundedText(response, MAX_TIME_RESPONSE_BYTES, () => new Error(`${endpoint.sourceId} time response is too large`));
      const localReceivedAt = this.now();
      throwIfAborted(linked.signal);
      const parsed = endpoint.parse(JSON.parse(body) as unknown);
      return { sourceId: endpoint.sourceId, localSentAt, localReceivedAt, ...parsed };
    } finally {
      linked.cleanup();
    }
  }
}

export function createVenueClockHealthHandler(service: Pick<VenueClockCalibrationService, "snapshot">): RequestHandler {
  return async (request, response) => {
    const controller = new AbortController();
    const abort = () => {
      if (!response.writableEnded) controller.abort(abortError("Client disconnected"));
    };
    request.once("aborted", abort);
    response.once("close", abort);
    try {
      const snapshot = await service.snapshot(controller.signal);
      if (controller.signal.aborted || response.destroyed) return;
      response.setHeader("Cache-Control", "no-store");
      response.json(snapshot);
    } catch (error) {
      if (controller.signal.aborted || response.destroyed) return;
      response.status(503).json({ error: error instanceof Error ? error.message : "Venue clock health unavailable", unavailable: true });
    } finally {
      request.removeListener("aborted", abort);
      response.removeListener("close", abort);
    }
  };
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function safeTimestamp(value: unknown, label: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive millisecond timestamp`);
  return value;
}

function decimalInteger(value: unknown, label: string) {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,24}$/.test(value)) throw new Error(`${label} must be a positive decimal integer`);
  return BigInt(value);
}

function secondsTimestamp(value: unknown, label: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || !Number.isSafeInteger(value * 1_000)) throw new Error(`${label} must be a positive second timestamp`);
  return value * 1_000;
}
