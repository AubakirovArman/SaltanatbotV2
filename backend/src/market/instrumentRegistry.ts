import type { RegistryInstrument, VenueCapabilityManifest, VenueMarketType } from "@saltanatbotv2/contracts";
import { DERIBIT_PUBLIC_CAPABILITIES } from "../venues/deribit/index.js";
import { GATE_PUBLIC_CAPABILITIES } from "../venues/gate/index.js";
import { HYPERLIQUID_PUBLIC_CAPABILITIES } from "../venues/hyperliquid/index.js";
import { OKX_PUBLIC_CAPABILITIES, OkxPublicAdapter } from "../venues/okx/index.js";
import { KRAKEN_PUBLIC_CAPABILITIES } from "../venues/kraken/index.js";
import { COINBASE_PUBLIC_CAPABILITIES } from "../venues/coinbase/index.js";
import { DYDX_PUBLIC_CAPABILITIES } from "../venues/dydx/index.js";
import { KUCOIN_PUBLIC_CAPABILITIES } from "../venues/kucoin/index.js";
import { MEXC_PUBLIC_CAPABILITIES } from "../venues/mexc/index.js";
import { publicVenueAdapters } from "../venues/publicRegistry.js";
import type { PublicInstrumentSnapshot, PublicVenueAdapter } from "../venues/publicTypes.js";
import { reviewedBasisEconomicAssetId, withReviewedEconomicAssetIdentity } from "./economicAssetIdentity.js";
import { readBoundedText } from "../http/boundedResponse.js";

const BINANCE_SPOT_INFO = "https://api.binance.com/api/v3/exchangeInfo";
const BINANCE_FUTURES_INFO = "https://fapi.binance.com/fapi/v1/exchangeInfo";
const BINANCE_FUNDING_INFO = "https://fapi.binance.com/fapi/v1/fundingInfo";
const BYBIT_INSTRUMENTS = "https://api.bybit.com/v5/market/instruments-info";
const MAX_REGISTRY_PAYLOAD_BYTES = 32 * 1024 * 1024;
export const DEFAULT_REGISTRY_MAX_STALE_MS = 6 * 60 * 60_000;

interface RegistryOptions {
  fetch?: typeof fetch;
  now?: () => number;
  cacheTtlMs?: number;
  maxStaleMs?: number;
  timeoutMs?: number;
  okxBaseUrl?: string;
  /** Production discovers the other credential-free adapters; isolated fetch fixtures opt in explicitly. */
  extendedPublicAdapters?: false | ReadonlyMap<string, Pick<PublicVenueAdapter, "venue" | "capabilities" | "instruments">>;
}

interface ExtendedPublicSource {
  adapter: Pick<PublicVenueAdapter, "venue" | "instruments">;
  marketType: VenueMarketType;
  key: string;
  label: string;
}

interface ReceivedPayload<T> {
  payload: T;
  /** Local time immediately after this specific source response was decoded. */
  receivedAt: number;
}

interface BinanceFilter {
  filterType?: string;
  tickSize?: string;
  stepSize?: string;
  minQty?: string;
  minNotional?: string;
  notional?: string;
}

interface BinanceSymbol {
  symbol?: string;
  pair?: string;
  status?: string;
  contractType?: string;
  deliveryDate?: number;
  baseAsset?: string;
  quoteAsset?: string;
  marginAsset?: string;
  filters?: BinanceFilter[];
  isSpotTradingAllowed?: boolean;
}

interface BinanceExchangeInfo {
  symbols?: BinanceSymbol[];
}

interface BinanceFundingInfo {
  symbol?: string;
  fundingIntervalHours?: number;
}

interface BybitInstrument {
  symbol?: string;
  contractType?: string;
  status?: string;
  baseCoin?: string;
  quoteCoin?: string;
  settleCoin?: string;
  deliveryTime?: string;
  fundingInterval?: number;
  priceFilter?: { tickSize?: string };
  lotSizeFilter?: {
    qtyStep?: string;
    minOrderQty?: string;
    minNotionalValue?: string;
  };
}

interface BybitEnvelope {
  retCode?: number;
  retMsg?: string;
  result?: { list?: BybitInstrument[]; nextPageCursor?: string };
}

export interface InstrumentRegistrySnapshot {
  updatedAt: number;
  instruments: RegistryInstrument[];
  /** Freshly checked rows only; execution and scanners must use this list. */
  verifiedInstruments: RegistryInstrument[];
  capabilities: VenueCapabilityManifest[];
  sourceErrors: string[];
  sourceStates: InstrumentRegistrySourceState[];
}

export interface InstrumentRegistrySourceState {
  source: string;
  status: "fresh" | "stale-cache" | "quarantined";
  receivedAt?: number;
  checkedAt: number;
  ageMs?: number;
  message?: string;
}

const CAPABILITIES: VenueCapabilityManifest[] = [
  {
    venue: "binance",
    publicData: true,
    spot: true,
    margin: false,
    perpetual: true,
    datedFuture: true,
    option: false,
    nativeSpread: false,
    topBook: true,
    depth: true,
    publicTrades: true,
    funding: true,
    borrow: false,
    depositWithdrawal: false,
    privateExecution: false,
    demoEnvironment: true,
    scopes: [
      { product: "spot", operation: "public-data", status: "implemented" },
      { product: "perpetual", operation: "public-data", status: "implemented" },
      { product: "future", operation: "public-data", status: "implemented" },
      { product: "perpetual", operation: "private-execution", status: "experimental" }
    ]
  },
  {
    venue: "bybit",
    publicData: true,
    spot: true,
    margin: false,
    perpetual: true,
    datedFuture: true,
    option: false,
    nativeSpread: true,
    topBook: true,
    depth: true,
    publicTrades: true,
    funding: true,
    borrow: false,
    depositWithdrawal: false,
    privateExecution: false,
    demoEnvironment: true,
    scopes: [
      { product: "spot", operation: "public-data", status: "implemented" },
      { product: "perpetual", operation: "public-data", status: "implemented" },
      { product: "future", operation: "public-data", status: "implemented" },
      { product: "native-spread", operation: "public-data", status: "implemented" },
      { product: "spot", operation: "private-execution", status: "experimental" },
      { product: "perpetual", operation: "private-execution", status: "experimental" },
      { product: "account", operation: "borrow", status: "manual-only" }
    ]
  },
  OKX_PUBLIC_CAPABILITIES,
  GATE_PUBLIC_CAPABILITIES,
  HYPERLIQUID_PUBLIC_CAPABILITIES,
  DERIBIT_PUBLIC_CAPABILITIES,
  KRAKEN_PUBLIC_CAPABILITIES,
  COINBASE_PUBLIC_CAPABILITIES,
  DYDX_PUBLIC_CAPABILITIES,
  KUCOIN_PUBLIC_CAPABILITIES,
  MEXC_PUBLIC_CAPABILITIES
];

/** Cached, transport-neutral venue metadata used by charts, scanners and execution preflight. */
export class InstrumentRegistry {
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly cacheTtlMs: number;
  private readonly maxStaleMs: number;
  private readonly timeoutMs: number;
  private readonly okx: OkxPublicAdapter;
  private readonly extendedPublicSources: ExtendedPublicSource[];
  private readonly sourceCache = new Map<string, { receivedAt: number; instruments: RegistryInstrument[] }>();
  private binanceFundingCache?: { receivedAt: number; intervals: Map<string, number> };
  private cached?: InstrumentRegistrySnapshot;
  private cachedUsableUntil = 0;
  private inFlight?: Promise<InstrumentRegistrySnapshot>;

  constructor(options: RegistryOptions = {}) {
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.cacheTtlMs = options.cacheTtlMs ?? 60 * 60_000;
    this.maxStaleMs = options.maxStaleMs ?? DEFAULT_REGISTRY_MAX_STALE_MS;
    if (!Number.isSafeInteger(this.maxStaleMs) || this.maxStaleMs < 0) throw new Error("maxStaleMs must be a non-negative safe integer");
    this.timeoutMs = options.timeoutMs ?? 8_000;
    this.okx = new OkxPublicAdapter({
      fetch: this.fetcher,
      now: this.now,
      timeoutMs: this.timeoutMs,
      ...(options.okxBaseUrl ? { baseUrl: options.okxBaseUrl } : {})
    });
    const extendedAdapters = options.extendedPublicAdapters === false ? undefined : (options.extendedPublicAdapters ?? (options.fetch === undefined ? publicVenueAdapters : undefined));
    this.extendedPublicSources = extendedAdapters ? buildExtendedPublicSources(extendedAdapters) : [];
  }

  async snapshot(force = false): Promise<InstrumentRegistrySnapshot> {
    if (!force && this.cached && this.now() <= this.cachedUsableUntil) return this.cached;
    this.inFlight ??= this.load().finally(() => {
      this.inFlight = undefined;
    });
    const next = await this.inFlight;
    if (next.instruments.length > 0) {
      this.cached = next;
      this.cachedUsableUntil = snapshotUsableUntil(next, this.cacheTtlMs, this.maxStaleMs);
    } else {
      this.cached = undefined;
      this.cachedUsableUntil = 0;
    }
    return next;
  }

  async get(venue: string, marketType: VenueMarketType, symbol: string) {
    const normalized = symbol.toUpperCase();
    const snapshot = await this.snapshot();
    return snapshot.verifiedInstruments.find((instrument) => instrument.venue === venue && instrument.marketType === marketType && instrument.venueSymbol === normalized);
  }

  private async load(): Promise<InstrumentRegistrySnapshot> {
    const [settled, extendedSettled] = await Promise.all([
      Promise.allSettled([
        this.fetchJson<BinanceExchangeInfo>(BINANCE_SPOT_INFO),
        this.fetchJson<BinanceExchangeInfo>(BINANCE_FUTURES_INFO),
        this.fetchJson<BinanceFundingInfo[]>(BINANCE_FUNDING_INFO),
        this.fetchBybit("spot"),
        this.fetchBybit("linear"),
        this.okx.instruments("spot").then((value) => ({ payload: value, receivedAt: value.receivedAt })),
        this.okx.instruments("perpetual").then((value) => ({ payload: value, receivedAt: value.receivedAt })),
        this.okx.instruments("future").then((value) => ({ payload: value, receivedAt: value.receivedAt }))
      ]),
      Promise.allSettled(this.extendedPublicSources.map(({ adapter, marketType }) => adapter.instruments(marketType).then((value) => ({ payload: value, receivedAt: value.receivedAt }))))
    ]);
    const checkedAt = this.now();
    const errors: string[] = [];
    const sourceStates: InstrumentRegistrySourceState[] = [];
    const funding = this.resolveFundingIntervals(settled[2], errors, sourceStates, checkedAt);
    const resolved = [
      this.resolveSource("binance:spot", "Binance spot", settled[0], (value) => normalizeBinance(value.symbols ?? [], "spot", funding.intervals), errors, sourceStates, checkedAt),
      this.resolveSource("binance:derivatives", "Binance futures", settled[1], (value) => normalizeBinance(value.symbols ?? [], "perpetual", funding.intervals), errors, sourceStates, checkedAt, funding.verified),
      this.resolveSource("bybit:spot", "Bybit spot", settled[3], (value) => normalizeBybit(value, "spot"), errors, sourceStates, checkedAt),
      this.resolveSource("bybit:linear", "Bybit linear", settled[4], (value) => normalizeBybit(value, "perpetual"), errors, sourceStates, checkedAt),
      this.resolveSource("okx:spot", "OKX spot", settled[5], (value) => value.instruments, errors, sourceStates, checkedAt),
      this.resolveSource("okx:swap", "OKX swap", settled[6], (value) => value.instruments, errors, sourceStates, checkedAt),
      this.resolveSource("okx:futures", "OKX futures", settled[7], (value) => value.instruments, errors, sourceStates, checkedAt)
    ];
    const extendedResolved = this.extendedPublicSources.map((source, index) => {
      const result = extendedSettled[index] as PromiseSettledResult<ReceivedPayload<PublicInstrumentSnapshot>>;
      if (result.status === "fulfilled" && result.value.payload.rejectedRows.length > 0) {
        errors.push(`${source.label}: rejected ${result.value.payload.rejectedRows.length} malformed row(s)`);
      }
      return this.resolveSource(source.key, source.label, result, (value) => value.instruments, errors, sourceStates, checkedAt);
    });
    this.reportOkxRejectedRows([settled[5], settled[6], settled[7]], errors);
    const instruments = dedupe([...resolved, ...extendedResolved].flatMap((source) => source.instruments)).map(withReviewedEconomicAssetIdentity);
    const verifiedInstruments = dedupe([...resolved, ...extendedResolved].flatMap((source) => source.verifiedInstruments)).map(withReviewedEconomicAssetIdentity);
    return {
      updatedAt: checkedAt,
      instruments,
      verifiedInstruments,
      capabilities: CAPABILITIES.map((manifest) => ({ ...manifest })),
      sourceErrors: errors,
      sourceStates
    };
  }

  private resolveFundingIntervals(result: PromiseSettledResult<ReceivedPayload<BinanceFundingInfo[]>>, errors: string[], states: InstrumentRegistrySourceState[], checkedAt: number) {
    if (result.status === "rejected") {
      const message = errorMessage(result.reason);
      errors.push(`Binance funding: ${message}`);
      const cached = this.binanceFundingCache;
      const ageMs = cached ? Math.max(0, checkedAt - cached.receivedAt) : undefined;
      if (cached && ageMs !== undefined && ageMs <= this.maxStaleMs) {
        states.push({ source: "binance:funding", status: "stale-cache", receivedAt: cached.receivedAt, checkedAt, ageMs, message });
        return { intervals: new Map(cached.intervals), verified: false };
      }
      states.push({ source: "binance:funding", status: "quarantined", ...(cached ? { receivedAt: cached.receivedAt, ageMs } : {}), checkedAt, message });
      return { intervals: new Map<string, number>(), verified: false };
    }
    const receivedAt = sourceReceivedAt(result.value.receivedAt, checkedAt, "Binance funding");
    const intervals = new Map(result.value.payload.filter((row) => validSymbol(row.symbol) && positive(row.fundingIntervalHours)).map((row) => [row.symbol as string, (row.fundingIntervalHours as number) * 60]));
    this.binanceFundingCache = { receivedAt, intervals };
    states.push({ source: "binance:funding", status: "fresh", receivedAt, checkedAt, ageMs: checkedAt - receivedAt });
    return { intervals: new Map(intervals), verified: true };
  }

  private resolveSource<T>(
    key: string,
    label: string,
    result: PromiseSettledResult<ReceivedPayload<T>>,
    normalize: (value: T) => RegistryInstrument[],
    errors: string[],
    states: InstrumentRegistrySourceState[],
    checkedAt: number,
    executionVerified = true
  ): { instruments: RegistryInstrument[]; verifiedInstruments: RegistryInstrument[] } {
    if (result.status === "rejected") {
      const message = errorMessage(result.reason);
      errors.push(`${label}: ${message}`);
      return this.cachedSource(key, message, states, checkedAt);
    }
    try {
      const receivedAt = sourceReceivedAt(result.value.receivedAt, checkedAt, label);
      const rows = normalize(result.value.payload);
      if (rows.length === 0) throw new Error("source returned no supported instruments");
      const cached = rows.map((row) => ({ ...row }));
      this.sourceCache.set(key, { receivedAt, instruments: cached });
      states.push({ source: key, status: "fresh", receivedAt, checkedAt, ageMs: checkedAt - receivedAt });
      return { instruments: rows, verifiedInstruments: executionVerified ? rows : [] };
    } catch (error) {
      const message = errorMessage(error);
      errors.push(`${label}: ${message}`);
      return this.cachedSource(key, message, states, checkedAt);
    }
  }

  private cachedSource(key: string, message: string, states: InstrumentRegistrySourceState[], checkedAt: number) {
    const cached = this.sourceCache.get(key);
    const ageMs = cached ? Math.max(0, checkedAt - cached.receivedAt) : undefined;
    if (cached && ageMs !== undefined && ageMs <= this.maxStaleMs) {
      states.push({ source: key, status: "stale-cache", receivedAt: cached.receivedAt, checkedAt, ageMs, message });
      return { instruments: cached.instruments.map((row) => ({ ...row })), verifiedInstruments: [] };
    }
    states.push({ source: key, status: "quarantined", ...(cached ? { receivedAt: cached.receivedAt, ageMs } : {}), checkedAt, message });
    return { instruments: [], verifiedInstruments: [] };
  }

  private reportOkxRejectedRows(results: PromiseSettledResult<ReceivedPayload<{ rejectedRows: { message: string }[] }>>[], errors: string[]) {
    const labels = ["OKX spot", "OKX swap", "OKX futures"];
    results.forEach((result, index) => {
      if (result.status === "fulfilled" && result.value.payload.rejectedRows.length > 0) {
        errors.push(`${labels[index]}: rejected ${result.value.payload.rejectedRows.length} malformed row(s)`);
      }
    });
  }

  private async fetchBybit(category: "spot" | "linear"): Promise<ReceivedPayload<BybitInstrument[]>> {
    const rows: BybitInstrument[] = [];
    let cursor = "";
    let receivedAt = 0;
    for (let page = 0; page < 4; page += 1) {
      const query = new URLSearchParams({ category, limit: "1000" });
      if (cursor) query.set("cursor", cursor);
      const response = await this.fetchJson<BybitEnvelope>(`${BYBIT_INSTRUMENTS}?${query}`);
      const envelope = response.payload;
      receivedAt = response.receivedAt;
      if (envelope.retCode !== 0) throw new Error(envelope.retMsg ?? `Bybit retCode ${envelope.retCode}`);
      rows.push(...(envelope.result?.list ?? []));
      cursor = envelope.result?.nextPageCursor ?? "";
      if (!cursor) break;
    }
    return { payload: rows, receivedAt };
  }

  private async fetchJson<T>(url: string): Promise<ReceivedPayload<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(url, { signal: controller.signal, headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await readBoundedText(response, MAX_REGISTRY_PAYLOAD_BYTES, () => new Error("Instrument-registry response is too large"));
      const payload = JSON.parse(body) as T;
      return { payload, receivedAt: this.now() };
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Process-wide metadata cache shared by catalog, scanner and execution preflight. */
export const instrumentRegistry = new InstrumentRegistry();

function buildExtendedPublicSources(adapters: ReadonlyMap<string, Pick<PublicVenueAdapter, "venue" | "capabilities" | "instruments">>): ExtendedPublicSource[] {
  const sources: ExtendedPublicSource[] = [];
  for (const [key, adapter] of [...adapters.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (key !== adapter.venue) throw new Error(`Public adapter registry key ${key} does not match venue ${adapter.venue}`);
    if (adapter.venue === "okx") continue;
    const capabilities = adapter.capabilities();
    if (capabilities.venue !== adapter.venue || !capabilities.publicData || capabilities.privateExecution) {
      throw new Error(`Extended registry adapter ${adapter.venue} has an invalid public capability boundary`);
    }
    const marketTypes: VenueMarketType[] = [];
    if (capabilities.spot) marketTypes.push("spot");
    if (capabilities.perpetual) marketTypes.push("perpetual");
    if (capabilities.datedFuture) marketTypes.push("future");
    if (capabilities.option) marketTypes.push("option");
    for (const marketType of marketTypes) {
      sources.push({ adapter, marketType, key: `${adapter.venue}:${marketType}`, label: `${adapter.venue} ${marketType}` });
    }
  }
  return sources;
}

function normalizeBinance(rows: BinanceSymbol[], fallbackMarket: "spot" | "perpetual", fundingIntervals: Map<string, number>) {
  const output: RegistryInstrument[] = [];
  for (const row of rows) {
    const symbol = String(row.symbol ?? "").toUpperCase();
    const baseAsset = String(row.baseAsset ?? "").toUpperCase();
    const quoteAsset = String(row.quoteAsset ?? "").toUpperCase();
    if (!validSymbol(symbol) || !baseAsset || !quoteAsset || row.status !== "TRADING") continue;
    if (fallbackMarket === "spot" && row.isSpotTradingAllowed === false) continue;
    const marketType: VenueMarketType = fallbackMarket === "spot" ? "spot" : row.contractType === "PERPETUAL" ? "perpetual" : "future";
    const price = filter(row, "PRICE_FILTER");
    const lot = filter(row, "LOT_SIZE") ?? filter(row, "MARKET_LOT_SIZE");
    const notional = filter(row, "NOTIONAL") ?? filter(row, "MIN_NOTIONAL");
    const instrument = buildInstrument({
      venue: "binance",
      symbol,
      baseAsset,
      quoteAsset,
      settleAsset: fallbackMarket === "spot" ? quoteAsset : String(row.marginAsset ?? quoteAsset).toUpperCase(),
      marketType,
      tickSize: number(price?.tickSize),
      quantityStep: number(lot?.stepSize),
      minimumQuantity: number(lot?.minQty),
      minimumNotional: number(notional?.notional ?? notional?.minNotional),
      fundingIntervalMinutes: marketType === "perpetual" ? (fundingIntervals.get(symbol) ?? 480) : undefined,
      expiryTime: marketType === "future" ? positive(row.deliveryDate) : undefined
    });
    if (instrument) output.push(instrument);
  }
  return output;
}

function normalizeBybit(rows: BybitInstrument[], fallbackMarket: "spot" | "perpetual") {
  const output: RegistryInstrument[] = [];
  for (const row of rows) {
    const symbol = String(row.symbol ?? "").toUpperCase();
    const baseAsset = String(row.baseCoin ?? "").toUpperCase();
    const quoteAsset = String(row.quoteCoin ?? "").toUpperCase();
    if (!validSymbol(symbol) || !baseAsset || !quoteAsset || row.status !== "Trading") continue;
    const marketType: VenueMarketType = fallbackMarket === "spot" ? "spot" : row.contractType?.includes("Perpetual") ? "perpetual" : "future";
    const instrument = buildInstrument({
      venue: "bybit",
      symbol,
      baseAsset,
      quoteAsset,
      settleAsset: String(row.settleCoin ?? quoteAsset).toUpperCase(),
      marketType,
      tickSize: number(row.priceFilter?.tickSize),
      quantityStep: number(row.lotSizeFilter?.qtyStep),
      minimumQuantity: number(row.lotSizeFilter?.minOrderQty),
      minimumNotional: number(row.lotSizeFilter?.minNotionalValue),
      fundingIntervalMinutes: marketType === "perpetual" ? positive(row.fundingInterval) : undefined,
      expiryTime: marketType === "future" ? positive(row.deliveryTime) : undefined
    });
    if (instrument) output.push(instrument);
  }
  return output;
}

function buildInstrument(input: {
  venue: string;
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  settleAsset: string;
  marketType: VenueMarketType;
  tickSize: number;
  quantityStep: number;
  minimumQuantity: number;
  minimumNotional: number;
  fundingIntervalMinutes?: number;
  expiryTime?: number;
}): RegistryInstrument | undefined {
  if (input.tickSize <= 0 || input.quantityStep <= 0) return undefined;
  const economicAssetId = reviewedBasisEconomicAssetId(input);
  return {
    id: `${input.venue}:${input.marketType}:${input.symbol}`,
    assetId: input.baseAsset,
    ...(economicAssetId ? { economicAssetId } : {}),
    venue: input.venue,
    venueSymbol: input.symbol,
    baseAsset: input.baseAsset,
    quoteAsset: input.quoteAsset,
    settleAsset: input.settleAsset,
    marketType: input.marketType,
    ...(input.marketType === "perpetual" || input.marketType === "future" ? { contractDirection: "linear" as const } : {}),
    contractMultiplier: 1,
    quantityUnit: "base",
    tickSize: input.tickSize,
    quantityStep: input.quantityStep,
    minimumQuantity: input.minimumQuantity,
    minimumNotional: input.minimumNotional,
    status: "trading",
    ...(input.fundingIntervalMinutes ? { fundingIntervalMinutes: input.fundingIntervalMinutes } : {}),
    ...(input.expiryTime ? { expiryTime: input.expiryTime } : {})
  };
}

function filter(row: BinanceSymbol, type: string) {
  return row.filters?.find((candidate) => candidate.filterType === type);
}

function dedupe(rows: RegistryInstrument[]) {
  return [...new Map(rows.map((row) => [row.id, row])).values()].sort((left, right) => left.id.localeCompare(right.id));
}

function snapshotUsableUntil(snapshot: InstrumentRegistrySnapshot, cacheTtlMs: number, maxStaleMs: number) {
  let usableUntil = snapshot.updatedAt + cacheTtlMs;
  for (const state of snapshot.sourceStates) {
    if (state.status === "fresh" && state.receivedAt !== undefined) usableUntil = Math.min(usableUntil, state.receivedAt + cacheTtlMs);
    if (state.status === "stale-cache" && state.receivedAt !== undefined) usableUntil = Math.min(usableUntil, state.receivedAt + maxStaleMs);
  }
  return usableUntil;
}

function sourceReceivedAt(value: number, checkedAt: number, label: string) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > checkedAt) throw new Error(`${label} receivedAt is invalid`);
  return value;
}

function validSymbol(value: unknown): value is string {
  return typeof value === "string" && /^[A-Z0-9][A-Z0-9_-]{1,39}$/.test(value);
}

function number(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function positive(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error ?? "unknown error");
}
