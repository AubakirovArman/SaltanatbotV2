import { createHash } from "node:crypto";
import type { ExchangeKeys } from "../../trading/exchange/binance.js";
import { linkedAbortSignal, SharedAbortableWork, throwIfAborted } from "../sharedAbortableWork.js";
import { UpstreamResourceGovernor, type UpstreamGovernorSnapshot } from "../upstream/resourceGovernor/index.js";
import { collectBinanceTelemetry } from "./binance.js";
import { collectBybitTelemetry } from "./bybit.js";
import { ACCOUNT_TELEMETRY_TTL_MS, issue, safeMessage } from "./helpers.js";
import { collectStablecoinFx, type StablecoinFxOptions } from "./stableFx.js";
import { BinanceReadonlyTelemetryTransport, type BinanceTelemetryRequester, BybitReadonlyTelemetryTransport, type BybitTelemetryRequester } from "./transport.js";
import type { AccountTelemetryIssue, AccountTelemetryReadiness, AccountTelemetryRequest, AccountTelemetrySnapshot, AccountTelemetryVenue, StablecoinFxTelemetry, VenueAccountTelemetry } from "./types.js";

const PRIVATE_SOURCE = {
  binance: "binance.account-telemetry",
  bybit: "bybit.account-telemetry"
} as const;

export interface AccountTelemetryServiceOptions {
  keys: (venue: AccountTelemetryVenue) => ExchangeKeys | undefined;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  governor?: UpstreamResourceGovernor;
  publicGovernor?: StablecoinFxOptions["governor"];
  binanceRequester?: BinanceTelemetryRequester;
  bybitRequester?: BybitTelemetryRequester;
  binanceSpotBase?: string;
  binanceFuturesBase?: string;
  bybitBase?: string;
}

/**
 * Protected, read-only account telemetry coordinator. It never accepts a key
 * from an HTTP request and its public result contains no credential material.
 */
export class AccountTelemetryService {
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly governor: UpstreamResourceGovernor;
  private readonly work = new SharedAbortableWork<string, AccountTelemetrySnapshot>(4);
  private readonly cache = new Map<string, AccountTelemetrySnapshot>();

  constructor(private readonly options: AccountTelemetryServiceOptions) {
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.governor = options.governor ?? new UpstreamResourceGovernor({
      [PRIVATE_SOURCE.binance]: { maxConcurrent: 1, failureThreshold: 3, cooldownMs: 30_000 },
      [PRIVATE_SOURCE.bybit]: { maxConcurrent: 1, failureThreshold: 3, cooldownMs: 30_000 }
    }, this.now);
  }

  snapshot(request: AccountTelemetryRequest, signal?: AbortSignal): Promise<AccountTelemetrySnapshot> {
    throwIfAborted(signal);
    const normalized = normalizeRequest(request);
    const key = JSON.stringify([normalized, this.credentialFingerprint(normalized.venues)]);
    const cached = this.cache.get(key);
    if (cached && cached.validUntil > this.now()) return Promise.resolve(structuredClone(cached));
    if (cached) this.cache.delete(key);
    return this.work.run(key, async (sharedSignal) => {
      const linked = linkedAbortSignal(sharedSignal, this.timeoutMs, "Account telemetry refresh timed out");
      try {
        const snapshot = await this.refresh(normalized, linked.signal);
        if (snapshot.validUntil > this.now()) this.remember(key, snapshot);
        return snapshot;
      } finally {
        linked.cleanup();
      }
    }, signal);
  }

  governorSnapshot(): UpstreamGovernorSnapshot {
    return this.governor.snapshot();
  }

  private credentialFingerprint(venues: readonly AccountTelemetryVenue[]) {
    const digest = createHash("sha256");
    for (const venue of venues) {
      const keys = this.options.keys(venue);
      digest.update(venue).update("\0").update(keys?.apiKey ?? "").update("\0").update(keys?.apiSecret ?? "").update("\0");
    }
    return digest.digest("hex");
  }

  private remember(key: string, snapshot: AccountTelemetrySnapshot) {
    this.cache.delete(key);
    this.cache.set(key, structuredClone(snapshot));
    while (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value!);
  }

  private async refresh(request: AccountTelemetryRequest, signal: AbortSignal): Promise<AccountTelemetrySnapshot> {
    const venuePromises = request.venues.map((venue) => this.collectVenue(venue, request, signal));
    const stablePromise = collectStablecoinFx(request, signal, {
      fetch: this.options.fetch,
      now: this.now,
      timeoutMs: Math.min(5_000, this.timeoutMs),
      governor: this.options.publicGovernor,
      binanceBase: this.options.binanceSpotBase,
      bybitBase: this.options.bybitBase
    });
    const [venueResults, stableResult] = await Promise.all([Promise.all(venuePromises), stablePromise]);
    const generatedAt = this.now();
    const venues = venueResults.sort((left, right) => left.venue.localeCompare(right.venue));
    const issues = [...venues.flatMap((venue) => venue.issues), ...stableResult.issues];
    const readiness = readinessFor(request, venues, stableResult.quotes);
    const evidenceValidity = [
      ...venues.map((venue) => venue.validUntil),
      ...stableResult.quotes.map((quote) => quote.evidence.validUntil)
    ].filter((value) => Number.isSafeInteger(value) && value > 0);
    return {
      schemaVersion: 1,
      readOnly: true,
      generatedAt,
      validUntil: evidenceValidity.length > 0 ? Math.min(...evidenceValidity) : generatedAt,
      complete: issues.length === 0 && venues.every((venue) => venue.status === "fresh") && stableResult.quotes.length === request.venues.length * request.stableAssets.length,
      request: {
        venues: [...request.venues],
        symbols: [...request.symbols],
        assets: [...request.assets],
        stableAssets: [...request.stableAssets]
      },
      venues,
      stablecoinFx: stableResult.quotes,
      issues,
      readiness,
      governor: this.governor.snapshot()
    };
  }

  private async collectVenue(venue: AccountTelemetryVenue, request: AccountTelemetryRequest, signal: AbortSignal): Promise<VenueAccountTelemetry> {
    const keys = this.options.keys(venue);
    if (!keys?.apiKey || !keys.apiSecret) return unconfigured(venue, this.now());
    const collect = async () => {
      if (venue === "binance") {
        const requester = this.options.binanceRequester ?? new BinanceReadonlyTelemetryTransport(keys, {
          fetch: this.options.fetch,
          now: this.now,
          timeoutMs: Math.min(5_000, this.timeoutMs),
          binanceSpotBase: this.options.binanceSpotBase,
          binanceFuturesBase: this.options.binanceFuturesBase
        });
        return collectBinanceTelemetry(requester, request, this.now, signal);
      }
      const requester = this.options.bybitRequester ?? new BybitReadonlyTelemetryTransport(keys, {
        fetch: this.options.fetch,
        now: this.now,
        timeoutMs: Math.min(5_000, this.timeoutMs),
        bybitBase: this.options.bybitBase
      });
      return collectBybitTelemetry(requester, request, this.now, signal);
    };
    try {
      return await this.governor.run(PRIVATE_SOURCE[venue], collect, { classifyError: (error) => error instanceof Error && error.name === "AbortError" ? "aborted" : "failure" });
    } catch (error) {
      const generatedAt = this.now();
      const dimensions = ["fee", "borrow", "transfer-network"] as const;
      return {
        venue,
        configured: true,
        status: "unavailable",
        generatedAt,
        validUntil: generatedAt,
        fees: [],
        borrow: [],
        transferNetworks: [],
        issues: dimensions.map((dimension) => issue(venue, dimension, error))
      };
    }
  }
}

function normalizeRequest(request: AccountTelemetryRequest): AccountTelemetryRequest {
  const venues = unique(request.venues).sort();
  const symbols = unique(request.symbols.map((value) => value.toUpperCase())).sort();
  const assets = unique(request.assets.map((value) => value.toUpperCase())).sort();
  const stableAssets = unique(request.stableAssets.map((value) => value.toUpperCase())).sort();
  if (venues.length < 1 || venues.length > 2 || venues.some((value) => value !== "binance" && value !== "bybit")) throw new Error("Account telemetry venues are invalid");
  if (symbols.length < 1 || symbols.length > 2 || symbols.some((value) => !/^[A-Z0-9]{3,30}$/.test(value))) throw new Error("Account telemetry supports one or two valid symbols per refresh");
  if (assets.length < 1 || assets.length > 4 || assets.some((value) => !/^[A-Z0-9]{2,15}$/.test(value))) throw new Error("Account telemetry supports one to four valid assets per refresh");
  if (stableAssets.length < 1 || stableAssets.length > 3 || stableAssets.includes("USDT") || stableAssets.some((value) => !/^[A-Z0-9]{2,15}$/.test(value))) throw new Error("Stablecoin telemetry supports one to three non-USDT assets per refresh");
  return { venues, symbols, assets, stableAssets };
}

function unconfigured(venue: AccountTelemetryVenue, now: number): VenueAccountTelemetry {
  return {
    venue,
    configured: false,
    status: "unconfigured",
    generatedAt: now,
    validUntil: now,
    fees: [],
    borrow: [],
    transferNetworks: [],
    issues: [
      { venue, dimension: "fee", code: "unavailable", message: `${venue} account telemetry is not configured` },
      { venue, dimension: "borrow", code: "unavailable", message: `${venue} account telemetry is not configured` },
      { venue, dimension: "transfer-network", code: "unavailable", message: `${venue} account telemetry is not configured` }
    ]
  };
}

function readinessFor(request: AccountTelemetryRequest, venues: readonly VenueAccountTelemetry[], fx: readonly StablecoinFxTelemetry[]): AccountTelemetryReadiness {
  const expectedFees = request.symbols.length * 2;
  const feeRates = venues.every((venue) => venue.fees.length === expectedFees && venue.fees.every((fee) => fee.usableForRateRanking));
  const borrowCapacityAndRate = venues.every((venue) => request.assets.every((asset) => venue.borrow.some((row) => row.asset === asset && row.usableForProjectedCost)));
  const transferNetworks = venues.every((venue) => request.assets.every((asset) => venue.transferNetworks.some((row) => row.asset === asset && row.usableForTransfer)));
  const stablecoinFx = request.stableAssets.every((asset) => fx.some((row) => row.baseAsset === asset && row.usableForEconomics));
  const blockers = [
    ...(feeRates ? [] : ["fee-rate coverage is incomplete or stale"]),
    "future commission asset is execution-dependent; authenticated fills remain mandatory",
    ...(borrowCapacityAndRate ? [] : ["borrow capacity or current rate coverage is incomplete"]),
    "venue APIs do not prove a non-recallable borrow contract",
    ...(transferNetworks ? [] : ["no currently usable deposit/withdraw network exists for every requested asset and venue"]),
    ...(stablecoinFx ? [] : ["no venue-timestamped stablecoin FX quote exists for every requested stable asset"])
  ];
  return { feeRates, feeAssets: false, borrowCapacityAndRate, borrowRecall: false, transferNetworks, stablecoinFx, executable: false, blockers };
}

function unique<T>(values: readonly T[]) {
  return [...new Set(values)];
}

export function accountTelemetryErrorMessage(error: unknown) {
  return safeMessage(error);
}

export { ACCOUNT_TELEMETRY_TTL_MS };
