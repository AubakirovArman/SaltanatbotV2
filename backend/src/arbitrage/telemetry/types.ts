import type { UpstreamGovernorSnapshot } from "../upstream/resourceGovernor/index.js";

export type AccountTelemetryVenue = "binance" | "bybit";
export type AccountTelemetryMarket = "spot" | "perpetual";

export interface AccountTelemetryRequest {
  venues: readonly AccountTelemetryVenue[];
  symbols: readonly string[];
  assets: readonly string[];
  stableAssets: readonly string[];
}

export interface AccountTelemetryEvidence {
  source: string;
  version: "account-telemetry-v1";
  asOf: number;
  validUntil: number;
  timestampQuality: "venue" | "receive-time";
  fresh: boolean;
}

export interface AccountFeeTelemetry {
  venue: AccountTelemetryVenue;
  market: AccountTelemetryMarket;
  symbol: string;
  accountScope: "current-account-symbol";
  tierId: string;
  makerBps: number;
  takerBps: number;
  rateDetail:
    | {
        kind: "binance-spot-components";
        makerBuyBps: number;
        makerSellBps: number;
        takerBuyBps: number;
        takerSellBps: number;
        standard: RateSides;
        special: RateSides;
        tax: RateSides;
      }
    | { kind: "flat"; rpiBps?: number };
  rebate: {
    maker: "verified" | "none";
    taker: "verified" | "none";
  };
  feeAsset: {
    status: "conditional" | "execution-dependent";
    discountAsset?: string;
    discountEnabled?: boolean;
    actualFillRequired: true;
  };
  usableForRateRanking: boolean;
  usableForSettlementAccounting: false;
  evidence: AccountTelemetryEvidence;
}

export interface RateSides {
  maker: number;
  taker: number;
  buyer: number;
  seller: number;
}

export interface AccountBorrowTelemetry {
  venue: AccountTelemetryVenue;
  asset: string;
  availableQuantity: number;
  accountLimitQuantity: number;
  annualRateBps: number;
  rateBasis: "next-hourly-annualized" | "current-hourly-annualized";
  borrowable: boolean;
  usageRate?: number;
  recallStatus: "unknown";
  usableForProjectedCost: boolean;
  usableForNonRecallableRoutes: false;
  evidence: AccountTelemetryEvidence;
}

export interface AccountTransferNetworkTelemetry {
  venue: AccountTelemetryVenue;
  asset: string;
  network: string;
  networkName?: string;
  depositEnabled: boolean;
  withdrawEnabled: boolean;
  fixedWithdrawFee: number;
  percentageWithdrawFeeBps?: number;
  minimumDeposit?: number;
  minimumWithdraw?: number;
  maximumWithdraw?: number;
  depositConfirmations?: number;
  safeConfirmations?: number;
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
  bidQuantity?: number;
  askQuantity?: number;
  usableForEconomics: boolean;
  evidence: AccountTelemetryEvidence;
}

export type AccountTelemetryIssueCode = "cancelled" | "invalid-response" | "rate-limit" | "stale" | "timeout" | "unavailable" | "unsupported";

export interface AccountTelemetryIssue {
  venue: AccountTelemetryVenue;
  dimension: "borrow" | "fee" | "stablecoin-fx" | "transfer-network";
  code: AccountTelemetryIssueCode;
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

export interface AccountTelemetryReadiness {
  feeRates: boolean;
  feeAssets: false;
  borrowCapacityAndRate: boolean;
  borrowRecall: false;
  transferNetworks: boolean;
  stablecoinFx: boolean;
  executable: false;
  blockers: string[];
}

export interface AccountTelemetrySnapshot {
  schemaVersion: 1;
  readOnly: true;
  generatedAt: number;
  validUntil: number;
  complete: boolean;
  request: {
    venues: AccountTelemetryVenue[];
    symbols: string[];
    assets: string[];
    stableAssets: string[];
  };
  venues: VenueAccountTelemetry[];
  stablecoinFx: StablecoinFxTelemetry[];
  issues: AccountTelemetryIssue[];
  readiness: AccountTelemetryReadiness;
  governor: UpstreamGovernorSnapshot;
}
