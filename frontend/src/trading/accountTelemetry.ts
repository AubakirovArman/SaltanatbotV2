export type AccountTelemetryVenue = "binance" | "bybit";

export interface AccountTelemetryEvidence {
  source: string;
  asOf: number;
  validUntil: number;
  timestampQuality: "venue" | "receive-time";
  fresh: boolean;
}

export interface AccountFeeTelemetry {
  venue: AccountTelemetryVenue;
  market: "spot" | "perpetual";
  symbol: string;
  tierId: string;
  makerBps: number;
  takerBps: number;
  feeAssetStatus: "conditional" | "execution-dependent";
  discountAsset?: string;
  discountEnabled?: boolean;
  usableForRateRanking: boolean;
  evidence: AccountTelemetryEvidence;
}

export interface AccountBorrowTelemetry {
  venue: AccountTelemetryVenue;
  asset: string;
  availableQuantity: number;
  accountLimitQuantity: number;
  annualRateBps: number;
  borrowable: boolean;
  usageRate?: number;
  recallStatus: "unknown";
  usableForProjectedCost: boolean;
  evidence: AccountTelemetryEvidence;
}

export interface AccountTransferNetworkTelemetry {
  venue: AccountTelemetryVenue;
  asset: string;
  network: string;
  depositEnabled: boolean;
  withdrawEnabled: boolean;
  fixedWithdrawFee: number;
  estimatedArrivalMinutes?: number;
  busy?: boolean;
  usableForTransfer: boolean;
  evidence: AccountTelemetryEvidence;
}

export interface StablecoinFxTelemetry {
  venue: AccountTelemetryVenue;
  baseAsset: string;
  quoteAsset: "USDT";
  symbol: string;
  bid: number;
  ask: number;
  usableForEconomics: boolean;
  evidence: AccountTelemetryEvidence;
}

export interface AccountTelemetryIssue {
  venue: AccountTelemetryVenue;
  dimension: "borrow" | "fee" | "stablecoin-fx" | "transfer-network";
  code: "cancelled" | "invalid-response" | "rate-limit" | "stale" | "timeout" | "unavailable" | "unsupported";
  subject?: string;
  message: string;
}

export interface VenueAccountTelemetry {
  venue: AccountTelemetryVenue;
  configured: boolean;
  status: "fresh" | "partial" | "unavailable" | "unconfigured";
  generatedAt: number;
  validUntil: number;
  fees: AccountFeeTelemetry[];
  borrow: AccountBorrowTelemetry[];
  transferNetworks: AccountTransferNetworkTelemetry[];
  issues: AccountTelemetryIssue[];
}

export interface AccountTelemetrySnapshot {
  schemaVersion: 1;
  readOnly: true;
  generatedAt: number;
  validUntil: number;
  complete: boolean;
  request: { venues: AccountTelemetryVenue[]; symbols: string[]; assets: string[]; stableAssets: string[] };
  venues: VenueAccountTelemetry[];
  stablecoinFx: StablecoinFxTelemetry[];
  issues: AccountTelemetryIssue[];
  readiness: {
    feeRates: boolean;
    feeAssets: false;
    borrowCapacityAndRate: boolean;
    borrowRecall: false;
    transferNetworks: boolean;
    stablecoinFx: boolean;
    executable: false;
    blockers: string[];
  };
}

export interface AccountTelemetryQuery {
  venues: AccountTelemetryVenue[];
  symbols: string[];
  assets: string[];
  stableAssets: string[];
}

export const DEFAULT_ACCOUNT_TELEMETRY_QUERY: AccountTelemetryQuery = {
  venues: ["binance", "bybit"],
  symbols: ["BTCUSDT", "ETHUSDT"],
  assets: ["BTC", "USDT", "USDC"],
  stableAssets: ["USDC"]
};

export function accountTelemetrySearch(query: AccountTelemetryQuery): string {
  const normalized = normalizeAccountTelemetryQuery(query);
  return new URLSearchParams({
    venues: normalized.venues.join(","),
    symbols: normalized.symbols.join(","),
    assets: normalized.assets.join(","),
    stableAssets: normalized.stableAssets.join(",")
  }).toString();
}

export function normalizeAccountTelemetryQuery(query: AccountTelemetryQuery): AccountTelemetryQuery {
  return {
    venues: unique(
      query.venues.map((value) => venue(value)),
      1,
      2,
      "venues"
    ),
    symbols: unique(
      query.symbols.map((value) => ticker(value, 3, 30)),
      1,
      2,
      "symbols"
    ),
    assets: unique(
      query.assets.map((value) => ticker(value, 2, 15)),
      1,
      4,
      "assets"
    ),
    stableAssets: unique(
      query.stableAssets.map((value) => ticker(value, 2, 15)),
      1,
      3,
      "stableAssets"
    )
  };
}

export function parseAccountTelemetrySnapshot(input: unknown): AccountTelemetrySnapshot {
  const root = record(input, "account telemetry response");
  if (root.schemaVersion !== 1 || root.readOnly !== true) throw invalid("unsupported safety/version boundary");
  const generatedAt = timestamp(root.generatedAt, "generatedAt");
  const validUntil = timestamp(root.validUntil, "validUntil");
  if (validUntil < generatedAt) throw invalid("validUntil precedes generatedAt");
  const request = record(root.request, "request");
  const readiness = record(root.readiness, "readiness");
  if (readiness.feeAssets !== false || readiness.borrowRecall !== false || readiness.executable !== false) {
    throw invalid("unsafe readiness flags");
  }
  return {
    schemaVersion: 1,
    readOnly: true,
    generatedAt,
    validUntil,
    complete: boolean(root.complete, "complete"),
    request: {
      venues: array(request.venues, 2, "request.venues").map(venue),
      symbols: array(request.symbols, 2, "request.symbols").map((value) => ticker(value, 3, 30)),
      assets: array(request.assets, 4, "request.assets").map((value) => ticker(value, 2, 15)),
      stableAssets: array(request.stableAssets, 3, "request.stableAssets").map((value) => ticker(value, 2, 15))
    },
    venues: array(root.venues, 2, "venues").map(parseVenue),
    stablecoinFx: array(root.stablecoinFx, 12, "stablecoinFx").map(parseFx),
    issues: array(root.issues, 64, "issues").map(parseIssue),
    readiness: {
      feeRates: boolean(readiness.feeRates, "readiness.feeRates"),
      feeAssets: false,
      borrowCapacityAndRate: boolean(readiness.borrowCapacityAndRate, "readiness.borrowCapacityAndRate"),
      borrowRecall: false,
      transferNetworks: boolean(readiness.transferNetworks, "readiness.transferNetworks"),
      stablecoinFx: boolean(readiness.stablecoinFx, "readiness.stablecoinFx"),
      executable: false,
      blockers: array(readiness.blockers, 32, "readiness.blockers").map((value) => text(value, "blocker", 240))
    }
  };
}

function parseVenue(input: unknown): VenueAccountTelemetry {
  const value = record(input, "venue telemetry");
  const generatedAt = timestamp(value.generatedAt, "venue.generatedAt");
  const validUntil = timestamp(value.validUntil, "venue.validUntil");
  if (validUntil < generatedAt) throw invalid("venue validUntil precedes generatedAt");
  return {
    venue: venue(value.venue),
    configured: boolean(value.configured, "venue.configured"),
    status: enumeration(value.status, ["fresh", "partial", "unavailable", "unconfigured"] as const, "venue.status"),
    generatedAt,
    validUntil,
    fees: array(value.fees, 8, "fees").map(parseFee),
    borrow: array(value.borrow, 16, "borrow").map(parseBorrow),
    transferNetworks: array(value.transferNetworks, 128, "transferNetworks").map(parseNetwork),
    issues: array(value.issues, 32, "venue.issues").map(parseIssue)
  };
}

function parseFee(input: unknown): AccountFeeTelemetry {
  const value = record(input, "fee telemetry");
  const feeAsset = record(value.feeAsset, "feeAsset");
  return {
    venue: venue(value.venue),
    market: enumeration(value.market, ["spot", "perpetual"] as const, "fee.market"),
    symbol: ticker(value.symbol, 3, 30),
    tierId: text(value.tierId, "fee.tierId", 80),
    makerBps: finite(value.makerBps, "fee.makerBps", -1_000, 10_000),
    takerBps: finite(value.takerBps, "fee.takerBps", -1_000, 10_000),
    feeAssetStatus: enumeration(feeAsset.status, ["conditional", "execution-dependent"] as const, "feeAsset.status"),
    ...(feeAsset.discountAsset === undefined ? {} : { discountAsset: ticker(feeAsset.discountAsset, 2, 15) }),
    ...(feeAsset.discountEnabled === undefined ? {} : { discountEnabled: boolean(feeAsset.discountEnabled, "feeAsset.discountEnabled") }),
    usableForRateRanking: boolean(value.usableForRateRanking, "fee.usableForRateRanking"),
    evidence: parseEvidence(value.evidence)
  };
}

function parseBorrow(input: unknown): AccountBorrowTelemetry {
  const value = record(input, "borrow telemetry");
  if (value.recallStatus !== "unknown") throw invalid("borrow recall status is not conservative");
  return {
    venue: venue(value.venue),
    asset: ticker(value.asset, 2, 15),
    availableQuantity: finite(value.availableQuantity, "borrow.availableQuantity", 0),
    accountLimitQuantity: finite(value.accountLimitQuantity, "borrow.accountLimitQuantity", 0),
    annualRateBps: finite(value.annualRateBps, "borrow.annualRateBps", 0, 10_000_000),
    borrowable: boolean(value.borrowable, "borrow.borrowable"),
    ...(value.usageRate === undefined ? {} : { usageRate: finite(value.usageRate, "borrow.usageRate", 0, 1) }),
    recallStatus: "unknown",
    usableForProjectedCost: boolean(value.usableForProjectedCost, "borrow.usableForProjectedCost"),
    evidence: parseEvidence(value.evidence)
  };
}

function parseNetwork(input: unknown): AccountTransferNetworkTelemetry {
  const value = record(input, "network telemetry");
  return {
    venue: venue(value.venue),
    asset: ticker(value.asset, 2, 15),
    network: text(value.network, "network", 80),
    depositEnabled: boolean(value.depositEnabled, "network.depositEnabled"),
    withdrawEnabled: boolean(value.withdrawEnabled, "network.withdrawEnabled"),
    fixedWithdrawFee: finite(value.fixedWithdrawFee, "network.fixedWithdrawFee", 0),
    ...(value.estimatedArrivalMinutes === undefined ? {} : { estimatedArrivalMinutes: finite(value.estimatedArrivalMinutes, "network.estimatedArrivalMinutes", 0, 100_000) }),
    ...(value.busy === undefined ? {} : { busy: boolean(value.busy, "network.busy") }),
    usableForTransfer: boolean(value.usableForTransfer, "network.usableForTransfer"),
    evidence: parseEvidence(value.evidence)
  };
}

function parseFx(input: unknown): StablecoinFxTelemetry {
  const value = record(input, "stablecoin FX telemetry");
  if (value.quoteAsset !== "USDT") throw invalid("FX quoteAsset is unsupported");
  const bid = finite(value.bid, "fx.bid", 0);
  const ask = finite(value.ask, "fx.ask", 0);
  if (bid <= 0 || ask <= 0 || bid > ask) throw invalid("FX book is invalid or crossed");
  return {
    venue: venue(value.venue),
    baseAsset: ticker(value.baseAsset, 2, 15),
    quoteAsset: "USDT",
    symbol: ticker(value.symbol, 3, 30),
    bid,
    ask,
    usableForEconomics: boolean(value.usableForEconomics, "fx.usableForEconomics"),
    evidence: parseEvidence(value.evidence)
  };
}

function parseIssue(input: unknown): AccountTelemetryIssue {
  const value = record(input, "telemetry issue");
  return {
    venue: venue(value.venue),
    dimension: enumeration(value.dimension, ["borrow", "fee", "stablecoin-fx", "transfer-network"] as const, "issue.dimension"),
    code: enumeration(value.code, ["cancelled", "invalid-response", "rate-limit", "stale", "timeout", "unavailable", "unsupported"] as const, "issue.code"),
    ...(value.subject === undefined ? {} : { subject: text(value.subject, "issue.subject", 80) }),
    message: text(value.message, "issue.message", 300)
  };
}

function parseEvidence(input: unknown): AccountTelemetryEvidence {
  const value = record(input, "evidence");
  if (value.version !== "account-telemetry-v1") throw invalid("evidence version is unsupported");
  const asOf = timestamp(value.asOf, "evidence.asOf");
  const validUntil = timestamp(value.validUntil, "evidence.validUntil");
  if (validUntil < asOf) throw invalid("evidence validity interval is invalid");
  return {
    source: text(value.source, "evidence.source", 120),
    asOf,
    validUntil,
    timestampQuality: enumeration(value.timestampQuality, ["venue", "receive-time"] as const, "evidence.timestampQuality"),
    fresh: boolean(value.fresh, "evidence.fresh")
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function array(value: unknown, max: number, label: string): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw invalid(`${label} must be a bounded array`);
  return value;
}

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max) throw invalid(`${label} is invalid`);
  return value;
}

function ticker(value: unknown, min: number, max: number): string {
  const normalized = typeof value === "string" ? value.trim().toUpperCase() : "";
  if (normalized.length < min || normalized.length > max || !/^[A-Z0-9]+$/.test(normalized)) throw invalid("ticker is invalid");
  return normalized;
}

function venue(value: unknown): AccountTelemetryVenue {
  return enumeration(value, ["binance", "bybit"] as const, "venue");
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw invalid(`${label} must be boolean`);
  return value;
}

function finite(value: unknown, label: string, min = -Number.MAX_VALUE, max = Number.MAX_VALUE): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw invalid(`${label} is invalid`);
  return value;
}

function timestamp(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) throw invalid(`${label} is invalid`);
  return value as number;
}

function enumeration<const Values extends readonly string[]>(value: unknown, allowed: Values, label: string): Values[number] {
  if (typeof value !== "string" || !allowed.includes(value)) throw invalid(`${label} is unsupported`);
  return value as Values[number];
}

function unique<T>(values: T[], min: number, max: number, label: string): T[] {
  const result = [...new Set(values)];
  if (result.length < min || result.length > max) throw invalid(`${label} count is invalid`);
  return result;
}

function invalid(message: string): Error {
  return new Error(`Invalid account telemetry response: ${message}`);
}
